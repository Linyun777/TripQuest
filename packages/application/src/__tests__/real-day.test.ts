import { describe, expect, it } from "vitest";
import { scheduleDay, validateDayDraft, type DayRoute } from "@tripquest/domain";
import type {
  MobilityProvider,
  PlaceLookupProvider,
  PlaceSummary,
  ProviderEvidence,
} from "@tripquest/providers";
import { buildDayDraft, createDayPlanningProblem, withStays } from "../day-planning";
import {
  createDayDraftConfirmationSnapshot,
  dayDraftSemanticFingerprint,
  fingerprintRequirements,
} from "../day-confirmation";
import { planningRequirementsSchema } from "../planning-requirements";
import {
  confirmRealDay,
  hydrateRealDay,
  storedRealDaySchema,
  type InitialRealDayDraft,
  type RealDayRepository,
} from "../real-day";

// Entirely synthetic "Amap" world: invented IDs, names and coordinates; no captured data.
const NOW = Date.parse("2026-10-15T01:00:00Z");
// Like the real provider, answers are stamped a moment after the request clock.
const evidence = (): ProviderEvidence => ({
  provider: "amap",
  sourceKind: "live",
  attribution: "高德地图",
  retrievedAt: new Date(NOW + 1_000).toISOString(),
});
const place = (index: number, name: string): PlaceSummary => ({
  ref: { provider: "amap", externalId: `SYN${index}` },
  name,
  address: `合成路 ${index} 号`,
  cityAdcode: "330100",
  categoryCode: "140100",
  location: { longitude: 120 + index / 1000, latitude: 30 + index / 1000, coordinateSystem: "gcj02" },
});
const WORLD = [place(0, "合成起点"), place(1, "合成博物馆"), place(2, "合成公园"), place(3, "合成餐厅")];

/** Directed minutes grow with distance in the list; `slower` adds seconds to every leg. */
function fakeAmap(options: { slower?: number; missing?: string[]; failing?: boolean } = {}) {
  const calls = { detail: 0, route: 0 };
  const provider: MobilityProvider & PlaceLookupProvider = {
    async searchPlaces() {
      throw new Error("not used");
    },
    async findPlacesById(ids) {
      calls.detail += 1;
      if (options.failing) {
        return { status: "failure", failure: { code: "timeout", retry: "after_backoff", safeMessage: "超时" }, evidence: evidence() };
      }
      const items = WORLD.filter((item) =>
        ids.includes(item.ref.externalId) && !options.missing?.includes(item.ref.externalId));
      return {
        status: "ok",
        data: { items, missing: ids.filter((id) => !items.some((item) => item.ref.externalId === id)) },
        evidence: evidence(),
      };
    },
    async findRoutes(request) {
      calls.route += 1;
      const from = WORLD.findIndex((item) => item.ref.externalId === request.origin.place.externalId);
      const to = WORLD.findIndex((item) => item.ref.externalId === request.destination.place.externalId);
      return {
        status: "ok",
        routes: [{
          mode: request.mode,
          durationSeconds: 300 + Math.abs(to - from) * 240 + (options.slower ?? 0),
          distanceMeters: 300 + Math.abs(to - from) * 280,
          ...(request.mode === "transit" ? { fareYuan: 4, summary: "合成地铁1号线" } : {}),
        }],
        evidence: evidence(),
      };
    },
  };
  return { provider, calls };
}

const selection = (item: PlaceSummary) => ({ place: item, evidence: evidence() });

/** A real draft built from the same public pieces the S5.2 runner uses. */
/** `modes[i]` is how leg i (start → first stop …) is travelled; walking when absent. */
/**
 * `shortened`（V2.11 估计停留被缩短的那天）：博物馆的停留是卡片估计的 120 分钟，排程时像规划器那样缩到 90；
 * 公园是用户说的 60 分钟。
 */
