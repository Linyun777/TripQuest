import { describe, expect, it } from "vitest";
import {
  scheduleDay,
  validateDayDraft,
  type DayPlanningInput,
  type DayRoute,
  type DaySchedule,
} from "../index";

const nowMs = Date.parse("2026-10-08T02:00:00Z");
const input: DayPlanningInput = {
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  window: { startsAt: 600, endsAt: 710 },
  startPlaceId: "start",
  endPlaceId: "end",
  places: ["start", "first", "middle", "last", "end"].map((placeId) => ({
    placeId,
    provider: "independent-fiction",
    externalId: placeId,
    snapshot: placeId,
  })),
  activities: [
    {
      activityId: "a",
      placeId: "first",
      role: "fixed",
      stayMinutes: 20,
      fixed: { startsAt: 610, endsAt: 630 },
    },
    {
      activityId: "b",
      placeId: "middle",
      role: "required",
      stayMinutes: 30,
    },
    {
      activityId: "c",
      placeId: "last",
      role: "fixed",
      stayMinutes: 20,
      fixed: { startsAt: 680, endsAt: 700 },
    },
  ].map((activity) => ({
    ...activity,
    role: activity.role as "fixed" | "required",
    staySource: "user",
    tickets: "not_required",
    opening: activity.activityId === "b"
      ? {
          status: "known",
          date: "2026-10-15",
          windows: [{ startsAt: 640, endsAt: 675 }],
          latestEntry: 640,
        }
      : {
          status: "known",
          date: "2026-10-15",
          windows: [{ startsAt: 600, endsAt: 720 }],
        },
  })),
  bufferMinutes: 5,
  nowMs,
};
const routes: DayRoute[] = [
  ["start", "first", 60, 100],
  ["first", "middle", 61, 110],
  ["middle", "last", 120, 120],
  ["last", "end", 300, 130],
].map(([fromPlaceId, toPlaceId, durationSeconds, distanceMeters]) => ({
  fromPlaceId: String(fromPlaceId),
  toPlaceId: String(toPlaceId),
  durationSeconds: Number(durationSeconds),
  distanceMeters: Number(distanceMeters),
  status: "known",
  provider: "independent-fiction",
  sourceKind: "fixture",
  retrievedAt: new Date(nowMs).toISOString(),
}));

// Hand calculation: 10:06 arrival, 4-minute wait; 10:37 arrival, 3-minute wait;
// 11:17 arrival, 3-minute wait; 11:50 return. No expected value comes from scheduleDay.
const expected: DaySchedule = {
  activities: [
    {
      activityId: "a", placeId: "first", arrivesAt: 606,
      startsAt: 610, endsAt: 630, waitMinutes: 4,
    },
    {
      activityId: "b", placeId: "middle", arrivesAt: 637,
      startsAt: 640, endsAt: 670, waitMinutes: 3,
    },
    {
      activityId: "c", placeId: "last", arrivesAt: 677,
      startsAt: 680, endsAt: 700, waitMinutes: 3,
    },
  ],
  legs: [
    {
      fromPlaceId: "start", toPlaceId: "first", departsAt: 600, arrivesAt: 606,
      travelMinutes: 1, bufferMinutes: 5, distanceMeters: 100, source: "route_estimate",
    },
    {
      fromPlaceId: "first", toPlaceId: "middle", departsAt: 630, arrivesAt: 637,
      travelMinutes: 2, bufferMinutes: 5, distanceMeters: 110, source: "route_estimate",
    },
    {
      fromPlaceId: "middle", toPlaceId: "last", departsAt: 670, arrivesAt: 677,
      travelMinutes: 2, bufferMinutes: 5, distanceMeters: 120, source: "route_estimate",
    },
    {
      fromPlaceId: "last", toPlaceId: "end", departsAt: 700, arrivesAt: 710,
      travelMinutes: 5, bufferMinutes: 5, distanceMeters: 130, source: "route_estimate",
    },
  ],
  endArrival: 710,
  totalWalkingMinutes: 10,
  longestWalkingMinutes: 5,
};

describe("independent multi-activity oracle", () => {
  it("matches two protected intervals, opening wait, latest entry and exact return time", () => {
    expect(scheduleDay(input, ["a", "b", "c"], routes))
      .toEqual({ status: "scheduled", schedule: expected });
    expect(validateDayDraft(input, expected, routes)).toEqual({ verdict: "checked", issues: [] });
  });

  it("rejects forged protected times, a missing required visit and a hidden final leg", () => {
    const corruptions: DaySchedule[] = [
      {
        ...expected,
        activities: [
          { ...expected.activities[0], startsAt: 611, endsAt: 631, waitMinutes: 5 },
          ...expected.activities.slice(1),
        ],
      },
      { ...expected, activities: [expected.activities[0], expected.activities[2]] },
      { ...expected, legs: expected.legs.slice(0, -1), endArrival: 700 },
    ];
    for (const draft of corruptions) {
      expect(validateDayDraft(input, draft, routes).verdict).toBe("rejected");
    }
  });

  it("accepts evidence at exactly five minutes and rejects it one millisecond later", () => {
    expect(validateDayDraft({ ...input, nowMs: nowMs + 300_000 }, expected, routes).verdict)
      .toBe("checked");
    expect(validateDayDraft({ ...input, nowMs: nowMs + 300_001 }, expected, routes).verdict)
      .toBe("rejected");
  });
});
