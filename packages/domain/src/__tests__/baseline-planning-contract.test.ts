import { describe, expect, it } from "vitest";
import {
  generateBaselineCandidate,
  referenceCases,
  validateCandidatePlan,
  type BaselinePlanningInput,
  type BaselinePlanningResult,
  type BaselineStatus,
  type BaselineStrategy,
  type CandidatePlan,
  type ChinaDateTime,
  type PlannedActivity,
  type ValidationIssueCode,
} from "../index";

// Every expectation below is restated from the S2.3 design contract (stable
// attempt order, selected-only-when-feasible, no input mutation, defensive
// invalid_input) and from the accepted S2.2 machine-code list. Nothing here is
// derived from the generator's own output.
const DATE = "2026-10-15";

/** The full declared contract surface, restated independently of the source. */
const DECLARED_STATUSES = [
  "candidate_found",
  "needs_information",
  "no_feasible_candidate",
  "invalid_input",
  "request_not_current",
  "unsupported_scenario",
  "planner_error",
] as const satisfies readonly BaselineStatus[];

const DECLARED_STRATEGIES = ["keep", "shift", "omit"] as const satisfies readonly BaselineStrategy[];

const DECLARED_CODES = [
  "invalid_shape",
  "invalid_datetime",
  "invalid_interval",
  "invalid_number",
  "duplicate_id",
  "inconsistent_baseline",
  "ambiguous_travel_leg",
  "stale_base",
  "journey_mismatch",
  "protected_activity_changed",
  "outside_scope_change",
  "unauthorized_metadata_change",
  "reservation_conflict",
  "activity_overlap",
  "delay_conflict",
  "travel_conflict",
  "unknown_location",
  "unknown_travel_duration",
  "reservation_unverified",
  "current_activity_end_unknown",
  "activity_progress_unknown",
] as const satisfies readonly ValidationIssueCode[];

type Case = readonly [label: string, input: BaselinePlanningInput];

function clock(value: string): ChinaDateTime {
  return `${DATE}T${value}:00+08:00`;
}

/** A fresh copy of the hand-authored C1 input. */
function scenario(): BaselinePlanningInput {
  return JSON.parse(JSON.stringify(referenceCases[0].input)) as BaselinePlanningInput;
}

function resumeAt(input: BaselinePlanningInput, time: string): BaselinePlanningInput {
  return {
    ...input,
    request: {
      ...input.request,
      delay: { ...input.request.delay, earliestResumeAt: clock(time) },
    },
  };
}

function unknownAfternoonToDinner(input: BaselinePlanningInput): BaselinePlanningInput {
  return {
    ...input,
    travelLegs: input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? { fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId, duration: { kind: "unknown" as const, reason: "not_provided" } }
        : leg,
    ),
  };
}

function insertBefore(
  activities: readonly PlannedActivity[],
  beforeId: string,
  item: PlannedActivity,
): PlannedActivity[] {
  const index = activities.findIndex((activity) => activity.id === beforeId);
  if (index < 0) throw new Error(`fixture missing ${beforeId}`);
  return [...activities.slice(0, index), item, ...activities.slice(index)];
}

function replaceActivity(
  activities: readonly PlannedActivity[],
  id: string,
  patch: Partial<PlannedActivity>,
): PlannedActivity[] {
  return activities.map((activity) => (activity.id === id ? { ...activity, ...patch } : activity));
}

function wellFormedScenarios(): Case[] {
  const base = scenario();
  const extra: PlannedActivity = {
    id: "A-EXTRA",
    placeId: "P-C",
    startsAt: clock("16:15"),
    endsAt: clock("16:30"),
    priority: "normal",
    locked: false,
  };

  return [
    ["keep", resumeAt(base, "14:45")],
    ["shift", base],
    ["omit", resumeAt(base, "17:10")],
    ["no feasible candidate", resumeAt(base, "17:11")],
    ["needs information", unknownAfternoonToDinner(base)],
    ["invalid input", { ...base, transferBufferMinutes: -1 }],
    ["request not current", { ...base, request: { ...base.request, basePlanVersion: 99 } }],
    ["stale state version", { ...base, request: { ...base.request, baseStateVersion: 99 } }],
    [
      "unsupported scenario",
      {
        ...base,
        plan: { ...base.plan, activities: insertBefore(base.plan.activities, "A-DINNER", extra) },
      },
    ],
    [
      "high priority cannot be omitted",
      resumeAt(
        {
          ...base,
          plan: {
            ...base.plan,
            activities: replaceActivity(base.plan.activities, "A-AFTERNOON", { priority: "high" }),
          },
        },
        "17:10",
      ),
    ],
  ];
}

function checkedAttempts(result: BaselinePlanningResult) {
  return result.attempts.filter((attempt) => attempt.outcome === "checked");
}

