import "server-only";
import { mkdir, open, readFile, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ReplanResult } from "@tripquest/application/day-replan";
import type { ReplanRound } from "./replan-config";

/** S5.3.3's own git-ignored ledger; it never reads or extends the s52 rounds. */
export function s533LedgerPath(workspaceRoot = resolve(process.cwd(), "../..")): string {
  return resolve(workspaceRoot, "eval-results/s533-live-budget.jsonl");
}
export const S533_LIMITS = { runs: 1, model: 8 } as const;

const shared = {
  version: z.literal("s533-budget.v1"),
  purpose: z.literal("replan-fixture-live"),
  round: z.enum(["developer", "independent-test"]),
  runId: z.uuid(),
  recordedAt: z.iso.datetime({ offset: true }),
};
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...shared, kind: z.literal("run"), profile: z.string().regex(/^[a-z0-9-]{1,64}$/) }),
  z.strictObject({ ...shared, kind: z.literal("request"), request: z.literal("model") }),
  z.strictObject({
    ...shared,
    kind: z.literal("result"),
    status: z.enum(["completed", "failed", "cancelled"]),
    outcome: z.enum(["candidate", "unchanged", "bounded_no_candidate"]).optional(),
    code: z.string().regex(/^[a-z_]{1,40}$/).optional(),
    model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    elapsedMs: z.number().int().nonnegative(),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    }).nullable(),
  }),
]);
type BudgetEvent = z.infer<typeof eventSchema>;
export class ReplanBudgetError extends Error {
  constructor() {
    super("本轮真实模型额度不可用；已用、失败和取消的记录不会重置。");
  }
}

/** Append-only, reserved durably before any request; an existing lock fails closed. */
export function createS533LiveBudget(path: string, round: ReplanRound, now: () => number = Date.now) {
  const base = (runId: string) => ({
    version: "s533-budget.v1" as const,
    purpose: "replan-fixture-live" as const,
    round,
    runId,
    recordedAt: new Date(now()).toISOString(),
  });
  async function append(create: (entries: BudgetEvent[]) => BudgetEvent) {
    const lock = `${path}.lock`;
    let locked = false;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      let entries: BudgetEvent[] = [];
      try {
        if ((await stat(path)).size > 256 * 1024) throw new ReplanBudgetError();
        const contents = await readFile(path, "utf8");
        if (contents && !contents.endsWith("\n")) throw new ReplanBudgetError();
        entries = contents.trim().split("\n").filter(Boolean)
          .map((line) => eventSchema.parse(JSON.parse(line)));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      const next = eventSchema.parse(create(entries.filter((entry) => entry.round === round)));
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(next)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    } catch {
      throw new ReplanBudgetError();
    } finally {
      if (locked) await rmdir(lock);
    }
  }
  return {
    reserveRun(runId: string, profile: string) {
      return append((entries) => {
        if (entries.filter((entry) => entry.kind === "run").length >= S533_LIMITS.runs) {
          throw new ReplanBudgetError();
        }
        return { ...base(runId), kind: "run", profile };
      });
    },
    reserveModel(runId: string) {
      return append((entries) => {
        const run = entries.some((entry) => entry.kind === "run" && entry.runId === runId);
        const done = entries.some((entry) => entry.kind === "result" && entry.runId === runId);
        const used = entries.filter((entry) => entry.kind === "request").length;
        if (!run || done || used >= S533_LIMITS.model) throw new ReplanBudgetError();
        return { ...base(runId), kind: "request", request: "model" };
      });
    },
    recordResult(runId: string, result: ReplanResult, model: string) {
      return append((entries) => {
        if (
          !entries.some((entry) => entry.kind === "run" && entry.runId === runId) ||
          entries.some((entry) => entry.kind === "result" && entry.runId === runId)
        ) {
          throw new ReplanBudgetError();
        }
        return {
          ...base(runId),
          kind: "result",
          status: result.status,
          ...(result.status === "completed" ? { outcome: result.outcome } : {}),
          ...(result.status === "failed" ? { code: result.code } : {}),
          model,
          counts: result.counts,
          elapsedMs: result.elapsedMs,
          usage: result.usage,
        };
      });
    },
  };
}
