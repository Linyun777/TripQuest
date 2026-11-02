import { describe, expect, it } from "vitest";

import {
  referenceCases,
  validateCandidatePlan,
  type CandidateValidationInput,
  type CheckedTransition,
  type ReferenceCaseId,
} from "../index";

/**
 * Independent S2.2 boundary tests for time, intervals and travel transitions.
 *
 * Every expected arrival below is derived by hand from the design's rule
 * (departsAt + travel minutes + buffer) and compared against the function's
 * own evidence; nothing is copied out of the implementation.
 */

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T[K] extends object
      ? DeepMutable<T[K]>
      : T[K];
};

type MutableInput = DeepMutable<CandidateValidationInput>;

const CHINA_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function caseById(id: ReferenceCaseId) {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`reference case ${id} is missing`);
  return found;
}

function inputFrom(id: ReferenceCaseId): CandidateValidationInput {
  const example = caseById(id);
  return {
    plan: clone(example.input.plan),
    state: clone(example.input.state),
    request: clone(example.input.request),
    candidate: clone(example.candidate),
    reservations: clone(example.input.reservations),
    travelLegs: clone(example.input.travelLegs),
    transferBufferMinutes: example.input.transferBufferMinutes,
  };
}

function mutableFrom(id: ReferenceCaseId): MutableInput {
  return clone(inputFrom(id)) as unknown as MutableInput;
}

function activityIn(input: MutableInput, activityId: string) {
  const found = input.candidate.activities.find((activity) => activity.id === activityId);
  if (found === undefined) throw new Error(`candidate activity ${activityId} is missing`);
  return found;
}

function setTravelMinutes(input: MutableInput, minutes: number): void {
  input.travelLegs = input.travelLegs.map((leg) =>
    leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
      ? { ...leg, duration: { kind: "known", minutes } }
      : leg,
  );
}

/**
 * Writes a value the compile-time contract rejects, on purpose, so the runtime
 * check can be exercised. `ChinaDateTime` is only a compile-time hint.
 */
