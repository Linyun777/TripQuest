import { describe, expect, it, vi } from "vitest";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import {
  assertDaySnapshotIntegrity,
  createDayDraftConfirmationSnapshot,
  fingerprintRequirements,
} from "@tripquest/application/day-confirmation";
import { planningRequirementsSchema } from "@tripquest/application/planning";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import type { DayDecisionContext } from "../day-contracts";

// V2.1: interests in the user's words; the planner writes its own search words and reasons.
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(now()) });
type Free = { id: string; text: string; when?: "morning" | "noon" | "afternoon" | "dusk" | "evening"; count?: number }[];
const problem = (
  weather?: Parameters<typeof createDayPlanningProblem>[0]["weather"],
  freeInterests: Free = [{ id: "i1", text: "看展" }, { id: "i2", text: "喝茶" }],
) => {
  const requirements = planningRequirementsSchema.parse({
    schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai", travelMode: "walking",
    date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: selection(0), endPlace: selection(4), interests: [], pace: "relaxed", visits: [],
    freeInterests,
    notes: "别太累",
  });
  return createDayPlanningProblem({
    runId: "33333333-3333-4333-8333-333333333333",
    requirementsFingerprint: fingerprintRequirements(requirements),
    nowMs: now(),
    weather,
    requirements,
    leaveLate: true,
  });
};

function scripted(steps: ((context: DayDecisionContext) => unknown)[]) {
  const seen: DayDecisionContext[] = [];
  const model = createDayScriptedModel((context) => {
    seen.push(structuredClone(context));
    return steps[seen.length - 1](context);
  });
  return { model, seen };
}

const run = (model: ReturnType<typeof createDayScriptedModel>, provider = new PlanningFixtureProvider(now), input = problem()) =>
  createDayPlanningRunner({ provider, model, now }).run(input, { signal: new AbortController().signal, onProgress: () => {} });

