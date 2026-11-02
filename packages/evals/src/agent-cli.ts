import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runV2, type V2Report } from "./v2/runner";
import { renderV2 } from "./v2/report";
import { parseAgentOptions } from "./v2/options";
import { liveBudget } from "./v2/live-budget";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outputRoot = join(root, "eval-results");
function gitMetadata() {
  try {
    return {
      sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    };
  } catch {
    return { sha: "unavailable", dirty: null };
  }
}
async function save(report: V2Report) {
  const folder = join(outputRoot, report.runId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(folder, "report.md"), renderV2(report));
  console.log(`${report.rows.filter((r) => r.score?.passed && !r.exception).length}/${report.rows.length} passed; ${folder}`);
  return !report.stoppedEarly && report.rows.every((r) => r.score?.passed && !r.exception);
}
async function main() {
  const options = parseAgentOptions(process.argv.slice(2));
  const git = gitMetadata();
  if (options.mode === "scripted") {
    const report = await runV2({ git, caseIds: options.caseIds, plannerIds: options.plannerIds });
    process.exitCode = await save(report) ? 0 : 1;
    return;
  }
  // Only this explicitly selected branch loads root env and the network adapter.
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.AGENT_LIVE_ENABLED !== "true") throw new Error("Live disabled");
  const profileId = options.profileId ?? process.env.AGENT_MODEL_PROFILE;
  if (!profileId) throw new Error("Missing profile");
  const config: unknown = JSON.parse(await readFile(join(root, "agent-models.local.json"), "utf8"));
  const { createLiveModel, resolveProfile } = await import("@tripquest/agent/live");
  const { profile } = resolveProfile(config, profileId, process.env);
  const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const budget = liveBudget(outputRoot, options.smoke!);
  const makeModel = () => createLiveModel({
    config,
    profileId,
    environment: process.env,
    beforeRequest: budget.beforeRequest,
  });
  makeModel(); // Validate adapter/tracing before reserving anything or sending requests.
  const caseIds = ["E05", "E06", "E13", "E14"];
  const controls = await runV2({
    git,
    caseIds,
    plannerIds: ["rules_only", "fixed_workflow", "adaptive_workflow"],
  });
  if (!await save(controls)) {
    process.exitCode = 1;
    return;
  }
  await budget.reserveRound();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const report = await runV2({
      git,
      caseIds,
      plannerIds: ["model_agent"],
      profileId,
      profileHash,
      modelFactory: makeModel,
      signal: controller.signal,
      onRow: async (row) => {
        await appendFile(join(outputRoot, `s42-live-${options.smoke}.jsonl`), JSON.stringify(row) + "\n");
      },
    });
    process.exitCode = await save(report) ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch(() => {
  console.error("Agent evaluation failed: check CLI/profile/live gate/budget and packages/agent/README.md. No raw credentials or response logged.");
  process.exitCode = 2;
});
