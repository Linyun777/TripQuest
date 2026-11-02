import { describe, expect, it } from "vitest";
import { scheduleReplan, validateReplan, type DayReplanInput } from "../day-adjustment";
import type { DayRoute, DaySchedule } from "../day-planning-types";

const nowMs = Date.parse("2026-10-16T01:00:00Z");
const input: DayReplanInput = {
  date: "2026-10-16", timeZone: "Asia/Shanghai", bufferMinutes: 5, nowMs,
  places: ["here", "required", "end"].map((placeId) => ({
    placeId, provider: "fixture", externalId: placeId, snapshot: JSON.stringify({ name: placeId }),
  })),
  resumePlaceId: "here", resumesAt: 600, endPlaceId: "end", endsAt: 1080,
  activities: [{
    activityId: "must-visit", placeId: "required", role: "required", stayMinutes: 30,
    staySource: "user", opening: { status: "unknown" }, tickets: "unknown",
  }],
  frozen: [], capacity: 6,
};
const routes: DayRoute[] = [{
  fromPlaceId: "here", toPlaceId: "end", status: "known", durationSeconds: 600,
  distanceMeters: 500, provider: "fixture", sourceKind: "fixture",
  retrievedAt: new Date(nowMs).toISOString(),
}];
const withoutRequired: DaySchedule = {
  activities: [],
  legs: [{
    fromPlaceId: "here", toPlaceId: "end", departsAt: 600, arrivesAt: 615,
    travelMinutes: 10, bufferMinutes: 5, distanceMeters: 500, source: "route_estimate",
  }],
  endArrival: 615, totalWalkingMinutes: 10, longestWalkingMinutes: 10,
};

describe("S5.3.3 independent zero-future protection", () => {
  it("rejects a direct-to-end schedule while an unprocessed required activity still exists", () => {
    expect.soft(scheduleReplan(input, [], routes)).toMatchObject({ status: "not_scheduled" });
    expect.soft(validateReplan(input, withoutRequired, routes).verdict).toBe("rejected");
  });
});
