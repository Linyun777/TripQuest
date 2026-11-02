import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveBudget } from "../v2/live-budget";

/**
 * The ledger is what stops a live smoke from silently spending more than the
 * agreed 12 runs / 48 requests, so it is tested independently of the runner.
 */

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "tq-s42-ledger-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const ledgerPath = (directory: string) => join(directory, "s42-live-budget.jsonl");
const lockPath = (directory: string) => join(directory, "s42-live-budget.lock");

const entries = async (directory: string) =>
  (await readFile(ledgerPath(directory), "utf8")).trim().split("\n").filter(Boolean).map(
    (line) => JSON.parse(line) as { kind: string; round: string },
  );

describe("live smoke budget ledger", () => {
  it("refuses an unknown round name before touching the filesystem", async () => {
    await withDirectory(async (directory) => {
      expect(() => liveBudget(directory, "developer-2")).toThrow("Unknown smoke round");
      expect(existsSync(ledgerPath(directory))).toBe(false);
    });
  });

  it("refuses a request that was never reserved as a round", async () => {
    await withDirectory(async (directory) => {
      const budget = liveBudget(directory, "developer");
      await expect(budget.beforeRequest()).rejects.toThrow("Live request budget exhausted");
      expect(existsSync(ledgerPath(directory))).toBe(false);
      expect(existsSync(lockPath(directory))).toBe(false);
    });
  });

  // 51 sequential lock-file round trips; the default 5s budget is too tight.
  it("allows exactly three rounds and sixteen requests per round", { timeout: 60_000 }, async () => {
    await withDirectory(async (directory) => {
      for (const round of ["developer", "test-1", "test-2"]) {
        const budget = liveBudget(directory, round);
        await budget.reserveRound();
        await expect(budget.reserveRound()).rejects.toThrow("already reserved");
        for (let index = 0; index < 16; index += 1) await budget.beforeRequest();
        await expect(budget.beforeRequest()).rejects.toThrow("exhausted");
      }
      const budget = liveBudget(directory, "test-2");
      await expect(budget.reserveRound()).rejects.toThrow("exhausted");
      const recorded = await entries(directory);
      expect(recorded.filter((e) => e.kind === "round")).toHaveLength(3);
      expect(recorded.filter((e) => e.kind === "request")).toHaveLength(48);
      expect(recorded.filter((e) => e.round === "test-1" && e.kind === "request")).toHaveLength(16);
      expect(existsSync(lockPath(directory))).toBe(false);
    });
  });

  it("keeps the per-round cap even when the global budget is untouched", async () => {
    await withDirectory(async (directory) => {
      const budget = liveBudget(directory, "developer");
      await budget.reserveRound();
      for (let index = 0; index < 16; index += 1) await budget.beforeRequest();
      await expect(budget.beforeRequest()).rejects.toThrow("exhausted");
      expect((await entries(directory)).filter((e) => e.kind === "request")).toHaveLength(16);
      const other = liveBudget(directory, "test-1");
      await other.reserveRound();
      await other.beforeRequest();
      expect((await entries(directory)).filter((e) => e.kind === "request")).toHaveLength(17);
    });
  });

  it("fails closed on a corrupt ledger instead of appending more spend", async () => {
    await withDirectory(async (directory) => {
      await writeFile(ledgerPath(directory), "{not json\n");
      const budget = liveBudget(directory, "developer");
      await expect(budget.reserveRound()).rejects.toThrow();
      expect(await readFile(ledgerPath(directory), "utf8")).toBe("{not json\n");
      expect(existsSync(lockPath(directory))).toBe(false);
    });
    await withDirectory(async (directory) => {
      await writeFile(ledgerPath(directory), `${JSON.stringify({ kind: "spend", round: "developer", at: "x" })}\n`);
      await expect(liveBudget(directory, "developer").reserveRound()).rejects.toThrow("Invalid live budget ledger");
    });
  });

  it("survives a fresh process boundary by reading the existing ledger", async () => {
    await withDirectory(async (directory) => {
      await liveBudget(directory, "developer").reserveRound();
      await liveBudget(directory, "developer").beforeRequest();
      const reopened = liveBudget(directory, "developer");
      await expect(reopened.reserveRound()).rejects.toThrow("already reserved");
      for (let index = 0; index < 15; index += 1) await reopened.beforeRequest();
      await expect(reopened.beforeRequest()).rejects.toThrow("exhausted");
    });
  });

  it("blocks all later runs while a stale lock file is present", async () => {
    await withDirectory(async (directory) => {
      await writeFile(lockPath(directory), "");
      const budget = liveBudget(directory, "developer");
      await expect(budget.reserveRound()).rejects.toThrow();
      expect(existsSync(ledgerPath(directory))).toBe(false);
    });
  });
});
