import { applyDraftPatch, emptyOutingDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import type { PlaceSummary, ProviderCallOptions, RouteRequest } from "@tripquest/providers";
import { PlanningFixtureProvider, planningFixturePlaces } from "@tripquest/providers/planning-fixture";

/**
 * V3.1 / V3.2 出游接口测试共用：演示地点扮成高德、本机个人真实模式的环境、一张两天的出游卡片。不发真实请求。
 */
export const NOW = Date.parse("2026-10-08T10:00:00+08:00");
export const SECRET = "s".repeat(40);
// 出游服务把按编号补查到的地点记成高德的实时数据，所以按本机个人真实模式配（AMAP_WEB_SERVICE_KEY 是假的，不会发出去）。
export const ENV = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "amap",
  REAL_PLACE_SAVE_ENABLED: "true",
  AMAP_WEB_SERVICE_KEY: "synthetic-not-sent",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_DRAFT_RECEIPT_SECRET: SECRET,
} as unknown as NodeJS.ProcessEnv;
export const fixture = new PlanningFixtureProvider(() => NOW);
const FIXTURE = planningFixturePlaces()[0]!.ref.provider;
const evidence = () => ({ provider: "amap", sourceKind: "live" as const, attribution: "高德地图", retrievedAt: new Date(NOW).toISOString() });
/** 演示地点扮成高德：编号、搜索、路线都来自演示数据，只把来源换成高德（路线请求换回演示来源再查）。 */
const asAmap = (place: PlaceSummary): PlaceSummary => ({ ...place, ref: { provider: "amap", externalId: place.ref.externalId } });
const places = planningFixturePlaces().map(asAmap);
export const amap = {
  async searchPlaces(...args: Parameters<PlanningFixtureProvider["searchPlaces"]>) {
    // V3.3：选暂定住处时搜“酒店”，演示餐饮小馆扮成一家住宿（分类码换成宾馆酒店）。
    if (args[0].query === "酒店") {
      const hotel = { ...places.find((place) => place.ref.externalId === "DEMO-CAFE")!, categoryCode: "100100" };
      return { status: "ok" as const, data: { items: [hotel], truncated: false }, evidence: evidence() };
    }
    const reply = await fixture.searchPlaces(...args);
    return reply.status === "ok"
      ? { ...reply, data: { ...reply.data, items: reply.data.items.map(asAmap) }, evidence: evidence() }
      : { ...reply, evidence: evidence() };
  },
  async findRoutes(request: RouteRequest, options?: ProviderCallOptions) {
    const back = (endpoint: RouteRequest["origin"]) => ({ ...endpoint, place: { ...endpoint.place, provider: FIXTURE } });
    const reply = await fixture.findRoutes({ ...request, origin: back(request.origin), destination: back(request.destination) }, options);
    return { ...reply, evidence: evidence() };
  },
  async findPlacesById(ids: readonly string[]) {
    const items = places.filter((place) => ids.includes(place.ref.externalId));
    return { status: "ok" as const, data: { items, missing: ids.filter((id) => !items.some((item) => item.ref.externalId === id)) }, evidence: evidence() };
  },
  async getWeatherForecast() {
    return { status: "failure" as const, failure: { code: "unavailable" as const, retry: "later" as const, safeMessage: "no forecast" }, evidence: evidence() };
  },
  async resolveCity() {
    return { status: "ok" as const, data: { adcode: "330100", name: "杭州市" }, evidence: evidence() };
  },
};

/** 两天的出游：从演示起点出发、住演示起点、去演示公园步行街（必去），每天都想去演示博物馆。 */
export function outingCard(): RequirementsDraft {
  const candidates = new Map(places.map((place, index) => [`c${index + 1}`, { externalId: place.ref.externalId, name: place.name, cityAdcode: "330100" }]));
  const applied = applyDraftPatch(emptyOutingDraft({ adcode: "330100", name: "杭州市", source: "located" }), {
    dates: { from: "2026-10-15", to: "2026-10-16" },
    startAt: "09:00",
    endAt: "18:00",
    dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
    start: { candidate: "c1" },
    end: { candidate: "c5" },
    setLodging: [{ nights: [1], place: { candidate: "c1" } }],
    addVisits: [{ place: { candidate: "c4" }, role: "required", stayMinutes: 60 }],
    addInterests: [{ text: "演示博物馆", perDay: true }],
    travel: { allowed: ["walking"], prefer: "balanced" },
  }, candidates);
  if (applied.status !== "ok") throw new Error(applied.code);
  return applied.draft;
}
