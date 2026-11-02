import { describe, expect, it } from "vitest";
import { scheduleDay, validateDayDraft, type DayActivity, type DayPlanningInput, type DayRoute, type DaySchedule } from "../index";

// V2.3: a stop the user wants at a time of day (`within`), and leaving later instead of
// waiting before the first stop (`leaveLate`). Figures below were worked out by hand first.
const nowMs = Date.parse("2026-10-08T10:00:00+08:00");
function setup(activity: Partial<DayActivity> = {}, input: Partial<DayPlanningInput> = {}) {
  const base: DayPlanningInput = {
    date: "2026-10-15",
    timeZone: "Asia/Shanghai",
    window: { startsAt: 600, endsAt: 720 },
    startPlaceId: "start",
    endPlaceId: "end",
    places: ["start", "visit", "end"].map((placeId) => ({
      placeId, provider: "fiction", externalId: placeId, snapshot: placeId,
    })),
    activities: [{
      activityId: "a", placeId: "visit", role: "discovered", stayMinutes: 60, staySource: "system_estimate",
      opening: { status: "unknown" }, tickets: "unknown", ...activity,
    }],
    bufferMinutes: 10,
    nowMs,
    ...input,
  };
  // start → visit: 61 s rounds up to 2 min, + 10 buffer = arrive 10:12.
  const routes: DayRoute[] = [
    { fromPlaceId: "start", toPlaceId: "visit", durationSeconds: 61 },
    { fromPlaceId: "visit", toPlaceId: "end", durationSeconds: 300 },
  ].map((r) => ({
    ...r, status: "known", distanceMeters: 100, provider: "fiction", sourceKind: "fixture",
    retrievedAt: new Date(nowMs).toISOString(),
  }));
  return { input: base, routes };
}
function scheduled(input: DayPlanningInput, routes: DayRoute[]): DaySchedule {
  const result = scheduleDay(input, ["a"], routes);
  if (result.status !== "scheduled") throw new Error(JSON.stringify(result));
  return result.schedule;
}

describe("V2.3 time of day", () => {
  it("waits for the stop's time of day, then checks it like any other fact", () => {
    const { input, routes } = setup({ within: { startsAt: 640, endsAt: 720 } });
    const schedule = scheduled(input, routes);
    expect(schedule.activities[0]).toMatchObject({ arrivesAt: 612, startsAt: 640, endsAt: 700, waitMinutes: 28 });
    expect(schedule.endArrival).toBe(715);
    const validation = validateDayDraft(input, schedule, routes);
    expect(validation.issues.map((issue) => issue.code)).not.toContain("day_time_of_day");
  });

  it("refuses a stop that cannot end inside its time of day", () => {
    const { input, routes } = setup({ within: { startsAt: 600, endsAt: 650 } });
    expect(scheduleDay(input, ["a"], routes)).toEqual({
      status: "not_scheduled",
      issues: [{ code: "day_time_of_day", kind: "violation", activityId: "a", expected: 650, actual: 672 }],
    });
  });

  it("finds the same problem in a schedule made elsewhere", () => {
    const { input, routes } = setup();
    const schedule = scheduled(input, routes); // 10:12–11:12, made without the time of day
    const timed: DayPlanningInput = { ...input, activities: [{ ...input.activities[0], within: { startsAt: 600, endsAt: 650 } }] };
    const validation = validateDayDraft(timed, schedule, routes);
    expect(validation.verdict).toBe("rejected");
    expect(validation.issues).toContainEqual({ code: "day_time_of_day", kind: "violation", activityId: "a" });
  });

  it("leaves later instead of waiting before the first stop, and the check accepts only that", () => {
    const { input, routes } = setup({ within: { startsAt: 640, endsAt: 720 } }, { leaveLate: true });
    const schedule = scheduled(input, routes);
    expect(schedule.legs[0]).toMatchObject({ departsAt: 628, arrivesAt: 640 });
    expect(schedule.activities[0]).toMatchObject({ arrivesAt: 640, startsAt: 640, waitMinutes: 0 });
    expect(schedule.endArrival).toBe(715);
    expect(validateDayDraft(input, schedule, routes).issues.map((issue) => issue.code)).not.toContain("day_schedule_mismatch");
    // Without the option a late departure is still a mismatch (V1–V2.2 data keep their meaning).
    const strict: DayPlanningInput = { ...input, leaveLate: undefined };
    expect(validateDayDraft(strict, schedule, routes).issues.map((issue) => issue.code)).toContain("day_schedule_mismatch");
    // Leaving before the window opens is never accepted.
    const early = { ...schedule, legs: [{ ...schedule.legs[0], departsAt: 590, arrivesAt: 602 }, ...schedule.legs.slice(1)] };
    expect(validateDayDraft(input, early, routes).issues.map((issue) => issue.code)).toContain("day_schedule_mismatch");
  });

  it("leaves each stop later too, so free time is spent where the user already is", () => {
    // Two stops: "b" free at 10:12–10:42, then "a" wanted from 11:30. Without leaveLate the
    // traveller would arrive at "a" at 10:54 and wait 36 minutes there.
    const { input } = setup({ within: { startsAt: 690, endsAt: 720 }, stayMinutes: 25 }, {
      places: ["start", "visit", "other", "end"].map((placeId) => ({ placeId, provider: "fiction", externalId: placeId, snapshot: placeId })),
      window: { startsAt: 600, endsAt: 760 },
    });
    const two: DayPlanningInput = {
      ...input,
      leaveLate: true,
      activities: [...input.activities, {
        activityId: "b", placeId: "other", role: "discovered", stayMinutes: 30, staySource: "system_estimate",
        opening: { status: "unknown" }, tickets: "unknown",
      }],
    };
    const known = (from: string, to: string, seconds: number): DayRoute => ({
      fromPlaceId: from, toPlaceId: to, status: "known", durationSeconds: seconds, distanceMeters: 100,
      provider: "fiction", sourceKind: "fixture", retrievedAt: new Date(nowMs).toISOString(),
    });
    const legs = [known("start", "other", 120), known("other", "visit", 120), known("visit", "end", 300)];
    const result = scheduleDay(two, ["b", "a"], legs);
    if (result.status !== "scheduled") throw new Error(JSON.stringify(result));
    // b 10:12–10:42; the leg to a leaves 11:18 (not 10:42) and arrives 11:30 with no wait.
    expect(result.schedule.legs[1]).toMatchObject({ departsAt: 678, arrivesAt: 690 });
    expect(result.schedule.activities[1]).toMatchObject({ arrivesAt: 690, startsAt: 690, waitMinutes: 0 });
    expect(validateDayDraft(two, result.schedule, legs).issues.map((issue) => issue.code)).not.toContain("day_schedule_mismatch");
    // Leaving a stop before it ends is never accepted.
    const early = { ...result.schedule, legs: result.schedule.legs.map((leg, index) => (index === 1 ? { ...leg, departsAt: 670, arrivesAt: 682 } : leg)) };
    expect(validateDayDraft(two, early, legs).issues.map((issue) => issue.code)).toContain("day_schedule_mismatch");
  });

  it("rejects a time of day that is not a real window", () => {
    const { input, routes } = setup({ within: { startsAt: 700, endsAt: 650 } });
    expect(scheduleDay(input, ["a"], routes)).toMatchObject({ status: "not_scheduled", issues: [{ code: "day_invalid_input" }] });
  });
});
