import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runFeedbackSuite, runClarification } from "../v3/runner";
import { auditSession } from "../v3/session-scoring";
import { feedbackBudget } from "../v3/live-budget";

describe("v3 independent expectations and session scoring", () => {
  it("matches hand expectations while preserving rejected business outcomes", async () => {
    const report = await runFeedbackSuite({ git: { sha: "test", dirty: true } });
    expect(report.passed).toBe(true);
    expect(report.mechanismRows).toHaveLength(6);
    expect(report.natural).toHaveLength(20);
    expect(report.mechanismRows[0].score?.repair).toBe("recovered");
    expect(report.mechanismRows[0].score?.passed).toBe(true);
    const rejected = report.mechanismRows.find((row) => row.caseId === "F03")!;
    expect(rejected.mechanismPassed).toBe(true);
    expect(rejected.output?.executionStatus).toBe("invalid_decision");
    expect(rejected.score?.execution).toBe(false);
    expect(rejected.output?.routeRequests).toBe(0);
    const c02 = report.natural.filter((row) => row.caseId === "C02");
    expect(new Set(c02.map((row) => row.answeredSnapshot)).size).toBe(1);
    expect(c02.every((row) => row.initialStatus === "needs_information")).toBe(true);
  });
  it("rejects forged transition facts, provenance and fingerprints", async () => {
    const row = await runClarification("C02", "P-B");
    const snapshot = row.snapshot;
    const forged = {
      ...snapshot,
      followup: { ...snapshot.followup!, transferBufferMinutes: 0 },
      answer: { ...snapshot.answer!, provenance: "gps" as "user_answer" },
    };
    expect(auditSession(forged, row.trace)).toEqual(expect.arrayContaining([
      "unexpected_fact_change", "followup_fingerprint", "answer_provenance",
    ]));
  });
  it("C01 needs no model or route; unanswered/cannot_answer/cancel stay distinct", async () => {
    const known = await runClarification("C01", "P-C");
    expect(known.passed).toBe(true);
    expect(known.snapshot.output?.modelRequests).toBe(0);
    expect(known.trace).toHaveLength(0);
    for (const [choice, status] of [[undefined, "awaiting_user"], ["cannot_answer", "finished"], ["cancel", "cancelled"]]) {
      const result = await runClarification("C02", choice);
      expect(result.passed).toBe(true);
      expect(result.snapshot.status).toBe(status);
      expect(result.snapshot.followup).toBeNull();
      expect(result.trace).toHaveLength(0);
    }
  });
});
describe("s43 separate fixed budget ledger", () => {
  it("counts failures, enforces 8 per round, ownership, concurrency and s42 isolation", async () => {
    const folder = await mkdtemp(join(tmpdir(), "tq-s43-budget-"));
    try {
      await writeFile(join(folder, "s42-live-budget.jsonl"), "s42 untouched\n");
      const developer = feedbackBudget(folder, "developer");
      await developer.reserveRound();
      await expect(feedbackBudget(folder, "developer").reserveRound()).rejects.toThrow();
      await expect(feedbackBudget(folder, "developer").beforeRequest()).rejects.toThrow();
      for (let index = 0; index < 8; index++) await developer.beforeRequest();
      await expect(developer.beforeRequest()).rejects.toThrow();
      const test = feedbackBudget(folder, "test");
      const concurrent = await Promise.allSettled([test.reserveRound(), feedbackBudget(folder, "test").reserveRound()]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await readFile(join(folder, "s42-live-budget.jsonl"), "utf8")).toBe("s42 untouched\n");
    } finally {
      await rm(folder, { recursive: true });
    }
  });
  it.each(["", "{bad", '{"kind":"request","round":"developer","at":"2026-09-30"}', '{"kind":"round","round":"bad","at":"2026-09-30"}'])("refuses corrupted ledger: %s", async (text) => {
    const folder = await mkdtemp(join(tmpdir(), "tq-s43-corrupt-"));
    try {
      await writeFile(join(folder, "s43-live-budget.jsonl"), text);
      await expect(feedbackBudget(folder, "developer").reserveRound()).rejects.toThrow();
      expect(await readFile(join(folder, "s43-live-budget.jsonl"), "utf8")).toBe(text);
    } finally {
      await rm(folder, { recursive: true });
    }
  });
});
