import { describe, expect, it } from "vitest";

import {
  referenceCases,
  validateCandidatePlan,
  type CandidateValidationInput,
  type PlannedActivity,
  type ReferenceCaseId,
} from "../index";

function fixture(id: ReferenceCaseId = "C1"): CandidateValidationInput {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing reference case ${id}`);
  return JSON.parse(JSON.stringify({ ...found.input, candidate: found.candidate })) as CandidateValidationInput;
}

function withActivity(
  input: CandidateValidationInput,
  id: string,
  changes: Partial<PlannedActivity>,
): CandidateValidationInput {
  return {
    ...input,
    candidate: {
      ...input.candidate,
      activities: input.candidate.activities.map((activity) =>
        activity.id === id ? { ...activity, ...changes } : activity,
      ),
    },
  };
}

function issueCodes(input: CandidateValidationInput): string[] {
  return validateCandidatePlan(input).issues.map((issue) => issue.code);
}

describe("S2.2 hand-written reference cases", () => {
  it("accepts C1 and proves the 17:20 arrival before the fixed dinner", () => {
    const result = validateCandidatePlan(fixture("C1"));
    expect(result.verdict).toBe("feasible");
    expect(result.issues).toEqual([]);
    expect(result.checkedTransitions[0]).toMatchObject({
      fromPlaceId: "P-C",
      toPlaceId: "P-C",
      departsAt: "2026-10-15T15:30:00+08:00",
      earliestArrivalAt: "2026-10-15T15:30:00+08:00",
      travelMinutes: 0,
      bufferMinutes: 0,
    });
    expect(result.checkedTransitions.at(-1)).toMatchObject({
      fromActivityId: "A-AFTERNOON",
      toActivityId: "A-DINNER",
      departsAt: "2026-10-15T16:30:00+08:00",
      earliestArrivalAt: "2026-10-15T17:20:00+08:00",
      nextStartsAt: "2026-10-15T18:00:00+08:00",
      travelMinutes: 40,
      bufferMinutes: 10,
    });
  });

  it("rejects C2 because the independently calculated arrival is 18:30", () => {
    const result = validateCandidatePlan(fixture("C2"));
    expect(result.verdict).toBe("known_violation");
    expect(result.issues.map((issue) => issue.code)).toContain("travel_conflict");
    expect(result.checkedTransitions.at(-1)?.earliestArrivalAt).toBe("2026-10-15T18:30:00+08:00");
  });

  it("rejects C3 and C4 for protected facts, not for uncertain travel", () => {
    for (const id of ["C3", "C4"] as const) {
      const result = validateCandidatePlan(fixture(id));
      expect(result.verdict).toBe("known_violation");
      expect(result.issues.map((issue) => issue.code)).toContain("protected_activity_changed");
      expect(result.issues.map((issue) => issue.code)).toContain("outside_scope_change");
    }
    expect(issueCodes(fixture("C3"))).toContain("reservation_conflict");
  });

  it("keeps C5 unknown rather than treating missing travel as zero", () => {
    const result = validateCandidatePlan(fixture("C5"));
    expect(result.verdict).toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_travel_duration");
    expect(result.checkedTransitions.some((entry) => entry.toActivityId === "A-DINNER")).toBe(false);
  });
});

describe("S2.2 time and travel boundaries", () => {
  it("accepts exactly 18:00 and rejects 18:01", () => {
    const base = fixture();
    const withMinutes = (minutes: number): CandidateValidationInput => ({
      ...base,
      travelLegs: base.travelLegs.map((leg) =>
        leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
          ? { ...leg, duration: { kind: "known" as const, minutes } }
          : leg,
      ),
    });
    expect(validateCandidatePlan(withMinutes(80)).verdict).toBe("feasible");
    const late = validateCandidatePlan(withMinutes(81));
    expect(late.verdict).toBe("known_violation");
    expect(late.checkedTransitions.at(-1)?.earliestArrivalAt).toBe("2026-10-15T18:01:00+08:00");
  });

  it("distinguishes a missing forward leg from a known zero-minute estimate", () => {
    const base = fixture();
    const withoutForward = {
      ...base,
      travelLegs: base.travelLegs.filter((leg) => leg.fromPlaceId !== "P-C"),
    };
    expect(issueCodes(withoutForward)).toContain("unknown_travel_duration");
    const zero = {
      ...base,
      travelLegs: base.travelLegs.map((leg) =>
        leg.fromPlaceId === "P-C"
          ? { ...leg, duration: { kind: "known" as const, minutes: 0 } }
          : leg,
      ),
    };
    const result = validateCandidatePlan(zero);
    expect(result.verdict).toBe("feasible");
    expect(result.checkedTransitions.at(-1)).toMatchObject({ travelMinutes: 0, bufferMinutes: 10 });
  });

  it("does not use a reverse directed leg in place of the missing forward leg", () => {
    const base = fixture();
    const input = {
      ...base,
      travelLegs: [
        ...base.travelLegs.filter((leg) => leg.fromPlaceId !== "P-C"),
        { fromPlaceId: "P-D", toPlaceId: "P-C", duration: { kind: "known" as const, minutes: 5 } },
      ],
    };
    expect(validateCandidatePlan(input).verdict).toBe("insufficient_information");
    expect(issueCodes(input)).toContain("unknown_travel_duration");
  });

  it("checks travel from the observed position into the first pending activity", () => {
    const base = fixture();
    const input = {
      ...base,
      state: { ...base.state, location: { kind: "known" as const, placeId: "P-B" } },
      travelLegs: base.travelLegs.map((leg) =>
        leg.fromPlaceId === "P-B" && leg.toPlaceId === "P-C"
          ? { ...leg, duration: { kind: "known" as const, minutes: 1 } }
          : leg,
      ),
    };
    const result = validateCandidatePlan(input);
    expect(result.verdict).toBe("known_violation");
    expect(result.checkedTransitions[0]).toMatchObject({
      fromPlaceId: "P-B",
      toPlaceId: "P-C",
      earliestArrivalAt: "2026-10-15T15:41:00+08:00",
    });
  });
});

describe("S2.2 scope, facts, and versions", () => {
  it("allows adding and deleting an ordinary future activity inside rest_of_day", () => {
    const base = fixture();
    const scope = { kind: "rest_of_day" as const, from: "2026-10-15T15:00:00+08:00" as const };
    const extra: PlannedActivity = {
      id: "A-EXTRA",
      placeId: "P-C",
      startsAt: "2026-10-15T16:30:00+08:00",
      endsAt: "2026-10-15T17:00:00+08:00",
      priority: "low",
      locked: false,
    };
    const added = {
      ...base,
      request: { ...base.request, scope },
      candidate: { ...base.candidate, activities: [...base.candidate.activities.slice(0, 3), extra, base.candidate.activities[3]] },
    };
    expect(validateCandidatePlan(added).verdict).toBe("feasible");
    const removed = {
      ...base,
      request: { ...base.request, scope },
      candidate: {
        ...base.candidate,
        activities: base.candidate.activities.filter((activity) => activity.id !== "A-AFTERNOON"),
      },
    };
    expect(validateCandidatePlan(removed).verdict).toBe("feasible");
  });

  it("does not let an outside activity gain edit rights by moving into the window", () => {
    const moved = withActivity(fixture(), "A-MORNING", {
      startsAt: "2026-10-15T15:00:00+08:00",
      endsAt: "2026-10-15T15:30:00+08:00",
    });
    const sorted = {
      ...moved,
      candidate: {
        ...moved.candidate,
        activities: [
          moved.candidate.activities[1],
          moved.candidate.activities[0],
          ...moved.candidate.activities.slice(2),
        ],
      },
    };
    expect(validateCandidatePlan(sorted).verdict).toBe("known_violation");
    expect(issueCodes(sorted)).toContain("outside_scope_change");
  });

  it("rejects priority, lock, and reservation-link edits separately from time edits", () => {
    const input = withActivity(fixture(), "A-AFTERNOON", { priority: "high" });
    expect(issueCodes(input)).toContain("unauthorized_metadata_change");
  });

  it("rejects stale plan and state versions", () => {
    const base = fixture();
    const input = {
      ...base,
      request: { ...base.request, baseStateVersion: base.state.version + 1 },
      candidate: { ...base.candidate, basePlanVersion: base.plan.version + 1 },
    };
    const result = validateCandidatePlan(input);
    expect(result.verdict).toBe("known_violation");
    expect(result.issues.filter((issue) => issue.code === "stale_base")).toHaveLength(2);
  });

  it("rejects a candidate that keeps an afternoon start before the delay can end", () => {
    const base = fixture();
    const unchanged = {
      ...base,
      candidate: { ...base.candidate, activities: base.plan.activities },
    };
    expect(validateCandidatePlan(unchanged).verdict).toBe("known_violation");
    expect(issueCodes(unchanged)).toContain("delay_conflict");
  });

  it("rejects a candidate or request bound to another journey", () => {
    const base = fixture();
    const input = {
      ...base,
      candidate: { ...base.candidate, journeyId: "J-OTHER" },
    };
    expect(validateCandidatePlan(input).verdict).toBe("known_violation");
    expect(issueCodes(input)).toContain("journey_mismatch");
  });

  it("retains a known protection conflict alongside an unknown route", () => {
    const base = fixture("C5");
    const input = withActivity(base, "A-MORNING", {
      startsAt: "2026-10-15T09:30:00+08:00",
      endsAt: "2026-10-15T10:30:00+08:00",
    });
    const result = validateCandidatePlan(input);
    expect(result.verdict).toBe("known_violation");
    expect(result.issues.map((issue) => issue.code)).toContain("protected_activity_changed");
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_travel_duration");
  });
});

describe("S2.2 observations and reservation uncertainty", () => {
  it("does not infer a missing past activity completion", () => {
    const base = fixture();
    const input = {
      ...base,
      state: { ...base.state, completedActivityIds: ["A-MORNING"] },
    };
    expect(validateCandidatePlan(input).verdict).toBe("insufficient_information");
    expect(issueCodes(input)).toContain("activity_progress_unknown");
  });

  it("still reports unknown progress when a past unreported activity is removed", () => {
    const base = fixture();
    const input = {
      ...base,
      state: { ...base.state, completedActivityIds: ["A-MORNING"] },
      request: {
        ...base.request,
        scope: { kind: "rest_of_day" as const, from: "2026-10-15T12:00:00+08:00" as const },
      },
      candidate: {
        ...base.candidate,
        activities: base.candidate.activities.filter((activity) => activity.id !== "A-LUNCH"),
      },
    };
    const result = validateCandidatePlan(input);
    expect(result.verdict).toBe("insufficient_information");
    expect(result.issues).toContainEqual({
      category: "insufficient_information",
      code: "activity_progress_unknown",
      activityId: "A-LUNCH",
    });
  });

  it("protects a skipped activity and keeps the current activity end unknown", () => {
    const base = fixture();
    const skipped = {
      ...base,
      state: { ...base.state, skippedActivityIds: ["A-AFTERNOON"] },
    };
    expect(issueCodes(skipped)).toContain("protected_activity_changed");

    const current = {
      ...base,
      state: {
        ...base.state,
        currentActivityId: "A-AFTERNOON",
        observedAt: "2026-10-15T15:45:00+08:00" as const,
      },
      request: {
        ...base.request,
        delay: {
          observedAt: "2026-10-15T15:45:00+08:00" as const,
          earliestResumeAt: "2026-10-15T16:00:00+08:00" as const,
        },
      },
      candidate: { ...base.candidate, activities: base.plan.activities },
    };
    const result = validateCandidatePlan(current);
    expect(result.verdict).toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.code)).toContain("current_activity_end_unknown");
  });

  it("keeps unknown location and an unverified referenced booking explicit", () => {
    const base = fixture();
    const input = {
      ...base,
      state: { ...base.state, location: { kind: "unknown" as const, reason: "not_provided" } },
      reservations: base.reservations.map((reservation) => ({
        ...reservation,
        confirmation: { ...reservation.confirmation, status: "pending" as const },
      })),
    };
    const result = validateCandidatePlan(input);
    expect(result.verdict).toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_location");
    expect(result.issues.map((issue) => issue.code)).toContain("reservation_unverified");
  });
});

describe("S2.2 malformed input and stable results", () => {
  it("returns invalid_input for impossible date, offset, zero interval, and bad minutes", () => {
    const base = fixture();
    const badDate = { ...base, plan: { ...base.plan, date: "2026-02-30" } };
    expect(issueCodes(badDate)).toContain("invalid_datetime");
    const badOffset = withActivity(base, "A-AFTERNOON", {
      startsAt: "2026-10-15T15:30:00+09:00" as PlannedActivity["startsAt"],
    });
    expect(issueCodes(badOffset)).toContain("invalid_datetime");
    const zeroInterval = withActivity(base, "A-AFTERNOON", {
      endsAt: "2026-10-15T15:30:00+08:00",
    });
    expect(issueCodes(zeroInterval)).toContain("invalid_interval");
    const badMinutes = {
      ...base,
      travelLegs: base.travelLegs.map((leg) =>
        leg.fromPlaceId === "P-C"
          ? { ...leg, duration: { kind: "known" as const, minutes: -1.5 } }
          : leg,
      ),
    };
    expect(issueCodes(badMinutes)).toContain("invalid_number");
    for (const input of [badDate, badOffset, zeroInterval, badMinutes]) {
      expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
      expect(validateCandidatePlan(input).checkedTransitions).toEqual([]);
    }
  });

  it("rejects duplicate IDs, duplicate directed routes, and contradictory confirmed booking", () => {
    const base = fixture();
    const duplicateActivity = {
      ...base,
      candidate: {
        ...base.candidate,
        activities: [...base.candidate.activities, base.candidate.activities[0]],
      },
    };
    expect(issueCodes(duplicateActivity)).toContain("duplicate_id");
    const duplicateRoute = { ...base, travelLegs: [...base.travelLegs, base.travelLegs[0]] };
    expect(issueCodes(duplicateRoute)).toContain("ambiguous_travel_leg");
    const badBooking = {
      ...base,
      reservations: base.reservations.map((reservation) => ({
        ...reservation,
        placeId: "P-X",
      })),
    };
    expect(issueCodes(badBooking)).toContain("inconsistent_baseline");
  });

  it("rejects a date-time outside the plan day and an unreferenced confirmed booking", () => {
    const base = fixture();
    const nextDay = withActivity(base, "A-AFTERNOON", {
      endsAt: "2026-10-16T00:01:00+08:00",
    });
    expect(validateCandidatePlan(nextDay).verdict).toBe("invalid_input");
    expect(issueCodes(nextDay)).toContain("invalid_interval");
    const extraBooking = {
      ...base,
      reservations: [
        ...base.reservations,
        { ...base.reservations[0], id: "R-UNREFERENCED" },
      ],
    };
    expect(issueCodes(extraBooking)).toContain("inconsistent_baseline");
  });

  it("treats a candidate overlap as a known conflict, while bad shape never throws", () => {
    const overlap = withActivity(fixture(), "A-AFTERNOON", {
      endsAt: "2026-10-15T18:10:00+08:00",
    });
    expect(validateCandidatePlan(overlap).verdict).toBe("known_violation");
    expect(issueCodes(overlap)).toContain("activity_overlap");
    expect(validateCandidatePlan(null as unknown as CandidateValidationInput)).toMatchObject({
      verdict: "invalid_input",
      checkedTransitions: [],
    });
    const sparse = [...fixture().candidate.activities];
    delete sparse[1];
    const malformed = { ...fixture(), candidate: { ...fixture().candidate, activities: sparse } };
    expect(validateCandidatePlan(malformed).verdict).toBe("invalid_input");
    expect(issueCodes(malformed)).toContain("invalid_shape");
  });

  it("does not mutate input and returns the same issues and evidence on repeat calls", () => {
    const input = fixture("C2");
    const before = JSON.stringify(input);
    const first = validateCandidatePlan(input);
    const second = validateCandidatePlan(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(second).toEqual(first);
  });
});
