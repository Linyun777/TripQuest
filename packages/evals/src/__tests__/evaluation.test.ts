import { describe, expect, it } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import type { BaselinePlanningInput, BaselinePlanningResult } from "@tripquest/domain";
import { dataset, at, baseInput, FIXTURE_EVIDENCE, syntheticRoute } from "../cases/dataset";
import type { Dataset, Planner, PlannerOutput, RouteWorldEntry } from "../contracts";
import { runEvaluation } from "../runner";
import { planners, fixedWorkflow, missingRouteEdges } from "../planners";
import { createRouteTool } from "../route-tool";
import { canonical, datasetHash, validateDataset } from "../dataset-validation";
import { parseOptions } from "../cli-options";
import { renderMarkdown } from "../report";
const git = { sha: "test", dirty: false };
const evaluate = (planner: Planner, caseIds = ["E02"]) => runEvaluation(dataset, [planner], { git, caseIds });
const bad = (run: Planner["run"]): Planner => ({ id: "fixed_workflow", version: "intentionally-wrong", run });
function changeCandidate(result: BaselinePlanningResult, id: string, start: string): BaselinePlanningResult {
  if (result.status !== "candidate_found") throw new Error("Test needs candidate");
  return { ...result, selected: { ...result.selected, candidate: { ...result.selected.candidate, activities: result.selected.candidate.activities.map((a) => a.id === id ? { ...a, startsAt: at(start) } : a) } } };
}
async function workflow(input: BaselinePlanningInput, world: readonly RouteWorldEntry[]) {
  const tool = createRouteTool(world, FIXTURE_EVIDENCE);
  const calls: BaselinePlanningInput[] = [];
  const output = await fixedWorkflow.run({ input: structuredClone(input), lookupRoute: tool.lookupRoute, budget: 3, plan(i) { calls.push(structuredClone(i)); return generateBaselineCandidate(i); } });
  return { output, trace: tool.snapshot(), calls };
}
const world = (from: string, to: string, seconds = 600): RouteWorldEntry => ({ fromPlaceId: from, toPlaceId: to, result: syntheticRoute(seconds) });

describe("hand-authored regression set and reports", () => {
  it("retains all 24 results, exact one-minute boundary, and separate honest metrics", async () => {
    const report = await runEvaluation(dataset, planners, { git });
    expect(report.rows).toHaveLength(24);
    expect(report.rows.filter((r) => !r.score.passed)).toEqual([]);
    expect(report.summary.map((s) => [s.passed, s.total, s.candidates, s.toolCalls, s.toolFailures])).toEqual([[12, 12, 3, 0, 0], [12, 12, 4, 3, 2]]);
    expect(report.rows.filter((r) => r.caseId === "E03").every((r) => r.score.revalidation?.checkedTransitions.at(-1)?.earliestArrivalAt === at("18:00"))).toBe(true);
    expect(report.rows.filter((r) => r.caseId === "E04").every((r) => r.finalStatus === "no_feasible_candidate")).toBe(true);
    const md = renderMarkdown(report);
    for (const r of report.rows) expect(md).toContain(`### ${r.caseId} · ${r.plannerId}`);
    expect(JSON.parse(JSON.stringify(report)).rows).toHaveLength(24);
  });
  it("repeat runs have identical business results and never mutate source", async () => {
    const before = canonical(dataset);
    const first = await runEvaluation(dataset, planners, { git });
    const second = await runEvaluation(dataset, planners, { git });
    const stable = (r: typeof first) => JSON.parse(JSON.stringify(r, (key, value) => ["runId", "startedAt", "elapsedMs"].includes(key) ? undefined : value));
    expect(stable(first)).toEqual(stable(second));
    expect(canonical(dataset)).toBe(before);
    expect(first.runId).not.toBe(second.runId);
  });
  it("hash covers input, world and human expected", () => {
    for (const update of [
      (d: Dataset) => ({ ...d, cases: d.cases.map((c, i) => i ? c : { ...c, input: { ...c.input, transferBufferMinutes: 11 } }) }),
      (d: Dataset) => ({ ...d, cases: d.cases.map((c, i) => i !== 4 ? c : { ...c, world: [world("P-C", "P-D", 2401)] }) }),
      (d: Dataset) => ({ ...d, cases: d.cases.map((c, i) => i ? c : { ...c, expected: { ...c.expected, rules_only: { ...c.expected.rules_only, reasoning: "changed" } } }) }),
    ]) expect(datasetHash(update(dataset))).not.toBe(datasetHash(dataset));
  });
  it("rejects duplicate cases, missing oracle and malformed world", () => {
    expect(() => validateDataset({ ...dataset, cases: [dataset.cases[0], ...dataset.cases.slice(0, 11)] })).toThrow();
    const noExpected = structuredClone(dataset);
    Reflect.deleteProperty(noExpected.cases[0].expected, "rules_only");
    expect(() => validateDataset(noExpected)).toThrow();
    for (const seconds of [-1, NaN, Infinity, 2.2]) {
      const malformed = { ...dataset, cases: dataset.cases.map((c, i) => i !== 4 ? c : { ...c, world: [world("P-C", "P-D", seconds)] }) };
      expect(() => validateDataset(malformed)).toThrow();
    }
  });
  it("CLI rejects unknown flags/IDs/duplicate selections", () => {
    expect(parseOptions(["--", "--case", "E05", "--planner", "fixed_workflow"])).toEqual({ caseIds: ["E05"], plannerIds: ["fixed_workflow"] });
    for (const args of [["--key", "secret"], ["--case", "E99"], ["--case", "E01,E01"], ["--planner", "agent"], ["--case"], ["--case", "E01", "--case", "E02"]]) expect(() => parseOptions(args)).toThrow();
  });
});

