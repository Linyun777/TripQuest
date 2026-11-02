import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

type Entry = { kind: "round" | "request"; round: string; at: string };
const rounds = ["developer", "test"];
export function feedbackBudget(directory: string, round: string) {
  if (!rounds.includes(round)) throw new Error("Unknown round");
  const ledger = join(directory, "s43-live-budget.jsonl");
  const lockPath = join(directory, "s43-live-budget.lock");
  let owned = false;
  async function append(kind: Entry["kind"]) {
    await mkdir(directory, { recursive: true });
    const lock = await open(lockPath, "wx");
    try {
      let entries: Entry[] = [];
      try {
        const text = await readFile(ledger, "utf8");
        if (!text.trim()) throw new Error("Corrupt ledger");
        entries = text.trim().split("\n").map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      for (const entry of entries) {
        if (!entry || Object.keys(entry).sort().join() !== "at,kind,round" ||
            !rounds.includes(entry.round) || !Number.isFinite(Date.parse(entry.at))) {
          throw new Error("Corrupt ledger");
        }
        if (entry.kind === "round" && !seen.has(entry.round)) seen.add(entry.round);
        else if (entry.kind === "request" && seen.has(entry.round)) {
          counts.set(entry.round, (counts.get(entry.round) ?? 0) + 1);
        } else throw new Error("Corrupt ledger");
      }
      if ([...counts.values()].some((value) => value > 8)) throw new Error("Corrupt ledger");
      if (kind === "round" && seen.has(round)) throw new Error("Round already consumed");
      if (kind === "request" && (!owned || !seen.has(round) || (counts.get(round) ?? 0) >= 8)) {
        throw new Error("Request budget exhausted");
      }
      await appendFile(ledger, JSON.stringify({ kind, round, at: new Date().toISOString() }) + "\n");
      if (kind === "round") owned = true;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  return { reserveRound: () => append("round"), beforeRequest: () => append("request") };
}
