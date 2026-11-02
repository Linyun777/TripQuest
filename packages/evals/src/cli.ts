import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dataset } from "./cases/dataset";
import { planners } from "./planners";
import { parseOptions } from "./cli-options";
import { runEvaluation } from "./runner";
import { renderMarkdown } from "./report";

// Bundled entry is packages/evals/dist/cli.js; never loads dotenv or app config.
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  let git: { sha: string; dirty: boolean | null } = { sha: "unavailable", dirty: null };
  try {
    git = { sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() };
  } catch { /* Honest metadata when run outside a Git checkout. */ }
  const report = await runEvaluation(dataset, planners.filter((p) => options.plannerIds.includes(p.id)), { caseIds: options.caseIds, git });
  const folder = new URL(`../../../eval-results/${report.runId}/`, import.meta.url);
  await mkdir(folder, { recursive: true });
  await writeFile(new URL("report.json", folder), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL("report.md", folder), renderMarkdown(report));
  console.log(`${report.rows.filter((r) => r.score.passed).length}/${report.rows.length} passed; ${fileURLToPath(folder)}`);
  process.exitCode = report.rows.every((r) => r.score.passed) ? 0 : 1;
}
main().catch(() => { console.error("Evaluation failed: invalid arguments/dataset or report I/O. See packages/evals/README.md for accepted arguments."); process.exitCode = 2; });
