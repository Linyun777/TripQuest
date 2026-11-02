import { describe, expect, it } from "vitest";

import { dataset, FIXTURE_EVIDENCE, syntheticRoute } from "../cases/dataset";
import type { PlannerContext, PlannerOutput, ToolCall } from "../contracts";
import { planners } from "../planners";
import { runEvaluation } from "../runner";
import { createRouteTool, edgeKey } from "../route-tool";
import { auditFacts, scoreOutput } from "../scoring";

// Expectations are hand derived from the S4.1 design. The developer already has a
// single "intentionally-wrong" planner; the design asks the scorer to catch seven
// distinct classes of wrongness *separately*, and to never turn a crash or a
// skipped case into a pass. This file drives scoreOutput/auditFacts directly so
// each class can be asserted in isolation.
const EVIDENCE = FIXTURE_EVIDENCE;

const report = await runEvaluation(dataset, planners, { git: { sha: "independent-test", dirty: false } });

function rowFor(caseId: string, plannerId: "rules_only" | "fixed_workflow") {
  const row = report.rows.find((r) => r.caseId === caseId && r.plannerId === plannerId);
  if (!row) throw new Error(`missing row ${caseId}/${plannerId}`);
  return row;
}

function correctOutput(caseId: string, plannerId: "rules_only" | "fixed_workflow" = "rules_only"): PlannerOutput {
  const row = rowFor(caseId, plannerId);
  const last = row.planningCalls.at(-1);
  if (!last) throw new Error(`row ${caseId}/${plannerId} made no planning call`);
  return { result: last.result, travelLegs: row.travelLegs };
}

const cases = Object.fromEntries(dataset.cases.map((c) => [c.id, c]));

function failuresFor(caseId: string, output: PlannerOutput, trace: readonly ToolCall[] = [], calls?: number) {
  const c = cases[caseId];
  if (!c) throw new Error(`unknown case ${caseId}`);
  const expectedCalls = calls ?? c.expected.rules_only.calls;
  const planningCalls = [{ toolCallsAtPlanning: trace.length, input: c.input, result: output.result }];
  void expectedCalls;
  return scoreOutput(c, "rules_only", output, planningCalls, trace).failures;
}

