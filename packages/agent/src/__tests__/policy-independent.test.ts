import { describe, expect, it } from "vitest";
import type {
  BaselineAttempt,
  BaselinePlanningInput,
  BaselinePlanningResult,
  ValidationIssue,
  ValidationIssueCode,
} from "@tripquest/domain";
import { generateBaselineCandidate } from "@tripquest/domain";
import { accessibleEdges, edgeKey, usefulEdges } from "../index";
import type { Observation } from "../contracts";
import { at, activity, diagnosticInput } from "./independent-fixtures";

/**
 * Independent policy tests. Fixtures come from `independent-fixtures.ts`
 * (rebuilt from the S4.2 design text) instead of the developer's fixtures, so
 * a shared helper cannot make both sides wrong in the same way.
 */

const keys = (input: BaselinePlanningInput): string[] =>
  accessibleEdges(input).map((edge) => edgeKey(edge));

const unknownIssue = (from: string, to: string): ValidationIssue => ({
  category: "insufficient_information",
  code: "unknown_travel_duration",
  fromPlaceId: from,
  toPlaceId: to,
});

const violation = (code: ValidationIssueCode): ValidationIssue => ({
  category: "known_violation",
  code,
});

function checked(strategy: BaselineAttempt["strategy"], issues: readonly ValidationIssue[]): BaselineAttempt {
  return {
    strategy,
    outcome: "checked",
    candidate: {
      id: `candidate-${strategy}`,
      journeyId: "independent",
      basePlanVersion: 1,
      baseStateVersion: 1,
      activities: [],
    },
    validation: {
      verdict: issues.some((i) => i.category === "known_violation")
        ? "known_violation"
        : "insufficient_information",
      issues: [...issues],
      checkedTransitions: [],
    },
  };
}

const skipped = (
  strategy: BaselineAttempt["strategy"],
  reasonCode: Extract<BaselineAttempt, { outcome: "not_constructed" }>["reasonCode"],
): BaselineAttempt => ({ strategy, outcome: "not_constructed", reasonCode });

/** Hand-built result so the policy function is exercised on shapes the planner cannot reach. */
const resultWith = (
  status: BaselinePlanningResult["status"],
  attempts: readonly BaselineAttempt[] = [],
  strategy: "keep" | "shift" | "omit" = "keep",
): BaselinePlanningResult =>
  status === "candidate_found"
    ? ({
      status,
      attempts,
      issues: [],
      selected: {
        strategy,
        candidate: {
          id: "selected",
          journeyId: "independent",
          basePlanVersion: 1,
          baseStateVersion: 1,
          activities: [],
        },
        validation: { verdict: "feasible", issues: [], checkedTransitions: [] },
      },
    } as unknown as BaselinePlanningResult)
    : ({ status, attempts, issues: [] } as unknown as BaselinePlanningResult);

