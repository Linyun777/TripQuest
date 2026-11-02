import { describe, expect, it } from "vitest";
import { scheduleDay, validateDayDraft, type DayPlanningInput, type DayRoute, type DaySchedule } from "../index";

const nowMs = Date.parse("2026-10-08T10:00:00+08:00");
function setup() {
  const input: DayPlanningInput = {
    date: "2026-10-15",
    timeZone: "Asia/Shanghai",
    window: { startsAt: 600, endsAt: 720 },
    startPlaceId: "start",
    endPlaceId: "end",
    places: ["start", "visit", "end"].map((placeId) => ({
      placeId, provider: "fiction", externalId: placeId, snapshot: placeId,
    })),
    activities: [{
      activityId: "a", placeId: "visit", role: "required", stayMinutes: 60, staySource: "user",
      opening: { status: "unknown" }, tickets: "unknown",
    }],
    bufferMinutes: 10,
    nowMs,
  };
  const routes: DayRoute[] = [
    { fromPlaceId: "start", toPlaceId: "visit", durationSeconds: 61 },
    { fromPlaceId: "visit", toPlaceId: "end", durationSeconds: 300 },
  ].map((r) => ({
    ...r, status: "known", distanceMeters: 100, provider: "fiction", sourceKind: "fixture",
    retrievedAt: new Date(nowMs).toISOString(),
  }));
  return { input, routes };
}
function schedule(input: DayPlanningInput, routes: DayRoute[]): DaySchedule {
  const result = scheduleDay(input, ["a"], routes);
  expect(result.status).toBe("scheduled");
  if (result.status !== "scheduled") throw new Error("expected schedule");
  return result.schedule;
}

describe("independent hand-calculated day examples", () => {
  it("rounds 61 seconds up, includes both buffers and the final route, but keeps unknown facts pending", () => {
    const { input, routes } = setup();
    const result = schedule(input, routes);
    expect(result.activities[0]).toEqual({
      activityId: "a", placeId: "visit", arrivesAt: 612, startsAt: 612, endsAt: 672, waitMinutes: 0,
    });
    expect(result.endArrival).toBe(687); // 11:27, recorded before the implementation.
    expect(result.totalWalkingMinutes).toBe(7);
    expect(validateDayDraft(input, result, routes).verdict).toBe("pending");
  });

  it("waits for the first opening that fits the whole stay, including latest entry", () => {
    const { input, routes } = setup();
    const opened: DayPlanningInput = { ...input, activities: [{
      ...input.activities[0], tickets: "not_required", opening: {
        status: "known", date: input.date, latestEntry: 630,
        windows: [{ startsAt: 600, endsAt: 620 }, { startsAt: 630, endsAt: 700 }],
      },
    }] };
    const result = schedule(opened, routes);
    expect(result.activities[0]).toMatchObject({ startsAt: 630, endsAt: 690, waitMinutes: 18 });
    expect(result.endArrival).toBe(705);
    expect(validateDayDraft(opened, result, routes).verdict).toBe("checked");
  });

  it("preserves a fixed interval with explicit early wait and rejects late arrival", () => {
    const { input, routes } = setup();
    const fixed: DayPlanningInput = { ...input, activities: [{
      ...input.activities[0], role: "fixed", fixed: { startsAt: 630, endsAt: 690 },
    }] };
    expect(schedule(fixed, routes).activities[0]).toMatchObject({ startsAt: 630, endsAt: 690, waitMinutes: 18 });
    const late = scheduleDay({ ...fixed, window: { startsAt: 620, endsAt: 720 } }, ["a"], routes);
    expect(late).toMatchObject({ status: "not_scheduled", issues: [{ code: "day_fixed_late", expected: 630, actual: 632 }] });
  });

  it("allows exact end arrival and rejects a final-leg overflow", () => {
    const { input, routes } = setup();
    expect(scheduleDay({ ...input, window: { startsAt: 600, endsAt: 687 } }, ["a"], routes).status).toBe("scheduled");
    expect(scheduleDay({ ...input, window: { startsAt: 600, endsAt: 686 } }, ["a"], routes)).toMatchObject({
      status: "not_scheduled", issues: [{ code: "day_window_exceeded", actual: 687 }],
    });
  });

  it("does not use a reverse route or fabricate a timeline for an unknown route", () => {
    const { input, routes } = setup();
    expect(scheduleDay(input, ["a"], [{ ...routes[0], fromPlaceId: "visit", toPlaceId: "start" }, routes[1]])).toMatchObject({
      status: "not_scheduled", issues: [{ code: "day_route_unknown", fromPlaceId: "start", toPlaceId: "visit" }],
    });
  });

  it.each(["omitted", "duplicate", "unknown"])("rejects %s activity references", (kind) => {
    const { input, routes } = setup();
    const order = kind === "omitted" ? [] : kind === "duplicate" ? ["a", "a"] : ["invented"];
    expect(scheduleDay(input, order, routes).status).toBe("not_scheduled");
  });

  it("independently rejects changed stay/fixed times, direction, buffers and aggregates", () => {
    const { input, routes } = setup();
    const original = schedule(input, routes);
    const corruptions: DaySchedule[] = [
      { ...original, activities: [{ ...original.activities[0], endsAt: 670 }] },
      { ...original, legs: [{ ...original.legs[0], bufferMinutes: 0 }, original.legs[1]] },
      { ...original, legs: [{ ...original.legs[0], toPlaceId: "end" }, original.legs[1]] },
      { ...original, endArrival: 600 },
    ];
    corruptions.forEach((draft) => expect(validateDayDraft(input, draft, routes).verdict).toBe("rejected"));
  });

  it("rejects known closed including fixed, and does not apply another date's opening", () => {
    const { input, routes } = setup();
    const closed: DayPlanningInput = { ...input, activities: [{
      ...input.activities[0], role: "fixed", fixed: { startsAt: 630, endsAt: 690 },
      opening: { status: "closed", date: input.date },
    }] };
    expect(validateDayDraft(closed, schedule(closed, routes), routes).verdict).toBe("rejected");
    const otherDate: DayPlanningInput = { ...closed, activities: [{
      ...closed.activities[0], opening: { status: "closed", date: "2026-10-16" },
    }] };
    expect(validateDayDraft(otherDate, schedule(otherDate, routes), routes).verdict).toBe("pending");
  });

  it("only accepts explicit same-identity/snapshot zero travel", () => {
    const { input, routes } = setup();
    const zero: DayRoute = { fromPlaceId: "start", toPlaceId: "visit", status: "same_place_assumption" };
    expect(scheduleDay(input, ["a"], [zero, routes[1]]).status).toBe("not_scheduled");
    const same: DayPlanningInput = { ...input, places: [
      input.places[0], { ...input.places[0], placeId: "visit" }, input.places[2],
    ] };
    expect(schedule(same, [zero, routes[1]]).activities[0].startsAt).toBe(600);
    expect(scheduleDay({ ...same, places: [same.places[0], { ...same.places[1], snapshot: "changed" }, same.places[2]] }, ["a"], [zero, routes[1]]).status).toBe("not_scheduled");
  });

  it("rejects stale/future/mixed evidence at final validation", () => {
    const { input, routes } = setup();
    const result = schedule(input, routes);
    for (const update of [
      { nowMs: nowMs + 300_001 }, { nowMs: nowMs - 1 },
    ]) expect(validateDayDraft({ ...input, ...update }, result, routes).verdict).toBe("rejected");
    expect(validateDayDraft(input, result, [{ ...routes[0], provider: "other" } as DayRoute, routes[1]]).verdict).toBe("rejected");
  });
});
