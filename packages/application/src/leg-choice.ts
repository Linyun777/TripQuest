import type { DayRoute, DayTravelMode } from "@tripquest/domain";
import type { MobilityProvider, ProviderCallOptions, RouteOption } from "@tripquest/providers";
import type { PlanningPlace, TravelPreference } from "./planning-requirements";
import { routeBetween } from "./route-request";

/**
 * 分段选路是确定性策略：直线距离决定值得查的方式，再按用户偏好给真实返回路线评分。
 * 模型不直接挑方式；确认与重开按原已选方式复查，且共用同一停车时间口径。
 */
export interface LegEnd {
  readonly placeId: string;
  readonly place: PlanningPlace["place"];
}

export interface ChosenLeg {
  readonly route: Extract<DayRoute, { status: "known" }> | Extract<DayRoute, { status: "unknown" }>;
  /** 折线只用于本次展示，不作长期路线缓存。 */
  readonly path?: readonly (readonly [number, number])[];
  /** 本次选路实际发出的供应商请求次数，包含无路线或失败的尝试。 */
  readonly requests: number;
}

const WALK_METERS_PER_MINUTE = 80;
/** 15 分钟内的已查步行优先，除非用户明确要求少走路；这是产品偏好策略，不是地理事实。 */
const EASY_WALK_MINUTES = 15;
/** 短段若已查方式都超过半小时，可额外比较允许的打车或自驾，避免直线近但实际绕路很远。 */
const SLOW_LEG_MINUTES = 30;
const WEIGHTS: Record<TravelPreference["prefer"], { minutes: number; walking: number; yuan: number }> = {
  balanced: { minutes: 1, walking: 0.5, yuan: 1 },
  fast: { minutes: 1, walking: 0.2, yuan: 0.15 },
  cheap: { minutes: 0.6, walking: 0.4, yuan: 2 },
  less_walking: { minutes: 1, walking: 2, yuan: 0.5 },
};

export function straightMeters(a: PlanningPlace["place"]["location"], b: PlanningPlace["place"]["location"]): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** 按直线距离与用户允许方式决定查询顺序；这一步只限调查范围，不产出可行路线。 */
export function modesToTry(meters: number, travel: TravelPreference): DayTravelMode[] {
  const wanted: DayTravelMode[] = meters <= 1200
    ? ["walking"]
    : meters <= 4000
      ? ["walking", "transit", "bicycling"]
      : ["transit", "taxi", "driving", "bicycling"];
  const allowed = wanted.filter((mode) => travel.allowed.includes(mode));
  // 推荐方式都不被允许时仍查用户允许的方式，例如只步行去远处；不擅自替用户开放打车。
  return allowed.length ? allowed : travel.allowed.filter((mode) => mode !== "driving" || travel.allowed.length === 1).slice(0, 2);
}

function walkingMinutes(option: RouteOption): number {
  if (option.mode === "walking") return option.durationSeconds / 60;
  if (option.mode === "transit") return (option.walkingMeters ?? 0) / WALK_METERS_PER_MINUTE;
  return 0;
}

/** 缺失票价时用产品估值参与比较，不能把估值冒充供应商返回费用写进结果。 */
function comparableYuan(option: RouteOption): number {
  if (option.fareYuan !== undefined) return option.fareYuan;
  if (option.mode === "taxi") return 13 + Math.max(0, option.distanceMeters / 1000 - 3) * 2.5;
  if (option.mode === "transit") return 3;
  return 0;
}

// 分数只用于路线偏好排序，不能代替时间窗可行性检查；未知价格的比较估值不会写入返回费用字段。
export function scoreOption(option: RouteOption, prefer: TravelPreference["prefer"]): number {
  const weight = WEIGHTS[prefer];
  return option.durationSeconds / 60 * weight.minutes + walkingMinutes(option) * weight.walking + comparableYuan(option) * weight.yuan;
}

/** 只在已得到的真实路线中排序；短步行优先，其余按时间、步行负担与费用的加权分数比较。 */
export function pickOption(options: readonly RouteOption[], travel: TravelPreference): RouteOption | null {
  if (options.length === 0) return null;
  const walk = options.find((option) => option.mode === "walking");
  if (walk && travel.prefer !== "less_walking" && walk.durationSeconds / 60 <= EASY_WALK_MINUTES) return walk;
  return [...options].sort((a, b) => scoreOption(a, travel.prefer) - scoreOption(b, travel.prefer))[0];
}

/** 查询合适方式并选一个；显式 mode 则只复查原方式，不能在确认阶段静默换交通方案。 */
/** 交通估计允许至少三分钟或 15% 的小漂移，确认仍保留原计划数值；步行要求精确一致。 */
export function estimateToleranceSeconds(durationSeconds: number): number {
  return Math.max(180, Math.round(durationSeconds * 0.15));
}

