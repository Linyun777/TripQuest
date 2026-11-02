import { describe, expect, it } from "vitest";
import {
  scheduleReplan,
  validateReplan,
  type DayReplanInput,
} from "../day-adjustment";
import type { DayRoute } from "../day-planning-types";

const nowMs = Date.parse("2026-10-15T06:00:00Z");
const place = (placeId: string) => ({
  placeId,
  provider: "fixture",
  externalId: placeId.toUpperCase(),
  snapshot: `{"name":"${placeId}"}`,
});
const route = (from: string, to: string, seconds: number): DayRoute => ({
  fromPlaceId: from,
  toPlaceId: to,
  status: "known",
  durationSeconds: seconds,
  distanceMeters: seconds,
  provider: "fixture",
  sourceKind: "fixture",
  retrievedAt: new Date(nowMs).toISOString(),
});
// Reported at "here" at 14:20; museum (optional 60), garden (optional 45),
// a 16:00–17:00 fixed booking at "show", ending at "end" by 18:30.
const base: DayReplanInput = {
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  bufferMinutes: 10,
  nowMs,
  places: ["here", "museum", "garden", "show", "end"].map(place),
  resumePlaceId: "here",
  resumesAt: 14 * 60 + 20,
  endPlaceId: "end",
  endsAt: 18 * 60 + 30,
  activities: [
    {
      activityId: "museum", placeId: "museum", role: "optional", stayMinutes: 60,
      staySource: "user", opening: { status: "unknown" }, tickets: "unknown",
    },
    {
      activityId: "garden", placeId: "garden", role: "optional", stayMinutes: 45,
      staySource: "user", opening: { status: "unknown" }, tickets: "unknown",
    },
    {
      activityId: "show", placeId: "show", role: "fixed", stayMinutes: 60,
      staySource: "user", fixed: { startsAt: 960, endsAt: 1020 },
      opening: { status: "unknown" }, tickets: "unknown",
    },
  ],
  frozen: [{ activityId: "show", startsAt: 960, endsAt: 1020 }],
  capacity: 6,
};
const routes = [
  route("here", "museum", 541), // 10 min after rounding up
  route("museum", "show", 900), // 15
  route("here", "garden", 300), // 5
  route("garden", "museum", 300), // 5
  route("museum", "garden", 300),
  route("garden", "show", 600), // 10
  route("show", "end", 1200), // 20
  route("here", "show", 1500), // 25
  route("here", "end", 600), // 10
];

