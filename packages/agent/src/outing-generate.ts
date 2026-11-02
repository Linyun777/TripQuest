import type { DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import type { DayPlanningRunner, DayProgress, DayWeather } from "@tripquest/application/day-planning";
import type { Allocation, DayFrame, OutingPlanInput } from "@tripquest/application/outing-allocation";
import { clock, splitDay, type DayInterest, type DayVisit } from "@tripquest/application/transfer-day";
import type { MobilityProvider, WeatherProvider } from "@tripquest/providers";
import { generateWithGraph, type OutingReviewOutcome } from "./outing-graph";
import type { LodgingChoice } from "./outing-lodging";
import type { ReviewRequest } from "./outing-review";
import type { RunBudget } from "./runs";
import { planTransferDay, type TransferDayResult } from "./transfer-day";

/**
 * V2.11 出游逐天生成（stages/V2.11.md §3.7）：按确认的分配，一天一天用一日规划器排（有固定交通的天按第 5 步
 * 切段）。前几天按兴趣新找到的地点作为排除列表交给后面的天（跨天不重复），所以按顺序生成，不并行。
 * 某一天排不开不影响其他天，那天标出原因。
 */
export interface GeneratedDay {
  readonly day: number;
  readonly date: string;
  readonly frame: DayFrame;
  readonly result: TransferDayResult;
  /** 每段排好时的确认快照（段号 → 快照），保存时逐段复核。 */
  readonly snapshots: ReadonlyMap<number, DayDraftConfirmationSnapshot>;
  /** 这一天按兴趣新找到的地点（高德编号）。 */
  readonly discovered: readonly string[];
  /** V3.2：这一天各城市的预报（审查看雨天户外）；查不到时没有。 */
  readonly weather?: Readonly<Record<string, DayWeather>>;
  /** V3.2：审查直接改了这一天时的说明（“审查后调整：…”），方案上显示。 */
  readonly reviewNote?: string;
}

export type OutingInput = OutingPlanInput & { readonly pace: "relaxed" | "standard"; readonly cityAdcode: string; readonly notes?: string };

export interface OutingDependencies {
  readonly runner: DayPlanningRunner;
  /** V3.3：选暂定住处时还要周边搜索。 */
  readonly provider: Pick<MobilityProvider, "findRoutes" | "searchPlaces">;
  readonly now: () => number;
  /** 某天某城市的预报；查不到返回 undefined。 */
  readonly weather?: (date: string, city: string) => Promise<DayWeather | undefined>;
  /** V3.2 审查 Agent 的模型请求；没有或 OUTING_REVIEW=off 时不审查。 */
  readonly reviewer?: ReviewRequest;
}

export interface OutingGenerateOptions {
  readonly signal: AbortSignal;
  /** 只生成这几天（“继续规划剩下的天”“重排这一天”）；不写是全部。 */
  readonly days?: readonly number[];
  /** 已经排好的天里找到的地点（重排某一天时排除）。 */
  readonly exclude?: readonly string[];
  readonly onProgress?: (day: number, progress: DayProgress) => void;
  readonly onDay?: (day: GeneratedDay) => void | Promise<void>;
  /** V3.2：审查做完后交出直接改了什么、给用户的建议、最后的分配（只在审查开着时调用）。 */
  readonly onReview?: (outcome: OutingReviewOutcome) => void;
  /** V3.2：开始检查整趟安排时（页面显示一步进度）。 */
  readonly onReviewStart?: () => void;
  /** V3.3：住处没定的几晚定了哪家（排之前调用；没有要定的就不调用），页面把它写进卡片。 */
  readonly onLodging?: (choices: readonly LodgingChoice[]) => void;
}

/** V3.1 起由总控图逐天生成（V3.2 起排完审查）。 */
export function generateOuting(
  input: OutingInput,
  allocation: Allocation,
  dependencies: OutingDependencies,
  options: OutingGenerateOptions,
): Promise<GeneratedDay[]> {
  return generateWithGraph(input, allocation, dependencies, options);
}

/** 这一天交给 planTransferDay 的输入（地点、兴趣、交通、排除列表）；预算按它切出的段数算。 */
function dayInput(input: OutingInput, allocation: Allocation, frame: DayFrame, exclude: readonly string[]) {
  const entry = allocation.days.find((item) => item.day === frame.day);
  const visits = (entry?.visits ?? []).flatMap((key): DayVisit[] => {
    const visit = input.visits.find((item) => item.key === key);
    if (!visit) return [];
    if (visit.role === "fixed") return [{ place: visit.place, role: "fixed" as const, startsAt: visit.startsAt!, endsAt: visit.endsAt! }];
    return [{
      place: visit.place,
      role: visit.role,
      stayMinutes: visit.stayMinutes,
      ...(visit.floor !== undefined ? { staySource: "estimate" as const, ...(visit.kind ? { kind: visit.kind } : {}) } : {}),
    }];
  });
  const interests: DayInterest[] = (entry?.interests ?? []).flatMap((id) => {
    const interest = input.interests.find((item) => item.id === id);
    return interest ? [{ id: interest.id, text: interest.text, ...(interest.when ? { when: interest.when } : {}), ...(interest.city ? { city: interest.city } : {}) }] : [];
  });
  return {
    date: frame.date,
    window: { startsAt: clock(frame.startsAt), endsAt: clock(Math.max(frame.startsAt, frame.endsAt)) },
    start: frame.start,
    end: frame.end,
    transfers: frame.transfers.map((item) => item.transfer),
    visits,
    interests,
    // V3.2：卡片上说这天不自驾（车在别的城市）时去掉自驾；只剩自驾时改成打车。
    travel: input.noDriving?.includes(frame.day) && input.travel.allowed.includes("driving")
      ? {
        ...input.travel,
        allowed: input.travel.allowed.length > 1 ? input.travel.allowed.filter((mode) => mode !== "driving") : ["taxi" as const],
      }
      : input.travel,
    pace: input.pace,
    cityAdcode: frame.start.place.cityAdcode ?? input.cityAdcode,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(exclude.length ? { exclude: [...exclude] } : {}),
  };
}

/** 排一天（总控图的 plan_day 节点）：查这一天各城市的预报，交给 planTransferDay，记下新找到的地点。 */
export async function planOutingDay(
  input: OutingInput,
  allocation: Allocation,
  frame: DayFrame,
  exclude: readonly string[],
  dependencies: OutingDependencies,
  options: Pick<OutingGenerateOptions, "signal" | "onProgress">,
): Promise<GeneratedDay> {
  const weatherByCity: Record<string, DayWeather> = {};
  for (const city of frame.cities) {
    const day = await dependencies.weather?.(frame.date, city).catch(() => undefined);
    if (day) weatherByCity[city] = day;
  }
  const snapshots = new Map<number, DayDraftConfirmationSnapshot>();
  const result = await planTransferDay({
    ...dayInput(input, allocation, frame, exclude),
    ...(Object.keys(weatherByCity).length ? { weatherByCity } : {}),
  }, dependencies, {
    signal: options.signal,
    onProgress: (_segment, progress) => options.onProgress?.(frame.day, progress),
    onDraftReady: (segment, snapshot) => snapshots.set(segment, snapshot),
  });
  const discovered = result.status !== "draft" ? [] : result.parts.flatMap((part) => {
    if (part.kind !== "plan") return [];
    const snapshot = snapshots.get(part.segment);
    return part.draft.activities.filter((activity) => activity.role === "discovered").flatMap((activity) => {
      const place = snapshot?.places.find((item) => item.placeId === activity.placeId);
      return place ? [place.selection.place.ref.externalId] : [];
    });
  });
  // V3.3：这一晚住处没定、也没找到时，方案上照实说终点按哪里估计。
  const noted = frame.unsettled && result.status === "draft" ? { ...result, notes: [frame.unsettled, ...result.notes] } : result;
  return {
    day: frame.day, date: frame.date, frame, result: noted, snapshots, discovered,
    ...(Object.keys(weatherByCity).length ? { weather: weatherByCity } : {}),
  };
}

/**
 * V3.1 共用预算按段数算（stages/V3.1.md §3.5）：有地点的段给一次一日规划的预算（模型 12、地图 80），只核对
 * 路线的段给地图 6；再加分配的模型 3，和排之前按编号补查地点、查预报的地图 20。
 */
export function outingSegmentBudget(input: OutingInput, allocation: Allocation, frames: readonly DayFrame[]): RunBudget {
  let model = 3;
  let amap = 20;
  for (const frame of frames) {
    for (const segment of splitDay(dayInput(input, allocation, frame, [])).segments) {
      if (segment.visits.length || segment.interests.length) {
        model += 12;
        amap += 80;
      } else {
        amap += 6;
      }
    }
  }
  return { model, amap, ms: 300_000 * Math.max(1, frames.length) };
}

/** 按城市查一次预报（同一趟出游里每个城市只查一次），取某一天；查不到返回 undefined。 */
export function forecastLookup(provider: Pick<WeatherProvider, "getWeatherForecast">, signal: AbortSignal) {
  const byCity = new Map<string, ReturnType<WeatherProvider["getWeatherForecast"]>>();
  return async (date: string, city: string): Promise<DayWeather | undefined> => {
    if (!byCity.has(city)) byCity.set(city, provider.getWeatherForecast(city, { signal }));
    const forecast = await byCity.get(city)!;
    const day = forecast.status === "ok" ? forecast.data.days.find((item) => item.date === date) : undefined;
    if (!day) return undefined;
    return {
      dayWeather: day.dayWeather,
      nightWeather: day.nightWeather,
      highCelsius: day.highCelsius,
      lowCelsius: day.lowCelsius,
      wet: day.wet,
      ...(day.windy ? { windy: true } : {}),
    };
  };
}