describe("V2.1 free-interest planning", () => {
  it("V2.11 daily: drops nearby results in a neighbouring city", async () => {
    const provider = new PlanningFixtureProvider(now);
    const original = provider.searchPlaces.bind(provider);
    vi.spyOn(provider, "searchPlaces").mockImplementation(async (request, options) => {
      const reply = await original(request, options);
      if (reply.status !== "ok" || !reply.data.items.length) return reply;
      const first = reply.data.items[0];
      const away = { ...first, ref: { ...first.ref, externalId: "AWAY-1" }, name: "邻市博物馆", cityAdcode: "330400" };
      return { ...reply, data: { ...reply.data, items: [...reply.data.items, away] } };
    });
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "stop", reason: "constraints_not_met" }),
    ]);
    await run(model, provider);
    expect(seen[1].searches[0].activityIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen[1])).not.toContain("邻市博物馆");
  });


  it("V3.5: looking for a sight, nearby shops are dropped and the whole city is searched at once; without a kind nothing is dropped", async () => {
    const provider = new PlanningFixtureProvider(now);
    const original = provider.searchPlaces.bind(provider);
    const search = vi.spyOn(provider, "searchPlaces").mockImplementation(async (request, options) => {
      const reply = await original({ ...request, query: "博物馆" }, options);
      if (reply.status !== "ok" || !reply.data.items.length) return reply;
      const first = reply.data.items[0]!;
      // 附近：真实高德在成都东站旁搜“熊猫”的 5 个分类码（旅行社、游客接待中心、快闪店、快收、精酿店）；全城：真正的景点在前面。
      const shop = (id: string, name: string, code: string) => ({ ...first, ref: { ...first.ref, externalId: id }, name, categoryCode: code });
      const items = request.scope.kind === "city"
        ? [shop("SIGHT-1", "演示熊猫基地", "110200"), shop("SHOP-1", "熊猫旅行社", "170200")]
        : [
          shop("SHOP-1", "熊猫旅行社", "170200"),
          shop("SHOP-2", "熊猫游客接待中心", "070100"),
          shop("SHOP-3", "熊猫快闪店", "060000"),
          shop("SHOP-4", "熊猫快收", "070500"),
          shop("SHOP-5", "熊猫精酿", "061210"),
        ];
      return { ...reply, data: { ...reply.data, items } };
    });
    const sight = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "熊猫", anchorPlaceId: "p1", kind: "city_spot" }),
      () => ({ action: "stop", reason: "constraints_not_met" }),
    ]);
    await run(sight.model, provider);
    expect(search.mock.calls.map(([request]) => request.scope.kind)).toEqual(["nearby", "city"]);
    expect(sight.seen[1].searches[0]).toMatchObject({ cityWide: expect.stringContaining("whole city"), excludedCount: 6 });
    expect(JSON.stringify(sight.seen[1])).toContain("演示熊猫基地");
    expect(JSON.stringify(sight.seen[1])).not.toContain("熊猫旅行社");

    search.mockClear();
    const plain = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "熊猫", anchorPlaceId: "p1" }),
      () => ({ action: "stop", reason: "constraints_not_met" }),
    ]);
    await run(plain.model, provider);
    expect(search.mock.calls.map(([request]) => request.scope.kind)).toEqual(["nearby"]);
    expect(JSON.stringify(plain.seen[1])).toContain("熊猫旅行社");
  });

  it("searches with the planner's own words, keeps its stay estimate and shows its reasons", async () => {
    const provider = new PlanningFixtureProvider(now);
    const search = vi.spyOn(provider, "searchPlaces");
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1", stayMinutes: 75 }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮小馆", anchorPlaceId: "p2", stayMinutes: 45 }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0], context.searches[1].activityIds[0]] }),
      (context) => ({
        action: "finish",
        attemptId: context.latestAttempt!.attemptId,
        reasons: {
          [context.searches[0].activityIds[0]]: "满足“看展”，室内展陈 https://example.com",
          [context.searches[1].activityIds[0]]: "满足“喝茶”，离终点近",
        },
      }),
    ]);
    const result = await run(model, provider);
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    // V2.10：演示世界附近的地点不到 3 个，每次搜索都逐级扩到 10、30 公里，扩大后的半径写进观察。
    const radius = (request: (typeof search.mock.calls)[number][0]) => (request.scope.kind === "nearby" ? request.scope.radiusMeters : null);
    expect(search.mock.calls.map(([request]) => [request.query, radius(request)])).toEqual([
      ["博物馆", 3000], ["博物馆", 10_000], ["博物馆", 30_000],
      ["餐饮小馆", 3000], ["餐饮小馆", 10_000], ["餐饮小馆", 30_000],
    ]);
    expect(seen[2].searches.map((item) => item.radiusMeters)).toEqual([30_000, 30_000]);
    expect(result.draft.activities.map((activity) => [activity.interest, activity.stayMinutes, activity.reason])).toEqual([
      ["i1", 75, "满足“看展”，室内展陈"],
      ["i2", 45, "满足“喝茶”，离终点近"],
    ]);
    // The model saw interests in the user's words, the soft notes, and its own earlier queries.
    expect(seen[0].requirements).toMatchObject({
      interests: [{ id: "i1", text: "看展" }, { id: "i2", text: "喝茶" }],
      notes: "别太累",
    });
    expect(seen[1].searches[0]).toMatchObject({ interest: "i1", query: "博物馆" });
  });

  it("refuses unknown interests, searches the whole city once when a search is repeated, then refuses it", async () => {
    const unknown = scripted([
      () => ({ action: "search_places", interestId: "i9", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i8", query: "博物馆", anchorPlaceId: "p1" }),
    ]);
    const provider = new PlanningFixtureProvider(now);
    const search = vi.spyOn(provider, "searchPlaces");
    const refused = await run(unknown.model, provider);
    expect(unknown.seen[1].feedback).toEqual({ code: "interest_not_selected" });
    // V3.4：第二次同样的搜索不拒绝，改在这一天的城市里按相关度搜一次，观察里写明；第三次才拒绝。
    expect(unknown.seen[3].feedback).toBeNull();
    expect(unknown.seen[3].searches[1]).toMatchObject({ query: "博物馆", cityWide: expect.stringContaining("whole city") });
    expect(search.mock.calls.map(([request]) => request.scope.kind)).toEqual(["nearby", "nearby", "nearby", "city"]);
    expect(unknown.seen[4].feedback).toEqual({ code: "duplicate_search" });
    expect(refused).toMatchObject({ status: "failed", code: "semantic_invalid" });

    const reasons = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0]] }),
      (context) => ({
        action: "finish",
        attemptId: context.latestAttempt!.attemptId,
        reasons: { a7: "虚构", [context.searches[0].activityIds[0]]: "很长".repeat(40) },
      }),
    ]);
    let snapshot: unknown;
    const finished = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: reasons.model, now })
      .run(problem(), { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (finished.status !== "completed" || finished.outcome !== "draft") throw new Error(JSON.stringify(finished));
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
    expect(finished.counts.semanticRepairs).toBe(0);
    expect(finished.draft.activities[0].reason).toHaveLength(60);
  });

  it("searches around an area the user named, finding it by name once (V2.2)", async () => {
    const provider = new PlanningFixtureProvider(now);
    const search = vi.spyOn(provider, "searchPlaces");
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", area: "演示公园" }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮小馆", area: "演示公园" }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮", area: "演示公园", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮", area: "虚构不存在" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0], context.searches[1].activityIds[0]] }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    let snapshot: unknown;
    const result = await createDayPlanningRunner({ provider, model, now })
      .run(problem(), { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    // One city lookup for the area, then nearby searches around it (widened: few demo places); the second reuses it.
    expect(search.mock.calls.map(([request]) => [request.query, request.scope.kind])).toEqual([
      ["演示公园", "city"],
      ["博物馆", "nearby"], ["博物馆", "nearby"], ["博物馆", "nearby"],
      ["餐饮小馆", "nearby"], ["餐饮小馆", "nearby"], ["餐饮小馆", "nearby"],
      ["虚构不存在", "city"],
    ]);
    const area = seen[1].places.find((place) => place.name === "演示公园步行街")!;
    expect(seen[1].searches[0]).toMatchObject({ area: "演示公园", anchorPlaceId: area.placeId });
    expect(seen[3].feedback?.code).toMatch(/^anchor_required/);
    expect(seen[4].searches[2]).toMatchObject({ area: "虚构不存在", failureCode: "area_not_found", activityIds: [] });
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
  });

  it("keeps a spot inside a found place as that place, not a second stop", async () => {
    const provider = new PlanningFixtureProvider(now);
    const park = places.find((place) => place.name === "演示公园步行街")!;
    const gate = { ...park, ref: { ...park.ref, externalId: "DEMO-PARK-GATE" }, name: "演示公园步行街-东门" };
    vi.spyOn(provider, "searchPlaces").mockResolvedValue({
      status: "ok",
      data: { items: [park, gate], truncated: false, excludedCount: 0 },
      evidence: planningFixtureEvidence(now()),
    });
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "公园", anchorPlaceId: "p1" }),
      () => ({ action: "stop", reason: "no_suitable_places" }),
    ]);
    await run(model, provider);
    expect(seen[1].searches[0].activityIds).toHaveLength(1);
    expect(seen[1].places.map((place) => place.name)).not.toContain("演示公园步行街-东门");
  });

  it("answers honestly that nothing fits when the model keeps resending orders that did not fit (V2.3)", async () => {
    // Three 3-hour stops cannot fit 10:00–18:00; the model then resends the same order until
    // its repairs run out. Every try failed on a definite constraint and nothing is protected.
    const order = (context: DayDecisionContext) => ({ action: "try_itinerary", orderedActivityIds: context.searches[0].activityIds.slice(0, 3) });
    const { model } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "演示", anchorPlaceId: "p1", stayMinutes: 180 }),
      order, order, order, order,
    ]);
    const result = await run(model, undefined, problem(undefined, [{ id: "i1", text: "多逛几处", count: 3 }]));
    expect(result).toMatchObject({ status: "completed", outcome: "no_plan", reason: "constraints_not_met" });
  });

  it("refuses a search past the budget with what is still possible, instead of failing the run", async () => {
    const queries = ["博物馆", "公园", "步行街", "花园", "餐饮"];
    const { model, seen } = scripted([
      ...queries.map((query) => () => ({ action: "search_places", interestId: "i1", query, anchorPlaceId: "p1" })),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0]] }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    const result = await run(model);
    expect(seen[5].feedback?.code).toBe("no_searches_left: try_itinerary with the activities found, or stop");
    expect(result).toMatchObject({ status: "completed", outcome: "draft", counts: { searches: 4 } });
  });

  it("refuses more stops for an interest than the user wants, and says which to keep (V2.3)", async () => {
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "演示", anchorPlaceId: "p1" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: context.searches[0].activityIds.slice(0, 2) }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: context.searches[0].activityIds.slice(0, 1) }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    const result = await run(model);
    const [first, second] = seen[1].searches[0].activityIds;
    expect(seen[2].feedback?.code).toBe(`interest_over_count: i1 wants 1, order has ${first},${second}; try ["${first}"]`);
    expect(result).toMatchObject({ status: "completed", outcome: "draft" });
    // Two interests over at once: one refusal names both and an order that fits.
    const both = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      () => ({ action: "search_places", interestId: "i2", query: "公园", anchorPlaceId: "p1" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [...context.searches[0].activityIds, ...context.searches[1].activityIds] }),
      () => ({ action: "stop", reason: "no_suitable_places" }),
    ]);
    await run(both.model, undefined, problem(undefined, [{ id: "i1", text: "看展" }, { id: "i2", text: "逛公园" }]));
    const [m1, m2] = both.seen[2].searches[0].activityIds;
    const [g1, g2] = both.seen[2].searches[1].activityIds;
    expect(both.seen[3].feedback?.code).toBe(
      `interest_over_count: i1 wants 1, order has ${m1},${m2}; i2 wants 1, order has ${g1},${g2}; try ["${m1}","${g1}"]`,
    );
    // Asked for three, three are fine.
    const three = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "演示", anchorPlaceId: "p1" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: context.searches[0].activityIds.slice(0, 3) }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    const counted = await run(three.model, undefined, problem(undefined, [{ id: "i1", text: "多逛几家", count: 3 }]));
    expect(three.seen[2].feedback).toBeNull();
    expect(counted).toMatchObject({ status: "completed", outcome: "draft" });
  });

  it("schedules a timed interest inside its slot, leaving later rather than waiting (V2.3)", async () => {
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0]] }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    let snapshot: unknown;
    const result = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model, now })
      .run(problem(undefined, [{ id: "i1", text: "下午看展", when: "afternoon" }]), {
        signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready),
      });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    expect(seen[1].activities[0].activity.within).toEqual({ startsAt: 720, endsAt: 1080 });
    expect(result.draft.activities[0]).toMatchObject({ startsAt: 720, waitMinutes: 0 });
    expect(result.draft.legs[0].departsAt).toBeGreaterThan(600);
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
  });

  it("suggests the order that puts a morning stop first when it would end too late (V2.3)", async () => {
    const { model, seen } = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "博物馆", anchorPlaceId: "p1", stayMinutes: 90 }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮小馆", anchorPlaceId: "p1", stayMinutes: 90 }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[1].activityIds[0], context.searches[0].activityIds[0]] }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: context.latestAttempt!.suggestedOrder! }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    const result = await run(model, undefined, problem(undefined, [{ id: "i1", text: "上午看展", when: "morning" }, { id: "i2", text: "喝茶" }]));
    const museum = seen[2].searches[0].activityIds[0];
    expect(seen[3].latestAttempt).toMatchObject({ status: "not_scheduled", issues: [{ code: "day_time_of_day", activityId: museum }] });
    expect(seen[3].latestAttempt!.suggestedOrder![0]).toBe(museum);
    expect(result).toMatchObject({ status: "completed", outcome: "draft" });
  });

  it("lets the rules policy plan free interests with their own words, and the snapshot stays saveable", async () => {
    let snapshot: unknown;
    const weather = { dayWeather: "小雨", nightWeather: "小雨", highCelsius: 20, lowCelsius: 15, wet: true };
    // Words the fixture world knows, so the rules policy can find places for them.
    const input = problem(weather, [{ id: "i1", text: "博物馆" }, { id: "i2", text: "餐饮小馆" }]);
    const result = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: createDayScriptedModel(), now })
      .run(input, { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    expect(new Set(result.draft.activities.map((activity) => activity.interest))).toEqual(new Set(["i1", "i2"]));
    // The weather travels with the problem in memory, and the confirmation snapshot accepts it.
    expect(input.weather).toEqual(weather);
    expect(snapshot).toMatchObject({ problem: { weather } });
    expect(() => createDayDraftConfirmationSnapshot(snapshot as never)).not.toThrow();
    // The same integrity check a save receipt runs must accept free interests and weather.
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
  });

  it("V2.10: keeps a stay inside its kind's range and flags an outdoor stop on a stormy day without dropping it", async () => {
    const steps = (): ((context: DayDecisionContext) => unknown)[] => [
      () => ({ action: "search_places", interestId: "i1", query: "公园", anchorPlaceId: "p1", stayMinutes: 600, kind: "city_spot" }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮小馆", anchorPlaceId: "p2", stayMinutes: 300, kind: "food" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0], context.searches[1].activityIds[0]] }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ];
    const storm = { dayWeather: "雷阵雨", nightWeather: "多云", highCelsius: 28, lowCelsius: 20, wet: true };
    let snapshot: unknown;
    const stormy = scripted(steps());
    const result = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: stormy.model, now })
      .run(problem(storm), { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    // 城市景点最多 240、吃饭最多 150：模型给的 600、300 被夹回这类地点的范围。
    expect(result.draft.activities.map((activity) => activity.stayMinutes)).toEqual([240, 150]);
    // 公园（高德分类 1101）在户外，提示雷阵雨；餐馆不提示；两站都还在。
    expect(result.draft.alerts).toEqual([
      { activityId: result.draft.activities[0].activityId, weather: "雷阵雨", advice: expect.stringContaining("户外") },
    ]);
    // 确认时按快照重算，提示和类型都要对得上。
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
    const sunny = scripted(steps());
    const fine = await run(sunny.model, undefined, problem({ dayWeather: "晴", nightWeather: "晴", highCelsius: 25, lowCelsius: 15, wet: false }));
    if (fine.status !== "completed" || fine.outcome !== "draft") throw new Error(JSON.stringify(fine));
    expect(fine.draft.alerts).toBeUndefined();
  });

  it("V2.11: an outdoor stop's alert follows the forecast of the city it is in", async () => {
    const storm = { dayWeather: "雷阵雨", nightWeather: "多云", highCelsius: 28, lowCelsius: 20, wet: true };
    const sunny = { dayWeather: "晴", nightWeather: "晴", highCelsius: 25, lowCelsius: 15, wet: false };
    const base = problem(sunny);
    const split = createDayPlanningProblem({
      runId: base.runId, requirementsFingerprint: base.requirementsFingerprint, nowMs: now(), requirements: base.requirements,
      leaveLate: true, weather: sunny, weatherByCity: { "330100": storm },
    });
    let snapshot: unknown;
    const steps = scripted([
      () => ({ action: "search_places", interestId: "i1", query: "公园", anchorPlaceId: "p1", stayMinutes: 60, kind: "city_spot" }),
      () => ({ action: "search_places", interestId: "i2", query: "餐饮小馆", anchorPlaceId: "p2", stayMinutes: 45, kind: "food" }),
      (context) => ({ action: "try_itinerary", orderedActivityIds: [context.searches[0].activityIds[0], context.searches[1].activityIds[0]] }),
      (context) => ({ action: "finish", attemptId: context.latestAttempt!.attemptId }),
    ]);
    const result = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: steps.model, now })
      .run(split, { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error(JSON.stringify(result));
    expect(result.draft.alerts?.map((alert) => alert.weather)).toEqual(["雷阵雨"]);
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
  });
});