describe("deterministic future scheduling after a report", () => {
  it("starts at the reported place and keeps the frozen fixed booking and its tail", () => {
    const result = scheduleReplan(base, ["garden"], routes);
    if (result.status !== "scheduled") throw new Error(JSON.stringify(result.issues));
    // 14:20 + 5 + 10 buffer = 14:35 garden → 15:20; +10 +10 = 15:40, wait 20 for 16:00.
    expect(result.schedule.activities.map((item) => item.startsAt)).toEqual([875, 960]);
    expect(result.schedule.legs[0]).toMatchObject({ fromPlaceId: "here", departsAt: 860, arrivesAt: 875 });
    expect(result.schedule.activities[1]).toMatchObject({ arrivesAt: 940, waitMinutes: 20 });
    expect(result.schedule.endArrival).toBe(1020 + 20 + 10);
    expect(validateReplan(base, result.schedule, routes).verdict).toBe("pending");
  });

  it("reports the late booking instead of moving it, and refuses to reorder the frozen tail", () => {
    // 14:20 → museum 14:40–15:40 → show arrival 16:05 > 16:00.
    expect(scheduleReplan(base, ["museum"], routes)).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_fixed_late", activityId: "show", expected: 960, actual: 965 }],
    });
    expect(scheduleReplan(base, ["show", "museum"], routes)).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_frozen_changed", activityId: "show" }],
    });
    const moved = { ...base, frozen: [{ activityId: "show", startsAt: 990, endsAt: 1050 }] };
    expect(scheduleReplan(moved, ["garden"], routes)).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_frozen_changed", expected: 990, actual: 960 }],
    });
  });

  it("enforces the remaining capacity left after archived identities", () => {
    const full = { ...base, capacity: 2 };
    expect(scheduleReplan(full, ["museum", "garden"], routes)).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_activity_count" }],
    });
  });

  it("schedules zero future activities as one checked leg to the end, without placeholders", () => {
    const empty = { ...base, activities: [], frozen: [], capacity: 0 };
    const result = scheduleReplan(empty, [], routes);
    if (result.status !== "scheduled") throw new Error("expected direct leg");
    expect(result.schedule).toEqual({
      activities: [],
      legs: [{
        fromPlaceId: "here", toPlaceId: "end", departsAt: 860, arrivesAt: 880,
        travelMinutes: 10, bufferMinutes: 10, distanceMeters: 600, source: "route_estimate",
      }],
      endArrival: 880,
      totalWalkingMinutes: 10,
      longestWalkingMinutes: 10,
    });
    expect(validateReplan(empty, result.schedule, routes).verdict).toBe("checked");
    expect(scheduleReplan({ ...empty, endsAt: 875 }, [], routes)).toMatchObject({
      status: "not_scheduled", issues: [{ code: "day_window_exceeded", actual: 880 }],
    });
    expect(scheduleReplan(empty, [], routes.filter((r) => r.toPlaceId !== "end"))).toMatchObject({
      status: "not_scheduled", issues: [{ code: "day_route_unknown", kind: "unknown" }],
    });
  });

  it("independently rejects forged times, a forged direct leg and a missing frozen tail", () => {
    const result = scheduleReplan(base, ["garden"], routes);
    if (result.status !== "scheduled") throw new Error("expected schedule");
    const shifted = {
      ...result.schedule,
      activities: result.schedule.activities.map((item, index) =>
        index === 0 ? { ...item, startsAt: item.startsAt - 5, endsAt: item.endsAt - 5 } : item),
    };
    expect(validateReplan(base, shifted, routes).issues.map((i) => i.code))
      .toContain("day_schedule_mismatch");
    const withoutTail = { ...result.schedule, activities: result.schedule.activities.slice(0, 1) };
    expect(validateReplan(base, withoutTail, routes).verdict).toBe("rejected");
    const empty = { ...base, activities: [], frozen: [], capacity: 0 };
    const direct = scheduleReplan(empty, [], routes);
    if (direct.status !== "scheduled") throw new Error("expected direct leg");
    const forged = { ...direct.schedule, endArrival: 870 };
    expect(validateReplan(empty, forged, routes)).toMatchObject({
      verdict: "rejected", issues: [{ code: "day_schedule_mismatch" }],
    });
  });

  it("pins a frozen ordinary slot after the anchor: early arrival waits, late arrival is a scope violation", () => {
    // Tail: show 16:00–17:00, then garden planned 17:40–18:25 (originally after another stop).
    const tail = {
      ...base,
      frozen: [
        { activityId: "show", startsAt: 960, endsAt: 1020 },
        { activityId: "garden", startsAt: 1060, endsAt: 1105 },
      ],
      endsAt: 1170,
      capacity: 6,
    };
    const extra = [...routes, route("show", "garden", 600), route("garden", "end", 600)];
    const pinned = scheduleReplan(tail, [], extra);
    if (pinned.status !== "scheduled") throw new Error(JSON.stringify(pinned.issues));
    // 17:00 + 10 + 10 = 17:20 arrival; waits 20 for the planned 17:40 instead of moving earlier.
    expect(pinned.schedule.activities[1]).toMatchObject({ arrivesAt: 1040, startsAt: 1060, waitMinutes: 20 });
    expect(validateReplan(tail, pinned.schedule, extra).verdict).toBe("pending");
    const tooEarly = { ...tail, frozen: [tail.frozen[0], { activityId: "garden", startsAt: 1030, endsAt: 1075 }] };
    expect(scheduleReplan(tooEarly, [], extra)).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_frozen_changed", activityId: "garden", expected: 1030, actual: 1040 }],
    });
  });
});