/** 自驾额外留十分钟停车与步行时间，是固定产品假设，并未查询停车场。 */
export const PARKING_SECONDS = 10 * 60;

/** 规划、确认前复查与重开统一加停车时间，避免同一条路线在三个阶段使用不同口径。 */
export function withParking(option: RouteOption): RouteOption {
  if (option.mode !== "driving") return option;
  return {
    ...option,
    durationSeconds: option.durationSeconds + PARKING_SECONDS,
    summary: option.summary ? `${option.summary}（含停车 10 分钟）` : "含停车 10 分钟",
  };
}

export async function chooseLeg(options: {
  from: LegEnd;
  to: LegEnd;
  travel: TravelPreference;
  provider: Pick<MobilityProvider, "findRoutes">;
  departureAt: string;
  call?: ProviderCallOptions;
  mode?: DayTravelMode;
  /** 每次实际请求前调用预算预留，抛错立即停止；比较多个方式不能只按一段路计一次。 */
  beforeRequest?: () => void | Promise<void>;
}): Promise<ChosenLeg> {
  const edge = { fromPlaceId: options.from.placeId, toPlaceId: options.to.placeId };
  // 直线距离只决定值得查询哪些方式，不能拿来当真实通行距离或时间。
  // 显式 mode 表示复核已保存的方案，只查原方式；重新比较方式会改变用户已确认的安排。
  const modes = options.mode
    ? [options.mode]
    : modesToTry(straightMeters(options.from.place.location, options.to.place.location), options.travel);
  const answered: { option: RouteOption; evidence: { provider: string; sourceKind: "fixture" | "live"; retrievedAt: string } }[] = [];
  let requests = 0;
  let lastFailure = "no_route";
  let stopped = false;
  const ask = async (mode: DayTravelMode) => {
    await options.beforeRequest?.();
    requests += 1;
    const reply = await options.provider.findRoutes({
      ...routeBetween(options.from.place, options.to.place),
      mode,
      departureAt: options.departureAt,
    }, options.call);
    if (reply.status === "ok") {
      // 同一方式多条路线按时长、距离、原始位置依次决胜，保证相同输入下选择稳定。
      const option = reply.routes
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.mode === mode)
        .sort((a, b) =>
          a.item.durationSeconds - b.item.durationSeconds ||
          a.item.distanceMeters - b.item.distanceMeters ||
          a.index - b.index)[0]?.item;
      if (option) answered.push({ option: withParking(option), evidence: reply.evidence });
      return;
    }
    lastFailure = reply.status === "failure" ? reply.failure.code : reply.reason;
    // 权限、配额、限流与取消停止继续问其他方式；不能靠换方式绕过供应商拒绝。
    if (reply.status === "failure" && ["quota_exceeded", "authorization_failed", "rate_limited", "cancelled"].includes(reply.failure.code)) {
      stopped = true;
    }
  };
  for (const mode of modes) {
    await ask(mode);
    if (stopped) break;
  }
  // 直线短不一定路程短，例如隔湖三公里可能要绕行六公里；只有现有方式都慢且用户允许时才补查车辆。
  const ride = (["taxi", "driving"] as const).find((mode) => options.travel.allowed.includes(mode) && !modes.includes(mode));
  const quick = answered.some(({ option }) => option.durationSeconds / 60 <= SLOW_LEG_MINUTES);
  if (!options.mode && !stopped && !quick && ride) await ask(ride);
  const best = pickOption(answered.map((item) => item.option), options.travel);
  // 查不到可用方式就保留 unknown，不能退成直线步行估时，让后面的排程误判为可达。
  if (!best) return { route: { ...edge, status: "unknown", reason: lastFailure }, requests };
  const evidence = answered.find((item) => item.option === best)!.evidence;
  return {
    route: {
      ...edge,
      status: "known",
      durationSeconds: best.durationSeconds,
      distanceMeters: best.distanceMeters,
      provider: evidence.provider,
      sourceKind: evidence.sourceKind,
      retrievedAt: evidence.retrievedAt,
      // 步行字段保持缺省，兼容旧数据的精确形状与指纹；其余方式才显式写出。
      ...(best.mode !== "walking" ? { mode: best.mode } : {}),
      ...(best.fareYuan !== undefined ? { fareYuan: best.fareYuan } : {}),
      ...(best.summary ? { summary: best.summary } : {}),
      ...(best.walkingMeters !== undefined ? { walkingMeters: best.walkingMeters } : {}),
    },
    ...(best.path?.length ? { path: best.path } : {}),
    requests,
  };
}
