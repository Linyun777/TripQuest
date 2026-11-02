import { appendFile, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Live V2.1 evaluation requests are recorded in the product's local usage ledger. Model
 * requests have no daily ceiling since D-054; each run is capped by the CLI instead.
 */

const hangzhouDay = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

export function v21ModelBudget(directory: string, now: () => number = Date.now) {
  const ledger = join(directory, "local-usage.jsonl");
  const lockPath = `${ledger}.lock`;
  let used = 0;
  return {
    used: () => used,
    async beforeRequest(): Promise<void> {
      await mkdir(directory, { recursive: true });
      // Same lock as the product's ledger: a directory that exists while someone appends.
      let locked = false;
      for (let attempt = 0; !locked; attempt += 1) {
        try {
          await mkdir(lockPath);
          locked = true;
        } catch (error) {
          if (attempt >= 100) throw error;
          await sleep(10);
        }
      }
      try {
        const day = hangzhouDay(now());
        const entry = { version: "local-usage.v1", day, pool: "model", kind: "model", purpose: "eval-v21", at: new Date(now()).toISOString() };
        await appendFile(ledger, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        used += 1;
      } finally {
        await rmdir(lockPath);
      }
    },
  };
}
