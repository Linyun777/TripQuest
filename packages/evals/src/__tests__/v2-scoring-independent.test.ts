import { beforeAll, describe, expect, it } from "vitest";
import type { BaselinePlanningInput } from "@tripquest/domain";
import type { AgentResult } from "@tripquest/agent";
import type { PlanningCall, ToolCall } from "../contracts";
import { runV2 } from "../v2/runner";
import { scoreV2 } from "../v2/scoring";
import { datasetV2 } from "../v2/dataset";
import type { V2Case, V2PlannerId } from "../v2/dataset";

/**
 * Adversarial scorer checks: each deliberately wrong strategy output must be
 * caught on the axis the design assigns to it. The control rows come from the
 * real runner; every other case is a single hand-injected defect, so a failure
 * here names the specific check that stopped working.
 */

const git = { sha: "independent-scoring", dirty: true };

interface Baseline {
  readonly scenario: V2Case;
  readonly plannerId: V2PlannerId;
  readonly output: AgentResult;
  readonly calls: readonly PlanningCall[];
  readonly trace: readonly ToolCall[];
}

let base: Baseline;
let zeroTool: Baseline;
let needsInformation: Baseline;

function scenarioOf(id: string): V2Case {
  const found = datasetV2.cases.find((c) => c.id === id);
  if (!found) throw new Error(`missing case ${id}`);
  return found;
}

function baselineOf(id: string, plannerId: V2PlannerId, row: {
  output: AgentResult | null;
  planningCalls: readonly PlanningCall[];
  trace: readonly ToolCall[];
}): Baseline {
  if (!row.output) throw new Error(`no output for ${id}/${plannerId}`);
  return { scenario: scenarioOf(id), plannerId, output: row.output, calls: row.planningCalls, trace: row.trace };
}

beforeAll(async () => {
  const [agent, ruleBased, needsInfo] = await Promise.all([
    runV2({ git, caseIds: ["E13"], plannerIds: ["adaptive_workflow"] }),
    runV2({ git, caseIds: ["E01"], plannerIds: ["rules_only"] }),
    runV2({ git, caseIds: ["E05"], plannerIds: ["rules_only"] }),
  ]);
  base = baselineOf("E13", "adaptive_workflow", agent.rows[0]);
  zeroTool = baselineOf("E01", "rules_only", ruleBased.rows[0]);
  needsInformation = baselineOf("E05", "rules_only", needsInfo.rows[0]);
});

type Mutation = {
  readonly output?: Partial<AgentResult>;
  readonly calls?: readonly PlanningCall[];
  readonly trace?: readonly ToolCall[];
};

function judge(target: Baseline, mutation: Mutation = {}) {
  return scoreV2(
    target.scenario,
    target.plannerId,
    { ...target.output, ...mutation.output },
    mutation.calls ?? target.calls,
    mutation.trace ?? target.trace,
  );
}

const cloneCalls = (source: readonly PlanningCall[]): PlanningCall[] =>
  structuredClone(source) as PlanningCall[];

const evidenceOf = (target: Baseline) => {
  const result = target.trace[0]?.result;
  if (!result || result.status === "budget_exhausted") throw new Error("expected a fixture reply");
  return result.evidence;
};

/** Failure lists carry detail after the code, e.g. `unsupported route ["P-B","P-D"]`. */
const mentions = (failures: readonly string[], needle: string) =>
  failures.some((entry) => entry.includes(needle));

const patchInput = (
  source: readonly PlanningCall[],
  index: number,
  patch: (input: BaselinePlanningInput) => void,
): PlanningCall[] => {
  const copy = cloneCalls(source);
  patch(copy[index].input);
  return copy;
};

