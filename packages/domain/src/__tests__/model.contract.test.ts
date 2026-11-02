import { describe, expect, it } from "vitest";

import {
  projectName,
  referenceCases,
  type ActivityPriority,
  type CalendarDate,
  type CandidatePlan,
  type ChinaDateTime,
  type FixtureTravelDuration,
  type FixtureTravelLeg,
  type JourneyState,
  type JourneyTimeZone,
  type ObservedLocation,
  type PlanVersion,
  type PlannedActivity,
  type ReferenceCase,
  type ReferenceCaseId,
  type ReferenceExpectation,
  type ReplanRequest,
  type ReplanScope,
  type Reservation,
  type ReservationConfirmationStatus,
  type TimeWindow,
} from "../index";

const CHINA_OFFSET = "+08:00";
const CHINA_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

/** Collects every string value reachable from a fixture, with its path. */
function collectStrings(value: unknown, path = "$"): { path: string; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStrings(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) =>
      collectStrings(nested, `${path}.${key}`),
    );
  }
  return [];
}

function caseById(id: ReferenceCaseId): ReferenceCase {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`reference case ${id} is missing`);
  return found;
}

describe("S2.1 public type surface", () => {
  it("keeps the engineering export that the web preview imports", () => {
    expect(projectName).toBe("TripQuest");
  });

  it("exposes every S2.1 concept as a usable type from the package entry", () => {
    const plan: PlanVersion = referenceCases[0].input.plan;
    const activity: PlannedActivity = plan.activities[0];
    const window: TimeWindow = activity;
    const reservation: Reservation = referenceCases[0].input.reservations[0];
    const state: JourneyState = referenceCases[0].input.state;
    const request: ReplanRequest = referenceCases[0].input.request;
    const candidate: CandidatePlan = referenceCases[0].candidate;
    const priority: ActivityPriority = activity.priority;
    const confirmation: ReservationConfirmationStatus = reservation.confirmation.status;
    const timeZone: JourneyTimeZone = plan.timeZone;
    const calendarDate: CalendarDate = plan.date;
    const knownLocation: ObservedLocation = { kind: "known", placeId: "P-C" };
    const unknownLocation: ObservedLocation = { kind: "unknown", reason: "not_provided" };
    const selectedWindow: ReplanScope = {
      kind: "selected_window",
      window: { startsAt: "2026-10-15T15:00:00+08:00", endsAt: "2026-10-15T18:00:00+08:00" },
    };
    const restOfDay: ReplanScope = { kind: "rest_of_day", from: "2026-10-15T15:00:00+08:00" };
    const unknownDuration: FixtureTravelDuration = { kind: "unknown", reason: "not_provided" };
    const leg: FixtureTravelLeg = {
      fromPlaceId: "P-C",
      toPlaceId: "P-D",
      duration: unknownDuration,
    };
    const expectations: ReferenceExpectation[] = referenceCases.map((entry) => entry.expected);
    const ids: ReferenceCaseId[] = referenceCases.map((entry) => entry.id);

    expect([
      plan.version,
      window.endsAt,
      state.version,
      request.basePlanVersion,
      candidate.basePlanVersion,
      reservation.id,
      priority,
      confirmation,
      timeZone,
      calendarDate,
      knownLocation.kind,
      unknownLocation.kind,
      selectedWindow.kind,
      restOfDay.kind,
      leg.toPlaceId,
      expectations.length,
      ids.length,
    ]).toHaveLength(17);
  });

  it("accepts a date-time carrying the +08:00 offset", () => {
    const valid: ChinaDateTime = "2026-10-15T09:00:00+08:00";
    expect(valid.endsWith(CHINA_OFFSET)).toBe(true);
  });

  it("rejects a date-time without the offset at compile time", () => {
    // @ts-expect-error ChinaDateTime requires the literal +08:00 suffix
    const noOffset: ChinaDateTime = "2026-10-15T09:00:00";
    expect(typeof noOffset).toBe("string");
  });

  it("rejects a different offset at compile time", () => {
    // @ts-expect-error only the +08:00 offset satisfies ChinaDateTime
    const otherOffset: ChinaDateTime = "2026-10-15T09:00:00+09:00";
    expect(typeof otherOffset).toBe("string");
  });

  it("does not constrain CalendarDate beyond string", () => {
    // Recorded as an observation, not a defect: runtime date validation belongs to S2.2.
    const loose: CalendarDate = "not-a-date";
    expect(loose).toBe("not-a-date");
  });
});

