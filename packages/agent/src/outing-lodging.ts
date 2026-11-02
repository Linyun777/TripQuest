import { isLodgingCategory, type Allocation, type DayFrame, type LodgingSegment } from "@tripquest/application/outing-allocation";
import { straightMeters } from "@tripquest/application/leg-choice";
import type { PlanningPlace } from "@tripquest/application/planning";
import type { ChooseLodgingFix } from "@tripquest/application/outing-review-contract";
import type { GeoPoint, MobilityProvider, PlaceSummary } from "@tripquest/providers";
import type { GeneratedDay, OutingInput } from "./outing-generate";

/**
 * V3.3 暂定住处（stages/V3.3.md §3.3）：住处没定的每一段连住，由代码按高德的真实搜索结果定一家，不问模型。
 * 中心点依次用：说了的区域、这一段几天分到的同城地点的坐标平均、只有兴趣时兴趣在全城的第一个结果的坐标平均（V3.4）、
 * 进城的车站、这一晚的终点；在中心点附近搜
 * “酒店”（先 3 公里，没有再 10 公里），只留住宿类（高德分类码 10 开头）、在这个城市的，最近的作为暂定，
 * 再按距离留 2 个作为候选。找不到就不定（方案上照实说按哪里估计），不编造。同一段里用户给了其中一晚的，
 * 跟它同一家，不搜。
 */
export interface LodgingChoice {
  readonly nights: readonly number[];
  readonly city: string | undefined;
  /** 定下的住处（找不到时为 null）。 */
  readonly place: PlanningPlace | null;
  /** follow：跟用户给的那晚同一家；search：按中心点搜到的。 */
  readonly from: "follow" | "search";
  readonly center?: "area" | "visits" | "interests" | "station" | "end";
  /** 中心点用了哪个区域（原话里的地名，或对话记成住处的那个地方的名字）。 */
  readonly area?: string;
  /** 卡片上这几晚原来是个区域（不是住宿），定下的这家替换它，区域记到“住处区域”里。 */
  readonly replaces?: true;
  /** 其余可换的（最多 2 个，按离中心点的距离）。 */
  readonly candidates: readonly PlanningPlace[];
}

export { isLodgingCategory };

const RADII = [3000, 10_000] as const;
const CANDIDATES = 2;

type Search = Pick<MobilityProvider, "searchPlaces">;

/** V3.4：只有兴趣时，最多拿几个兴趣去全城搜（每个一次请求）。 */
const INTEREST_SEARCHES = 3;

/** 每段要的地图请求上限（区域绑定一次，周边搜索最多两次；V3.4 起兴趣定位最多再 3 次），预算按它留。 */
export const LODGING_SEARCHES_PER_STAY = 3 + INTEREST_SEARCHES;

export async function chooseLodging(
  segments: readonly LodgingSegment[],
  input: OutingInput,
  allocation: Allocation,
  frames: readonly DayFrame[],
  provider: Search,
  signal: AbortSignal,
): Promise<LodgingChoice[]> {
  const areas = new Map<string, PlaceSummary | null>();
  const choices: LodgingChoice[] = [];
  for (const segment of segments) {
    if (segment.given) {
      choices.push({ nights: segment.nights, city: segment.city, place: segment.given, from: "follow", candidates: [] });
      continue;
    }
    const center = await centerOf(segment, input, allocation, frames, provider, signal, areas);
    if (!center) {
      choices.push({ nights: segment.nights, city: segment.city, place: null, from: "search", candidates: [] });
      continue;
    }
    const found = await nearbyLodging(center.point, segment.city, provider, signal);
    choices.push({
      nights: segment.nights,
      city: segment.city,
      place: found[0] ?? null,
      from: "search",
      center: center.source,
      ...(center.area ? { area: center.area } : {}),
      ...(segment.area ? { replaces: true as const } : {}),
      candidates: found.slice(1, 1 + CANDIDATES),
    });
  }
  return choices;
}

/** 中心点（§3.3 第 1 条、§3.6）。 */
async function centerOf(
  segment: LodgingSegment,
  input: OutingInput,
  allocation: Allocation,
  frames: readonly DayFrame[],
  provider: Search,
  signal: AbortSignal,
  areas: Map<string, PlaceSummary | null>,
): Promise<{ point: GeoPoint; source: NonNullable<LodgingChoice["center"]>; area?: string } | null> {
  if (segment.area) return { point: segment.area.place.location, source: "area", area: segment.area.place.name };
  for (const area of input.lodgingAreas ?? []) {
    const key = `${area.text}@${segment.city}`;
    if (!areas.has(key)) areas.set(key, segment.city ? await bindArea(area.text, segment.city, provider, signal) : null);
    const bound = areas.get(key);
    if (bound) return { point: bound.location, source: "area", area: area.text };
  }
  // 这一段的几晚，加上最后一晚的第二天（早上从住处出发）。
  const days = [...segment.nights, segment.nights.at(-1)! + 1];
  const keys = allocation.days.filter((entry) => days.includes(entry.day)).flatMap((entry) => entry.visits);
  const points = input.visits
    .filter((visit) => keys.includes(visit.key) && visit.place.place.cityAdcode === segment.city)
    .map((visit) => visit.place.place.location);
  if (points.length) return { point: averageOf(points), source: "visits" };
  // V3.4（stages/V3.4.md §3.7）：没有具体地点、只有兴趣（“看熊猫”）时，每个兴趣在当晚城市按相关度搜一次，取第一个结果
  // 的坐标求平均。这些结果只用来定位，不存、不排进方案；每天都要的兴趣（“每晚喝一杯”）说明不了去哪，不算。
  const interestIds = allocation.days.filter((entry) => days.includes(entry.day)).flatMap((entry) => entry.interests);
  const texts = [...new Set(input.interests
    .filter((item) => interestIds.includes(item.id) && !item.perDay && (!item.city || item.city === segment.city))
    .map((item) => item.text))].slice(0, INTEREST_SEARCHES);
  if (segment.city && texts.length) {
    const found: GeoPoint[] = [];
    for (const text of texts) {
      const reply = await provider.searchPlaces({ query: text, scope: { kind: "city", cityAdcode: segment.city }, limit: 5 }, { signal }).catch(() => null);
      const first = reply?.status === "ok"
        ? reply.data.items.find((item) => item.cityAdcode === segment.city && !isLodgingCategory(item.categoryCode))
        : undefined;
      if (first) found.push(first.location);
    }
    if (found.length) return { point: averageOf(found), source: "interests" };
  }
  const station = input.transports.find((ride) => days.includes(ride.day) && ride.to.place.cityAdcode === segment.city) ??
    input.transports.find((ride) => days.includes(ride.day) && ride.from.place.cityAdcode === segment.city);
  if (station) {
    const place = station.to.place.cityAdcode === segment.city ? station.to : station.from;
    return { point: place.place.location, source: "station" };
  }
  const end = frames.find((frame) => frame.day === segment.nights[0])?.end;
  return end && end.place.cityAdcode === segment.city ? { point: end.place.location, source: "end" } : null;
}

