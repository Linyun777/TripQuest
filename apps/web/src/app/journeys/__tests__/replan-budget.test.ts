import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createS533LiveBudget } from "../replan-budget";

const run = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("s533 fixture+live ledger", () => {
  it("allows one run and eight model requests per round, keeps rounds apart and fails closed on a lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s533-ledger-"));
    const path = join(dir, "s533-live-budget.jsonl");
    try {
      const developer = createS533LiveBudget(path, "developer");
      await expect(developer.reserveModel(run), "no request before its run").rejects.toThrow();
      await developer.reserveRun(run, "deepseek-flash");
      for (let index = 0; index < 8; index += 1) await developer.reserveModel(run);
      await expect(developer.reserveModel(run), "ninth model request").rejects.toThrow();
      await expect(developer.reserveRun(other, "deepseek-flash"), "second run").rejects.toThrow();
      // The independent round has its own allowance in the same file.
      await createS533LiveBudget(path, "independent-test").reserveRun(other, "deepseek-flash");
      const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.kind === "request")).toHaveLength(8);
      expect(JSON.stringify(lines)).not.toMatch(/key|token|location/i);
      mkdirSync(`${path}.lock`);
      await expect(createS533LiveBudget(path, "independent-test").reserveModel(other)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
