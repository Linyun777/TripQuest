import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { S54_CASES, S54_DATASET_VERSION, s54DatasetDigest } from "./s54/dataset";
import { renderS54, type S54Report } from "./s54/report";
import { runS54Case, type ModelFactories, type S54Row } from "./s54/run";
import { s54LiveBudget, type S54LiveRound } from "./s54/budget";
import { parsePlanningOptions } from "./s54/options";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outputRoot = join(root, "eval-results");

function gitMetadata(): S54Report["git"] {
  try {
    return {
      sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    };
  } catch {
    return { sha: "unavailable", dirty: null };
  }
}

/** Only this branch reads the root env, the local profile file and the network adapters. */
async function liveFactories(round: S54LiveRound) {
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.AGENT_LIVE_ENABLED !== "true") throw new Error("Live disabled");
  const profileId = process.env.AGENT_MODEL_PROFILE;
  if (!profileId) throw new Error("Missing profile");
  const config: unknown = JSON.parse(await readFile(join(root, "agent-models.local.json"), "utf8"));
  const { resolveProfile } = await import("@tripquest/agent/live");
  const { createDayLiveModel } = await import("@tripquest/agent/day-live");
  const { createReplanLiveModel } = await import("@tripquest/agent/replan-live");
  const { profile } = resolveProfile(config, profileId, process.env);
  const budget = s54LiveBudget(outputRoot, round);
  const options = { config, profileId, environment: process.env, beforeRequest: budget.beforeRequest };
  const factories: ModelFactories = {
    day: () => createDayLiveModel(options),
    replan: () => createReplanLiveModel(options),
  };
  // Validate both adapters before anything is reserved or sent.
  factories.day();
  factories.replan();
  return { factories, budget, profileId, configuredModel: profile.model };
}

async function main() {
  const options = parsePlanningOptions(process.argv.slice(2));
  const cases = S54_CASES.filter((item) => options.caseIds.includes(item.id));
  const live = options.policy === "live" ? await liveFactories(options.round!) : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);

  const rows: S54Row[] = [];
  // The free rule policy always runs, so every report carries its own comparison.
  for (const item of cases) rows.push(await runS54Case(item, "scripted"));
  if (live) {
    await live.budget.reserveRound();
    for (const item of cases) {
      if (controller.signal.aborted) break;
      rows.push(await runS54Case(item, "live", live.factories, controller.signal));
    }
  }
  const report: S54Report = {
    runId: `s54-${randomUUID()}`,
    startedAt: new Date().toISOString(),
    dataset: { version: S54_DATASET_VERSION, digest: s54DatasetDigest(), cases: cases.length },
    git: gitMetadata(),
    policies: live ? ["scripted", "live"] : ["scripted"],
    live: live
      ? {
          round: options.round!,
          profileId: live.profileId,
          configuredModel: live.configuredModel,
          returnedModels: [...new Set(rows.flatMap((row) => row.returnedModels))],
        }
      : null,
    rows,
  };
  const folder = join(outputRoot, report.runId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(folder, "report.md"), renderS54(report));
  const passed = rows.filter((row) => row.passed).length;
  const violations = rows.reduce((sum, row) => sum + row.violations.length, 0);
  console.log(`${passed}/${rows.length} met expectations; ${violations} violations; ${folder}`);
  // Misses are findings, not tool errors; only violations or exceptions fail the command.
  process.exitCode = violations || rows.some((row) => row.outcome === "exception") ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  console.error(`Planning evaluation failed: ${message.slice(0, 200)}. No credentials or raw responses are logged.`);
  process.exitCode = 2;
});