function forceField(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

/** Independent minute arithmetic on a +08:00 date-time. */
function shiftMinutes(value: string, minutes: number): string {
  const match = CHINA_DATE_TIME.exec(value);
  if (match === null) throw new Error(`not a +08:00 date-time: ${value}`);
  const [, year, month, day, hours, mins, seconds] = match;
  const base = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(mins),
    Number(seconds),
  );
  const shifted = new Date(base + minutes * 60_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}+08:00`;
}

function transitionTo(result: { checkedTransitions: readonly CheckedTransition[] }, activityId: string) {
  return result.checkedTransitions.find((transition) => transition.toActivityId === activityId);
}

function codesOf(input: CandidateValidationInput): string[] {
  return validateCandidatePlan(input).issues.map((issue) => issue.code);
}

/**
 * Applies one mutation to a fresh C1 input and asserts the verdict, plus the
 * issue code when one is expected.
 *
 * Several cases that share a single branch are deliberately grouped into one
 * `it` to keep the suite readable. The label is attached to every assertion so
 * a merged test still reports which case failed.
 */
function expectVerdict(
  label: string,
  mutate: (input: MutableInput) => void,
  verdict: string,
  code?: string,
): void {
  const input = mutableFrom("C1");
  mutate(input);
  const result = validateCandidatePlan(input);

  expect(result.verdict, `${label} → verdict`).toBe(verdict);
  if (code !== undefined) {
    expect(
      result.issues.map((issue) => issue.code),
      `${label} → issue codes`,
    ).toContain(code);
  }
}

describe("S2.2 boundaries: real dates and offsets", () => {
  it("rejects a calendar date or clock time that does not exist", () => {
    expectVerdict(
      "non-existent calendar date 2026-02-30",
      (input) => {
        input.plan.date = "2026-02-30";
      },
      "invalid_input",
      "invalid_datetime",
    );

    expectVerdict(
      "non-existent hour 25:00",
      (input) => {
        activityIn(input, "A-AFTERNOON").startsAt = "2026-10-15T25:00:00+08:00";
      },
      "invalid_input",
    );
  });

  it("rejects a date-time whose offset is not exactly +08:00", () => {
    expectVerdict(
      "offset omitted",
      (input) => {
        forceField(activityIn(input, "A-AFTERNOON"), "endsAt", "2026-10-15T16:30:00");
      },
      "invalid_input",
      "invalid_datetime",
    );

    expectVerdict(
      "offset +09:00",
      (input) => {
        forceField(activityIn(input, "A-AFTERNOON"), "endsAt", "2026-10-15T16:30:00+09:00");
      },
      "invalid_input",
      "invalid_datetime",
    );
  });

  it("accepts a time zone of Asia/Shanghai only", () => {
    const input = mutableFrom("C1");
    (input.plan as { timeZone: string }).timeZone = "Europe/Berlin";

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
  });
});

describe("S2.2 boundaries: intervals and the plan day", () => {
  it("rejects a zero-length or reversed interval", () => {
    expectVerdict(
      "zero-length 15:30-15:30",
      (input) => {
        const afternoon = activityIn(input, "A-AFTERNOON");
        afternoon.startsAt = "2026-10-15T15:30:00+08:00";
        afternoon.endsAt = "2026-10-15T15:30:00+08:00";
      },
      "invalid_input",
      "invalid_interval",
    );

    expectVerdict(
      "reversed 16:30-15:30",
      (input) => {
        const afternoon = activityIn(input, "A-AFTERNOON");
        afternoon.startsAt = "2026-10-15T16:30:00+08:00";
        afternoon.endsAt = "2026-10-15T15:30:00+08:00";
      },
      "invalid_input",
    );
  });

  it("rejects an activity that starts on the previous day", () => {
    const input = mutableFrom("C1");
    activityIn(input, "A-AFTERNOON").startsAt = "2026-10-14T23:00:00+08:00";

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
    expect(codesOf(input)).toContain("invalid_interval");
  });

  it("rejects an activity that runs one minute past the plan day", () => {
    const input = mutableFrom("C1");
    activityIn(input, "A-DINNER").endsAt = "2026-10-16T00:01:00+08:00";

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
    expect(codesOf(input)).toContain("invalid_interval");
  });

  it("allows an activity that ends exactly at the next midnight", () => {
    const input = mutableFrom("C1");
    activityIn(input, "A-DINNER").endsAt = "2026-10-16T00:00:00+08:00";

    const result = validateCandidatePlan(input);

    expect(result.verdict).not.toBe("invalid_input");
    expect(result.issues.map((issue) => issue.code)).not.toContain("invalid_interval");
  });

  it("rejects candidate activities that are not in time order", () => {
    const input = mutableFrom("C1");
    const activities = input.candidate.activities;
    const afternoonIndex = activities.findIndex((activity) => activity.id === "A-AFTERNOON");
    const dinnerIndex = activities.findIndex((activity) => activity.id === "A-DINNER");
    const swap = activities[afternoonIndex];
    activities[afternoonIndex] = activities[dinnerIndex];
    activities[dinnerIndex] = swap;

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
    expect(codesOf(input)).toContain("invalid_interval");
  });

  it("rejects fractional, negative, non-finite and negative-buffer minute values", () => {
    expectVerdict(
      "fractional travel 12.5",
      (input) => setTravelMinutes(input, 12.5),
      "invalid_input",
      "invalid_number",
    );

    expectVerdict(
      "negative travel -1",
      (input) => setTravelMinutes(input, -1),
      "invalid_input",
      "invalid_number",
    );

    // An emptied number field in the lab page arrives here as NaN.
    expectVerdict(
      "NaN travel",
      (input) => {
        forceField(input.travelLegs[2], "duration", { kind: "known", minutes: Number.NaN });
      },
      "invalid_input",
      "invalid_number",
    );

    expectVerdict(
      "infinite travel",
      (input) => {
        forceField(input.travelLegs[2], "duration", {
          kind: "known",
          minutes: Number.POSITIVE_INFINITY,
        });
      },
      "invalid_input",
    );

    expectVerdict(
      "negative transfer buffer -5",
      (input) => {
        input.transferBufferMinutes = -5;
      },
      "invalid_input",
    );
  });
});

describe("S2.2 boundaries: recomputed arrivals", () => {
  it("proves the hand-derived arrival for C1 and C2", () => {
    // C1: 16:30 + 40 minutes travel + 10 minutes buffer = 17:20, before 18:00.
    const c1 = transitionTo(validateCandidatePlan(inputFrom("C1")), "A-DINNER");
    expect(c1?.departsAt).toBe("2026-10-15T16:30:00+08:00");
    expect(c1?.travelMinutes).toBe(40);
    expect(c1?.bufferMinutes).toBe(10);
    expect(c1?.earliestArrivalAt).toBe("2026-10-15T17:20:00+08:00");
    expect(c1?.nextStartsAt).toBe("2026-10-15T18:00:00+08:00");
    expect(c1?.fromPlaceId).toBe("P-C");
    expect(c1?.toPlaceId).toBe("P-D");

    // C2: 17:50 + 30 + 10 = 18:30, after the unchanged 18:00 dinner.
    const c2 = transitionTo(validateCandidatePlan(inputFrom("C2")), "A-DINNER");
    expect(c2?.departsAt).toBe("2026-10-15T17:50:00+08:00");
    expect(c2?.travelMinutes).toBe(30);
    expect(c2?.earliestArrivalAt).toBe("2026-10-15T18:30:00+08:00");
    expect(c2?.nextStartsAt).toBe("2026-10-15T18:00:00+08:00");
  });

  it("keeps every reported arrival equal to departsAt + travel + buffer", () => {
    for (const id of ["C1", "C2", "C3", "C4", "C5"] as const) {
      const result = validateCandidatePlan(inputFrom(id));
      for (const transition of result.checkedTransitions) {
        expect(transition.earliestArrivalAt).toBe(
          shiftMinutes(transition.departsAt, transition.travelMinutes + transition.bufferMinutes),
        );
      }
    }
  });

  it("accepts an arrival exactly at the next start and rejects one minute later", () => {
    const onTime = mutableFrom("C1");
    setTravelMinutes(onTime, 80); // 16:30 + 80 + 10 = 18:00 exactly.
    const onTimeResult = validateCandidatePlan(onTime);
    expect(onTimeResult.verdict, "arrival 18:00 → verdict").toBe("feasible");
    expect(
      transitionTo(onTimeResult, "A-DINNER")?.earliestArrivalAt,
      "arrival 18:00 → evidence",
    ).toBe("2026-10-15T18:00:00+08:00");

    const late = mutableFrom("C1");
    setTravelMinutes(late, 81); // 16:30 + 81 + 10 = 18:01.
    const lateResult = validateCandidatePlan(late);
    expect(lateResult.verdict, "arrival 18:01 → verdict").toBe("known_violation");
    expect(
      lateResult.issues.map((issue) => issue.code),
      "arrival 18:01 → issue codes",
    ).toContain("travel_conflict");
    expect(
      transitionTo(lateResult, "A-DINNER")?.earliestArrivalAt,
      "arrival 18:01 → evidence",
    ).toBe("2026-10-15T18:01:00+08:00");
  });
});

describe("S2.2 boundaries: same place, zero minutes and missing legs", () => {
  it("exempts a same-place hop from travel and buffer, and needs no leg record for it", () => {
    // The observed location and the first pending activity are both P-C.
    const plain = validateCandidatePlan(inputFrom("C1"));
    const first = plain.checkedTransitions.find(
      (transition) => transition.toActivityId === "A-AFTERNOON",
    );

    expect(first?.fromPlaceId).toBe("P-C");
    expect(first?.toPlaceId).toBe("P-C");
    expect(first?.travelMinutes).toBe(0);
    expect(first?.bufferMinutes).toBe(0);
    expect(first?.earliestArrivalAt).toBe(first?.departsAt);

    // Removing the P-C -> P-D record must not make the same-place hop unknown:
    // no P-C -> P-C record exists, yet the hop is still proven.
    const withoutLeg = mutableFrom("C1");
    withoutLeg.travelLegs = withoutLeg.travelLegs.filter(
      (leg) => !(leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"),
    );
    const result = validateCandidatePlan(withoutLeg);
    const unknownTargets = result.issues
      .filter((issue) => issue.code === "unknown_travel_duration")
      .map((issue) => issue.activityId);

    expect(unknownTargets).not.toContain("A-AFTERNOON");
    expect(transitionTo(result, "A-AFTERNOON")).toBeDefined();
  });

  it("keeps a known zero-minute estimate distinct from a missing one", () => {
    const input = mutableFrom("C1");
    setTravelMinutes(input, 0);

    const result = validateCandidatePlan(input);
    const dinner = transitionTo(result, "A-DINNER");

    // Different places: the zero estimate still carries the transfer buffer.
    expect(dinner?.travelMinutes).toBe(0);
    expect(dinner?.bufferMinutes).toBe(10);
    expect(dinner?.earliestArrivalAt).toBe("2026-10-15T16:40:00+08:00");
    expect(result.issues.map((issue) => issue.code)).not.toContain("unknown_travel_duration");
  });

  it("reports a missing forward leg as insufficient rather than as zero minutes", () => {
    const input = mutableFrom("C1");
    input.travelLegs = input.travelLegs.filter(
      (leg) => !(leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"),
    );

    const result = validateCandidatePlan(input);

    expect(result.verdict).toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_travel_duration");
    expect(transitionTo(result, "A-DINNER")).toBeUndefined();
  });

  it("matches travel legs by direction only", () => {
    // A reverse leg must not stand in for the missing forward leg.
    const reverseOnly = mutableFrom("C1");
    reverseOnly.travelLegs = [
      ...reverseOnly.travelLegs.filter(
        (leg) => !(leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"),
      ),
      { fromPlaceId: "P-D", toPlaceId: "P-C", duration: { kind: "known", minutes: 5 } },
    ];
    const reverseResult = validateCandidatePlan(reverseOnly);
    expect(
      reverseResult.issues.map((issue) => issue.code),
      "reverse leg → issue codes",
    ).toContain("unknown_travel_duration");
    expect(transitionTo(reverseResult, "A-DINNER"), "reverse leg → no dinner proof").toBeUndefined();

    // Both directions of the same pair may coexist without ambiguity.
    const bothDirections = mutableFrom("C1");
    bothDirections.travelLegs = [
      ...bothDirections.travelLegs,
      { fromPlaceId: "P-D", toPlaceId: "P-C", duration: { kind: "known", minutes: 5 } },
    ];
    expect(validateCandidatePlan(bothDirections).verdict, "both directions → verdict").toBe(
      "feasible",
    );
  });

  it("rejects two records for the same direction instead of guessing", () => {
    const input = mutableFrom("C1");
    input.travelLegs = [
      ...input.travelLegs,
      { fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known", minutes: 5 } },
    ];

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
    expect(codesOf(input)).toContain("ambiguous_travel_leg");
  });
});

describe("S2.2 boundaries: delay and unknown positions", () => {
  it("rejects a start before the resume time", () => {
    // The delay ends at 15:30 (C1's earliestResumeAt).
    expectVerdict(
      "unchanged 15:00-16:00 afternoon",
      (input) => {
        activityIn(input, "A-AFTERNOON").startsAt = "2026-10-15T15:00:00+08:00";
        activityIn(input, "A-AFTERNOON").endsAt = "2026-10-15T16:00:00+08:00";
      },
      "known_violation",
      "delay_conflict",
    );

    expectVerdict(
      "one minute early, 15:29",
      (input) => {
        activityIn(input, "A-AFTERNOON").startsAt = "2026-10-15T15:29:00+08:00";
        activityIn(input, "A-AFTERNOON").endsAt = "2026-10-15T16:29:00+08:00";
      },
      "known_violation",
      "delay_conflict",
    );
  });

  it("accepts a start exactly at the resume time and departs then", () => {
    const atResume = mutableFrom("C1");
    activityIn(atResume, "A-AFTERNOON").startsAt = "2026-10-15T15:30:00+08:00";
    activityIn(atResume, "A-AFTERNOON").endsAt = "2026-10-15T16:30:00+08:00";
    expect(validateCandidatePlan(atResume).verdict, "start at 15:30 → verdict").toBe("feasible");

    const result = validateCandidatePlan(inputFrom("C1"));
    const first = result.checkedTransitions.find(
      (transition) => transition.toActivityId === "A-AFTERNOON",
    );
    expect(first?.departsAt, "first pending → departs at resume time").toBe(
      "2026-10-15T15:30:00+08:00",
    );
    // Departing from the observed location, not from a previous activity.
    expect(first?.fromActivityId, "first pending → no preceding activity").toBeUndefined();
  });

  it("handles an observed position that is unknown", () => {
    const unknown = mutableFrom("C1");
    unknown.state.location = { kind: "unknown" };

    const result = validateCandidatePlan(unknown);
    expect(result.verdict, "unknown location → verdict").toBe("insufficient_information");
    expect(result.issues.map((issue) => issue.code), "unknown location → issue codes").toContain(
      "unknown_location",
    );
    expect(transitionTo(result, "A-AFTERNOON"), "unknown location → no invented route").toBeUndefined();

    expectVerdict(
      "unknown location that still carries a place",
      (input) => {
        input.state.location = { kind: "unknown", placeId: "P-C" } as never;
      },
      "invalid_input",
      "invalid_shape",
    );
  });

  it("reports the current activity's real end as unknown and does not depart from it", () => {
    const input = mutableFrom("C1");
    // A-AFTERNOON is the activity in progress at the observation time; it is
    // neither completed nor skipped, so the snapshot stays self-consistent.
    input.state.currentActivityId = "A-AFTERNOON";

    const result = validateCandidatePlan(input);

    expect(result.verdict).not.toBe("invalid_input");
    expect(result.issues.map((issue) => issue.code)).toContain("current_activity_end_unknown");
    expect(
      result.checkedTransitions.some((transition) => transition.fromActivityId === "A-AFTERNOON"),
    ).toBe(false);
  });

  it("rejects a current activity that the state also calls completed", () => {
    const input = mutableFrom("C1");
    input.state.currentActivityId = "A-LUNCH";

    expect(validateCandidatePlan(input).verdict).toBe("invalid_input");
    expect(codesOf(input)).toContain("inconsistent_baseline");
  });
});

describe("S2.2 boundaries: progress against the observation time", () => {
  it("reports an already-started activity whose progress the state does not account for", () => {
    // C1 observes at 14:30. Lunch (12:00-13:00) has already started, but the
    // snapshot no longer calls it completed, skipped or current, so whether it
    // actually happened is unknown and no verdict can be justified from it.
    const input = mutableFrom("C1");
    input.state.completedActivityIds = ["A-MORNING"];

    expect(validateCandidatePlan(input).verdict).toBe("insufficient_information");
    expect(codesOf(input)).toContain("activity_progress_unknown");
  });

  it("does not report unknown progress when every started activity is accounted for", () => {
    // C1 as given: morning and lunch completed, the afternoon is current.
    expect(codesOf(mutableFrom("C1")), "C1 as given").not.toContain("activity_progress_unknown");

    // Recording lunch as skipped accounts for it just as well as completing it.
    const skipped = mutableFrom("C1");
    skipped.state.completedActivityIds = ["A-MORNING"];
    skipped.state.skippedActivityIds = ["A-LUNCH"];
    const result = validateCandidatePlan(skipped);

    expect(result.verdict, "skipped lunch → verdict").not.toBe("invalid_input");
    expect(
      result.issues.map((issue) => issue.code),
      "skipped lunch → issue codes",
    ).not.toContain("activity_progress_unknown");
  });
});
