import "server-only";
import { mkdir, open, readFile, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { DayPlanningResult } from "@tripquest/application/day-planning";
import type { LiveRound } from "./generation-config";

/** Next runs from apps/web; the git-ignored ledger lives in the workspace eval-results. */
export function s52LedgerPath(workspaceRoot = resolve(process.cwd(), "../..")): string {
  return resolve(workspaceRoot, "eval-results/s52-live-budget.jsonl");
}

const shared = {
  version: z.literal("s52-budget.v1"),
  round: z.enum(["developer", "independent-test"]),
  runId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  recordedAt: z.iso.datetime({ offset: true }),
};
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...shared, kind: z.literal("run"), dataMode: z.enum(["fixture", "amap"]), modelMode: z.enum(["scripted", "live"]) }),
  z.strictObject({ ...shared, kind: z.literal("request"), request: z.enum(["model", "search", "route"]), manual: z.boolean() }),
  z.strictObject({
    ...shared, kind: z.literal("result"), status: z.enum(["completed", "failed", "cancelled"]),
    outcome: z.enum(["draft", "no_plan"]).optional(), code: z.string().regex(/^[a-z_]{1,40}$/).optional(),
    elapsedMs: z.number().int().nonnegative(),
    model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
    usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).nullable(),
  }),
]);
type BudgetEvent = z.infer<typeof eventSchema>;
export class LiveBudgetError extends Error {
  constructor() { super("本轮真实验证预算不可用；失败和取消的预留记录不会重置。"); }
}

/** Atomic, append-only reservation shared by the HTTP route and manual search action. */
export function createS52LiveBudget(path: string, round: LiveRound, now: () => number = Date.now) {
  const base = (runId: string) => ({ version: "s52-budget.v1" as const, round, runId, recordedAt: new Date(now()).toISOString() });
  async function transaction(create: (entries: BudgetEvent[]) => BudgetEvent) {
    const lock = `${path}.lock`;
    let locked = false;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await mkdir(lock, { mode: 0o700 }); // Existing lock fails closed; never remove another process's lock.
      locked = true;
      let entries: BudgetEvent[] = [];
      try {
        if ((await stat(path)).size > 512 * 1024) throw new LiveBudgetError();
        const contents = await readFile(path, "utf8");
        if (contents && !contents.endsWith("\n")) throw new LiveBudgetError();
        entries = contents.trim().split("\n").filter(Boolean).map((line) => eventSchema.parse(JSON.parse(line)));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      const next = eventSchema.parse(create(entries.filter((e) => e.round === round)));
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(next)}\n`, "utf8");
        await file.sync(); // Reserve durably before any network request.
      } finally { await file.close(); }
    } catch {
      throw new LiveBudgetError();
    } finally {
      if (locked) await rmdir(lock);
    }
  }
  return {
    reserveRun(runId: string, dataMode: "fixture" | "amap", modelMode: "scripted" | "live") {
      return transaction((entries) => {
        const runs = entries.filter((e) => e.kind === "run");
        if (runs.some((e) => e.runId === runId || (e.kind === "run" && e.dataMode === dataMode && e.modelMode === modelMode))) {
          throw new LiveBudgetError();
        }
        return { ...base(runId), kind: "run", dataMode, modelMode };
      });
    },
    reserveRequest(runId: string, request: "model" | "search" | "route", manual = false) {
      return transaction((entries) => {
        const run = entries.find((e) => e.kind === "run" && e.runId === runId);
        if ((!manual && !run) || (manual && request !== "search") || entries.some((e) => e.kind === "result" && e.runId === runId)) {
          throw new LiveBudgetError();
        }
        const requests = entries.filter((e) => e.kind === "request" && e.request === request);
        const cap = request === "model" ? 20 : request === "search" ? 6 : 21;
        const perRun = request === "model" ? 10 : request === "search" ? 4 : 21;
        if (requests.length >= cap || (!manual && requests.filter((e) => e.runId === runId).length >= perRun)) {
          throw new LiveBudgetError();
        }
        return { ...base(runId), kind: "request", request, manual };
      });
    },
    recordResult(runId: string, result: DayPlanningResult, model: string) {
      return transaction((entries) => {
        if (!entries.some((e) => e.kind === "run" && e.runId === runId) || entries.some((e) => e.kind === "result" && e.runId === runId)) {
          throw new LiveBudgetError();
        }
        return {
          ...base(runId), kind: "result", status: result.status, elapsedMs: result.elapsedMs, model, usage: result.usage,
          ...(result.status === "completed" ? { outcome: result.outcome } : {}),
          ...(result.status === "failed" ? { code: result.code } : {}),
        };
      });
    },
  };
}