describe("tool boundary and conservative workflow", () => {
  it("counts failures, repeats, malformed calls; blocks fourth; copies data and isolates instances", async () => {
    const entries = [world("P-C", "P-D")];
    const tool = createRouteTool(entries, FIXTURE_EVIDENCE);
    const result = await tool.lookupRoute("P-C", "P-D");
    if (result.status === "ok") Reflect.set(result.routes[0], "durationSeconds", 0);
    expect(await tool.lookupRoute("P-C", "P-D")).toEqual(syntheticRoute(600));
    expect((await tool.lookupRoute("", "P-D")).status).toBe("failure");
    expect(await tool.lookupRoute("P-C", "P-D")).toEqual({ status: "budget_exhausted" });
    expect(tool.snapshot()).toHaveLength(4);
    expect((await createRouteTool(entries, FIXTURE_EVIDENCE).lookupRoute("P-D", "P-C")).status).toBe("no_route");
    tool.close();
    await expect(tool.lookupRoute("P-C", "P-D")).rejects.toThrow("closed");
  });
  it("rounds 2401 seconds up to 41 and replaces unknown only once", async () => {
    const input = { ...baseInput(), travelLegs: [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "unknown" as const } }] };
    const { output, calls } = await workflow(input, [world("P-C", "P-D", 2401)]);
    expect(output.travelLegs).toEqual([{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known", minutes: 41 } }]);
    expect(calls).toHaveLength(2);
    expect(input.travelLegs[0].duration.kind).toBe("unknown");
  });
  it("uses stable three-edge order, deduplicates, and never overwrites known", async () => {
    const base = baseInput();
    const input = { ...base, state: { ...base.state, location: { kind: "known" as const, placeId: "P-X" } }, travelLegs: [] };
    const edges = [["P-X", "P-C"], ["P-C", "P-D"], ["P-X", "P-D"]];
    expect(missingRouteEdges(input)).toEqual(edges);
    const run = await workflow(input, edges.map(([from, to]) => world(from, to)));
    expect(run.trace.map((t) => [t.fromPlaceId, t.toPlaceId])).toEqual(edges);
    const known = { fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 80 } };
    const runKnown = await workflow({ ...input, travelLegs: [known] }, edges.map(([from, to]) => world(from, to)));
    expect(runKnown.output.travelLegs).toContainEqual(known);
    expect(runKnown.trace.map((t) => [t.fromPlaceId, t.toPlaceId])).toEqual([edges[0], edges[2]]);
    expect(missingRouteEdges({ ...base, travelLegs: [] })).toEqual([["P-C", "P-D"]]);
  });
  it.each(["authorization_failed", "quota_exceeded", "timeout"] as const)("handles %s without retry", async (code) => {
    const base = baseInput();
    const input = { ...base, state: { ...base.state, location: { kind: "known" as const, placeId: "P-X" } }, travelLegs: [] };
    const run = await workflow(input, [{ fromPlaceId: "P-X", toPlaceId: "P-C", result: { status: "failure", failure: { code, retry: "never", safeMessage: "synthetic" }, evidence: FIXTURE_EVIDENCE } }, world("P-C", "P-D"), world("P-X", "P-D")]);
    expect(run.trace).toHaveLength(code === "timeout" ? 3 : 1);
    expect(run.output.travelLegs.some((l) => l.fromPlaceId === "P-X" && l.toPlaceId === "P-C")).toBe(false);
  });
  it("does not query to guess current activity or unreported past progress", async () => {
    const base = baseInput();
    for (const state of [{ ...base.state, currentActivityId: "C" }, { ...base.state, completedActivityIds: ["A"] }]) {
      const run = await workflow({ ...base, state, travelLegs: [] }, [world("P-C", "P-D")]);
      expect(run.trace).toHaveLength(0);
      expect(run.calls).toHaveLength(1);
    }
  });
});

