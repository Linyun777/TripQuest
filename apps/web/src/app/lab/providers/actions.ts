"use server";
import { AmapMobilityProvider, HANGZHOU_ADCODE, isAmapEndpoint } from "@tripquest/providers/server";
import { liveConfiguration } from "./live-config";
import type { RouteReply, SearchReply } from "./live-types";

const unavailable = { status: "unavailable" as const, message: "未配置实时服务或当前环境不允许查询。请检查服务端配置并重启。" };
const now = () => new Date().toISOString();
function provider() {
  return new AmapMobilityProvider({ key: process.env.AMAP_WEB_SERVICE_KEY ?? "", fetch: globalThis.fetch, now });
}
export async function searchLivePlaces(query: unknown): Promise<SearchReply> {
  if (liveConfiguration() !== "ready") return unavailable;
  if (typeof query !== "string" || query.trim().length < 1 || query.trim().length > 80) return { status: "unavailable", message: "请输入 1–80 字符的杭州地点名称。" };
  return { status: "result", result: await provider().searchPlaces({ query: query.trim(), scope: { kind: "city", cityAdcode: HANGZHOU_ADCODE }, limit: 5 }) };
}
export async function findLiveWalkingRoute(origin: unknown, destination: unknown): Promise<RouteReply> {
  if (liveConfiguration() !== "ready") return unavailable;
  // Browser claims are only temporary lab input, never authenticated POI bindings.
  const endpoint = (v: unknown) => {
    if (!v || typeof v !== "object" || !("cityAdcode" in v) || v.cityAdcode !== HANGZHOU_ADCODE || !("ref" in v) || !("location" in v)) return null;
    const e = { place: v.ref, location: v.location };
    return isAmapEndpoint(e) ? e : null;
  };
  const from = endpoint(origin), to = endpoint(destination);
  if (!from || !to || from.place.externalId === to.place.externalId) return { status: "unavailable", message: "请明确选择两个不同的杭州高德地点。" };
  return { status: "result", result: await provider().findRoutes({ origin: from, destination: to, cityAdcode: HANGZHOU_ADCODE, mode: "walking", departureAt: now() }) };
}
