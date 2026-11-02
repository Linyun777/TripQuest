import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, type DecisionModel } from "@tripquest/agent";
import { runV2 } from "../v2/runner";
import { datasetV2 } from "../v2/dataset";
import { dataset } from "../cases/dataset";
import { datasetHash } from "../dataset-validation";
import { parseAgentOptions } from "../v2/options";
import { validateV2Cases } from "../v2/validation";
import { renderV2 } from "../v2/report";
import { liveBudget } from "../v2/live-budget";
const git = { sha: "test", dirty: false };

describe("v2 fairness and independent scoring", () => {
  it("retains v1 hash and inputs, produces all 56 rows with separate scores", async () => {
    expect(datasetHash(dataset)).toBe("e5ca0c0c88916fb4d2ca9c57d61ca283d11451191f28f638774efddf96eafed3");
    for (let i = 0; i < 12; i++) {
      expect(datasetV2.cases[i].input).toEqual(dataset.cases[i].input);
      expect(datasetV2.cases[i].world).toEqual(dataset.cases[i].world);
      expect(datasetV2.cases[i].expected.model_agent).not.toHaveProperty("calls");
    }
    const report = await runV2({ git });
    expect(report.rows).toHaveLength(56);
    expect(report.rows.filter((r) => !r.score?.passed)).toEqual([]);
    expect(report.summary.map((s) => s.candidates)).toEqual([3, 6, 6, 6]);
    expect(report.summary.every((s) => s.modelApiCalls === 0)).toBe(true);
    const md = renderV2(report);
    for (const row of report.rows) expect(md).toContain(`### ${row.caseId} · ${row.plannerId}`);
  });
  it("independently checks E13 retention and E14 direct-route stopping", async () => {
    const report = await runV2({ git, caseIds: ["E13", "E14"] });
    const find = (caseId: string, plannerId: string) => report.rows.find((r) => r.caseId === caseId && r.plannerId === plannerId)!;
    expect(find("E13", "fixed_workflow").trace).toHaveLength(3);
    expect(find("E13", "adaptive_workflow").trace.map((t) => [t.fromPlaceId, t.toPlaceId])).toEqual([
      ["P-B", "P-C"], ["P-C", "P-D"],
    ]);
    expect(find("E14", "adaptive_workflow").trace.map((t) => [t.fromPlaceId, t.toPlaceId])).toEqual([["P-B", "P-D"]]);
    expect(find("E13", "model_agent").score?.revalidation?.checkedTransitions.at(-1)?.earliestArrivalAt).toBe("2026-10-15T17:20:00+08:00");
    expect(find("E14", "model_agent").score?.revalidation?.checkedTransitions.at(-1)?.earliestArrivalAt).toBe("2026-10-15T18:00:00+08:00");
  });
  it("early omit remains safe but fails quality; model calls need not equal fixed calls", async () => {
    let call = 0;
    const modelFactory = (): DecisionModel => ({
      ...createScriptedModel(),
      async decide() {
        return { usage: null, decision: call++ === 0
          ? { action: "lookup_route", fromPlaceId: "P-B", toPlaceId: "P-D" }
          : { action: "finish", reasonCode: "sufficient_information" } };
      },
    });
    const report = await runV2({ git, caseIds: ["E13"], plannerIds: ["model_agent"], modelFactory });
    const row = report.rows[0];
    expect(row.score).toMatchObject({ quality: false, safety: true, execution: true, passed: false });
    expect(row.trace).toHaveLength(1);
  });
  it("model exceptions stay failed even when the business needs-information status is expected", async () => {
    const report = await runV2({
      git, caseIds: ["E06"], plannerIds: ["model_agent"],
      modelFactory: () => ({ ...createScriptedModel(), async decide() { throw new Error("synthetic"); } }),
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].score).toMatchObject({ quality: true, safety: true, execution: false, passed: false });
  });
  it("factory failures retain rows and never masquerade as zero-case success", async () => {
    const report = await runV2({
      git, caseIds: ["E05", "E06"], plannerIds: ["model_agent"],
      modelFactory: () => { throw new Error("synthetic factory failure"); },
    });
    expect(report.rows).toHaveLength(2);
    expect(report.summary[0].passed).toBe(0);
    expect(report.rows.every((r) => r.exception === "execution_error")).toBe(true);
  });
  it("repeat scripted runs are identical apart from explicit timing fields", async () => {
    const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
      ["runId", "startedAt", "elapsedMs"].includes(key) ? undefined : item,
    ));
    expect(stable(await runV2({ git }))).toEqual(stable(await runV2({ git })));
  });
  it("requires an explicit fixed smoke selection; cannot accidentally run all live cases", () => {
    expect(parseAgentOptions([])).toEqual({ mode: "scripted" });
    expect(parseAgentOptions([
      "--", "--mode", "live", "--smoke", "developer", "--profile", "deepseek-flash",
    ])).toMatchObject({ mode: "live", smoke: "developer" });
    for (const args of [
      ["--mode", "live"], ["--mode", "live", "--smoke", "developer", "--case", "E13"],
      ["--case", "E01,E01"], ["--profile", "deepseek-flash"], ["--mode", "other"],
      ["--mode", "scripted", "--mode", "live"], ["--unknown", "x"],
    ]) expect(() => parseAgentOptions(args)).toThrow();
  });
  it("rejects missing v2 answers and malformed tool data before running", () => {
    const missing = structuredClone(datasetV2.cases);
    Reflect.deleteProperty(missing[0].expected, "model_agent");
    expect(() => validateV2Cases(missing)).toThrow("Missing business oracle");
    const malformed = structuredClone(datasetV2.cases);
    const result = malformed[12].world[0].result;
    if (result.status === "ok") Reflect.set(result.routes[0], "durationSeconds", -1);
    expect(() => validateV2Cases(malformed)).toThrow("Invalid synthetic route");
  });
  it("reserves rounds and all 48 request attempts durably with no automatic repeat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tq-s42-budget-"));
    try {
      for (const round of ["developer", "test-1", "test-2"]) {
        const budget = liveBudget(directory, round);
        await budget.reserveRound();
        await expect(budget.reserveRound()).rejects.toThrow();
        for (let i = 0; i < 16; i++) await budget.beforeRequest();
        await expect(budget.beforeRequest()).rejects.toThrow();
      }
      const entries = (await readFile(join(directory, "s42-live-budget.jsonl"), "utf8")).trim().split("\n");
      expect(entries).toHaveLength(51);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