function averageOf(points: readonly GeoPoint[]): GeoPoint {
  const average = (pick: (point: GeoPoint) => number) => points.reduce((total, point) => total + pick(point), 0) / points.length;
  return { ...points[0]!, longitude: average((point) => point.longitude), latitude: average((point) => point.latitude) };
}

/** 区域按名字绑定到这个城市的一个地点（名字对得上才算，PITFALLS 第 6 节；跳过住宿本身）。 */
async function bindArea(text: string, city: string, provider: Search, signal: AbortSignal): Promise<PlaceSummary | null> {
  const reply = await provider.searchPlaces({ query: text, scope: { kind: "city", cityAdcode: city }, limit: 5 }, { signal }).catch(() => null);
  if (reply?.status !== "ok") return null;
  return reply.data.items.find((item) => !isLodgingCategory(item.categoryCode) &&
    item.cityAdcode === city && (item.name.includes(text) || text.includes(item.name))) ?? null;
}

/** 周边搜索住宿，按离中心点的距离排好（先 3 公里，没有再 10 公里）。 */
async function nearbyLodging(center: GeoPoint, city: string | undefined, provider: Search, signal: AbortSignal): Promise<PlanningPlace[]> {
  for (const radiusMeters of RADII) {
    const reply = await provider.searchPlaces({ query: "酒店", scope: { kind: "nearby", center, radiusMeters }, limit: 5 }, { signal }).catch(() => null);
    if (reply?.status !== "ok") return [];
    const found = reply.data.items
      .filter((item) => isLodgingCategory(item.categoryCode) && (!city || item.cityAdcode === city))
      .sort((a, b) => straightMeters(center, a.location) - straightMeters(center, b.location))
      .map((place) => ({ place, evidence: reply.evidence }));
    if (found.length) return found;
  }
  return [];
}

/**
 * 换住处的候选建议（§3.5）：每段连住给最多 2 个，理由写离这一段每天的最后一站、第二天的第一站多远（直线，用已经
 * 查到的坐标，不多发请求）；只算这个城市里的站（第二天一早坐车走、到了别的城市才有第一站的，不算）。
 */
export function lodgingSuggestions(
  choices: readonly LodgingChoice[],
  generated: readonly GeneratedDay[],
): { readonly fix: ChooseLodgingFix; readonly text: string }[] {
  // 各站的坐标在每段的确认快照里（方案本身只有名称）。
  const stops = (day: number): PlaceSummary[] => {
    const entry = generated.find((item) => item.day === day);
    if (!entry || entry.result.status !== "draft") return [];
    return entry.result.parts.flatMap((part) => {
      if (part.kind !== "plan") return [];
      const snapshot = entry.snapshots.get(part.segment);
      return part.draft.activities.flatMap((activity) => {
        const place = snapshot?.places.find((item) => item.placeId === activity.placeId);
        return place ? [place.selection.place] : [];
      });
    });
  };
  const km = (meters: number) => (meters < 1000 ? `${Math.round(meters / 100) * 100} 米` : `${(meters / 1000).toFixed(1)} 公里`);
  return choices.filter((choice) => choice.from === "search" && choice.place).flatMap((choice) => {
    const first = choice.nights[0]!;
    const last = choice.nights.at(-1)!;
    const nights = first === last ? `第 ${first} 晚` : `第 ${first}–${last} 晚`;
    return choice.candidates.map((candidate) => {
      const where = candidate.place.location;
      const near: string[] = [];
      const here = (day: number) => stops(day).filter((stop) => !choice.city || stop.cityAdcode === choice.city);
      for (const night of choice.nights) {
        const end = here(night).at(-1);
        const start = here(night + 1)[0];
        if (end) near.push(`离第 ${night} 天最后一站 ${km(straightMeters(where, end.location))}`);
        if (start) near.push(`离第 ${night + 1} 天第一站 ${km(straightMeters(where, start.location))}`);
      }
      const reason = (near.length ? near.slice(0, 4).join("、") : `离${choice.area ?? "这几天去的地方"}近`).slice(0, 120);
      const fix: ChooseLodgingFix = {
        action: "choose_lodging",
        nights: [...choice.nights],
        place: { externalId: candidate.place.ref.externalId, name: candidate.place.name.slice(0, 80), city: candidate.place.cityAdcode },
        reason,
      };
      return { fix, text: `${nights}换成${candidate.place.name}`.slice(0, 80) };
    });
  });
}