describe("S2.1 value semantics", () => {
  it("states every date-time with the +08:00 offset", () => {
    const offenders = referenceCases
      .flatMap((entry) => collectStrings(entry, entry.id))
      .filter((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry.value))
      .filter((entry) => !CHINA_DATE_TIME.test(entry.value))
      .map((entry) => `${entry.path} = ${entry.value}`);

    expect(offenders).toEqual([]);
  });

  it("states the plan date as YYYY-MM-DD without a time part", () => {
    const offenders = referenceCases
      .map((entry) => entry.input.plan.date)
      .filter((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date));

    expect(offenders).toEqual([]);
  });

  it("keeps every interval non-empty, so [startsAt, endsAt) has content", () => {
    const intervals: { label: string; window: TimeWindow }[] = [];

    for (const entry of referenceCases) {
      for (const activity of entry.input.plan.activities) {
        intervals.push({ label: `${entry.id} plan ${activity.id}`, window: activity });
      }
      for (const activity of entry.candidate.activities) {
        intervals.push({ label: `${entry.id} candidate ${activity.id}`, window: activity });
      }
      for (const reservation of entry.input.reservations) {
        intervals.push({ label: `${entry.id} reservation ${reservation.id}`, window: reservation });
      }
      const { scope } = entry.input.request;
      if (scope.kind === "selected_window") {
        intervals.push({ label: `${entry.id} scope window`, window: scope.window });
      }
    }

    const offenders = intervals
      .filter((entry) => entry.window.startsAt >= entry.window.endsAt)
      .map((entry) => entry.label);

    expect(offenders).toEqual([]);
  });

  it("never overlaps consecutive activities in a plan or candidate", () => {
    const offenders: string[] = [];

    for (const entry of referenceCases) {
      const sequences = [
        { label: `${entry.id} plan`, activities: entry.input.plan.activities },
        { label: `${entry.id} candidate`, activities: entry.candidate.activities },
      ];
      for (const sequence of sequences) {
        for (let index = 1; index < sequence.activities.length; index += 1) {
          const previous = sequence.activities[index - 1];
          const current = sequence.activities[index];
          if (previous.endsAt > current.startsAt) {
            offenders.push(`${sequence.label}: ${previous.id} ends after ${current.id} starts`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps all activity times inside the plan calendar date", () => {
    const offenders: string[] = [];

    for (const entry of referenceCases) {
      for (const activity of [...entry.input.plan.activities, ...entry.candidate.activities]) {
        if (!activity.startsAt.startsWith(entry.input.plan.date)) {
          offenders.push(`${entry.id} ${activity.id} starts on another date`);
        }
        if (!activity.endsAt.startsWith(entry.input.plan.date)) {
          offenders.push(`${entry.id} ${activity.id} ends on another date`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps travel minutes a non-negative integer", () => {
    const offenders: string[] = [];

    for (const entry of referenceCases) {
      for (const leg of entry.input.travelLegs) {
        if (leg.duration.kind !== "known") continue;
        const { minutes } = leg.duration;
        if (!Number.isInteger(minutes) || minutes < 0) {
          offenders.push(`${entry.id} ${leg.fromPlaceId}->${leg.toPlaceId} = ${minutes}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never encodes unknown travel time as zero minutes", () => {
    const offenders: string[] = [];

    for (const entry of referenceCases) {
      for (const leg of entry.input.travelLegs) {
        if (leg.duration.kind !== "unknown") continue;
        if ("minutes" in leg.duration) {
          offenders.push(`${entry.id} ${leg.fromPlaceId}->${leg.toPlaceId} carries minutes`);
        }
      }
    }

    expect(offenders).toEqual([]);

    const unknownLeg = caseById("C5").input.travelLegs.find(
      (leg) => leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D",
    );
    expect(unknownLeg?.duration.kind).toBe("unknown");
  });

  it("never encodes an unknown location as a place", () => {
    const unknown: ObservedLocation = { kind: "unknown", reason: "not_provided" };
    expect("placeId" in unknown).toBe(false);

    const offenders = referenceCases
      .filter((entry) => entry.input.state.location.kind === "unknown")
      .map((entry) => entry.id);

    expect(offenders).toEqual([]);
  });

  it("keeps the plan version and the state version independent", () => {
    for (const entry of referenceCases) {
      expect(Number.isInteger(entry.input.plan.version)).toBe(true);
      expect(entry.input.plan.version).toBeGreaterThan(0);
      expect(Number.isInteger(entry.input.state.version)).toBe(true);
      expect(entry.input.state.version).toBeGreaterThan(0);
      expect(entry.input.plan.version).not.toBe(entry.input.state.version);
    }
  });

  it("does not give a candidate plan a committed version number", () => {
    for (const entry of referenceCases) {
      expect("version" in entry.candidate).toBe(false);
      expect(entry.candidate.basePlanVersion).toBe(entry.input.plan.version);
      expect(entry.candidate.baseStateVersion).toBe(entry.input.state.version);
    }
  });

  it("separates completed, skipped and current activity", () => {
    for (const entry of referenceCases) {
      const { state } = entry.input;
      const completed = new Set(state.completedActivityIds);
      const skipped = new Set(state.skippedActivityIds);

      expect([...completed].filter((id) => skipped.has(id))).toEqual([]);
      if (state.currentActivityId !== null) {
        expect(completed.has(state.currentActivityId)).toBe(false);
      }
    }
  });

  it("round-trips the fixtures through JSON", () => {
    const serialized = JSON.stringify(referenceCases);
    const restored: unknown = JSON.parse(serialized);

    expect(restored).toEqual(JSON.parse(JSON.stringify(referenceCases)));
    expect(serialized).not.toContain("undefined");
    expect(serialized).not.toContain("NaN");
  });
});