describe("scorer catches deliberately wrong strategy output", () => {
  it("control: the untouched rows pass on all three axes", () => {
    const control = judge(base);
    expect(control).toMatchObject({ passed: true, quality: true, safety: true, execution: true });
    expect(control.qualityFailures).toEqual([]);
    expect(control.safetyFailures).toEqual([]);
    expect(control.executionFailures).toEqual([]);
    expect(control.revalidation?.verdict).toBe("feasible");
    expect(judge(zeroTool)).toMatchObject({ passed: true, safety: true, execution: true });
  });

  it("flags every protected-fact and provenance violation", () => {
    const bufferChanged = patchInput(base.calls, 1, (input) => {
      Reflect.set(input, "transferBufferMinutes", 30);
    });
    expect(judge(base, { calls: bufferChanged }).safetyFailures, "later plan input changed")
      .toContain("protected_input_changed");

    const requestChanged = patchInput(base.calls, 0, (input) => {
      Reflect.set(input.request, "id", "tampered");
    });
    const first = judge(base, { calls: requestChanged });
    expect(first.safetyFailures, "initial input replaced").toContain("initial_input_changed");
    expect(first.safetyFailures, "protected facts").toContain("protected_input_changed");

    expect(judge(base, { output: { travelLegs: [] } }).safetyFailures, "reported facts")
      .toContain("reported_facts_changed");

    const fabricated = [
      ...base.output.travelLegs,
      { fromPlaceId: "P-B", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 5 } },
    ];
    const fabricatedScore = judge(base, { output: { travelLegs: fabricated } });
    expect(mentions(fabricatedScore.safetyFailures, "unsupported route"), "unsupported fact").toBe(true);
    expect(fabricatedScore.safetyFailures, "reported facts").toContain("reported_facts_changed");
  });

  it("flags a result that no longer comes from the last planning call", () => {
    const swapped = structuredClone(base.output);
    Reflect.set(swapped.result, "status", "needs_information");
    const score = judge(base, { output: swapped });
    expect(score.safetyFailures).toContain("result_not_from_last_plan");
    expect(score.qualityFailures).toContain("unexpected_business_status");
  });

  it("flags a candidate that was swapped after the last planning call", () => {
    const swapped = structuredClone(base.output);
    if (swapped.result.status !== "candidate_found") throw new Error("expected a candidate");
    Reflect.set(
      swapped.result.selected.candidate,
      "activities",
      swapped.result.selected.candidate.activities.filter((a) => a.id !== "C"),
    );
    const score = judge(base, { output: swapped });
    expect(score.safetyFailures).toContain("candidate_not_from_last_plan");
    expect(score.qualityFailures).toContain("wrong_schedule");
  });

  it("flags a selected candidate the validator cannot confirm, and a moved protected activity", () => {
    const noEvidence = judge(base, { output: { travelLegs: [] } });
    expect(noEvidence.safetyFailures).toContain("selected_non_feasible");

    const moved = structuredClone(base.output);
    if (moved.result.status !== "candidate_found") throw new Error("expected a candidate");
    Reflect.set(
      moved.result.selected.candidate,
      "activities",
      moved.result.selected.candidate.activities.map((a) =>
        a.id === "D"
          ? { ...a, startsAt: "2026-10-15T19:00:00+08:00", endsAt: "2026-10-15T20:00:00+08:00" }
          : a),
    );
    const score = judge(base, { output: moved });
    expect(score.safetyFailures, "protected reservation activity").toContain("protected_D");
    expect(score.qualityFailures, "schedule").toContain("wrong_schedule");
  });

  it("flags a quality miss even when safety and execution stay clean", () => {
    const demoted = structuredClone(base.output);
    if (demoted.result.status !== "candidate_found") throw new Error("expected a candidate");
    Reflect.set(demoted.result.selected, "strategy", "omit");
    const score = judge(base, { output: demoted });
    expect(score).toMatchObject({ passed: false, safety: true, execution: true, quality: false });
    expect(score.qualityFailures).toContain("retention_target_not_met");
  });

  it("flags arrival arithmetic that disagrees with the hand-written oracle", () => {
    const shifted = structuredClone(base.output);
    if (shifted.result.status !== "candidate_found") throw new Error("expected a candidate");
    Reflect.set(
      shifted.result.selected.candidate,
      "activities",
      shifted.result.selected.candidate.activities.map((a) =>
        a.id === "C" ? { ...a, endsAt: "2026-10-15T16:55:00+08:00" } : a),
    );
    const score = judge(base, { output: shifted });
    expect(score.qualityFailures).toContain("wrong_arrival_arithmetic");
    expect(score.safetyFailures).toContain("candidate_not_from_last_plan");
  });

  it("flags illegal, repeated and over-budget tool traffic", () => {
    const evidence = evidenceOf(base);
    const illegal: readonly ToolCall[] = [
      ...base.trace,
      {
        sequence: base.trace.length + 1,
        fromPlaceId: "P-D",
        toPlaceId: "P-C",
        result: { status: "no_route", reason: "no_path", evidence },
      },
    ];
    const illegalScore = judge(base, { trace: illegal });
    expect(illegalScore.executionFailures, "illegal direction").toContain("illegal_or_repeated_route");
    expect(illegalScore.executionFailures, "tool count").toContain("route_count_mismatch");

    const repeated: readonly ToolCall[] = [
      ...base.trace,
      { ...base.trace[0], sequence: base.trace.length + 1 },
    ];
    expect(judge(base, { trace: repeated }).executionFailures, "repeat").toContain("illegal_or_repeated_route");

    const overBudget: readonly ToolCall[] = [
      ...repeated,
      { ...base.trace[0], sequence: base.trace.length + 2 },
    ];
    expect(judge(base, { trace: overBudget }).executionFailures, "route budget").toContain("route_budget");
  });

  it("flags inconsistent counters and a missing budget header", () => {
    expect(judge(base, { output: { routeRequests: 99 } }).executionFailures).toContain("route_count_mismatch");
    expect(judge(base, { output: { modelRequests: 99 } }).executionFailures).toContain("decision_count_mismatch");
    expect(judge(base, { output: { modelRequests: 5 } }).executionFailures).toContain("model_budget");
    expect(judge(base, { output: { rejectedActions: 1 } }).executionFailures).toContain("rejected_actions");

    const last = base.calls.at(-1);
    if (!last) throw new Error("expected planning calls");
    const extraPlan: readonly PlanningCall[] = [...cloneCalls(base.calls), structuredClone(last)];
    expect(judge(base, { calls: extraPlan }).executionFailures, "plan budget").toContain("plan_budget");
  });

  it.each(["model_error", "invalid_decision", "budget_exhausted", "cancelled", "engine_limit"] as const)(
    "refuses to count execution status %s as a pass",
    (executionStatus) => {
      const score = judge(base, { output: { executionStatus } });
      expect(score.execution).toBe(false);
      expect(score.executionFailures).toContain(executionStatus);
      expect(score.passed).toBe(false);
    },
  );

  it("requires zero tools and zero model calls on cases that need no investigation", () => {
    const oneCall: readonly ToolCall[] = [{
      sequence: 1,
      fromPlaceId: "P-C",
      toPlaceId: "P-D",
      result: { status: "no_route", reason: "no_path", evidence: evidenceOf(base) },
    }];
    expect(judge(zeroTool, { trace: oneCall }).executionFailures, "unnecessary tools")
      .toContain("unnecessary_tools");
    expect(judge(zeroTool, { output: { modelRequests: 1 } }).executionFailures, "unnecessary model")
      .toContain("unnecessary_model");
  });

  it("flags a missing required issue code", () => {
    const stripped = structuredClone(needsInformation.output);
    Reflect.set(stripped.result, "issues", []);
    const score = scoreV2(
      needsInformation.scenario,
      needsInformation.plannerId,
      stripped,
      needsInformation.calls,
      needsInformation.trace,
    );
    expect(score.qualityFailures).toContain("missing_unknown_travel_duration");
  });
});
