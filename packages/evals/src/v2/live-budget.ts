import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

interface Entry {
  readonly kind: "round" | "request";
  readonly round: string;
  readonly at: string;
}
/** Shared append-only reservation ledger; failures consume requests and rounds are not retried. */
export function liveBudget(directory: string, round: string) {
  if (!["developer", "test-1", "test-2"].includes(round)) throw new Error("Unknown smoke round");
  const ledger = join(directory, "s42-live-budget.jsonl");
  const lockPath = join(directory, "s42-live-budget.lock");
  async function append(kind: Entry["kind"]): Promise<void> {
    await mkdir(directory, { recursive: true });
    const lock = await open(lockPath, "wx");
    try {
      let entries: Entry[];
      try {
        entries = (await readFile(ledger, "utf8")).trim().split("\n")
          .filter(Boolean).map((line) => JSON.parse(line) as Entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      if (entries.some((e) => !["round", "request"].includes(e.kind) ||
        !["developer", "test-1", "test-2"].includes(e.round))) throw new Error("Invalid live budget ledger");
      const rounds = entries.filter((e) => e.kind === "round");
      const requests = entries.filter((e) => e.kind === "request");
      if (kind === "round" && (rounds.some((e) => e.round === round) || rounds.length >= 3)) {
        throw new Error("Smoke round already reserved or exhausted");
      }
      if (kind === "request" && (!rounds.some((e) => e.round === round) || requests.length >= 48 ||
        requests.filter((e) => e.round === round).length >= 16)) {
        throw new Error("Live request budget exhausted");
      }
      await appendFile(ledger, JSON.stringify({ kind, round, at: new Date().toISOString() }) + "\n");
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  return { reserveRound: () => append("round"), beforeRequest: () => append("request") };
}