async function realSnapshot(modes: ("walking" | "transit")[] = [], shortened = false) {
  const requirements = planningRequirementsSchema.parse({
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-16",
    window: { startsAt: "09:00", endsAt: "18:00" },
    startPlace: selection(WORLD[0]),
    endPlace: selection(WORLD[3]),
    interests: [],
    pace: "standard",
    visits: shortened
      ? [
        { place: selection(WORLD[1]), role: "required", stayMinutes: 120, staySource: "estimate" },
        { place: selection(WORLD[2]), role: "required", stayMinutes: 60 },
      ]
      : [
        { place: selection(WORLD[1]), role: "required", stayMinutes: 90 },
        { place: selection(WORLD[2]), role: "fixed", startsAt: "13:00", endsAt: "14:00" },
      ],
  });
  const problem = createDayPlanningProblem({
    requirements,
    runId: "11111111-1111-4111-8111-111111111111",
    requirementsFingerprint: fingerprintRequirements(requirements),
    nowMs: NOW + 2_000,
  });
  const { provider } = fakeAmap();
  const order = problem.activities.map((item) => item.activity.activityId);
  const path = [problem.input.startPlaceId, ...problem.activities.map((item) => item.activity.placeId), problem.input.endPlaceId];
  const routes: DayRoute[] = [];
  const routeEvidence = new Map();
  for (let index = 1; index < path.length; index += 1) {
    const from = problem.places.find((item) => item.placeId === path[index - 1])!.selection.place;
    const to = problem.places.find((item) => item.placeId === path[index])!.selection.place;
    const mode = modes[index - 1] ?? "walking";
    const reply = await provider.findRoutes({
      origin: { place: from.ref, location: from.location },
      destination: { place: to.ref, location: to.location },
      mode,
      cityAdcode: "330100",
      departureAt: "2026-10-16T00:00:00+08:00",
    });
    if (reply.status !== "ok") throw new Error("route");
    routes.push({
      fromPlaceId: path[index - 1],
      toPlaceId: path[index],
      status: "known",
      durationSeconds: reply.routes[0].durationSeconds,
      distanceMeters: reply.routes[0].distanceMeters,
      provider: "amap",
      sourceKind: "live",
      retrievedAt: reply.evidence.retrievedAt,
      ...(mode !== "walking" ? { mode, fareYuan: 4, summary: "合成地铁1号线" } : {}),
    });
    routeEvidence.set(JSON.stringify([path[index - 1], path[index]]), reply.evidence);
  }
  const museum = problem.activities.find((item) => item.floor !== undefined);
  const stays = new Map(shortened && museum ? [[museum.activity.activityId, 90]] : []);
  const input = { ...problem.input, activities: withStays(problem.activities, stays).map((item) => item.activity) };
  const scheduled = scheduleDay(input, order, routes);
  if (scheduled.status !== "scheduled") throw new Error("schedule");
  const draft = buildDayDraft({
    problem,
    places: problem.places,
    activities: problem.activities,
    schedule: scheduled.schedule,
    validation: validateDayDraft(input, scheduled.schedule, routes),
    routeEvidence,
    routes,
    ...(stays.size ? { stays } : {}),
    // The runner builds the draft after its routes arrive.
    createdAt: new Date(NOW + 2_000).toISOString(),
  });
  return createDayDraftConfirmationSnapshot({ problem, places: problem.places, activities: problem.activities, routes, draft });
}

class MemoryRealDays implements RealDayRepository {
  saved: InitialRealDayDraft[] = [];
  async findRealDayCreation(runId: string) {
    const found = this.saved.find((item) => item.creationRunId === runId);
    return found ? { journeyId: found.journeyId, intentFingerprint: found.creationIntentFingerprint } : null;
  }
  async createRealDay(draft: InitialRealDayDraft) {
    this.saved.push(draft);
    return { status: "saved" as const, journeyId: draft.journeyId, planVersion: 1 as const };
  }
}

