import { applyRides, planRides, type RideFill, type RideMode, type RideStation } from "@tripquest/application/outing-rides";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import type { MobilityProvider, PlaceSummary } from "@tripquest/providers";
import { currentRun } from "./runs";

/**
 * V3.6 补车站和往返（stages/V3.6.md §3.2–3.4）：按 planRides 算出的城市，每个“方式 + 城市”在那个城市按相关度搜一次
 * （高铁 / 火车搜“火车站”，飞机搜“机场”；2026-11-02 真实样本核对：“火车站”在上海、青岛、成都、厦门排第一的是主要车站，
 * “高铁站”在上海排第一的是松江站），只留高德分类码是火车站（150200）或机场（150100、150104）的、在这个城市的，
 * 去掉在建、停运和航站楼这类。只存编号和名称（D-045 / D-046）；一个都没有就照旧空着，不编造。
 */

type Search = Pick<MobilityProvider, "searchPlaces">;

const QUERY: Record<RideMode, string> = { train: "火车站", flight: "机场" };
const CATEGORY: Record<RideMode, RegExp> = { train: /^150200$/, flight: /^1501(00|04)$/ };
const NOT_A_STATION = /建设中|暂停营业|停运|停用|货运|航站楼|卫星厅|候机|售票|出站口|进站口|停车场/;

export function isRideStation(place: PlaceSummary, mode: RideMode, city: string): boolean {
  const codes = (place.categoryCode ?? "").split("|");
  return place.cityAdcode === city && codes.some((code) => CATEGORY[mode].test(code)) && !NOT_A_STATION.test(place.name);
}

/** 补完的卡片和回复后面那句；没补就原样返回（note 为 null）。searches 是用了几次地图请求。 */
export async function fillRides(
  draft: RequirementsDraft,
  userTexts: readonly string[],
  provider: Search,
  signal: AbortSignal,
  options: { readonly stationsOnly?: boolean } = {},
): Promise<RideFill & { readonly searches: number }> {
  const plan = planRides(draft, userTexts, options);
  if (!plan) return { draft, stations: [], added: [], note: null, searches: 0 };
  const found = new Map<string, readonly RideStation[]>();
  let searches = 0;
  for (const need of plan.needs) {
    const key = `${need.mode}@${need.city}`;
    if (need.preset || found.has(key)) continue;
    searches += 1;
    found.set(key, await findStations(need.mode, need.city, provider, signal));
  }
  const filled = applyRides(draft, plan, found);
  // 运行记录（§3.4）：补了哪几端、按什么城市、搜到几个；加了哪几趟。只记编号、城市编码和名称。
  currentRun()?.step("check", "outing:rides", {
    stations: filled.stations.map((item) => `${item.ride}:${item.end}@${item.city}=${item.name}(${item.found})`).slice(0, 8),
    added: filled.added.map((item) => `${item.kind}:d${item.day}:${item.mode}`),
    searches,
  });
  return { ...filled, searches };
}

/** 一个城市里这种方式的车站（按相关度，去掉同名的）；查不到为空。V4.3 补用户说了方式的中间段也用它。 */
export async function findStations(mode: RideMode, city: string, provider: Search, signal: AbortSignal): Promise<RideStation[]> {
  const reply = await provider.searchPlaces({ query: QUERY[mode], scope: { kind: "city", cityAdcode: city }, limit: 10 }, { signal })
    .catch(() => null);
  const items = reply?.status === "ok" ? reply.data.items.filter((item) => isRideStation(item, mode, city)) : [];
  const unique = [...new Map(items.map((item) => [item.name, item])).values()];
  return unique.map((item) => ({ externalId: item.ref.externalId, name: item.name.slice(0, 80), city }));
}
