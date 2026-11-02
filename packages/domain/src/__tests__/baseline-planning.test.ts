import { describe, expect, it } from "vitest";
import {
  generateBaselineCandidate,
  referenceCases,
  validateCandidatePlan,
  type BaselinePlanningInput,
  type ChinaDateTime,
  type PlannedActivity,
} from "../index";

// Only the hand-authored input is used. All expectations below are calculated
// independently; the fixture's candidate and expected result are not read.
function scenario(): BaselinePlanningInput {
  return JSON.parse(JSON.stringify(referenceCases[0].input)) as BaselinePlanningInput;
}

function clock(value: string): ChinaDateTime {
  return `2026-10-15T${value}:00+08:00`;
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

function afternoon(input: BaselinePlanningInput): PlannedActivity {
  const activity = input.plan.activities.find((item) => item.id === "A-AFTERNOON");
  if (!activity) throw new Error("fixture missing afternoon activity");
  return activity;
}

describe("S2.3 conservative baseline", () => {
  it("keeps the plan when the original afternoon still works", () => {
    const input = resumeAt(scenario(), "14:45");
    const result = generateBaselineCandidate(input);

    expect(result.status).toBe("candidate_found");
    expect(result.selected?.strategy).toBe("keep");
    expect(result.selected?.candidate.activities).toEqual(input.plan.activities);
    expect(result.selected?.validation.verdict).toBe("feasible");
    expect(result.attempts.map((item) => item.strategy)).toEqual(["keep"]);
  });

  it("shifts the single editable activity intact and independently validates 17:20", () => {
    const input = scenario();
    const before = JSON.stringify(input);
    const result = generateBaselineCandidate(input);
    const again = generateBaselineCandidate(input);

    expect(result).toEqual(again);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.status).toBe("candidate_found");
    expect(result.attempts.map((item) => item.strategy)).toEqual(["keep", "shift"]);
    expect(result.attempts[0]).toMatchObject({ outcome: "checked", validation: { verdict: "known_violation" } });
    expect(result.selected?.strategy).toBe("shift");
    const candidate = result.selected?.candidate;
    expect(candidate?.activities.find((item) => item.id === "A-AFTERNOON")).toEqual({
      ...afternoon(input), startsAt: clock("15:30"), endsAt: clock("16:30"),
    });
    expect(candidate?.activities.filter((item) => item.id !== "A-AFTERNOON")).toEqual(
      input.plan.activities.filter((item) => item.id !== "A-AFTERNOON"),
    );
    expect(result.selected?.validation.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"))
      .toMatchObject({ departsAt: clock("16:30"), travelMinutes: 40, bufferMinutes: 10, earliestArrivalAt: clock("17:20") });
    expect(result.selected?.validation.verdict).toBe("feasible");
    expect(validateCandidatePlan({ ...input, candidate: candidate! }).verdict).toBe("feasible");
  });

  it("omits the future ordinary activity at 17:10 and reaches dinner exactly at 18:00", () => {
    const input = resumeAt(scenario(), "17:10");
    const result = generateBaselineCandidate(input);

    expect(result.status).toBe("candidate_found");
    expect(result.attempts).toMatchObject([
      { strategy: "keep", outcome: "checked" },
      { strategy: "shift", outcome: "not_constructed", reasonCode: "outside_scope" },
      { strategy: "omit", outcome: "checked", validation: { verdict: "feasible" } },
    ]);
    expect(result.selected?.strategy).toBe("omit");
    expect(result.selected?.candidate.activities).toEqual(
      input.plan.activities.filter((item) => item.id !== "A-AFTERNOON"),
    );
    expect(input.state.skippedActivityIds).toEqual([]);
    expect(result.selected?.validation.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"))
      .toMatchObject({ departsAt: clock("17:10"), earliestArrivalAt: clock("18:00") });
  });

  it("at 17:11 reports the fixed strategies failed without moving the booking", () => {
    const input = resumeAt(scenario(), "17:11");
    const result = generateBaselineCandidate(input);

    expect(result.status).toBe("no_feasible_candidate");
    expect(result.selected).toBeUndefined();
    expect(result.attempts).toMatchObject([
      { strategy: "keep", outcome: "checked" },
      { strategy: "shift", outcome: "not_constructed", reasonCode: "outside_scope" },
      { strategy: "omit", outcome: "checked", validation: { verdict: "known_violation" } },
    ]);
    const omit = result.attempts[2];
    if (omit.outcome !== "checked") throw new Error("omit not checked");
    expect(omit.candidate.activities.find((item) => item.id === "A-DINNER")).toEqual(
      input.plan.activities.find((item) => item.id === "A-DINNER"),
    );
    expect(omit.validation.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"))
      .toMatchObject({ earliestArrivalAt: clock("18:01") });
    expect(result.issues.some((item) => item.code === "travel_conflict")).toBe(true);
  });

  it("keeps the unknown route as needs_information rather than claiming a feasible option", () => {
    const input = scenario();
    const travelLegs = input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? { ...leg, duration: { kind: "unknown" as const, reason: "not_provided" } }
        : leg,
    );
    const result = generateBaselineCandidate({ ...input, travelLegs });

    expect(result.status).toBe("needs_information");
    expect(result.selected).toBeUndefined();
    expect(result.attempts.map((item) => item.strategy)).toEqual(["keep", "shift", "omit"]);
    expect(result.issues.some((item) => item.code === "unknown_travel_duration")).toBe(true);
    expect(result.attempts.filter((item) => item.outcome === "checked")
      .every((item) => item.validation.verdict !== "feasible")).toBe(true);
  });

  it("distinguishes invalid data and stale requests before trying to repair them", () => {
    const input = scenario();
    const invalid = generateBaselineCandidate({ ...input, transferBufferMinutes: -1 });
    expect(invalid.status).toBe("invalid_input");
    expect(invalid.issues).toContainEqual(expect.objectContaining({ code: "invalid_number" }));
    expect(invalid.attempts.map((item) => item.strategy)).toEqual(["keep"]);

    const stale = generateBaselineCandidate({
      ...input,
      request: { ...input.request, basePlanVersion: 99 },
    });
    expect(stale.status).toBe("request_not_current");
    expect(stale.issues).toContainEqual(expect.objectContaining({ code: "stale_base" }));
    expect(stale.attempts.map((item) => item.strategy)).toEqual(["keep"]);
    const malformed = generateBaselineCandidate(null as unknown as BaselinePlanningInput);
    expect(malformed.selected).toBeUndefined();
    expect(malformed).toMatchObject({
      status: "invalid_input",
      issues: [expect.objectContaining({ code: "invalid_shape" })],
    });
  });

  it("does not call the restricted one-activity strategy a global impossibility", () => {
    const input = scenario();
    const extra: PlannedActivity = {
      id: "A-EXTRA", placeId: "P-C", startsAt: clock("16:15"), endsAt: clock("16:30"),
      priority: "normal", locked: false,
    };
    const result = generateBaselineCandidate({
      ...input,
      plan: { ...input.plan, activities: [...input.plan.activities.slice(0, 3), extra, input.plan.activities[3]] },
    });

    expect(result.status).toBe("unsupported_scenario");
    expect(result.selected).toBeUndefined();
    expect(result.attempts).toMatchObject([
      { strategy: "keep", outcome: "checked" },
      { strategy: "shift", outcome: "not_constructed", reasonCode: "multiple_editable_activities" },
    ]);
  });

  it("never automatically omits a high-priority or locked activity", () => {
    const input = resumeAt(scenario(), "17:10");
    const high = generateBaselineCandidate({
      ...input,
      plan: { ...input.plan, activities: input.plan.activities.map((item) =>
        item.id === "A-AFTERNOON" ? { ...item, priority: "high" as const } : item,
      ) },
    });
    expect(high.status).toBe("no_feasible_candidate");
    expect(high.attempts.at(-1)).toMatchObject({ strategy: "omit", outcome: "not_constructed", reasonCode: "omit_not_allowed" });

    const locked = generateBaselineCandidate({
      ...input,
      plan: { ...input.plan, activities: input.plan.activities.map((item) =>
        item.id === "A-AFTERNOON" ? { ...item, locked: true } : item,
      ) },
    });
    expect(locked.status).toBe("no_feasible_candidate");
    expect(locked.attempts.map((item) => item.strategy)).toEqual(["keep"]);
  });

  it("uses a known previous directed leg to shift, while a reverse leg cannot stand in", () => {
    const input = scenario();
    const prior: PlannedActivity = {
      id: "A-PRIOR", placeId: "P-B", startsAt: clock("15:10"), endsAt: clock("15:30"),
      priority: "high", locked: true,
    };
    const plan = {
      ...input.plan,
      activities: [input.plan.activities[0], input.plan.activities[1], prior,
        { ...afternoon(input), startsAt: clock("15:40"), endsAt: clock("16:20") }, input.plan.activities[3]],
    };
    const base = resumeAt({
      ...input, plan,
      state: { ...input.state, location: { kind: "known", placeId: "P-B" } },
    }, "15:00");
    const result = generateBaselineCandidate(base);
    expect(result.status).toBe("candidate_found");
    expect(result.selected?.strategy).toBe("shift");
    expect(result.selected?.candidate.activities.find((item) => item.id === "A-AFTERNOON"))
      .toMatchObject({ startsAt: clock("16:00"), endsAt: clock("16:40") });
    expect(result.selected?.validation.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"))
      .toMatchObject({ earliestArrivalAt: clock("17:30") });

    const reverseOnly = generateBaselineCandidate({
      ...base,
      travelLegs: [
        ...base.travelLegs.filter((leg) => !(leg.fromPlaceId === "P-B" && leg.toPlaceId === "P-C")),
        { fromPlaceId: "P-C", toPlaceId: "P-B", duration: { kind: "known", minutes: 20 } },
      ],
    });
    expect(reverseOnly.status).toBe("needs_information");
    expect(reverseOnly.attempts).toContainEqual({ strategy: "shift", outcome: "not_constructed", reasonCode: "duplicate" });
    expect(reverseOnly.issues.some((item) => item.code === "unknown_travel_duration" && item.fromPlaceId === "P-B"))
      .toBe(true);
  });

  it("supports rest_of_day but does not infer when a current activity ends", () => {
    const input = scenario();
    const restOfDay = generateBaselineCandidate({
      ...input,
      request: { ...input.request, scope: { kind: "rest_of_day", from: clock("15:00") } },
    });
    expect(restOfDay.status).toBe("candidate_found");
    expect(restOfDay.selected?.strategy).toBe("shift");
    expect(restOfDay.selected?.candidate.activities.find((item) => item.id === "A-DINNER"))
      .toEqual(input.plan.activities.find((item) => item.id === "A-DINNER"));

    const current = generateBaselineCandidate({
      ...input,
      state: {
        ...input.state, completedActivityIds: ["A-MORNING"], currentActivityId: "A-LUNCH",
        location: { kind: "known", placeId: "P-B" },
      },
    });
    expect(current.status).toBe("needs_information");
    expect(current.selected).toBeUndefined();
    expect(current.issues.some((item) => item.code === "current_activity_end_unknown")).toBe(true);
    expect(current.attempts.filter((item) => item.outcome === "checked")
      .every((item) => item.candidate.activities.some((activity) => activity.id === "A-LUNCH"))).toBe(true);
  });
});
