import { describe, expect, it } from "vitest";
import { scheduleDay, validateDayDraft, type DayRoute } from "@tripquest/domain";
import type { PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import type { StoredJourney } from "../contracts";
import { createDayDraftConfirmationSnapshot, fingerprintRequirements } from "../day-confirmation";
import { buildDayDraft, createDayPlanningProblem } from "../day-planning";
import type { PlanningRequirements } from "../planning-requirements";
import { assertRealDayMatchesJourney, type StoredRealDay } from "../real-day";
import { buildAdjustedDay, checkRealDayProgress, planAdjustment, prepareAdjustment } from "../real-adjust";

// V2.5: synthetic places, our own routes; no provider data.
const NOW = Date.parse("2026-10-16T02:00:00Z"); // 10:00 on the trip day
const evidence = (): ProviderEvidence => ({ provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: new Date(NOW).toISOString() });
const place = (index: number, name: string): PlaceSummary => ({
  ref: { provider: "amap", externalId: `SYN${index}` }, name, cityAdcode: "330100",
  location: { longitude: 120 + index / 1000, latitude: 30 + index / 1000, coordinateSystem: "gcj02" },
});
const PLACES = [place(0, "合成起点"), place(1, "合成博物馆"), place(2, "合成公园"), place(3, "合成茶馆"), place(4, "合成咖啡馆")];
const selection = (item: PlaceSummary) => ({ place: item, evidence: evidence() });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [START, MUSEUM, PARK, TEA] = [uuid(1), uuid(2), uuid(3), uuid(4)];
const [A_MUSEUM, A_PARK, A_TEA] = [uuid(11), uuid(12), uuid(13)];
const RESERVATION = uuid(21);
const at = (time: string) => `2026-10-16T${time}:00+08:00` as const;
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** A saved real day: museum (required) → park (fixed 13:00–14:00) → tea (discovered). */
function savedDay(): StoredJourney {
  const activity = (activityId: string, placeId: string, role: "required" | "fixed" | "discovered", startsAt: string, endsAt: string) => ({
    record: {
      activity: {
        activityId, placeId, role, stayMinutes: minute(endsAt) - minute(startsAt), staySource: role === "discovered" ? "system_estimate" as const : "user" as const,
        ...(role === "fixed" ? { fixed: { startsAt: minute(startsAt), endsAt: minute(endsAt) } } : {}),
        opening: { status: "unknown" as const }, tickets: "unknown" as const,
      },
      ...(role === "discovered" ? { interest: "i1" } : {}),
    },
    startsAt: minute(startsAt), endsAt: minute(endsAt),
    ...(role === "fixed" ? { reservationId: RESERVATION } : {}),
  });
  const realDay: StoredRealDay = {
    schemaVersion: "stored-real-day.v1",
    planVersion: 1,
    context: {
      creationRunId: uuid(31), requirementsFingerprint: "a".repeat(64), date: "2026-10-16", timeZone: "Asia/Shanghai",
      window: { startsAt: 540, endsAt: 1080 }, startPlaceId: START, endPlaceId: START, bufferMinutes: 5, pace: "standard",
      interests: [], freeInterests: [{ id: "i1", text: "喝茶" }],
    },
    places: [
      { placeId: START, provider: "amap", externalId: "SYN0", name: "合成起点" },
      { placeId: MUSEUM, provider: "amap", externalId: "SYN1", name: "合成博物馆" },
      { placeId: PARK, provider: "amap", externalId: "SYN2", name: "合成公园" },
      { placeId: TEA, provider: "amap", externalId: "SYN3", name: "合成茶馆" },
    ],
    activities: [
      activity(A_MUSEUM, MUSEUM, "required", "09:30", "11:00"),
      activity(A_PARK, PARK, "fixed", "13:00", "14:00"),
      activity(A_TEA, TEA, "discovered", "14:30", "15:30"),
    ],
    acknowledgeUnknowns: true,
  };
  const rows = realDay.activities.map((item) => ({
    id: item.record.activity.activityId, placeId: item.record.activity.placeId,
    startsAt: at(`${String(Math.floor(item.startsAt / 60)).padStart(2, "0")}:${String(item.startsAt % 60).padStart(2, "0")}`),
    endsAt: at(`${String(Math.floor(item.endsAt / 60)).padStart(2, "0")}:${String(item.endsAt % 60).padStart(2, "0")}`),
    priority: item.record.activity.role === "discovered" ? "normal" as const : "high" as const,
    locked: item.record.activity.role === "fixed",
    ...(item.reservationId ? { reservationId: item.reservationId } : {}),
  }));
  return {
    creationKind: "real_day", realDay, journeyId: uuid(41), title: "合成真实行程",
    createdAt: at("08:00"), updatedAt: at("08:00"), currentObservationVersion: 0,
    currentPlan: { journeyId: uuid(41), date: "2026-10-16", timeZone: "Asia/Shanghai", version: 1, changeReason: "initial_creation", activities: rows },
    activitySnapshots: rows.map((row, position) => ({ activityId: row.id, position, placeName: realDay.places.find((item) => item.placeId === row.placeId)!.name })),
    reservations: [{
      placeName: "合成公园",
      reservation: { id: RESERVATION, placeId: PARK, startsAt: at("13:00"), endsAt: at("14:00"), confirmation: { status: "unknown", source: { kind: "user_reported" }, recordedAt: at("08:00") } },
    }],
  };
}
const live = new Map([[START, selection(PLACES[0])], [MUSEUM, selection(PLACES[1])], [PARK, selection(PLACES[2])], [TEA, selection(PLACES[3])]]);
const report = (extra: Record<string, unknown> = {}) => ({
  reportId: uuid(51), basePlanVersion: 1, baseObservationVersion: 0, completedActivityIds: [A_MUSEUM], skippedActivityIds: [],
  observedAt: "2026-10-16T11:05+08:00", earliestResumeAt: "2026-10-16T11:05+08:00", location: { kind: "known" as const, placeId: MUSEUM },
  noCurrentActivity: true as const, ...extra,
});

/** The remainder scheduled in plan order, as the planner would hand it over. */
function planned(requirements: PlanningRequirements, extra: PlaceSummary[] = []) {
  const problem = createDayPlanningProblem({
    requirements, runId: uuid(61), requirementsFingerprint: fingerprintRequirements(requirements), nowMs: NOW, leaveLate: true,
  });
  // Optional extras join as discovered stops (what a search would have found).
  const places = [...problem.places, ...extra.map((item, index) => ({ placeId: `p${problem.places.length + index + 1}`, selection: selection(item) }))];
  const activities = [...problem.activities, ...extra.map((_, index) => ({
    activity: {
      activityId: `a${problem.activities.length + index + 1}`, placeId: `p${problem.places.length + index + 1}`, role: "discovered" as const,
      stayMinutes: 45, staySource: "system_estimate" as const, opening: { status: "unknown" as const }, tickets: "unknown" as const,
    },
    interest: "i1",
  }))];
  const input = { ...problem.input, places: places.map(({ placeId, selection: item }) => ({ placeId, ...item.place.ref, snapshot: JSON.stringify(item.place) })), activities: activities.map((item) => item.activity) };
  const order = activities.map((item) => item.activity.activityId);
  const path = [input.startPlaceId, ...activities.map((item) => item.activity.placeId), input.endPlaceId];
  const routes: DayRoute[] = path.slice(1).map((to, index) => ({
    fromPlaceId: path[index], toPlaceId: to, status: "known", durationSeconds: 600, distanceMeters: 700,
    provider: "amap", sourceKind: "live", retrievedAt: new Date(NOW).toISOString(),
  }));
  const scheduled = scheduleDay(input, order, routes);
  if (scheduled.status !== "scheduled") throw new Error(JSON.stringify(scheduled));
  const draft = buildDayDraft({
    problem: { ...problem, activities, input }, places, activities, schedule: scheduled.schedule,
    validation: validateDayDraft(input, scheduled.schedule, routes), routeEvidence: new Map(), routes, createdAt: new Date(NOW).toISOString(),
  });
  return { draft, snapshot: createDayDraftConfirmationSnapshot({ problem, places, activities, routes, draft }) };
}

describe("V2.5 adjusting a saved real day", () => {
  it("records progress on this day's stops only, at the current versions, and never undoes it", () => {
    const stored = savedDay();
    expect(checkRealDayProgress(stored, report())).toMatchObject({ status: "ok", progress: { version: 1, completedActivityIds: [A_MUSEUM], locationPlaceId: MUSEUM } });
    expect(checkRealDayProgress(stored, report({ completedActivityIds: [uuid(99)] }))).toEqual({ status: "invalid_report" });
    expect(checkRealDayProgress(stored, report({ baseObservationVersion: 1 }))).toEqual({ status: "stale" });
    const first = checkRealDayProgress(stored, report());
    if (first.status !== "ok") throw new Error(first.status);
    const progressed: StoredJourney = { ...stored, currentObservationVersion: 1, dayProgress: { ...first.progress, recordedAt: at("11:05") } };
    // Taking back a done stop is refused; the same state again is no change.
    expect(checkRealDayProgress(progressed, report({ baseObservationVersion: 1, completedActivityIds: [] }))).toEqual({ status: "invalid_report" });
    expect(checkRealDayProgress(progressed, report({ reportId: uuid(52), baseObservationVersion: 1 }))).toEqual({ status: "no_change", observationVersion: 1 });
  });

  it("plans what is left from where and when the user goes on, keeping untouched stops and the appointment", () => {
    const { realDay } = savedDay();
    const prepared = prepareAdjustment({
      details: realDay!, done: { completed: [], skipped: [] }, nowMinute: minute("11:07"), live,
      request: { completed: [A_MUSEUM], skipped: [], replace: [{ activityId: A_TEA, interest: "喝咖啡" }], addInterests: [] },
    });
    if (prepared.status !== "ok") throw new Error(prepared.code);
    expect(prepared.requirements).toMatchObject({
      window: { startsAt: "11:10", endsAt: "18:00" },
      startPlace: { place: { name: "合成博物馆" } },
      visits: [{ role: "fixed", startsAt: "13:00", endsAt: "14:00", place: { place: { name: "合成公园" } } }],
      freeInterests: [{ id: "i1", text: "喝咖啡" }],
    });
    expect(prepared).toMatchObject({ completed: [A_MUSEUM], skipped: [A_TEA], removed: [A_TEA] });
    // An appointment already passed cannot be kept; a stop not in this day is refused.
    const late = prepareAdjustment({ details: realDay!, done: { completed: [A_MUSEUM], skipped: [] }, nowMinute: minute("13:30"), live, request: { completed: [], skipped: [], replace: [], addInterests: [] } });
    expect(late).toEqual({ status: "invalid", code: "fixed_passed" });
    const unknown = prepareAdjustment({ details: realDay!, done: { completed: [], skipped: [] }, nowMinute: 600, live, request: { completed: [uuid(99)], skipped: [], replace: [], addInterests: [] } });
    expect(unknown).toEqual({ status: "invalid", code: "unknown_stop" });
  });

  it("makes the next version: kept stops keep their IDs and booking, done ones are history, the change is marked", () => {
    const stored = savedDay();
    const prepared = prepareAdjustment({
      details: stored.realDay!, done: { completed: [], skipped: [] }, nowMinute: minute("11:07"), live,
      request: { completed: [A_MUSEUM], skipped: [], replace: [{ activityId: A_TEA, interest: "喝咖啡" }], addInterests: [] },
    });
    if (prepared.status !== "ok") throw new Error("prepare");
    const { draft, snapshot } = planned(prepared.requirements!, [PLACES[4]]);
    let n = 100;
    const adjusted = buildAdjustedDay({ stored, prepared, draft, snapshot, note: "茶馆换成喝咖啡", idGenerator: { next: () => uuid(++n) } });
    const { realDay, next, diff } = adjusted;
    expect(realDay).toMatchObject({ planVersion: 2, change: { parentVersion: 1, note: "茶馆换成喝咖啡" } });
    expect(realDay.archived).toEqual([
      { activityId: A_MUSEUM, placeId: MUSEUM, status: "completed", startsAt: 570, endsAt: 660 },
      { activityId: A_TEA, placeId: TEA, status: "skipped", startsAt: 870, endsAt: 930 },
    ]);
    // The park keeps its activity and its booking; the coffee is new.
    expect(realDay.activities.map((item) => [item.record.activity.activityId === A_PARK, item.reservationId === RESERVATION])).toEqual([[true, true], [false, false]]);
    expect(realDay.places.some((item) => item.externalId === "SYN4")).toBe(true);
    // The coffee's interest is the new one, numbered after the day's first interest.
    const coffee = realDay.activities.find((item) => item.record.activity.activityId !== A_PARK)!;
    expect(realDay.context.freeInterests?.find((item) => item.id === coffee.record.interest)?.text).toBe("喝咖啡");
    expect(coffee.record.interest).not.toBe("i1");
    expect(diff.map((item) => [item.kind, item.name])).toEqual([["kept", "合成公园"], ["added", "合成咖啡馆"], ["removed", "合成茶馆"]]);
    // The new version passes the same check as every saved real day.
    expect(() => assertRealDayMatchesJourney(realDay, next)).not.toThrow();
    expect(JSON.stringify(realDay)).not.toMatch(/longitude|latitude|durationSeconds|address/);
  });

  it("when the kept stays overfill what is left, suggests dropping one instead of failing (found in the real run)", async () => {
    const { realDay } = savedDay();
    // 12:20 to 14:30: the 90-minute museum and the 13:00 park cannot both fit.
    const prepared = prepareAdjustment({
      details: realDay!, done: { completed: [], skipped: [] }, nowMinute: minute("12:18"), live,
      request: { completed: [], skipped: [A_TEA], replace: [], addInterests: [], endsAt: "14:30" },
    });
    if (prepared.status !== "ok") throw new Error(prepared.code);
    expect(prepared.requirements).toBeNull();
    const asked: number[] = [];
    const result = await planAdjustment(prepared, async (requirements) => {
      asked.push(requirements.visits.length);
      const { draft, snapshot } = planned(requirements);
      return { result: { status: "completed", outcome: "draft", draft } as never, snapshot };
    });
    // The appointment is never the one proposed; the museum is, and only as a suggestion.
    expect(asked).toEqual([1]);
    expect(result).toMatchObject({ status: "suggest", drop: A_MUSEUM });
  });
});
