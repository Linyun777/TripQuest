import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createInvestigation, createScriptedModel } from "@tripquest/agent";
import { generateBaselineCandidate } from "@tripquest/domain";
import { createRouteTool } from "./route-tool";
import { FIXTURE_EVIDENCE } from "./cases/dataset";
import { clarificationCase, places } from "./v3/cases";
import { runFeedbackSuite, runMechanism, runClarification } from "./v3/runner";
import { feedbackBudget } from "./v3/live-budget";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outputRoot = join(root, "eval-results");
const args = process.argv.slice(2).filter((value) => value !== "--");
const demo = args[0] === "demo";
if (demo) args.shift();
function options() {
  const result: Record<string, string> = {};
  const allowed = demo ? ["--case", "--answer"] : ["--mode", "--profile", "--smoke"];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.includes(key) || !args[index + 1] || result[key]) throw new Error("Invalid arguments");
    result[key] = args[index + 1];
  }
  return result;
}
async function save(value: object, passed = true) {
  const id = "runId" in value ? String(value.runId) : randomUUID();
  const folder = join(outputRoot, id);
  await mkdir(folder, { recursive: true });
  const json = JSON.stringify({
    versions: { graph: "bounded-route-feedback-v1", prompt: "route-investigation-feedback-v1", schema: "route-decision-v1", session: "location-session-v1" },
    ...value,
  }, null, 2);
  await writeFile(join(folder, "report.json"), json + "\n");
  await writeFile(join(folder, "report.md"),
    `# S4.3 反馈与澄清\n\n路线全为虚构；机制注入、自然模型与用户回答分别记录。费用 unknown。\n\n预期检查：${passed ? "通过" : "未通过"}。\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  console.log(`${passed ? "PASS" : "FAIL"}; ${folder}`);
  process.exitCode = passed ? 0 : 1;
}
async function main() {
  const flags = options();
  if (demo) {
    const id = flags["--case"] ?? "C02";
    if (!["C01", "C02", "C03"].includes(id)) throw new Error("Unknown demo");
    const c = clarificationCase(id);
    const tool = createRouteTool(c.world, FIXTURE_EVIDENCE);
    const session = createInvestigation(c.input, {
      places, model: createScriptedModel(), decisionPolicy: "feedback_once",
      plan: generateBaselineCandidate, lookupRoute: tool.lookupRoute,
    });
    let snapshot = await session.start();
    console.log(`虚构案例 ${id}；观察时间 ${c.input.state.observedAt}；仅内存，退出失效。`);
    console.log(snapshot.question?.text);
    for (const option of snapshot.question?.options ?? []) console.log(`${option.id}: ${option.name}`);
    let answer = flags["--answer"];
    if (answer === undefined && process.stdin.isTTY) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const answerController = new AbortController();
      terminal.on("SIGINT", () => answerController.abort());
      terminal.on("close", () => answerController.abort());
      try {
        answer = (await terminal.question("输入地点 ID、cannot_answer 或 cancel：", {
          signal: answerController.signal,
        })).trim();
      } catch {
        answer = "cancel";
      } finally {
        terminal.close();
      }
    }
    try {
      if (answer === "cancel") snapshot = session.cancel();
      else if (answer !== undefined && snapshot.question) {
        snapshot = await session.answer({
          questionId: snapshot.question.questionId,
          snapshotFingerprint: snapshot.question.snapshotFingerprint,
          choice: answer,
        }, c.input);
      }
      console.log(JSON.stringify({
        status: snapshot.status,
        oldVersion: snapshot.initial.state.version,
        newVersion: snapshot.followup?.state.version ?? null,
        result: snapshot.output?.result.status ?? snapshot.initialResult.status,
        selected: snapshot.output?.result.selected?.strategy ?? null,
        stop: snapshot.output?.executionStatus ?? null,
        routes: tool.snapshot().map((event) => `${event.fromPlaceId}→${event.toPlaceId}`),
      }, null, 2));
      await save({ schemaVersion: 3, caseId: id, snapshot, trace: tool.snapshot() });
    } finally {
      tool.close();
    }
    return;
  }
  const git = {
    sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  };
  const mode = flags["--mode"] ?? "scripted";
  if (mode === "scripted") {
    if (flags["--smoke"] || flags["--profile"]) throw new Error("Live flags in offline mode");
    const report = await runFeedbackSuite({ git });
    await save(report, report.passed);
    return;
  }
  if (mode !== "live") throw new Error("Unknown mode");
  const round = flags["--smoke"];
  if (!round || !["developer", "test"].includes(round)) throw new Error("Select fixed round");
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  if (process.env.AGENT_LIVE_ENABLED !== "true") throw new Error("Live disabled");
  const profileId = flags["--profile"] ?? process.env.AGENT_MODEL_PROFILE;
  if (!profileId) throw new Error("Missing profile");
  const config: unknown = JSON.parse(await readFile(join(root, "agent-models.local.json"), "utf8"));
  const { createLiveModel, resolveProfile } = await import("@tripquest/agent/live");
  const { profile } = resolveProfile(config, profileId, process.env);
  const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const budget = feedbackBudget(outputRoot, round);
  const factory = () => createLiveModel({
    config, profileId, environment: process.env, beforeRequest: budget.beforeRequest,
  });
  factory();
  await budget.reserveRound();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const rows = [];
    const first = await runMechanism("F01", factory(), controller.signal);
    rows.push(first);
    await appendFile(join(outputRoot, `s43-live-${round}.jsonl`), JSON.stringify(first) + "\n");
    const stopped = controller.signal.aborted || ["auth", "quota"].includes(first.output?.error ?? "");
    if (!stopped) {
      const second = await runClarification("C02", "P-B", factory(), controller.signal);
      rows.push(second);
      await appendFile(join(outputRoot, `s43-live-${round}.jsonl`), JSON.stringify(second) + "\n");
    }
    const passed = !stopped && rows.every((row) =>
      "mechanismPassed" in row ? row.mechanismPassed : row.passed,
    );
    await save({
      schemaVersion: 3, runId: randomUUID(), startedAt: new Date().toISOString(), git,
      profileId, profileHash, round, rows, skippedRuns: 2 - rows.length, passed,
    }, passed);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch(() => {
  console.error("S4.3 failed: check arguments/profile/answer/budget. Raw inputs and credentials are not logged.");
  process.exitCode = 2;
});
