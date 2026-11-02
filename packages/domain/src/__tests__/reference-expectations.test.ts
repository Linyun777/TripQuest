import { describe, expect, it } from "vitest";

import {
  referenceCases,
  type ChinaDateTime,
  type ReferenceCase,
  type ReferenceCaseId,
  type TimeWindow,
} from "../index";

/**
 * Test-side re-derivation of the hand-written expectations.
 *
 * This is NOT the S2.2 validator. It implements only the rules the S2.1 design
 * states, reads nothing from `expected`, and exists to check that the five
 * human expectations are arithmetically and logically correct. A passing run
 * here says nothing about whether the future validator is correct.
 */

const CHINA_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;

/** Deterministic minute arithmetic on a +08:00 date-time, independent of the machine time zone. */
function shiftMinutes(value: ChinaDateTime, minutes: number): string {
  const match = CHINA_DATE_TIME.exec(value);
  if (match === null) throw new Error(`not a +08:00 date-time: ${value}`);
  const [, date, hours, mins, seconds] = match;
  const base = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    Number(hours),
    Number(mins),
    Number(seconds),
  );
  const shifted = new Date(base + minutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}+08:00`;
}

function isInside(window: TimeWindow, container: TimeWindow): boolean {
  return window.startsAt >= container.startsAt && window.endsAt <= container.endsAt;
}

type DerivedVerdict =
  | { readonly kind: "feasible"; readonly arrivalAtNextLockedActivity: string }
  | { readonly kind: "known_violation"; readonly arrivalAtNextLockedActivity?: string }
  | { readonly kind: "insufficient_information" };

function deriveVerdict(entry: ReferenceCase): DerivedVerdict {
  const { plan, state, request, travelLegs, transferBufferMinutes } = entry.input;
  const baseById = new Map(plan.activities.map((activity) => [activity.id, activity]));

  const changed = entry.candidate.activities.filter((activity) => {
    const base = baseById.get(activity.id);
    if (base === undefined) return true;
    return base.startsAt !== activity.startsAt || base.endsAt !== activity.endsAt;
  });

  for (const activity of changed) {
    const base = baseById.get(activity.id);
    if (base === undefined) return { kind: "known_violation" };
    if (state.completedActivityIds.includes(activity.id)) return { kind: "known_violation" };
    if (base.locked) return { kind: "known_violation" };
    if (request.scope.kind === "selected_window" && !isInside(activity, request.scope.window)) {
      return { kind: "known_violation" };
    }
    if (activity.startsAt < request.delay.earliestResumeAt) return { kind: "known_violation" };
  }

  const lastChanged = changed[changed.length - 1];
  if (lastChanged === undefined) return { kind: "insufficient_information" };

  const candidateOrder = entry.candidate.activities;
  const position = candidateOrder.findIndex((activity) => activity.id === lastChanged.id);
  const nextLocked = candidateOrder
    .slice(position + 1)
    .find((activity) => activity.locked === true);
  if (nextLocked === undefined) return { kind: "insufficient_information" };

  const leg = travelLegs.find(
    (entryLeg) =>
      entryLeg.fromPlaceId === lastChanged.placeId && entryLeg.toPlaceId === nextLocked.placeId,
  );
  if (leg === undefined || leg.duration.kind === "unknown") {
    return { kind: "insufficient_information" };
  }

  const arrival = shiftMinutes(
    lastChanged.endsAt,
    leg.duration.minutes + transferBufferMinutes,
  );
  if (arrival <= nextLocked.startsAt) {
    return { kind: "feasible", arrivalAtNextLockedActivity: arrival };
  }
  return { kind: "known_violation", arrivalAtNextLockedActivity: arrival };
}

function arrivalOf(verdict: DerivedVerdict): string | undefined {
  return verdict.kind === "insufficient_information"
    ? undefined
    : verdict.arrivalAtNextLockedActivity;
}

function caseById(id: ReferenceCaseId): ReferenceCase {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`reference case ${id} is missing`);
  return found;
}

function withTravelMinutes(entry: ReferenceCase, minutes: number): ReferenceCase {
  return {
    ...entry,
    input: {
      ...entry.input,
      travelLegs: entry.input.travelLegs.map((leg) =>
        leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
          ? { ...leg, duration: { kind: "known", minutes, source: "hand_authored_fixture" } }
          : leg,
      ),
    },
  };
}

describe("independent re-derivation of the hand-written expectations", () => {
  it("reproduces the arrival time the human author wrote for C1", () => {
    // 16:30 end + 40 minutes travel + 10 minutes buffer = 17:20, before the 18:00 dinner.
    const derived = deriveVerdict(caseById("C1"));

    expect(derived).toEqual({
      kind: "feasible",
      arrivalAtNextLockedActivity: "2026-10-15T17:20:00+08:00",
    });
  });

  it("reproduces the arrival time the human author wrote for C2", () => {
    // 17:50 end + 30 minutes travel + 10 minutes buffer = 18:30, after the 18:00 dinner starts.
    const derived = deriveVerdict(caseById("C2"));

    expect(derived).toEqual({
      kind: "known_violation",
      arrivalAtNextLockedActivity: "2026-10-15T18:30:00+08:00",
    });
  });

  it("derives the same verdict category as every hand-written expectation", () => {
    const mismatches = referenceCases
      .map((entry) => ({ id: entry.id, derived: deriveVerdict(entry), written: entry.expected }))
      .filter((entry) => entry.derived.kind !== entry.written.kind)
      .map((entry) => `${entry.id}: derived ${entry.derived.kind}, written ${entry.written.kind}`);

    expect(mismatches).toEqual([]);
  });

  it("agrees with every arrival time that the fixtures state", () => {
    const mismatches: string[] = [];

    for (const entry of referenceCases) {
      const derived = deriveVerdict(entry);
      const written = entry.expected;
      if (written.kind === "insufficient_information") continue;

      if (written.arrivalAtNextLockedActivity !== arrivalOf(derived)) {
        mismatches.push(
          `${entry.id}: written ${written.arrivalAtNextLockedActivity}, derived ${arrivalOf(derived)}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("bases the C3 and C4 violations on protected facts, not on timing", () => {
    const { state, plan } = caseById("C3").input;
    const dinner = plan.activities.find((activity) => activity.id === "A-DINNER");
    const movedDinner = caseById("C3").candidate.activities.find(
      (activity) => activity.id === "A-DINNER",
    );

    expect(dinner?.locked).toBe(true);
    expect(movedDinner?.startsAt).not.toBe(dinner?.startsAt);
    expect(state.completedActivityIds).not.toContain("A-DINNER");

    const morning = plan.activities.find((activity) => activity.id === "A-MORNING");
    const movedMorning = caseById("C4").candidate.activities.find(
      (activity) => activity.id === "A-MORNING",
    );

    expect(caseById("C4").input.state.completedActivityIds).toContain("A-MORNING");
    expect(movedMorning?.startsAt).not.toBe(morning?.startsAt);
    expect(morning?.locked).toBe(false);
  });

  it("treats the missing C5 travel time as insufficient, never as feasible or violated", () => {
    const derived = deriveVerdict(caseById("C5"));

    expect(derived.kind).toBe("insufficient_information");
    expect(caseById("C5").expected.kind).toBe("insufficient_information");
  });

  it("isolates the C5 variable: its candidate carries the same schedule as C1", () => {
    const c1 = caseById("C1");
    const c5 = caseById("C5");

    expect(JSON.stringify(c5.candidate.activities)).toBe(JSON.stringify(c1.candidate.activities));
    expect(JSON.stringify(c5.input.plan)).toBe(JSON.stringify(c1.input.plan));
    expect(JSON.stringify(c5.input.travelLegs)).not.toBe(JSON.stringify(c1.input.travelLegs));
    expect(c5.expected.kind).not.toBe(c1.expected.kind);
  });

  it("discriminates: the same case flips verdict when the travel time changes", () => {
    const base = caseById("C1");

    expect(deriveVerdict(withTravelMinutes(base, 40)).kind).toBe("feasible");
    expect(deriveVerdict(withTravelMinutes(base, 80)).kind).toBe("feasible");
    expect(deriveVerdict(withTravelMinutes(base, 81)).kind).toBe("known_violation");
    expect(deriveVerdict(withTravelMinutes(base, 120)).kind).toBe("known_violation");
    expect(arrivalOf(deriveVerdict(withTravelMinutes(base, 81)))).toBe(
      "2026-10-15T18:01:00+08:00",
    );
  });

  it("treats an arrival exactly at the locked start as on time", () => {
    // Assumption declared in the test evidence: arriving at 18:00 for a 18:00 booking counts as
    // on time, so the comparison is arrival <= locked.startsAt.
    const derived = deriveVerdict(withTravelMinutes(caseById("C1"), 80));

    expect(derived).toEqual({
      kind: "feasible",
      arrivalAtNextLockedActivity: "2026-10-15T18:00:00+08:00",
    });
  });

  it("shifts minutes across a day boundary without drifting", () => {
    expect(shiftMinutes("2026-10-15T23:50:00+08:00", 20)).toBe("2026-10-16T00:10:00+08:00");
    expect(shiftMinutes("2026-10-15T00:05:00+08:00", -10)).toBe("2026-10-14T23:55:00+08:00");
  });
});