describe("accessibleEdges preconditions (design §3/§4: never ask the model what routes cannot fix)", () => {
  it("returns the three topology directions in observation→activity→reservation order", () => {
    expect(keys(diagnosticInput("15:30"))).toEqual([
      JSON.stringify(["P-B", "P-C"]),
      JSON.stringify(["P-C", "P-D"]),
      JSON.stringify(["P-B", "P-D"]),
    ]);
  });

  it("offers nothing when the journey shape is outside the accepted single-activity topology", () => {
    const base = diagnosticInput("15:30");
    const cases: readonly [string, BaselinePlanningInput][] = [
      ["unknown location", { ...base, state: { ...base.state, location: { kind: "unknown" } } }],
      ["activity in progress", { ...base, state: { ...base.state, currentActivityId: "C" } }],
      ["three unfinished activities", {
        ...base,
        plan: {
          ...base.plan,
          activities: [...base.plan.activities, activity("E", "P-E", "20:00", "21:00")],
        },
      }],
      ["one unfinished activity", {
        ...base,
        state: { ...base.state, completedActivityIds: ["A", "B", "C"] },
      }],
      ["unfinished activity already started", {
        ...base,
        state: { ...base.state, observedAt: at("15:30") },
      }],
      ["editable target is locked", {
        ...base,
        plan: {
          ...base.plan,
          activities: base.plan.activities.map((a) => (a.id === "C" ? { ...a, locked: true } : a)),
        },
      }],
      ["editable target carries a reservation", {
        ...base,
        plan: {
          ...base.plan,
          activities: base.plan.activities.map((a) => (a.id === "C" ? { ...a, reservationId: "R-C" } : a)),
        },
      }],
      ["reservation activity is not locked", {
        ...base,
        plan: {
          ...base.plan,
          activities: base.plan.activities.map((a) => (a.id === "D" ? { ...a, locked: false } : a)),
        },
      }],
      ["reservation activity has no reservation link", {
        ...base,
        plan: {
          ...base.plan,
          activities: base.plan.activities.map((a) => {
            if (a.id !== "D") return a;
            const { reservationId, ...rest } = a;
            void reservationId;
            return rest;
          }),
        },
      }],
      ["target starts before the scope window", {
        ...base,
        request: {
          ...base.request,
          scope: { kind: "selected_window", window: { startsAt: at("15:30"), endsAt: at("18:00") } },
        },
      }],
      ["target ends after the scope window", {
        ...base,
        request: {
          ...base.request,
          scope: { kind: "selected_window", window: { startsAt: at("15:00"), endsAt: at("15:30") } },
        },
      }],
      ["reservation not confirmed", {
        ...base,
        reservations: base.reservations.map((r) => ({
          ...r,
          confirmation: { ...r.confirmation, status: "pending" as const },
        })),
      }],
    ];
    for (const [label, input] of cases) expect(keys(input), label).toEqual([]);
  });

  it("collapses a duplicated direction instead of offering it twice", () => {
    const base = diagnosticInput("15:30");
    const knownFirst = {
      ...base,
      travelLegs: [{ fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known" as const, minutes: 10 } }],
    };
    expect(keys(knownFirst)).toEqual([
      JSON.stringify(["P-C", "P-D"]),
      JSON.stringify(["P-B", "P-D"]),
    ]);
    const atTarget = { ...base, state: { ...base.state, location: { kind: "known" as const, placeId: "P-C" } } };
    expect(keys(atTarget)).toEqual([JSON.stringify(["P-C", "P-D"])]);
    const atReservation = { ...base, state: { ...base.state, location: { kind: "known" as const, placeId: "P-D" } } };
    expect(keys(atReservation)).toEqual([
      JSON.stringify(["P-D", "P-C"]),
      JSON.stringify(["P-C", "P-D"]),
    ]);
  });

  it("pins the scope window boundaries to the exact minute", () => {
    const base = diagnosticInput("15:30");
    const window = (startsAt: string, endsAt: string): BaselinePlanningInput => ({
      ...base,
      request: {
        ...base.request,
        scope: { kind: "selected_window", window: { startsAt: at(startsAt), endsAt: at(endsAt) } },
      },
    });
    expect(keys(window("15:00", "16:00")), "target interval touching both edges").toHaveLength(3);
    expect(keys(window("15:01", "16:00")), "one minute past the target start").toEqual([]);
    expect(keys(window("15:00", "15:59")), "one minute short of the target end").toEqual([]);
  });

  it("uses the end of the plan date for a rest_of_day scope", () => {
    const base = diagnosticInput("15:30");
    const late: BaselinePlanningInput = {
      ...base,
      request: { ...base.request, scope: { kind: "rest_of_day" as const, from: at("15:00") } },
    };
    expect(keys(late)).toEqual(keys(base));
    const lateEvening: BaselinePlanningInput = {
      ...late,
      plan: {
        ...late.plan,
        activities: late.plan.activities.map((a) =>
          a.id === "C" ? { ...a, startsAt: at("23:00"), endsAt: at("23:59:59") } : a),
      },
    };
    expect(keys(lateEvening), "23:59:59 is still inside the plan date").toHaveLength(3);
  });
});

describe("usefulEdges only justifies investigating a still-possible strategy", () => {
  const allowed = accessibleEdges(diagnosticInput("15:30"));
  const none: readonly Observation[] = [];

  it.each(["invalid_input", "request_not_current", "unsupported_scenario", "planner_error"] as const)(
    "stops on hard status %s",
    (status) => {
      expect(usefulEdges(resultWith(status, [checked("keep", [unknownIssue("P-B", "P-C")])]), allowed, none))
        .toEqual([]);
    },
  );

  it("stops once a keeping strategy is already feasible", () => {
    const feasible = resultWith("candidate_found", [checked("shift", [])], "shift");
    expect(usefulEdges(feasible, allowed, none)).toEqual([]);
  });

  it("keeps investigating when only omission is provable so far", () => {
    const omitted = resultWith("candidate_found", [
      checked("keep", [violation("delay_conflict")]),
      checked("shift", [violation("outside_scope_change")]),
      checked("omit", [unknownIssue("P-B", "P-D")]),
    ], "omit");
    expect(usefulEdges(omitted, allowed, none)).toEqual([["P-B", "P-D"]]);
  });

  it("lets a known violation in one attempt coexist with unknown information in another", () => {
    const mixed = resultWith("needs_information", [
      checked("keep", [violation("delay_conflict")]),
      checked("shift", [unknownIssue("P-C", "P-D")]),
    ]);
    expect(usefulEdges(mixed, allowed, none)).toEqual([["P-C", "P-D"]]);
  });

  it("does not investigate a strategy that already carries a known violation", () => {
    // Design §5: an unknown code in the same attempt must not cancel that
    // attempt's own known violation.
    const unknownOnly = resultWith("needs_information", [
      checked("keep", [unknownIssue("P-B", "P-C")]),
    ]);
    expect(usefulEdges(unknownOnly, allowed, none)).toEqual([["P-B", "P-C"]]);
    const conflicted = resultWith("needs_information", [
      checked("keep", [violation("delay_conflict"), unknownIssue("P-B", "P-C")]),
    ]);
    expect(usefulEdges(conflicted, allowed, none)).toEqual([]);
    const laterStillPossible = resultWith("needs_information", [
      checked("keep", [violation("delay_conflict"), unknownIssue("P-B", "P-C")]),
      checked("shift", [unknownIssue("P-C", "P-D")]),
    ]);
    expect(usefulEdges(laterStillPossible, allowed, none)).toEqual([["P-C", "P-D"]]);
  });

  it("ignores attempts that were never constructed", () => {
    const notConstructed = resultWith("needs_information", [
      skipped("keep", "outside_scope"),
      checked("shift", [unknownIssue("P-B", "P-C")]),
    ]);
    expect(usefulEdges(notConstructed, allowed, none)).toEqual([["P-B", "P-C"]]);
  });

  it("never returns a direction outside the allowed set, even after an earlier attempt mentioned it", () => {
    const leaky = resultWith("needs_information", [
      checked("keep", [unknownIssue("P-X", "P-Y")]),
      checked("shift", [unknownIssue("P-C", "P-D")]),
    ]);
    expect(usefulEdges(leaky, allowed, none)).toEqual([["P-C", "P-D"]]);
  });

  it("falls through to a later still-possible attempt once the earlier one has nothing left to ask", () => {
    const twoUnknown = resultWith("needs_information", [
      checked("shift", [unknownIssue("P-B", "P-C"), unknownIssue("P-C", "P-D")]),
      checked("omit", [unknownIssue("P-B", "P-D")]),
    ]);
    expect(usefulEdges(twoUnknown, allowed, none)).toEqual([["P-B", "P-C"], ["P-C", "P-D"]]);
    const requested: readonly Observation[] = [{ edge: ["P-B", "P-C"], status: "ok" }];
    expect(usefulEdges(twoUnknown, allowed, requested)).toEqual([["P-C", "P-D"]]);
    const firstAttemptExhausted: readonly Observation[] = [
      { edge: ["P-B", "P-C"], status: "ok" },
      { edge: ["P-C", "P-D"], status: "ok" },
    ];
    expect(usefulEdges(twoUnknown, allowed, firstAttemptExhausted)).toEqual([["P-B", "P-D"]]);
    const allRequested: readonly Observation[] = [
      ...firstAttemptExhausted,
      { edge: ["P-B", "P-D"], status: "ok" },
    ];
    expect(usefulEdges(twoUnknown, allowed, allRequested)).toEqual([]);
  });

  it("returns nothing when there are no attempts to reason about", () => {
    expect(usefulEdges(resultWith("needs_information"), allowed, none)).toEqual([]);
  });

  it("matches the design's E13 order (retention first) and E14 order (direct route only)", () => {
    const e13 = diagnosticInput("15:30");
    const e13Allowed = accessibleEdges(e13);
    const e13Result = generateBaselineCandidate(e13);
    expect(e13Result.status).toBe("needs_information");
    const e13Useful = usefulEdges(e13Result, e13Allowed, none);
    expect(e13Useful.map(edgeKey)).toEqual([
      JSON.stringify(["P-B", "P-C"]),
      JSON.stringify(["P-C", "P-D"]),
    ]);
    expect(edgeKey(e13Useful[0]), "retention edge is asked first").toBe(JSON.stringify(["P-B", "P-C"]));

    const e14 = diagnosticInput("17:10");
    const e14Allowed = accessibleEdges(e14);
    const e14Result = generateBaselineCandidate(e14);
    expect(e14Result.status).toBe("needs_information");
    expect(usefulEdges(e14Result, e14Allowed, none).map(edgeKey)).toEqual([
      JSON.stringify(["P-B", "P-D"]),
    ]);
  });

  it("asks for the second retention edge only after the first one is proven", () => {
    const e13 = diagnosticInput("15:30");
    const allowedE13 = accessibleEdges(e13);
    const proven = {
      ...e13,
      travelLegs: [{ fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known" as const, minutes: 10 } }],
    };
    const result = generateBaselineCandidate(proven);
    expect(usefulEdges(result, allowedE13, [{ edge: ["P-B", "P-C"], status: "ok" }]).map(edgeKey))
      .toEqual([JSON.stringify(["P-C", "P-D"])]);
  });

  it("stops asking once the retention strategy becomes feasible", () => {
    const e13 = diagnosticInput("15:30");
    const allowedE13 = accessibleEdges(e13);
    const bothKnown = {
      ...e13,
      travelLegs: [
        { fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known" as const, minutes: 10 } },
        { fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known" as const, minutes: 20 } },
      ],
    };
    const result = generateBaselineCandidate(bothKnown);
    expect(result.status).toBe("candidate_found");
    expect(usefulEdges(result, allowedE13, [])).toEqual([]);
  });
});
