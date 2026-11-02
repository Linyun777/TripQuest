import { describe, expect, it } from "vitest";
import {
  generateBaselineCandidate,
  referenceCases,
  type BaselineAttempt,
  type BaselinePlanningInput,
  type BaselinePlanningResult,
  type CandidatePlan,
  type ChinaDateTime,
  type PlannedActivity,
  type Reservation,
} from "../index";

// Expectations in this file are derived by hand from the S2.3 design document
// (fixed strategy rules and the hand-calculated acceptance table) plus the
// already-accepted S2.2 validator contract. The generator's own output is never
// used to produce an expectation, and C1's candidate/expected are never read.
const DATE = "2026-10-15";

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

function windowScope(
  input: BaselinePlanningInput,
  startsAt: string,
  endsAt: string,
): BaselinePlanningInput {
  return {
    ...input,
    request: {
      ...input.request,
      scope: { kind: "selected_window", window: { startsAt: clock(startsAt), endsAt: clock(endsAt) } },
    },
  };
}

function restOfDayScope(input: BaselinePlanningInput, from: string): BaselinePlanningInput {
  return { ...input, request: { ...input.request, scope: { kind: "rest_of_day", from: clock(from) } } };
}

function withActivities(
  input: BaselinePlanningInput,
  activities: readonly PlannedActivity[],
): BaselinePlanningInput {
  return { ...input, plan: { ...input.plan, activities } };
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

function strategyOrder(result: BaselinePlanningResult): string[] {
  return result.attempts.map((attempt) => attempt.strategy);
}

function attemptAt(result: BaselinePlanningResult, index: number): BaselineAttempt {
  const attempt = result.attempts[index];
  if (attempt === undefined) throw new Error(`no attempt at index ${index}`);
  return attempt;
}

function checkedCandidate(result: BaselinePlanningResult, strategy: string): CandidatePlan {
  const attempt = result.attempts.find(
    (item) => item.strategy === strategy && item.outcome === "checked",
  );
  if (attempt === undefined || attempt.outcome !== "checked") {
    throw new Error(`no checked ${strategy} attempt`);
  }
  return attempt.candidate;
}

function selectedCandidate(result: BaselinePlanningResult): CandidatePlan {
  if (result.status !== "candidate_found") {
    throw new Error(`expected candidate_found, received ${result.status}`);
  }
  return result.selected.candidate;
}

function candidateActivity(candidate: CandidatePlan, id: string): PlannedActivity {
  const found = candidate.activities.find((activity) => activity.id === id);
  if (found === undefined) throw new Error(`candidate missing ${id}`);
  return found;
}

/** Half-open: an activity may start exactly when the previous one ends. */
function hasOverlap(activities: readonly PlannedActivity[]): boolean {
  for (let index = 1; index < activities.length; index += 1) {
    if (activities[index].startsAt < activities[index - 1].endsAt) return true;
  }
  return false;
}

describe("S2.3 baseline boundaries", () => {
  it("records would_reorder instead of emitting a shifted candidate that would collide", () => {
    // A fixed, locked activity sits at 17:30–18:00 inside the window. Keeping the
    // 60-minute afternoon and moving it to the resume time makes it end at 18:00,
    // which runs past that fixed start, so no shifted candidate may be produced.
    const base = scenario();
    const fixed: PlannedActivity = {
      id: "A-FIXED",
      placeId: "P-D",
      startsAt: clock("17:30"),
      endsAt: clock("18:00"),
      priority: "high",
      locked: true,
    };
    const input = resumeAt(
      withActivities(base, insertBefore(base.plan.activities, "A-DINNER", fixed)),
      "17:00",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("no_feasible_candidate");
    expect(result.selected, "selected").toBeUndefined();
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);
    expect(attemptAt(result, 0), "keep").toMatchObject({
      outcome: "checked",
      validation: { verdict: "known_violation" },
    });
    expect(attemptAt(result, 1), "shift").toMatchObject({
      outcome: "not_constructed",
      reasonCode: "would_reorder",
    });
    // Omitting the afternoon leaves 17:00 + 40 + 10 = 17:50, still after 17:30.
    expect(attemptAt(result, 2), "omit").toMatchObject({
      outcome: "checked",
      validation: { verdict: "known_violation" },
    });

    for (const attempt of result.attempts) {
      if (attempt.outcome !== "checked") continue;
      expect(hasOverlap(attempt.candidate.activities), `${attempt.strategy} has no overlap`).toBe(false);
    }
  });

  it("treats the editable range as half-open at both ends", () => {
    // (a) The afternoon ends exactly on the window end, so it stays editable and
    // the shifted candidate ending exactly at 16:30 is still inside the window.
    const base = scenario();
    const accepted = generateBaselineCandidate(windowScope(resumeAt(base, "15:30"), "15:00", "16:30"));
    expect(accepted.status, "a status").toBe("candidate_found");
    expect(accepted.selected?.strategy, "a strategy").toBe("shift");
    expect(candidateActivity(selectedCandidate(accepted), "A-AFTERNOON"), "a afternoon").toMatchObject({
      startsAt: clock("15:30"),
      endsAt: clock("16:30"),
    });
    expect(accepted.selected?.validation.verdict, "a verdict").toBe("feasible");

    // (b) Exactly one minute past the window end, the afternoon is not an editable
    // activity at all, so no shift or omit attempt is made. One minute is the
    // tightest probe of the half-open upper bound.
    const beyond = withActivities(base, replaceActivity(base.plan.activities, "A-AFTERNOON", {
      endsAt: clock("16:01"),
    }));
    const refused = generateBaselineCandidate(windowScope(resumeAt(beyond, "15:30"), "15:00", "16:00"));
    expect(refused.status, "b status").toBe("no_feasible_candidate");
    expect(refused.selected, "b selected").toBeUndefined();
    expect(strategyOrder(refused), "b attempts").toEqual(["keep"]);
  });

  it("does not make an already-started activity adjustable when the window covers it", () => {
    // The window opens at 10:00, before the 14:30 observation, so A-MID satisfies
    // the window test even though it has already started. Its real end is unknown,
    // so it must stay out of the adjustable set: only the afternoon is adjustable.
    const base = scenario();
    const mid: PlannedActivity = {
      id: "A-MID",
      placeId: "P-C",
      startsAt: clock("14:00"),
      endsAt: clock("14:30"),
      priority: "normal",
      locked: false,
    };
    const input = windowScope(
      resumeAt(
        {
          ...base,
          plan: { ...base.plan, activities: insertBefore(base.plan.activities, "A-AFTERNOON", mid) },
        },
        "15:30",
      ),
      "10:00",
      "18:00",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("needs_information");
    expect(result.selected, "selected").toBeUndefined();
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);
    expect(candidateActivity(checkedCandidate(result, "shift"), "A-AFTERNOON"), "shift anchor").toMatchObject({
      startsAt: clock("15:30"),
      endsAt: clock("16:30"),
    });
  });

  it("matches a travel leg by direction, not just by its origin", () => {
    // The observation location is P-B and the target is P-C. The only leg leaving
    // P-B goes to P-A, so there is no P-B -> P-C estimate and the shift anchor must
    // fall back to the resume time. Reading the first leg from P-B would instead
    // anchor the shift on 30 minutes of travel to the wrong place.
    const base = scenario();
    const prior: PlannedActivity = {
      id: "A-PRIOR",
      placeId: "P-B",
      startsAt: clock("13:00"),
      endsAt: clock("14:00"),
      priority: "normal",
      locked: false,
    };
    const travelLegs = [
      ...base.travelLegs.filter((leg) => !(leg.fromPlaceId === "P-B" && leg.toPlaceId === "P-C")),
      { fromPlaceId: "P-B", toPlaceId: "P-A", duration: { kind: "known" as const, minutes: 30 } },
    ];
    const input = resumeAt(
      {
        ...base,
        travelLegs,
        plan: { ...base.plan, activities: insertBefore(base.plan.activities, "A-AFTERNOON", prior) },
        state: {
          ...base.state,
          completedActivityIds: [...base.state.completedActivityIds, "A-PRIOR"],
          location: { kind: "known", placeId: "P-B" },
        },
      },
      "15:00",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("needs_information");
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);
    expect(attemptAt(result, 1), "shift").toMatchObject({
      outcome: "not_constructed",
      reasonCode: "duplicate",
    });
    expect(
      result.issues.some((issue) => issue.code === "unknown_travel_duration" && issue.fromPlaceId === "P-B"),
      "missing P-B to P-C leg reported",
    ).toBe(true);
  });

  it("does not make a completed activity adjustable even when it sits inside the window", () => {
    // The state here is deliberately inconsistent: A-DONE is completed although its
    // planned start is after the observation. That is the only way to isolate the
    // completed-activity exclusion, because a self-consistent state would already
    // exclude it through the observation-time rule.
    const base = scenario();
    const done: PlannedActivity = {
      id: "A-DONE",
      placeId: "P-C",
      startsAt: clock("16:00"),
      endsAt: clock("16:30"),
      priority: "normal",
      locked: false,
    };
    const input = resumeAt(
      {
        ...base,
        plan: { ...base.plan, activities: insertBefore(base.plan.activities, "A-DINNER", done) },
        state: { ...base.state, completedActivityIds: [...base.state.completedActivityIds, "A-DONE"] },
      },
      "15:30",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("candidate_found");
    expect(result.selected?.strategy, "strategy").toBe("omit");
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);
    expect(attemptAt(result, 1), "shift").toMatchObject({
      outcome: "not_constructed",
      reasonCode: "would_reorder",
    });
    expect(candidateActivity(selectedCandidate(result), "A-DONE"), "completed activity untouched").toEqual(done);
  });

  it("does not treat an activity that already started but is unreported as a reliable predecessor", () => {
    // A-EARLY is neither completed nor current, yet its planned 14:00 start is
    // before the 14:30 observation. Its real end is unknown, so the shift must be
    // anchored on the observed location and the resume time instead. The long
    // P-B -> P-C leg makes the two readings differ: 15:30 (correct) vs 16:40.
    const base = scenario();
    const early: PlannedActivity = {
      id: "A-EARLY",
      placeId: "P-B",
      startsAt: clock("14:00"),
      endsAt: clock("15:00"),
      priority: "normal",
      locked: false,
    };
    const travelLegs = base.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-B" && leg.toPlaceId === "P-C"
        ? { ...leg, duration: { kind: "known" as const, minutes: 90 } }
        : leg,
    );
    const input = resumeAt(
      {
        ...base,
        travelLegs,
        plan: { ...base.plan, activities: insertBefore(base.plan.activities, "A-AFTERNOON", early) },
      },
      "15:30",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("needs_information");
    expect(result.selected, "selected").toBeUndefined();
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);
    expect(attemptAt(result, 1), "shift outcome").toMatchObject({ outcome: "checked" });
    expect(candidateActivity(checkedCandidate(result, "shift"), "A-AFTERNOON"), "shift anchor").toMatchObject({
      startsAt: clock("15:30"),
      endsAt: clock("16:30"),
    });
    expect(
      result.issues.some((issue) => issue.code === "activity_progress_unknown"),
      "progress gap preserved",
    ).toBe(true);
  });

  it("protects a reservation-linked activity even when it is not locked", () => {
    const base = scenario();
    const booking: Reservation = {
      id: "R-AFTERNOON",
      placeId: "P-C",
      startsAt: clock("15:00"),
      endsAt: clock("16:00"),
      confirmation: {
        status: "confirmed",
        source: { kind: "fixture", reference: "hand-authored fictional booking" },
        recordedAt: clock("08:00"),
      },
    };
    const input = resumeAt(
      {
        ...base,
        reservations: [...base.reservations, booking],
        plan: {
          ...base.plan,
          activities: replaceActivity(base.plan.activities, "A-AFTERNOON", {
            reservationId: "R-AFTERNOON",
          }),
        },
      },
      "15:30",
    );
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("no_feasible_candidate");
    expect(result.selected, "selected").toBeUndefined();
    expect(strategyOrder(result), "attempts").toEqual(["keep"]);
    expect(attemptAt(result, 0), "keep").toMatchObject({
      outcome: "checked",
      validation: { verdict: "known_violation" },
    });
  });

  it("uses the end of the day, not the dinner start, as the rest_of_day upper bound", () => {
    const base = scenario();
    const evening: PlannedActivity = {
      id: "A-EVENING",
      placeId: "P-D",
      startsAt: clock("20:00"),
      endsAt: clock("21:00"),
      priority: "normal",
      locked: false,
    };
    const withEvening = withActivities(base, [...base.plan.activities, evening]);

    // The default [15:00, 18:00) window excludes the 20:00 activity, so only the
    // afternoon is adjustable and the ordinary shift is selected.
    const window = generateBaselineCandidate(withEvening);
    expect(window.status, "window status").toBe("candidate_found");
    expect(window.selected?.strategy, "window strategy").toBe("shift");
    expect(candidateActivity(selectedCandidate(window), "A-AFTERNOON"), "window afternoon").toMatchObject({
      startsAt: clock("15:30"),
      endsAt: clock("16:30"),
    });

    // Rest of day runs to midnight, so the 20:00 activity becomes adjustable too
    // and the one-activity baseline must refuse rather than claim impossibility.
    const restOfDay = generateBaselineCandidate(restOfDayScope(withEvening, "15:00"));
    expect(restOfDay.status, "rest status").toBe("unsupported_scenario");
    expect(restOfDay.selected, "rest selected").toBeUndefined();
    expect(strategyOrder(restOfDay), "rest attempts").toEqual(["keep", "shift"]);
    expect(attemptAt(restOfDay, 1), "rest reason").toMatchObject({
      outcome: "not_constructed",
      reasonCode: "multiple_editable_activities",
    });
  });
});
