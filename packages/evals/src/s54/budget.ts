import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const S54_LIVE_ROUNDS = ["developer", "test"] as const;
export type S54LiveRound = (typeof S54_LIVE_ROUNDS)[number];
/** Per round: 24 runs, each within its own agent limit (draft 10, replan 8). */
export const S54_ROUND_REQUESTS = 220;

interface Entry {
  readonly kind: "round" | "request";
  readonly round: S54LiveRound;
  readonly at: string;
}

/**
 * Append-only ledger shared by every S5.4 live run, separate from s42/s52/s533. A round is
 * reserved once and never re-run; each model request is reserved before it is sent.
 */
export function s54LiveBudget(directory: string, round: S54LiveRound) {
  const ledger = join(directory, "s54-live-budget.jsonl");
  const lockPath = join(directory, "s54-live-budget.lock");

  async function append(kind: Entry["kind"]): Promise<void> {
    await mkdir(directory, { recursive: true });
    const lock = await open(lockPath, "wx");
    try {
      let entries: Entry[];
      try {
        entries = (await readFile(ledger, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      if (entries.some((entry) =>
        !["round", "request"].includes(entry.kind) || !S54_LIVE_ROUNDS.includes(entry.round))) {
        throw new Error("Invalid S5.4 live budget ledger");
      }
      const reserved = entries.some((entry) => entry.kind === "round" && entry.round === round);
      if (kind === "round" && reserved) throw new Error(`Live round ${round} was already used`);
      if (kind === "request") {
        const used = entries.filter((entry) => entry.kind === "request" && entry.round === round).length;
        if (!reserved || used >= S54_ROUND_REQUESTS) throw new Error("Live request budget exhausted");
      }
      const entry: Entry = { kind, round, at: new Date().toISOString() };
      await appendFile(ledger, JSON.stringify(entry) + "\n");
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  return {
    reserveRound: () => append("round"),
    beforeRequest: () => append("request"),
  };
}
