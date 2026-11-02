import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { StoredJourney } from "@tripquest/application";
import { emptyDraft } from "@tripquest/application/conversation";
import { assertRealDayMatchesJourney, type StoredRealDay } from "@tripquest/application/real-day";
import {
  assertAdjustmentCommit,
  checkRealDayProgress,
  type RealDayAdjustRepository,
} from "@tripquest/application/real-adjust";
import { createDayPlanningRunner, createDayScriptedModel } from "@tripquest/agent/day-planning";
import type { PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import { chatTripOf, requestByIds } from "../adjust-service";
import { createPlanService, type PlanEvent } from "../plan-service";
import { estimateTrip } from "../trip-estimate";
import { tripProgressView } from "../trip-progress-service";
import { MemoryConversations } from "./memory-conversations";

// V2.5 through the plan service: synthetic places and routes only, no provider data.
let NOW = Date.parse("2026-10-16T03:10:00Z"); // 11:10 in Hangzhou, on the trip day
const evidence = (): ProviderEvidence => ({ provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: new Date(NOW).toISOString() });
const at = (externalId: string, name: string, offset: number): PlaceSummary => ({
  ref: { provider: "amap", externalId }, name, cityAdcode: "330100", categoryCode: "050500",
  location: { longitude: 120.1 + offset / 1000, latitude: 30.2 + offset / 1000, coordinateSystem: "gcj02" },
});
const PLACES = [at("SYN-HOME", "合成广场", 0), at("SYN-MUSEUM", "合成博物馆", 1), at("SYN-OPERA", "合成剧场", 2), at("SYN-TEA", "合成茶馆", 3), at("SYN-CAFE", "合成咖啡馆", 4)];
const amap = {
  async searchPlaces(request: { query: string }) {
    const items = /咖啡/.test(request.query) ? [PLACES[4]] : [];
    return { status: "ok" as const, data: { items, truncated: false, excludedCount: 0 }, evidence: evidence() };
  },
  async findPlacesById(ids: readonly string[]) {
    return { status: "ok" as const, data: { items: PLACES.filter((place) => ids.includes(place.ref.externalId)), missing: [] }, evidence: evidence() };
  },
  async findRoutes(request: { mode: string }) {
    return request.mode === "walking"
      ? { status: "ok" as const, routes: [{ mode: "walking" as const, durationSeconds: 600, distanceMeters: 700 }], evidence: evidence() }
      : { status: "no_route" as const, reason: "unsupported_mode" as const, evidence: evidence() };
  },
  async getWeatherForecast() {
    return { status: "failure" as const, failure: { code: "unknown" as const, retry: "never" as const, safeMessage: "x" }, evidence: evidence() };
  },
  // V2.6: "从我这儿重新排": the café is the place nearest to the device.
  async nearestPlace() {
    return { status: "ok" as const, data: { place: PLACES[4], distanceMeters: 30 }, evidence: evidence() };
  },
};
const ENV = {
  NODE_ENV: "development", PLANNING_PLACE_SOURCE: "amap", REAL_PLACE_SAVE_ENABLED: "true", AMAP_WEB_SERVICE_KEY: "test-only",
  PLANNING_SAVE_ENABLED: "true", PLANNING_DRAFT_RECEIPT_SECRET: "test-only-adjust-receipt-secret-0123456789",
} as unknown as NodeJS.ProcessEnv;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [HOME, MUSEUM, OPERA, TEA] = [id(1), id(2), id(3), id(4)];
const [A_MUSEUM, A_OPERA, A_TEA] = [id(11), id(12), id(13)];
const [C1, C2] = [id(51), id(52)];
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Museum 09:30, opera 11:30, tea 14:00, from the square and back; saved as version 1. */
function savedDay(): StoredJourney {
  const stop = (activityId: string, placeId: string, interest: string, startsAt: string, endsAt: string) => ({
    record: {
      activity: {
        activityId, placeId, role: "discovered" as const, stayMinutes: minute(endsAt) - minute(startsAt),
        staySource: "system_estimate" as const, opening: { status: "unknown" as const }, tickets: "unknown" as const,
      },
      interest,
    },
    startsAt: minute(startsAt),
    endsAt: minute(endsAt),
  });
  const realDay: StoredRealDay = {
    schemaVersion: "stored-real-day.v1",
    planVersion: 1,
    context: {
      creationRunId: id(31), requirementsFingerprint: "a".repeat(64), date: "2026-10-16", timeZone: "Asia/Shanghai",
      window: { startsAt: 540, endsAt: 1080 }, startPlaceId: HOME, endPlaceId: HOME, bufferMinutes: 5, pace: "standard",
      interests: [], freeInterests: [{ id: "i1", text: "看展" }, { id: "i2", text: "越剧相关" }, { id: "i3", text: "喝茶" }],
      travel: { allowed: ["walking"], prefer: "balanced" },
    },
    places: [
      { placeId: HOME, provider: "amap", externalId: "SYN-HOME", name: "合成广场" },
      { placeId: MUSEUM, provider: "amap", externalId: "SYN-MUSEUM", name: "合成博物馆" },
      { placeId: OPERA, provider: "amap", externalId: "SYN-OPERA", name: "合成剧场" },
      { placeId: TEA, provider: "amap", externalId: "SYN-TEA", name: "合成茶馆" },
    ],
    activities: [
      stop(A_MUSEUM, MUSEUM, "i1", "09:30", "11:00"),
      stop(A_OPERA, OPERA, "i2", "11:30", "12:30"),
      stop(A_TEA, TEA, "i3", "14:00", "15:00"),
    ],
    acknowledgeUnknowns: true,
  };
  const iso = (value: number) => `2026-10-16T${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}:00+08:00` as const;
  const rows = realDay.activities.map((item) => ({
    id: item.record.activity.activityId, placeId: item.record.activity.placeId,
    startsAt: iso(item.startsAt), endsAt: iso(item.endsAt), priority: "normal" as const, locked: false,
  }));
  return {
    creationKind: "real_day", realDay, journeyId: id(41), title: "合成一日", createdAt: iso(480), updatedAt: iso(480),
    currentObservationVersion: 0,
    currentPlan: { journeyId: id(41), date: "2026-10-16", timeZone: "Asia/Shanghai", version: 1, changeReason: "initial_creation", activities: rows },
    activitySnapshots: rows.map((row, position) => ({ activityId: row.id, position, placeName: realDay.places.find((place) => place.placeId === row.placeId)!.name })),
    reservations: [],
  };
}

/** The repository's checks under its lock, in memory. */
class MemoryJourneys implements RealDayAdjustRepository {
  current = savedDay();
  versions = new Map<number, StoredJourney>([[1, this.current]]);
  confirmed = new Map<string, { intentFingerprint: string; planVersion: number }>();
  async findCurrentJourney() {
    return this.current;
  }
  async findRealDayAdjustment(_journeyId: string, runId: string) {
    return this.confirmed.get(runId) ?? null;
  }
  async commitRealDayProgress(input: Parameters<RealDayAdjustRepository["commitRealDayProgress"]>[0]) {
    const checked = checkRealDayProgress(this.current, input.command);
    if (checked.status !== "ok") return checked.status === "no_change" ? checked : { status: checked.status };
    this.current = { ...this.current, currentObservationVersion: checked.progress.version, dayProgress: { ...checked.progress, recordedAt: input.recordedAt } };
    return { status: "saved" as const, observationVersion: checked.progress.version };
  }
  async commitRealDayAdjustment(input: Parameters<RealDayAdjustRepository["commitRealDayAdjustment"]>[0]) {
    const prior = this.confirmed.get(input.runId);
    if (prior) return prior.intentFingerprint === input.intentFingerprint ? { status: "already_saved" as const, planVersion: prior.planVersion } : { status: "intent_conflict" as const };
    if (this.current.currentPlan.version !== input.basePlanVersion || this.current.currentObservationVersion !== input.baseObservationVersion) return { status: "stale" as const };
    const checked = checkRealDayProgress(this.current, input.progress);
    if (checked.status !== "ok") return { status: "stale" as const };
    assertAdjustmentCommit(this.current, input.adjusted, { completed: checked.progress.completedActivityIds, skipped: checked.progress.skippedActivityIds });
    assertRealDayMatchesJourney(input.adjusted.realDay, { ...input.adjusted.next, reservations: this.current.reservations });
    const version = input.adjusted.next.currentPlan.version;
    this.current = {
      ...this.current, ...input.adjusted.next, realDay: input.adjusted.realDay,
      currentObservationVersion: checked.progress.version, dayProgress: { ...checked.progress, recordedAt: input.confirmedAt },
    };
    this.versions.set(version, this.current);
    this.confirmed.set(input.runId, { intentFingerprint: input.intentFingerprint, planVersion: version });
    return { status: "saved" as const, planVersion: version };
  }
}

function setup() {
  NOW = Date.parse("2026-10-16T03:10:00Z");
  const conversations = new MemoryConversations();
  conversations.conversations.set(C1, {
    id: C1, title: "合成一日", status: "planned", journeyId: id(41), draft: emptyDraft(), messageCount: 4, createdAt: "", updatedAt: "",
  });
  // Four earlier messages: the request, the reply, the plan and its saving.
  conversations.messages.set(C1, ["a", "b", "c", "d"].map((text, index) => ({
    id: id(60 + index), seq: index + 1, role: "assistant" as const, kind: "text" as const, body: { text }, createdAt: "",
  })));
  const journeys = new MemoryJourneys();
  const service = createPlanService({
    environment: ENV,
    now: () => NOW,
    repository: () => conversations,
    journeys: () => journeys,
    amap: () => amap as never,
    runner: async (provider) => createDayPlanningRunner({ provider, model: createDayScriptedModel(), now: () => NOW }),
  });
  const adjust = async (request: Parameters<typeof service.adjust>[1]["request"], expectedCount = 4) => {
    const events: PlanEvent[] = [];
    await service.adjust(C1, { expectedCount, request }, (event) => events.push(event), new AbortController().signal);
    return events.at(-1)!;
  };
  return { conversations, journeys, service, adjust };
}

describe("V2.5 changing the saved trip from the conversation", () => {
  it("plans what is left, shows the change, and confirms it once as version 2", async () => {
    const { journeys, service, adjust, conversations } = setup();
    // The chat sees keys and names only; its keys come back as this version's IDs.
    const { trip, keys } = chatTripOf(journeys.current)!;
    expect(trip.stops.map((stop) => [stop.key, stop.name, stop.status])).toEqual([["s1", "合成博物馆", "todo"], ["s2", "合成剧场", "todo"], ["s3", "合成茶馆", "todo"]]);
    const request = requestByIds({ completed: ["s1"], replace: [{ stop: "s2", interest: "喝咖啡" }] }, keys)!;
    expect(requestByIds({ completed: ["s9"] }, keys)).toBeNull();

    const done = await adjust(request);
    if (done.type !== "done" || !done.receipt) throw new Error(JSON.stringify(done));
    const card = done.messages.find((message) => message.kind === "adjust_card");
    if (card?.kind !== "adjust_card") throw new Error("no card");
    // The order is the planner's; what changed is ours to show.
    const kinds = new Map(card.items.map((item) => [item.name, item.kind]));
    expect(Object.fromEntries(kinds)).toEqual({ 合成博物馆: "done", 合成咖啡馆: "added", 合成茶馆: expect.stringMatching(/kept|moved/), 合成剧场: "removed" });
    expect(card.items.find((item) => item.kind === "added")!.after!.startsAt >= "11:10").toBe(true);
    expect(card).toMatchObject({ note: "合成剧场换成喝咖啡，完成合成博物馆", savedVersion: null, open: true });
    // Nothing changed before the confirm; the offer stores no live figures.
    expect(journeys.current.currentPlan.version).toBe(1);
    expect(JSON.stringify(conversations.messages.get(C1))).not.toMatch(/longitude|latitude|meters|duration/);

    NOW += 60_000;
    expect(await service.confirmAdjust(C1, done.receipt.receipt)).toEqual({ status: "saved", planVersion: 2 });
    expect(await service.confirmAdjust(C1, done.receipt.receipt)).toEqual({ status: "already_saved", planVersion: 2 });
    expect(await service.confirmAdjust(C2, done.receipt.receipt)).toEqual({ status: "invalid_receipt" });
    expect(conversations.messages.get(C1)!.find((message) => message.kind === "adjust_card")).toMatchObject({ body: { savedVersion: 2 } });
    const saved = journeys.current;
    expect(saved.realDay).toMatchObject({
      planVersion: 2,
      archived: [{ activityId: A_MUSEUM, status: "completed" }, { activityId: A_OPERA, status: "skipped" }],
      change: { parentVersion: 1, origin: { placeId: HOME, startsAt: 540 } },
    });
    // The tea house kept its activity; the day goes on from the museum.
    expect(saved.realDay!.activities.map((item) => item.record.activity.activityId)).toContain(A_TEA);
    expect(saved.dayProgress).toMatchObject({ completedActivityIds: [A_MUSEUM], skippedActivityIds: [A_OPERA], locationPlaceId: MUSEUM });

    // The panel shows the whole day: history first, from where it began.
    const view = tripProgressView(saved, C1, new Map())!;
    expect(view.start.name).toBe("合成广场");
    // At 11:15 the user is on the way to the first stop left, timed from 11:10, not from history.
    expect(estimateTrip(view, minute("11:15"), true)).toMatchObject({ position: { kind: "travel", to: 2 }, label: expect.stringContaining("去往合成茶馆") });
    expect(view.stops.map((stop) => [stop.name, stop.status])).toEqual([
      ["合成博物馆", "done"], ["合成剧场", "skipped"], ["合成茶馆", "todo"], ["合成咖啡馆", "todo"],
    ]);
  });

  it("goes on from where the device is when asked, and says so when there is no position (V2.6)", async () => {
    const { journeys, adjust, service } = setup();
    const { keys } = chatTripOf(journeys.current)!;
    const request = { ...requestByIds({ completed: ["s1"] }, keys)!, from: "here" as const };
    const events: PlanEvent[] = [];
    await service.adjust(C1, { expectedCount: 4, request, here: { longitude: 120.1, latitude: 30.2 } }, (event) => events.push(event), new AbortController().signal);
    const steps = events.flatMap((event) => (event.type === "step" ? [event.step.text] : []));
    expect(steps).toContain("从你现在的位置（合成咖啡馆附近）继续排");
    expect(events.at(-1)).toMatchObject({ type: "done", messages: expect.arrayContaining([expect.objectContaining({ kind: "adjust_card" })]) });
    // No point sent: honest, and from the last stop as before.
    const without = await adjust(request, 6);
    expect(without.type).toBe("done");
  });

  it("refuses an offer planned on an older state, and stops already passed or unknown", async () => {
    const { journeys, service, adjust } = setup();
    const { keys } = chatTripOf(journeys.current)!;
    const done = await adjust(requestByIds({ skipped: ["s2"] }, keys)!);
    if (done.type !== "done" || !done.receipt) throw new Error(JSON.stringify(done));
    // An offer is good for 15 minutes.
    NOW += 16 * 60_000;
    expect(await service.confirmAdjust(C1, done.receipt.receipt)).toEqual({ status: "expired" });
    NOW -= 16 * 60_000;
    // Marked on the journey page meanwhile: the offer no longer fits the state.
    await journeys.commitRealDayProgress({
      journeyId: id(41),
      command: {
        reportId: id(90), basePlanVersion: 1, baseObservationVersion: 0, completedActivityIds: [A_MUSEUM], skippedActivityIds: [],
        observedAt: "2026-10-16T11:10+08:00", earliestResumeAt: "2026-10-16T11:10+08:00", location: { kind: "known", placeId: MUSEUM }, noCurrentActivity: true,
      },
      recordedAt: "2026-10-16T11:10:00+08:00",
    });
    expect(await service.confirmAdjust(C1, done.receipt.receipt)).toEqual({ status: "stale" });
    expect(journeys.current.currentPlan.version).toBe(1);
    // A count from before another tab's message is refused before any planning.
    expect(await adjust(requestByIds({ skipped: ["s2"] }, keys)!, 3)).toMatchObject({ type: "refused", status: "conflict" });
  });

  it("estimates where the user is by the plan's clock and their marks", () => {
    const view = tripProgressView(savedDay(), null, new Map())!;
    // 11:15: the museum ended at 11:00 unmarked → asks for a mark rather than guessing.
    expect(estimateTrip(view, minute("11:15"), true)).toMatchObject({ position: { kind: "at", stop: 0 }, states: ["overdue", "next", "todo"] });
    const marked = { ...view, stops: view.stops.map((stop, index) => (index === 0 ? { ...stop, status: "done" as const } : stop)) };
    // Halfway along the walk from the museum (11:00) to the opera (11:30).
    expect(estimateTrip(marked, minute("11:15"), true)).toMatchObject({
      done: 1, total: 3, position: { kind: "travel", from: 0, to: 1, fraction: 0.5, minutesLeft: 15 }, next: { stop: 1 },
    });
    expect(estimateTrip(marked, minute("11:45"), true)).toMatchObject({ position: { kind: "at", stop: 1 }, states: ["done", "current", "next"] });
    // A skipped stop leaves the path; another day shows no position.
    const skipped = { ...marked, stops: marked.stops.map((stop, index) => (index === 1 ? { ...stop, status: "skipped" as const } : stop)) };
    expect(estimateTrip(skipped, minute("11:45"), true)).toMatchObject({ total: 2, position: { kind: "travel", from: 0, to: 2 } });
    expect(estimateTrip(view, minute("11:45"), false).position).toEqual({ kind: "before" });
  });
});