let counter = 0;
const ids = { next: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` };

async function save(routes: MobilityProvider, repository = new MemoryRealDays(), modes: ("walking" | "transit")[] = [], shortened = false) {
  const snapshot = await realSnapshot(modes, shortened);
  const result = await confirmRealDay({
    snapshot,
    draftFingerprint: dayDraftSemanticFingerprint(snapshot),
    title: "合成真实行程",
    acknowledgeUnknowns: true,
    expiresAt: NOW + 15 * 60_000,
    enabled: true,
    routes,
    repository,
    idGenerator: ids,
    clock: { now: () => new Date(NOW) },
  });
  return { result, repository, snapshot };
}

describe("S5.5 real day: minimal save", () => {
  it("keeps only Amap IDs, names and the plan — no coordinates, addresses, categories or route figures", async () => {
    const { result, repository } = await save(fakeAmap().provider);
    expect(result.status).toBe("saved");
    const [draft] = repository.saved;
    const stored = JSON.stringify({ realDay: draft.realDay, plan: draft.currentPlan, reservations: draft.reservations });
    for (const forbidden of [
      "location", "longitude", "latitude", "address", "合成路", "categoryCode", "140100", "durationSeconds",
      "distanceMeters", "travelMinutes", "retrievedAt", "evidence", "attribution", "legs", "routes",
    ]) {
      expect(stored).not.toContain(forbidden);
    }
    expect(draft.realDay.places.map((item) => [item.externalId, item.name])).toEqual([
      ["SYN0", "合成起点"], ["SYN3", "合成餐厅"], ["SYN1", "合成博物馆"], ["SYN2", "合成公园"],
    ]);
    expect(draft.realDay.activities.map((item) => item.record.activity.role)).toEqual(["required", "fixed"]);
    expect(draft.reservations).toHaveLength(1);
  });

  it("refuses to save when a live route changed since the draft was generated", async () => {
    const { result, repository } = await save(fakeAmap({ slower: 61 }).provider);
    expect(result).toEqual({ status: "draft_changed" });
    expect(repository.saved).toHaveLength(0);
  });

  it("reports a provider outage during the recheck as temporary, not as a changed draft", async () => {
    const down: MobilityProvider = {
      ...fakeAmap().provider,
      async findRoutes() {
        return { status: "failure", failure: { code: "rate_limited", retry: "after_backoff", safeMessage: "频繁" }, evidence: evidence() };
      },
    };
    const { result, repository } = await save(down);
    expect(result).toEqual({ status: "temporarily_unavailable" });
    expect(repository.saved).toHaveLength(0);
  });

  it("replays the same confirmation and rejects a different intent for the same run", async () => {
    const first = await save(fakeAmap().provider);
    const again = await save(fakeAmap().provider, first.repository);
    expect(again.result).toMatchObject({ status: "already_saved", journeyId: first.repository.saved[0].journeyId });
    const snapshot = first.snapshot;
    const other = await confirmRealDay({
      snapshot,
      draftFingerprint: dayDraftSemanticFingerprint(snapshot),
      title: "另一个标题",
      acknowledgeUnknowns: true,
      expiresAt: NOW + 15 * 60_000,
      enabled: true,
      routes: fakeAmap().provider,
      repository: first.repository,
      idGenerator: ids,
      clock: { now: () => new Date(NOW) },
    });
    expect(other).toEqual({ status: "intent_conflict" });
  });
});

describe("V2.11 real day whose estimated stay was shortened (fixed in V3.1)", () => {
  it("saves it with the stay it was scheduled for, keeps the user's own stay, and reopens as checked", async () => {
    const { result, repository, snapshot } = await save(fakeAmap().provider, new MemoryRealDays(), [], true);
    // 修之前这里是“Invalid stored real day”：存的停留还是 120，起止却只隔 90 分钟。
    expect(result.status).toBe("saved");
    const planned = snapshot.draft.activities.map((item) => item.stayMinutes);
    expect(planned).toEqual([90, 60]);
    const details = storedRealDaySchema.parse(repository.saved[0].realDay);
    expect(details.activities.map((item) => [item.record.activity.stayMinutes, item.endsAt - item.startsAt])).toEqual([[90, 90], [60, 60]]);
    expect(details.activities.map((item) => item.record.activity.staySource)).toEqual(["system_estimate", "user"]);
    const check = await hydrateRealDay(details, { places: fakeAmap().provider, routes: fakeAmap().provider, nowMs: NOW });
    expect(check).toMatchObject({ status: "checked", feasible: true });
  });
});

describe("S5.5 real day: reopen re-queries and checks", () => {
  async function saved() {
    const { repository } = await save(fakeAmap().provider);
    return storedRealDaySchema.parse(repository.saved[0].realDay);
  }

  it("rebuilds live details, keeps saved times, and finds them still feasible", async () => {
    const details = await saved();
    const { provider, calls } = fakeAmap();
    const check = await hydrateRealDay(details, { places: provider, routes: provider, nowMs: NOW });
    expect(check).toMatchObject({ status: "checked", feasible: true, renamed: [] });
    if (check.status !== "checked") return;
    expect(check.legs).toHaveLength(3);
    expect(check.legs.every((leg) => leg.travelMinutes !== null)).toBe(true);
    expect(check.places).toHaveLength(4);
    expect(calls).toEqual({ detail: 1, route: 3 });
  });

  it("reports a late arrival when walking now takes much longer", async () => {
    const details = await saved();
    const { provider } = fakeAmap({ slower: 3 * 3600 });
    const check = await hydrateRealDay(details, { places: provider, routes: provider, nowMs: NOW });
    expect(check).toMatchObject({ status: "checked", feasible: false });
    if (check.status !== "checked") return;
    expect(check.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([expect.stringMatching(/day_frozen_changed|day_fixed_late/)]),
    );
  });

  it("stays read-only when a place is gone or Amap fails, without querying routes", async () => {
    const details = await saved();
    const gone = fakeAmap({ missing: ["SYN2"] });
    const missing = await hydrateRealDay(details, { places: gone.provider, routes: gone.provider, nowMs: NOW });
    expect(missing).toMatchObject({ status: "unavailable", reason: "places_missing" });
    if (missing.status === "unavailable") {
      expect(missing.missing).toEqual([details.places.find((item) => item.externalId === "SYN2")!.placeId]);
    }
    expect(gone.calls.route).toBe(0);
    const down = fakeAmap({ failing: true });
    expect(await hydrateRealDay(details, { places: down.provider, routes: down.provider, nowMs: NOW }))
      .toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(down.calls.route).toBe(0);
  });
});

describe("V2.2 real day with transit legs", () => {
  it("saves how each stop is reached and reopens each leg with that same mode", async () => {
    // Leg 2 (first stop → second stop) by subway; the rest walked.
    const { result, repository } = await save(fakeAmap().provider, new MemoryRealDays(), ["walking", "transit"]);
    expect(result.status).toBe("saved");
    const details = storedRealDaySchema.parse(repository.saved[0].realDay);
    expect(details.activities.map((item) => item.arrivalMode)).toEqual([undefined, "transit"]);
    // Still no route figures or fares stored.
    expect(JSON.stringify(details)).not.toMatch(/fareYuan|合成地铁|durationSeconds/);

    const asked: string[] = [];
    const { provider } = fakeAmap();
    const spy: MobilityProvider = { ...provider, findRoutes: (request, options) => { asked.push(request.mode); return provider.findRoutes(request, options); } };
    const check = await hydrateRealDay(details, { places: provider, routes: spy, nowMs: NOW });
    expect(asked).toEqual(["walking", "transit", "walking"]);
    expect(check).toMatchObject({ status: "checked", feasible: true });
    if (check.status === "checked") expect(check.legs[1]).toMatchObject({ mode: "transit", fareYuan: 4, summary: "合成地铁1号线" });
  });

  it("reopens a day whose transit estimate drifted a little as tight, not broken", async () => {
    // Transit into the first stop: the day's first arrival has no slack before it.
    const { repository } = await save(fakeAmap().provider, new MemoryRealDays(), ["transit"]);
    const details = storedRealDaySchema.parse(repository.saved[0].realDay);
    const slower = (seconds: number): MobilityProvider => ({
      ...fakeAmap().provider,
      findRoutes: (request, options) => fakeAmap({ slower: request.mode === "transit" ? seconds : 0 }).provider.findRoutes(request, options),
    });
    const tight = await hydrateRealDay(details, { places: fakeAmap().provider, routes: slower(120), nowMs: NOW });
    expect(tight).toMatchObject({ status: "checked", feasible: true, tightMinutes: 2 });
    const broken = await hydrateRealDay(details, { places: fakeAmap().provider, routes: slower(1800), nowMs: NOW });
    expect(broken).toMatchObject({ status: "checked", feasible: false });
    expect(broken).not.toHaveProperty("tightMinutes");
  });

  it("keeps a small transit drift at save time but refuses a real change", async () => {
    const drift = { ...fakeAmap({ slower: 60 }).provider };
    const slightly = await save(drift, new MemoryRealDays(), ["walking", "transit"]);
    // Walking legs must match exactly, so a uniform 60 s slowdown still changes the walks.
    expect(slightly.result).toEqual({ status: "draft_changed" });

    const transitOnly: MobilityProvider = {
      ...fakeAmap().provider,
      async findRoutes(request, options) {
        const reply = await fakeAmap({ slower: request.mode === "transit" ? 60 : 0 }).provider.findRoutes(request, options);
        return reply;
      },
    };
    expect((await save(transitOnly, new MemoryRealDays(), ["walking", "transit"])).result.status).toBe("saved");
    const bigger: MobilityProvider = {
      ...fakeAmap().provider,
      async findRoutes(request, options) {
        return fakeAmap({ slower: request.mode === "transit" ? 1800 : 0 }).provider.findRoutes(request, options);
      },
    };
    expect((await save(bigger, new MemoryRealDays(), ["walking", "transit"])).result).toEqual({ status: "draft_changed" });
  });
});