describe("S4.1 scorer catches each class of deliberately wrong planner", () => {
  it("starts from a baseline that the scorer accepts", () => {
    const c = cases["E02"];
    expect(c, "E02 exists in the dataset").toBeDefined();
    const clean = scoreOutput(c!, "rules_only", correctOutput("E02"), [{ toolCallsAtPlanning: 0, input: c!.input, result: correctOutput("E02").result }], []);
    expect(clean.failures, "the unmodified output scores clean").toEqual([]);
    expect(clean.passed).toBe(true);
  });

  it("catches a moved locked reservation", () => {
    const output = correctOutput("E02");
    const moved = output.result.selected!.candidate.activities.map((a) =>
      a.reservationId ? { ...a, startsAt: "2026-10-15T18:30:00+08:00" as never } : a,
    );
    const tampered: PlannerOutput = { ...output, result: { ...output.result, selected: { ...output.result.selected!, candidate: { ...output.result.selected!.candidate, activities: moved } } } as never };
    expect(failuresFor("E02", tampered).join(" | "), "a moved reservation is not silently accepted").toMatch(/protected activity changed|revalidation|schedule differs/);
  });

  it("catches a changed completed activity", () => {
    const output = correctOutput("E02");
    const c = cases["E02"]!;
    const done = c.input.state.completedActivityIds[0];
    const tampered = output.result.selected!.candidate.activities.map((a) =>
      a.id === done ? { ...a, startsAt: "2026-10-15T08:00:00+08:00" as never } : a,
    );
    const wrong: PlannerOutput = { ...output, result: { ...output.result, selected: { ...output.result.selected!, candidate: { ...output.result.selected!.candidate, activities: tampered } } } as never };
    expect(failuresFor("E02", wrong).join(" | "), "a changed completed activity is caught").toMatch(/protected activity changed|schedule differs/);
  });

  it("catches unknown travel filled in with an unsupported zero or guessed minute value", () => {
    const c = cases["E05"]!;
    expect(c.input.travelLegs, "E05 starts with no C->D leg at all").toEqual([]);

    // Claimed as known without any successful tool call to back it.
    const invented = [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 0 } }];
    expect(auditFacts(c.input, invented, []), "a fabricated known value is unsupported").toContain(`unsupported route ${edgeKey("P-C", "P-D")}`);

    // A tool call that returned a different minute value does not justify it either.
    const wrongProof: ToolCall[] = [{
      sequence: 1, fromPlaceId: "P-C", toPlaceId: "P-D",
      result: syntheticRoute(2401),
    }];
    expect(auditFacts(c.input, invented, wrongProof).length, "0 minutes is not what 2401s rounds to").toBeGreaterThan(0);

    // The exact ceiling value is accepted.
    const exact = [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 41 } }];
    expect(auditFacts(c.input, exact, wrongProof), "2401s rounds up to exactly 41").toEqual([]);
  });

  it("catches a fabricated feasible verdict by re-validating independently", () => {
    const output = correctOutput("E02");
    // Squeeze the adjustable activity so the planner's own claim cannot hold.
    const squeezed = output.result.selected!.candidate.activities.map((a) =>
      a.locked || a.reservationId ? a : { ...a, endsAt: "2026-10-15T18:30:00+08:00" as never },
    );
    const lying: PlannerOutput = { ...output, result: { ...output.result, selected: { ...output.result.selected!, candidate: { ...output.result.selected!.candidate, activities: squeezed } } } as never };
    const c = cases["E02"]!;
    const score = scoreOutput(c, "rules_only", lying, [{ toolCallsAtPlanning: 0, input: c.input, result: lying.result }], []);
    expect(score.passed, "a non-feasible selection cannot pass").toBe(false);
    expect(score.revalidation, "revalidation is recorded").not.toBeNull();
    expect(score.selectedNonFeasible || score.failures.length > 0, "either flagged non-feasible or otherwise failed").toBe(true);
  });

  it("catches the right status carrying the wrong schedule", () => {
    const output = correctOutput("E02");
    const activities = [...output.result.selected!.candidate.activities];
    const swappable = activities.filter((a) => !a.locked && !a.reservationId);
    expect(swappable.length, "E02 has an adjustable activity").toBeGreaterThan(0);
    const wrong = activities.map((a) => (a.id === swappable[0]!.id ? { ...a, startsAt: "2026-10-15T16:00:00+08:00" as never } : a));
    const tampered: PlannerOutput = { ...output, result: { ...output.result, selected: { ...output.result.selected!, candidate: { ...output.result.selected!.candidate, activities: wrong } } } as never };
    expect(failuresFor("E02", tampered).join(" | "), "a wrong schedule is caught even with the right status").toMatch(/schedule differs|revalidation|arrival/);
  });

  it("catches a non-candidate result that still carries a selection", () => {
    const base = correctOutput("E08");
    expect(base.result.status, "E08 expects a non-candidate outcome").not.toBe("candidate_found");
    const smuggled = { ...base, result: { ...base.result, selected: { strategy: "keep", candidate: {}, validation: {} } } } as unknown as PlannerOutput;
    expect(failuresFor("E08", smuggled).join(" | "), "a selection on a non-candidate result is rejected").toContain("non-candidate result contains selection");
  });

  it("catches an over-budget tool trace", () => {
    const c = cases["E05"]!;
    const output = correctOutput("E05");
    const overBudget: ToolCall[] = [1, 2, 3, 4].map((n) => ({
      sequence: n, fromPlaceId: "P-A", toPlaceId: "P-B",
      result: n === 4 ? { status: "budget_exhausted" } : { status: "no_route", reason: "no_path", evidence: EVIDENCE },
    }));
    const score = scoreOutput(c, "fixed_workflow", output, [{ toolCallsAtPlanning: 0, input: c.input, result: output.result }], overBudget);
    expect(score.passed).toBe(false);
    expect(score.failures.join(" | "), "budget exhaustion is a failure, not a shrug").toMatch(/tool budget exceeded|unexpected tool call count/);
  });
});