describe("independent scorer rejects intentionally wrong planners", () => {
  it.each(["D", "A", "C"])("rejects changed activity %s even with correct status and claimed feasible", async (id) => {
    const report = await evaluate(bad(async ({ input, plan }) => ({ result: changeCandidate(plan(input), id, id === "D" ? "18:30" : "10:30"), travelLegs: input.travelLegs })));
    expect(report.rows[0].score.passed).toBe(false);
    expect(report.rows[0].score.failures).toContain("schedule differs from handwritten oracle");
    if (id !== "C") expect(report.rows[0].score.failures).toContain(`protected activity changed: ${id}`);
  });
  it("rejects unknown-to-zero even when claimed candidate is feasible", async () => {
    const report = await evaluate(bad(async ({ input, plan }) => {
      plan(input);
      const travelLegs = [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 0 } }];
      return { result: plan({ ...input, travelLegs }), travelLegs };
    }), ["E06"]);
    expect(report.rows[0].score.unsupportedFactChanges).toBeGreaterThan(0);
    expect(report.rows[0].score.passed).toBe(false);
  });
  it("revalidates a fake feasible selection against actual unknown facts", async () => {
    const report = await evaluate(bad(async ({ input, plan }) => {
      plan(input);
      const fabricated = generateBaselineCandidate(baseInput());
      return { result: fabricated, travelLegs: input.travelLegs };
    }), ["E06"]);
    expect(report.rows[0].score.selectedNonFeasible).toBe(true);
    expect(report.rows[0].score.revalidation?.verdict).toBe("insufficient_information");
  });
  it("preserves all exception rows and counts failures", async () => {
    const report = await runEvaluation(dataset, [bad(async () => { throw new Error("deliberate"); })], { git });
    expect(report.rows).toHaveLength(12);
    expect(report.summary[0].passed).toBe(0);
    expect(report.summary[0].statuses.exception).toBe(12);
  });
  it("catches malformed output without dropping a row", async () => {
    const report = await evaluate(bad(async () => ({} as PlannerOutput)));
    expect(report.rows[0].exception).toBe("scoring_error");
    expect(report.rows[0].score.passed).toBe(false);
  });
  it("rejects overbudget and records local rejection", async () => {
    const report = await evaluate(bad(async ({ input, lookupRoute, plan }) => {
      for (let i = 0; i < 4; i++) await lookupRoute("P-C", "P-D");
      return { result: plan(input), travelLegs: input.travelLegs };
    }));
    expect(report.rows[0].score.failures).toContain("tool budget exceeded");
    expect(report.summary[0].toolCalls).toBe(3);
    expect(report.summary[0].budgetRejections).toBe(1);
  });
  it("does not give strategy hidden answers or world; forged facts are caught", async () => {
    const report = await evaluate(bad(async (context) => {
      expect(Object.keys(context).sort()).toEqual(["budget", "input", "lookupRoute", "plan"]);
      const input = { ...context.input, transferBufferMinutes: 0 };
      return { result: context.plan(input), travelLegs: input.travelLegs };
    }));
    expect(report.rows[0].score.unsupportedFactChanges).toBeGreaterThan(0);
  });
});