describe("V2.11 stay sources", () => {
  // 10:00–18:00 共 480 分钟：景区 360 分钟加用户说的 100 分钟，再加路上和缓冲就排不下；估计的那站缩到排得下为止。
  const withStays = (estimate: boolean) => {
    const requirements = planningRequirementsSchema.parse({
      schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai", travelMode: "walking",
      date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
      startPlace: selection(0), endPlace: selection(0), interests: [], pace: "standard",
      visits: [
        { place: selection(1), role: "required", stayMinutes: 360, ...(estimate ? { staySource: "estimate", kind: "big_scenic" } : {}) },
        { place: selection(2), role: "required", stayMinutes: 100 },
      ],
    });
    return createDayPlanningProblem({
      runId: "44444444-4444-4444-8444-444444444444",
      requirementsFingerprint: fingerprintRequirements(requirements),
      nowMs: now(),
      requirements,
      leaveLate: true,
    });
  };
  const tryBoth = () => scripted([
    () => ({ action: "try_itinerary", orderedActivityIds: ["a1", "a2"] }),
    (context) => context.latestAttempt?.status === "success"
      ? { action: "finish", attemptId: context.latestAttempt.attemptId }
      : { action: "stop", reason: "constraints_not_met" },
  ]);

  it("shortens an estimated stay to fit, says so, and the snapshot still checks out; a stay the user gave is kept", async () => {
    let snapshot: unknown;
    const estimated = await createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: tryBoth().model, now })
      .run(withStays(true), { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    if (estimated.status !== "completed" || estimated.outcome !== "draft") throw new Error(JSON.stringify(estimated));
    const shortened = estimated.draft.activities[0].stayMinutes;
    expect(shortened).toBeLessThan(360);
    expect(shortened).toBeGreaterThanOrEqual(180);
    expect(estimated.draft.activities[1].stayMinutes).toBe(100);
    expect(estimated.draft.assumptions.some((item) => item.includes("原估 6 小时"))).toBe(true);
    expect(() => assertDaySnapshotIntegrity(snapshot as never, true, "fixture")).not.toThrow();
    // 改了方案里的停留（低于下限）就对不上。
    const forged = structuredClone(snapshot) as { draft: { activities: { stayMinutes: number }[] } };
    forged.draft.activities[0].stayMinutes = 60;
    expect(() => assertDaySnapshotIntegrity(forged as never, true, "fixture")).toThrow();

    const said = await run(tryBoth().model, new PlanningFixtureProvider(now), withStays(false));
    expect(said).toMatchObject({ status: "completed", outcome: "no_plan" });
  });
});