describe("S4.1 fact audit", () => {
  const e02 = cases["E02"]!;
  const known = e02.input.travelLegs[0]!;
  const key = edgeKey(known.fromPlaceId, known.toPlaceId);

  it("rejects duplicated, removed and overwritten facts", () => {
    expect(auditFacts(e02.input, [...e02.input.travelLegs, known], []), "the same directed edge twice").toContain(`duplicate edge ${key}`);
    expect(auditFacts(e02.input, [], []), "an original fact may not be dropped").toContain("removed original fact");
    const overwritten = [{ ...known, duration: { kind: "known" as const, minutes: 999 } }];
    expect(auditFacts(e02.input, overwritten, []), "a known value may not be overwritten").toContain(`overwritten known ${key}`);
  });

  it("accepts an unchanged list and a single tool-backed replacement", () => {
    const e05 = cases["E05"]!;
    expect(auditFacts(e05.input, e05.input.travelLegs, []), "no change, no complaint").toEqual([]);
    const proof: ToolCall[] = [{
      sequence: 1, fromPlaceId: "P-C", toPlaceId: "P-D",
      result: syntheticRoute(2400),
    }];
    const replaced = [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 40 } }];
    expect(auditFacts(e05.input, replaced, proof), "2400s rounds to exactly 40").toEqual([]);
  });

  it("does not let a reverse-direction fact stand in for the missing direction", () => {
    const e07 = cases["E07"]!;
    const reverseOnly = e07.input.travelLegs;
    expect(reverseOnly, "E07 knows only D->C").toEqual([{ fromPlaceId: "P-D", toPlaceId: "P-C", duration: { kind: "known", minutes: 40 } }]);
    const borrowed = [...reverseOnly, { fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 40 } }];
    expect(auditFacts(e07.input, borrowed, []), "the forward direction needs its own proof").toContain(`unsupported route ${edgeKey("P-C", "P-D")}`);
  });
});

describe("S4.1 tool gateway", () => {
  const world = [
    { fromPlaceId: "P-A", toPlaceId: "P-B", result: syntheticRoute(600) },
  ];

  it("allows exactly the budget, then refuses locally without consulting the world", async () => {
    const tool = createRouteTool(world, EVIDENCE);
    for (let n = 1; n <= 3; n += 1) {
      const reply = await tool.lookupRoute("P-A", "P-B");
      expect(reply.status, `call ${n} within budget`).toBe("ok");
    }
    const refused = await tool.lookupRoute("P-A", "P-B");
    expect(refused.status, "the fourth call is refused").toBe("budget_exhausted");
    expect(tool.snapshot(), "refusals are still counted in the trace").toHaveLength(4);
    tool.close();
  });

  it("never lets a reverse direction reuse a forward answer", async () => {
    const tool = createRouteTool(world, EVIDENCE);
    const forward = await tool.lookupRoute("P-A", "P-B");
    expect(forward.status).toBe("ok");
    const reverse = await tool.lookupRoute("P-B", "P-A");
    expect(reverse.status, "the reverse direction is genuinely absent").toBe("no_route");
    tool.close();
  });

  it("counts invalid arguments and failed lookups against the budget", async () => {
    const tool = createRouteTool(world, EVIDENCE);
    const bad = await tool.lookupRoute("", "P-B");
    expect(bad.status).toBe("failure");
    const missing = await tool.lookupRoute("P-X", "P-Y");
    expect(missing.status).toBe("no_route");
    await tool.lookupRoute("P-A", "P-B");
    const refused = await tool.lookupRoute("P-A", "P-B");
    expect(refused.status, "failures consume the budget too").toBe("budget_exhausted");
    tool.close();
  });

  it("refuses to serve a closed instance", async () => {
    const tool = createRouteTool(world, EVIDENCE);
    tool.close();
    await expect(tool.lookupRoute("P-A", "P-B")).rejects.toThrow();
  });
});

describe("S4.1 planner context carries no answers", () => {
  it("exposes exactly input, lookupRoute, budget and plan", () => {
    // Compile-time guard: adding an answer-bearing field to PlannerContext breaks this.
    type Keys = keyof PlannerContext;
    const exact: [Keys] extends ["input" | "lookupRoute" | "budget" | "plan"] ? (["input" | "lookupRoute" | "budget" | "plan"] extends [Keys] ? true : false) : false = true;
    expect(exact, "PlannerContext gained or lost a field; re-check that no answer leaks in").toBe(true);
  });

  it("keeps the tool world out of the planner input", () => {
    const c = cases["E05"]!;
    const serialized = JSON.stringify(c.input);
    for (const entry of c.world) {
      expect(serialized, "the input must not embed world answers").not.toContain(String(entry.result.status === "ok" ? entry.result.routes[0]?.durationSeconds : "unused"));
    }
    expect(Object.keys(c).sort(), "a case keeps answers separate from input").toEqual(["expected", "id", "input", "source", "title", "world"]);
  });
});