function checkedCandidate(result: BaselinePlanningResult, strategy: BaselineStrategy): CandidatePlan {
  const attempt = result.attempts.find(
    (item) => item.strategy === strategy && item.outcome === "checked",
  );
  if (attempt === undefined || attempt.outcome !== "checked") {
    throw new Error(`no checked ${strategy} attempt`);
  }
  return attempt.candidate;
}

function strategyOrder(result: BaselinePlanningResult): string[] {
  return result.attempts.map((attempt) => attempt.strategy);
}

/** Calls the generator and fails the current test if it throws instead of returning. */
function callWithoutThrowing(value: unknown, label: string): BaselinePlanningResult {
  let captured: BaselinePlanningResult | undefined;
  let thrown: unknown;
  try {
    captured = generateBaselineCandidate(value as BaselinePlanningInput);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${label} does not throw`).toBeUndefined();
  if (captured === undefined) throw new Error(`${label} produced no result`);
  return captured;
}

describe("S2.3 baseline contract", () => {
  it("selects a candidate only when the public validator calls it feasible", () => {
    const cases: Case[] = [
      ["keep", resumeAt(scenario(), "14:45")],
      ["shift", scenario()],
      ["omit", resumeAt(scenario(), "17:10")],
    ];

    for (const [label, input] of cases) {
      const result = generateBaselineCandidate(input);
      expect(result.status, `${label} status`).toBe("candidate_found");
      if (result.status !== "candidate_found") continue;
      const selected = result.selected;

      expect(selected.validation.verdict, `${label} selected verdict`).toBe("feasible");
      expect(
        validateCandidatePlan({ ...input, candidate: selected.candidate }).verdict,
        `${label} re-validated by the public validator`,
      ).toBe("feasible");
      expect(
        checkedAttempts(result).at(-1)?.strategy,
        `${label} selected strategy is the last checked attempt`,
      ).toBe(selected.strategy);
    }
  });

  it("keeps status, attempts and issues mutually consistent for every scenario", () => {
    for (const [label, input] of wellFormedScenarios()) {
      const result = generateBaselineCandidate(input);
      const checked = checkedAttempts(result);
      const feasible = checked.filter((attempt) => attempt.validation.verdict === "feasible");
      const gaps = checked.filter((attempt) => attempt.validation.verdict === "insufficient_information");

      expect(DECLARED_STATUSES.includes(result.status), `${label} status is declared`).toBe(true);
      expect(result.attempts.length, `${label} at most three attempts`).toBeLessThanOrEqual(3);

      if (result.status === "candidate_found") {
        expect(result.selected, `${label} selected`).toBeDefined();
        expect(feasible.length, `${label} has a feasible checked attempt`).toBeGreaterThan(0);
      } else {
        expect(result.selected, `${label} no selected`).toBeUndefined();
        expect(feasible.length, `${label} has no feasible checked attempt`).toBe(0);
      }

      if (result.status === "needs_information") {
        expect(gaps.length, `${label} preserves an information gap`).toBeGreaterThan(0);
      }
      if (result.status === "no_feasible_candidate") {
        expect(gaps.length, `${label} is not an information gap`).toBe(0);
      }
      if (result.status === "unsupported_scenario") {
        expect(
          result.attempts.some(
            (attempt) => attempt.outcome === "not_constructed" && attempt.reasonCode === "multiple_editable_activities",
          ),
          `${label} names the unsupported reason`,
        ).toBe(true);
      }
      if (result.status === "invalid_input" || result.status === "request_not_current") {
        expect(strategyOrder(result), `${label} stops after keep`).toEqual(["keep"]);
      }

      const keys = result.issues.map((issue) => JSON.stringify(issue));
      expect(new Set(keys).size, `${label} issues are deduplicated`).toBe(keys.length);
      for (const issue of result.issues) {
        expect(DECLARED_CODES.includes(issue.code), `${label} declared code ${issue.code}`).toBe(true);
      }
    }
  });

  it("records attempts as a fixed keep then shift then omit prefix without repeating a strategy", () => {
    for (const [label, input] of wellFormedScenarios()) {
      const strategies = strategyOrder(generateBaselineCandidate(input));
      expect(strategies, `${label} fixed prefix`).toEqual(DECLARED_STRATEGIES.slice(0, strategies.length));
      expect(new Set(strategies).size, `${label} no repeated strategy`).toBe(strategies.length);
    }
  });

  it("binds every constructed candidate to the request versions and derives a stable id", () => {
    for (const [label, input] of wellFormedScenarios()) {
      const result = generateBaselineCandidate(input);
      for (const attempt of result.attempts) {
        if (attempt.outcome !== "checked") continue;
        expect(attempt.candidate.journeyId, `${label}/${attempt.strategy} journey`).toBe(input.plan.journeyId);
        expect(attempt.candidate.basePlanVersion, `${label}/${attempt.strategy} plan version`).toBe(input.plan.version);
        expect(attempt.candidate.baseStateVersion, `${label}/${attempt.strategy} state version`).toBe(input.state.version);
      }
    }

    const input = scenario();
    const first = generateBaselineCandidate(input);
    const second = generateBaselineCandidate(scenario());
    const keepId = checkedCandidate(first, "keep").id;
    const shiftId = checkedCandidate(first, "shift").id;

    expect(checkedCandidate(second, "keep").id, "keep id stable across calls").toBe(keepId);
    expect(checkedCandidate(second, "shift").id, "shift id stable across calls").toBe(shiftId);
    expect(keepId === shiftId, "strategy distinguishes ids").toBe(false);

    const bumpedPlan = generateBaselineCandidate({
      ...input,
      plan: { ...input.plan, version: 2 },
      request: { ...input.request, basePlanVersion: 2 },
    });
    expect(checkedCandidate(bumpedPlan, "keep").id, "plan version changes the id").not.toBe(keepId);

    const bumpedState = generateBaselineCandidate({
      ...input,
      state: { ...input.state, version: 4 },
      request: { ...input.request, baseStateVersion: 4 },
    });
    expect(checkedCandidate(bumpedState, "keep").id, "state version changes the id").not.toBe(keepId);

    const otherRequest = generateBaselineCandidate({
      ...input,
      request: { ...input.request, id: "REQ-DELAY-2" },
    });
    expect(checkedCandidate(otherRequest, "keep").id, "request id changes the id").not.toBe(keepId);
  });

  it("is deterministic and never mutates the input it was given", () => {
    for (const [label, input] of wellFormedScenarios()) {
      const before = JSON.stringify(input);
      const first = generateBaselineCandidate(input);
      const after = JSON.stringify(input);
      const second = generateBaselineCandidate(input);

      expect(after, `${label} input untouched`).toBe(before);
      expect(first, `${label} repeated call agrees`).toEqual(second);
    }
  });

  it("reports malformed runtime values as invalid_input instead of throwing", () => {
    const base = scenario();
    const throwing = {
      get plan(): never {
        throw new Error("boom");
      },
    };

    // Unreadable inputs: the plan/state/request needed to build even the keep
    // candidate cannot be read, so no attempt is recorded. The contract only
    // requires invalid_input with evidence, never an unhandled exception.
    const unreadable: ReadonlyArray<readonly [string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["number", 42],
      ["string", "not an input"],
      ["empty object", {}],
      ["plan removed", { state: base.state, request: base.request, reservations: base.reservations, travelLegs: base.travelLegs, transferBufferMinutes: 10 }],
      ["state removed", { plan: base.plan, request: base.request, reservations: base.reservations, travelLegs: base.travelLegs, transferBufferMinutes: 10 }],
      ["request removed", { plan: base.plan, state: base.state, reservations: base.reservations, travelLegs: base.travelLegs, transferBufferMinutes: 10 }],
      ["throwing getter", throwing],
    ];

    // Readable but invalid inputs: the keep candidate is built and rejected by
    // the validator, so the attempt record and the field path are preserved.
    const readable: ReadonlyArray<readonly [string, unknown, string, string]> = [
      ["activities not an array", { ...base, plan: { ...base.plan, activities: "nope" } }, "invalid_shape", "plan.activities"],
      ["reservations removed", { ...base, reservations: undefined }, "invalid_shape", "reservations"],
      ["negative buffer", { ...base, transferBufferMinutes: -1 }, "invalid_number", "transferBufferMinutes"],
    ];

    for (const [label, value] of unreadable) {
      const result = callWithoutThrowing(value, label);
      expect(result.status, `${label} status`).toBe("invalid_input");
      expect(result.issues.length > 0, `${label} keeps the evidence`).toBe(true);
      expect(strategyOrder(result), `${label} records no attempt`).toEqual([]);
    }

    for (const [label, value, code, fieldPath] of readable) {
      const result = callWithoutThrowing(value, label);
      expect(result.status, `${label} status`).toBe("invalid_input");
      expect(strategyOrder(result), `${label} attempts`).toEqual(["keep"]);
      expect(
        result.issues.some((issue) => issue.code === code && issue.fieldPath === fieldPath),
        `${label} names ${code} at ${fieldPath}`,
      ).toBe(true);
    }
  });

  it("reaches every declared status and strategy except the defensive planner_error", () => {
    const statuses = new Set<BaselineStatus>();
    const strategies = new Set<BaselineStrategy>();

    for (const [, input] of wellFormedScenarios()) {
      const result = generateBaselineCandidate(input);
      statuses.add(result.status);
      if (result.status === "candidate_found") strategies.add(result.selected.strategy);
    }
    const malformed = generateBaselineCandidate(null as unknown as BaselinePlanningInput);
    statuses.add(malformed.status);

    for (const status of DECLARED_STATUSES) {
      const reachable = status !== "planner_error";
      expect(statuses.has(status), `status ${status}`).toBe(reachable);
    }
    for (const strategy of DECLARED_STRATEGIES) {
      expect(strategies.has(strategy), `strategy ${strategy}`).toBe(true);
    }
  });
});
