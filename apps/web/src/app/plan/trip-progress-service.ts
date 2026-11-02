import "server-only";
import { traced } from "../runs/runs";
import { requireOwner } from "../auth/owner";
import type { StoredJourney } from "@tripquest/application";
import type { DayProgressReply } from "@tripquest/application/day-progress";
import type { RealDayAdjustRepository } from "@tripquest/application/real-adjust";
import { journeyCity } from "@tripquest/application/real-day";
import { isOutdoorCategory } from "@tripquest/application/day-planning";
import { DrizzleConversationRepository, DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { PlaceLookupProvider, WeatherProvider } from "@tripquest/providers";
import { readRealPlaceMode } from "../real-places/real-mode";
import { createUserUsage, meteredAmap } from "../usage/usage";
import type { TripProgressView, TripStopView } from "./trip-estimate";

export interface TripProgressOptions {
  /** V2.12：当前用户（接口从会话取得）；仓库只读写这个用户的数据。 */
  userId?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  journeys?: () => RealDayAdjustRepository;
  conversationOf?: (journeyId: string) => Promise<string | null>;
  places?: () => PlaceLookupProvider | null;
}

const chinaTime = (nowMs: number) => new Date(nowMs + 8 * 3_600_000).toISOString();

/** 面板只持有名称、自有计划时间与用户标记，坐标另按本次实时查询补齐。 */
export function tripProgressView(
  journey: StoredJourney,
  conversationId: string | null,
  points: ReadonlyMap<string, readonly [number, number]>,
  /** 按高德地点 ID 附加本次类别和当天天气，二者都只供当前展示。 */
  live: { categories?: ReadonlyMap<string, string>; weather?: TripProgressView["weather"] } = {},
): TripProgressView | null {
  const details = journey.realDay;
  if (journey.creationKind !== "real_day" || !details) return null;
  const place = (placeId: string) => details.places.find((item) => item.placeId === placeId)!;
  const point = (placeId: string) => points.get(place(placeId).externalId) ?? null;
  const outdoor = (placeId: string) => isOutdoorCategory(live.categories?.get(place(placeId).externalId));
  const done = new Set(journey.dayProgress?.completedActivityIds ?? []);
  const skipped = new Set(journey.dayProgress?.skippedActivityIds ?? []);
  // 先展示已在身后的历史，再展示本版计划，各区域内部按时间排序。
  const stops: TripStopView[] = [
    ...[...(details.archived ?? [])].sort((a, b) => a.startsAt - b.startsAt).map((item) => ({
      activityId: item.activityId,
      name: place(item.placeId).name,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      status: item.status === "completed" ? "done" as const : "skipped" as const,
      archived: true,
      fixed: false,
      point: point(item.placeId),
    })),
    ...details.activities.map((item) => {
      const { activityId, placeId, role } = item.record.activity;
      return {
        activityId,
        name: place(placeId).name,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        status: done.has(activityId) ? "done" as const : skipped.has(activityId) ? "skipped" as const : "todo" as const,
        archived: false,
        fixed: role === "fixed",
        point: point(placeId),
        ...(outdoor(placeId) ? { outdoor: true } : {}),
        ...(item.arrivalMode ? { arrivalMode: item.arrivalMode } : {}),
      };
    }),
  ];
  // 后续版本可能从中途恢复，面板起点仍展示这一天最初出发的位置。
  const origin = details.change?.origin ?? { placeId: details.context.startPlaceId, startsAt: details.context.window.startsAt };
  const lastStop = details.activities.at(-1)?.record.activity.placeId;
  const endsAtLastStop = details.context.endPlaceId === lastStop;
  return {
    journeyId: journey.journeyId,
    conversationId,
    title: journey.title,
    date: details.context.date,
    planVersion: journey.currentPlan.version,
    observationVersion: journey.currentObservationVersion,
    note: details.change?.note ?? null,
    window: { startsAt: origin.startsAt, endsAt: details.context.window.endsAt },
    resumeAt: details.context.window.startsAt,
    start: { name: place(origin.placeId).name, point: point(origin.placeId) },
    end: endsAtLastStop ? null : { name: place(details.context.endPlaceId).name, point: point(details.context.endPlaceId) },
    ...(live.weather !== undefined ? { weather: live.weather } : {}),
    stops,
  };
}

/** 合并行程城市的实时和当日昼夜天气描述（V2.10：按行程的城市），两个来源都不可用才返回 null。 */
async function todaysWeather(provider: Partial<WeatherProvider>, cityAdcode: string, date: string): Promise<TripProgressView["weather"]> {
  const [live, forecast] = await Promise.all([
    provider.getLiveWeather?.(cityAdcode).catch(() => null) ?? null,
    provider.getWeatherForecast?.(cityAdcode).catch(() => null) ?? null,
  ]);
  const day = forecast?.status === "ok" ? forecast.data.days.find((item) => item.date === date) : undefined;
  const now = live?.status === "ok" ? live.data.weather : null;
  if (!now && !day) return null;
  return { now, day: day?.dayWeather ?? null, night: day?.nightWeather ?? null };
}

export function createTripProgressService(options: TripProgressOptions = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const journeys = () => options.journeys?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner());
  const conversationOf = (journeyId: string) => options.conversationOf?.(journeyId) ??
    new DrizzleConversationRepository(getSharedJourneyDatabase().database, owner()).findConversationIdByJourney(journeyId).catch(() => null);
  const places = (): (PlaceLookupProvider & Partial<WeatherProvider>) | null => {
    if (options.places) return options.places();
    const mode = readRealPlaceMode(environment());
    return mode.enabled
      ? meteredAmap({ key: mode.key, usage: createUserUsage(owner()), purpose: "progress-map", now })
      : null;
  };

  /** 实时补查地图点，失败时仍返回可用的文字与进度面板。 */
  async function load(journeyId: string, conversationId?: string | null): Promise<TripProgressView | null> {
    const journey = await journeys().findCurrentJourney(journeyId);
    if (!journey?.realDay) return null;
    const ids = [...new Set(journey.realDay.places.map((place) => place.externalId))];
    const points = new Map<string, readonly [number, number]>();
    const categories = new Map<string, string>();
    const provider = places();
    for (let index = 0; provider && index < ids.length; index += 10) {
      const reply = await provider.findPlacesById(ids.slice(index, index + 10)).catch(() => null);
      if (!reply || reply.status !== "ok") break;
      for (const item of reply.data.items) {
        points.set(item.ref.externalId, [item.location.longitude, item.location.latitude]);
        if (item.categoryCode) categories.set(item.ref.externalId, item.categoryCode);
      }
    }
    // 天气只对行程当天有提醒意义，实时与预报两次查询结果均不长期存储。
    const weather = provider && journey.realDay.context.date === chinaTime(now()).slice(0, 10)
      ? await todaysWeather(provider, journeyCity(journey).adcode, journey.realDay.context.date)
      : undefined;
    return tripProgressView(journey, conversationId === undefined ? await conversationOf(journeyId) : conversationId, points, { categories, weather });
  }

  /**
   * 行程当天，将单项标记合并成截至当前的累计报告，使用服务端时间。
   * 完成标记同时报告所在地点；跳过只改变活动标记，不推测用户已经移动。
   */
  async function mark(journeyId: string, input: {
    action: "complete" | "skip";
    activityId: string;
    reportId: string;
    basePlanVersion: number;
    baseObservationVersion: number;
  }): Promise<DayProgressReply | { status: "not_today" }> {
    const repository = journeys();
    const journey = await repository.findCurrentJourney(journeyId);
    if (!journey?.realDay) return { status: "not_found" };
    const local = chinaTime(now());
    if (local.slice(0, 10) !== journey.realDay.context.date) return { status: "not_today" };
    const at = `${local.slice(0, 16)}+08:00` as const;
    // 页面只发一次标记，服务端合并成累计报告；客户端带来的双版本仍交仓储在锁内核对，
    // 防止另一页刚确认的调整被基于旧进度的点击覆盖。
    const completed = new Set(journey.dayProgress?.completedActivityIds ?? []);
    const skipped = new Set(journey.dayProgress?.skippedActivityIds ?? []);
    (input.action === "complete" ? completed : skipped).add(input.activityId);
    const placeId = journey.realDay.activities.find((item) => item.record.activity.activityId === input.activityId)?.record.activity.placeId;
    const previous = journey.dayProgress?.locationPlaceId ?? null;
    const location = input.action === "complete" && placeId ? placeId : previous;
    return repository.commitRealDayProgress({
      journeyId,
      command: {
        reportId: input.reportId,
        basePlanVersion: input.basePlanVersion,
        baseObservationVersion: input.baseObservationVersion,
        completedActivityIds: [...completed],
        skippedActivityIds: [...skipped],
        observedAt: at,
        earliestResumeAt: at,
        location: location ? { kind: "known", placeId: location } : { kind: "unknown" },
        noCurrentActivity: true,
      },
      recordedAt: `${local.slice(0, 19)}+08:00`,
    });
  }

  return {
    load: (journeyId: string, conversationId?: string | null) => traced({ trigger: "progress", userId: options.userId ?? null }, () => load(journeyId, conversationId)),
    mark,
  };
}
