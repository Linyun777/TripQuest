import {
  dayMinutes,
  type DayActivity,
  type DayIssue,
  type DayPlanningInput,
  type DayRoute,
  type DaySchedule,
  type DayValidation,
} from "@tripquest/domain";
import { openingFor } from "./opening-hours";
import { z } from "zod";
import type { DayDraftConfirmationSnapshot } from "./day-confirmation";
import {
  estimatedFloor,
  interestIdSchema,
  planningRequirementsSchema,
  type PlanningInterestId,
  type PlanningPlace,
  type PlanningRequirements,
} from "./planning-requirements";

export const DAY_PLANNING_PROTOCOL = "day-planning.v1" as const;
export const DAY_STAY_MINUTES = { culture: 90, nature: 60, city_walk: 45, food: 60 } as const;
export const DAY_INTEREST_QUERIES = {
  culture: "博物馆", nature: "公园", city_walk: "步行街", food: "餐饮",
} as const;

export { KIND_STAYS, MAX_STAY_MINUTES, PLACE_KINDS, stayForKind, type PlaceKind } from "./place-kinds";
import type { PlaceKind } from "./place-kinds";

/**
 * 按产品规则把风景名胜大类 1100、公园广场 1101、风景名胜 1102，以及交通地名 1903（道路名，如去“苏堤”走走）
 * 视作室外类，不能代表每个设施的实际遮蔽情况（V2.10 真实验证：“苏堤春晓”是 110000，“苏堤”是 190301）。
 */
export function isOutdoorCategory(code: string | undefined): boolean {
  return !!code && /^(110[012]|1903)/.test(code);
}

/** V2.10：爬山、海边水上按类型算户外；其余看高德分类（公园广场、风景名胜）。 */
export function isOutdoorPlace(kind: PlaceKind | undefined, categoryCode: string | undefined): boolean {
  return kind === "hike" || kind === "water" || isOutdoorCategory(categoryCode);
}

const id = z.string().min(1).max(100);
const minute = z.number().int().min(0).max(1439);
export const dayIssueSchema = z.strictObject({
  code: z.enum([
    "day_invalid_input", "day_activity_count", "day_unknown_activity", "day_duplicate_activity",
    "day_missing_protected", "day_fixed_order", "day_route_unknown", "day_route_evidence",
    "day_same_place_invalid", "day_fixed_late", "day_opening_conflict", "day_opening_unknown", "day_time_of_day",
    "day_tickets_unknown", "day_window_exceeded", "day_schedule_mismatch", "day_frozen_changed",
  ]),
  kind: z.enum(["violation", "unknown"]),
  activityId: id.optional(),
  fromPlaceId: id.optional(),
  toPlaceId: id.optional(),
  expected: z.number().int().optional(),
  actual: z.number().int().optional(),
});
const sourceSchema = z.strictObject({
  provider: z.string().min(1).max(80),
  sourceKind: z.enum(["fixture", "live"]),
  attribution: z.string().min(1).max(300),
  retrievedAt: z.iso.datetime({ offset: true }),
  datasetVersion: z.string().max(80).optional(),
});
const namedPlaceSchema = z.strictObject({ placeId: id, name: z.string().min(1).max(200), source: sourceSchema });
export const dayDraftSchema = z.strictObject({
  protocolVersion: z.literal(DAY_PLANNING_PROTOCOL),
  runId: id,
  requirementsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
  date: z.iso.date(),
  timeZone: z.literal("Asia/Shanghai"),
  window: z.strictObject({ startsAt: minute, endsAt: minute }),
  startPlace: namedPlaceSchema,
  endPlace: namedPlaceSchema,
  places: z.array(namedPlaceSchema).min(1).max(30),
  activities: z.array(z.strictObject({
    activityId: id,
    placeId: id,
    role: z.enum(["optional", "required", "fixed", "discovered"]),
    stayMinutes: z.number().int().positive().max(1439),
    staySource: z.enum(["user", "system_estimate"]),
    interest: interestIdSchema.optional(),
    /** 模型为已选中的新发现站给出的短理由，只作解释，不是地点、路线或营业事实。 */
    reason: z.string().min(1).max(80).optional(),
    arrivesAt: minute,
    startsAt: minute,
    endsAt: minute,
    waitMinutes: z.number().int().min(0).max(1439),
  })).min(1).max(6),
  legs: z.array(z.strictObject({
    fromPlaceId: id,
    toPlaceId: id,
    departsAt: minute,
    arrivesAt: minute,
    travelMinutes: z.number().int().min(0).max(1439),
    bufferMinutes: z.union([z.literal(0), z.literal(5), z.literal(10)]),
    distanceMeters: z.number().int().nonnegative(),
    source: z.enum(["route_estimate", "same_place_assumption"]),
    evidence: sourceSchema.optional(),
    /** 缺省为步行以兼容旧草稿；生成与保存时不能另猜一种出行方式。 */
    mode: z.enum(["walking", "transit", "taxi", "bicycling", "driving"]).optional(),
    fareYuan: z.number().nonnegative().max(10_000).optional(),
    summary: z.string().min(1).max(80).optional(),
    walkingMeters: z.number().int().nonnegative().optional(),
  })).min(2).max(7),
  endArrival: minute,
  totalWalkingMinutes: z.number().int().nonnegative(),
  longestWalkingMinutes: z.number().int().nonnegative(),
  verification: z.enum(["checked", "pending"]),
  checks: z.array(dayIssueSchema).max(30),
  assumptions: z.array(z.string().max(200)).max(12),
  omittedOptional: z.array(z.strictObject({
    activityId: id,
    name: z.string().min(1).max(200),
    reason: z.string().min(1).max(200),
  })).max(8),
  /**
   * V2.10：户外的站遇到雨、雷暴或 6 级以上大风预报时的提示。只提示、不删站；按本轮实时预报算，
   * 不进入正式持久化。
   */
  alerts: z.array(z.strictObject({
    activityId: id,
    weather: z.string().min(1).max(40),
    advice: z.string().min(1).max(80),
  })).max(6).optional(),
});
export type DayDraft = z.infer<typeof dayDraftSchema>;

export const dayCountsSchema = z.strictObject({
  model: z.number().int().min(0).max(10),
  searches: z.number().int().min(0).max(4),
  tries: z.number().int().min(0).max(3),
  routes: z.number().int().min(0).max(48),
  semanticRepairs: z.number().int().min(0).max(2),
});
export type DayCounts = z.infer<typeof dayCountsSchema>;
export const dayProgressSchema = z.strictObject({
  phase: z.enum(["preparing", "deciding", "searching", "routing", "checking", "observing"]),
  counts: dayCountsSchema,
  /** 进度文案由服务端根据名称和搜索词生成，只说明阶段，不携带供应商返回正文。 */
  detail: z.string().min(1).max(120).optional(),
});
export type DayProgress = z.infer<typeof dayProgressSchema>;
export const dayFailureSchema = z.enum([
  "model_error", "invalid_output", "semantic_invalid", "provider_error", "budget_exhausted",
  "timeout", "context_limit", "engine_limit", "internal_error", "live_budget",
]);
export type DayFailure = z.infer<typeof dayFailureSchema>;
const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
const resultBase = {
  runId: id,
  counts: dayCountsSchema,
  elapsedMs: z.number().int().nonnegative(),
  usage: usageSchema.nullable(),
};
export const dayPlanningResultSchema = z.union([
  z.strictObject({
    ...resultBase,
    status: z.literal("completed"),
    outcome: z.literal("draft"),
    draft: dayDraftSchema,
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal("completed"),
    outcome: z.literal("no_plan"),
    reason: z.enum(["no_suitable_places", "constraints_not_met", "insufficient_information"]),
    issues: z.array(dayIssueSchema).max(30),
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal("failed"),
    code: dayFailureSchema,
    /** 失败前发给模型的校验提示码，仅本机诊断使用，不附对话或地点详情。 */
    hints: z.array(z.string().min(1).max(80)).max(10).optional(),
  }),
  z.strictObject({ ...resultBase, status: z.literal("cancelled") }),
]);
export type DayPlanningResult = z.infer<typeof dayPlanningResultSchema>;

export const daySaveOfferSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    runId: z.uuid(),
    requirementsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    draftFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: z.string().min(1).max(48 * 1024),
    expiresAt: z.iso.datetime({ offset: true }),
    acknowledgeUnknownsRequired: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["disabled", "source_not_allowed", "snapshot_invalid", "receipt_too_large"]),
  }),
]);
export type DaySaveOffer = z.infer<typeof daySaveOfferSchema>;

export const dayStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), runId: id, sequence: z.literal(0) }),
  z.strictObject({ type: z.literal("progress"), runId: id, sequence: z.number().int().positive(), progress: dayProgressSchema }),
  z.strictObject({
    type: z.literal("result"), runId: id, sequence: z.number().int().positive(),
    result: dayPlanningResultSchema, saveOffer: daySaveOfferSchema.optional(),
  }),
]).superRefine((event, context) => {
  if (event.type !== "result") return;
  if (event.result.runId !== event.runId) {
    context.addIssue({ code: "custom", message: "Result belongs to another run" });
  }
  const offer = event.saveOffer;
  if (offer?.status !== "available") return;
  const result = event.result;
  if (result.status !== "completed" || result.outcome !== "draft" ||
    offer.runId !== event.runId || result.draft.runId !== event.runId ||
    offer.requirementsFingerprint !== result.draft.requirementsFingerprint ||
    offer.acknowledgeUnknownsRequired !== (result.draft.verification === "pending")) {
    context.addIssue({ code: "custom", message: "Save offer does not match the draft" });
  }
});
export type DayStreamEvent = z.infer<typeof dayStreamEventSchema>;
export const DAY_STREAM_EVENT_BYTES = 128 * 1024;
export const DAY_STREAM_TOTAL_BYTES = 512 * 1024;

export interface DayPlaceRecord {
  readonly placeId: string;
  readonly selection: PlanningPlace;
}
export interface DayActivityRecord {
  readonly activity: DayActivity;
  readonly interest?: PlanningInterestId;
  /** V2.10：新发现地点由模型估计的大致类型。 */
  readonly kind?: PlaceKind;
  /** V2.11：卡片上估计的停留排不下时最短能缩到多少（用户说的没有这一项，不缩）。 */
  readonly floor?: number;
}

/**
 * V2.11（stages/V2.11.md §3.2）：方案里被缩短的估计停留（活动 → 分钟）。只认卡片上估计的、
 * 缩短后不低于下限也不高于原估计的；其余差异不认，确认时重演排程就对不上。
 */
export function shortenedStays(
  records: readonly DayActivityRecord[],
  planned: readonly { readonly activityId: string; readonly stayMinutes: number }[],
): Map<string, number> {
  const stays = new Map<string, number>();
  for (const item of planned) {
    const record = records.find((r) => r.activity.activityId === item.activityId);
    if (record?.floor !== undefined && item.stayMinutes >= record.floor && item.stayMinutes < record.activity.stayMinutes) {
      stays.set(item.activityId, item.stayMinutes);
    }
  }
  return stays;
}

/** 按缩短后的停留换掉活动（其余不变）。 */
export function withStays(records: readonly DayActivityRecord[], stays: ReadonlyMap<string, number>): DayActivityRecord[] {
  return records.map((record) => stays.has(record.activity.activityId)
    ? { ...record, activity: { ...record.activity, stayMinutes: stays.get(record.activity.activityId)! } }
    : record);
}

/** “5 小时”“4.5 小时”“45 分钟”。 */
function hoursText(minutes: number): string {
  return minutes % 30 === 0 && minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** 天气仅影响推荐偏好，不参与已核实硬事实，也不进入持久化。 */
export const dayWeatherSchema = z.strictObject({
  dayWeather: z.string().min(1).max(20),
  nightWeather: z.string().min(1).max(20),
  highCelsius: z.number().min(-60).max(60),
  lowCelsius: z.number().min(-60).max(60),
  wet: z.boolean(),
  /** V2.10：白天或夜间风力 6 级及以上。 */
  windy: z.boolean().optional(),
});
export type DayWeather = z.infer<typeof dayWeatherSchema>;
export interface DayPlanningProblem {
  readonly protocolVersion: typeof DAY_PLANNING_PROTOCOL;
  readonly runId: string;
  readonly requirementsFingerprint: string;
  readonly requirements: PlanningRequirements;
  readonly input: DayPlanningInput;
  readonly places: readonly DayPlaceRecord[];
  readonly activities: readonly DayActivityRecord[];
  readonly weather?: DayWeather;
  /**
   * V2.11：一天里跨城市时各城市的预报（行政区编码 → 预报）。户外提示按每一站所在的城市看，
   * 没有那个城市的就用 weather。
   */
  readonly weatherByCity?: Readonly<Record<string, DayWeather>>;
}
export interface DayPlanningRunner {
  run(problem: DayPlanningProblem, options: {
    signal: AbortSignal;
    onProgress: (progress: DayProgress) => void;
    onDraftReady?: (snapshot: DayDraftConfirmationSnapshot) => void;
    /** 所选路线的地图折线只供本次渲染，不随草稿存进正式行程。 */
    onRoutePath?: (fromPlaceId: string, toPlaceId: string, path: readonly (readonly [number, number])[]) => void;
  }): Promise<DayPlanningResult>;
}

/** 把已核验地点选择和需求转为冻结规划问题；这个纯映射本身不验证签名或调用外部服务。 */
export function createDayPlanningProblem(options: {
  requirements: PlanningRequirements;
  runId: string;
  requirementsFingerprint: string;
  nowMs: number;
  weather?: DayWeather;
  /** V2.11：各城市的预报（一天里跨城市时）。 */
  weatherByCity?: Readonly<Record<string, DayWeather>>;
  /** 对话规划把等待转为晚出发；旧步行演示、编辑和重规划维持原时间语义，不自动启用。 */
  leaveLate?: true;
}): DayPlanningProblem {
  const requirements = planningRequirementsSchema.parse(options.requirements);
  // 把供应商地点映射为本轮 p1 / p2、a1 / a2，模型只能组合已登记的对象。
  // 同一外部地点若出现不一致快照就拒绝，避免一次规划混用两份相互矛盾的事实。
  const places: DayPlaceRecord[] = [];
  const add = (selection: PlanningPlace) => {
    const existing = places.find((p) =>
      p.selection.place.ref.provider === selection.place.ref.provider &&
      p.selection.place.ref.externalId === selection.place.ref.externalId);
    if (existing) {
      if (JSON.stringify(existing.selection.place) !== JSON.stringify(selection.place)) {
        throw new Error("conflicting_place_snapshot");
      }
      return existing.placeId;
    }
    const placeId = `p${places.length + 1}`;
    places.push({ placeId, selection });
    return placeId;
  };
  const startPlaceId = add(requirements.startPlace);
  const endPlaceId = add(requirements.endPlace);
  const activities: DayActivityRecord[] = requirements.visits.map((visit, index) => ({
    activity: {
      activityId: `a${index + 1}`,
      placeId: add(visit.place),
      role: visit.role,
      stayMinutes: visit.role === "fixed"
        ? dayMinutes(visit.endsAt) - dayMinutes(visit.startsAt) : visit.stayMinutes,
      staySource: visit.role !== "fixed" && visit.staySource === "estimate" ? "system_estimate" : "user",
      ...(visit.role === "fixed" ? {
        fixed: { startsAt: dayMinutes(visit.startsAt), endsAt: dayMinutes(visit.endsAt) },
      } : {}),
      // 只有营业信息对应所选日期时才形成窗口，其余保持 unknown。
      opening: openingFor(visit.place.hours, requirements.date),
      tickets: "unknown",
    },
    ...(visit.role !== "fixed" && visit.staySource === "estimate" ? {
      floor: estimatedFloor(visit)!,
      ...(visit.kind ? { kind: visit.kind } : {}),
    } : {}),
  }));
  const problem: DayPlanningProblem = {
    protocolVersion: DAY_PLANNING_PROTOCOL,
    runId: options.runId,
    requirementsFingerprint: options.requirementsFingerprint,
    requirements,
    places,
    activities,
    ...(options.weather ? { weather: dayWeatherSchema.parse(options.weather) } : {}),
    ...(options.weatherByCity ? {
      weatherByCity: Object.fromEntries(Object.entries(options.weatherByCity).map(([city, day]) => [city, dayWeatherSchema.parse(day)])),
    } : {}),
    input: {
      date: requirements.date,
      timeZone: requirements.timeZone,
      window: { startsAt: dayMinutes(requirements.window.startsAt), endsAt: dayMinutes(requirements.window.endsAt) },
      startPlaceId,
      endPlaceId,
      places: places.map(({ placeId, selection }) => ({
        placeId,
        ...selection.place.ref,
        snapshot: JSON.stringify(selection.place),
      })),
      activities: activities.map((record) => record.activity),
      bufferMinutes: requirements.pace === "relaxed" ? 10 : 5,
      nowMs: options.nowMs,
      ...(options.leaveLate ? { leaveLate: true as const } : {}),
    },
  };
  return freezeDayProblem(problem);
}

/** 递归冻结输入与结果树，防止工具或调用方通过共享引用悄悄改变后续校验所依据的需求。 */
export function freezeDayProblem<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freezeDayProblem);
  }
  return value;
}

/**
 * 将独立校验后的排程装配为展示契约：补名称、来源、未知项、假设和未纳入的可选项。
 * 这里不再做规划决策；pending 会原样保留，不能在展示转换时升级成已核实。
 */
export function buildDayDraft(options: {
  problem: Pick<DayPlanningProblem, "input" | "runId" | "requirementsFingerprint" | "activities" | "weather" | "weatherByCity">;
  places: readonly DayPlaceRecord[];
  activities: readonly DayActivityRecord[];
  schedule: DaySchedule;
  validation: DayValidation;
  routeEvidence: ReadonlyMap<string, PlanningPlace["evidence"]>;
  createdAt: string;
  reasons?: Readonly<Record<string, string>>;
  /** 传入已选路线用于展示分段方式和费用；不在展示转换时重新选路。 */
  routes?: readonly DayRoute[];
  /** V2.11：排不下时缩短了的估计停留（活动 → 分钟），方案里写明原估计。 */
  stays?: ReadonlyMap<string, number>;
}): DayDraft {
  const { problem, schedule } = options;
  if (options.validation.verdict === "rejected") throw new Error("unverified_draft");
  const named = (placeId: string) => {
    const record = options.places.find((p) => p.placeId === placeId)!;
    return { placeId, name: record.selection.place.name, source: record.selection.evidence };
  };
  const usedPlaces = new Set([
    problem.input.startPlaceId, problem.input.endPlaceId, ...schedule.activities.map((a) => a.placeId),
  ]);
  const selected = new Set(schedule.activities.map((a) => a.activityId));
  // 假设与未知项随草稿一起展示：缓冲、估计停留与票务未核实都不能在转换视图时变成确定事实。
  const assumptions = [
    `跨地点衔接保留 ${problem.input.bufferMinutes} 分钟缓冲，属于产品假设。`,
    "步行时间按本轮查询估计，并非所选日期的交通预测。",
    "新发现地点的停留时长为系统预计，尚未核实营业与票务。",
  ];
  if (schedule.legs.some((leg) => leg.source === "same_place_assumption")) {
    assumptions.push("同一地点，未估计场内移动；活动停留仍计时。");
  }
  const hasFood = schedule.activities.some((a) => {
    const record = options.activities.find((r) => r.activity.activityId === a.activityId)!;
    const category = options.places.find((p) => p.placeId === a.placeId)?.selection.place.categoryCode;
    return record.interest === "food" || category?.startsWith("05");
  });
  if (!hasFood && problem.input.window.endsAt - problem.input.window.startsAt >= 360) {
    assumptions.push("餐饮/休息未单独安排。");
  }
  for (const [activityId, minutes] of options.stays ?? []) {
    const record = options.activities.find((r) => r.activity.activityId === activityId)!;
    assumptions.push(`${named(record.activity.placeId).name.slice(0, 40)}按 ${hoursText(minutes)}排（原估 ${hoursText(record.activity.stayMinutes)}）。`);
  }
  return dayDraftSchema.parse({
    protocolVersion: DAY_PLANNING_PROTOCOL,
    runId: problem.runId,
    requirementsFingerprint: problem.requirementsFingerprint,
    createdAt: options.createdAt,
    date: problem.input.date,
    timeZone: problem.input.timeZone,
    window: problem.input.window,
    startPlace: named(problem.input.startPlaceId),
    endPlace: named(problem.input.endPlaceId),
    places: options.places.filter((p) => usedPlaces.has(p.placeId)).map((p) => named(p.placeId)),
    activities: schedule.activities.map((a) => {
      const record = options.activities.find((r) => r.activity.activityId === a.activityId)!;
      return {
        ...a,
        role: record.activity.role,
        stayMinutes: options.stays?.get(a.activityId) ?? record.activity.stayMinutes,
        staySource: record.activity.staySource,
        ...(record.interest ? { interest: record.interest } : {}),
        ...(options.reasons?.[a.activityId] ? { reason: options.reasons[a.activityId] } : {}),
      };
    }),
    legs: schedule.legs.map((leg) => {
      const route = options.routes?.find((item) =>
        item.fromPlaceId === leg.fromPlaceId && item.toPlaceId === leg.toPlaceId);
      const travel = route?.status === "known" ? route : undefined;
      return {
        ...leg,
        ...(options.routeEvidence.has(JSON.stringify([leg.fromPlaceId, leg.toPlaceId]))
          ? { evidence: options.routeEvidence.get(JSON.stringify([leg.fromPlaceId, leg.toPlaceId])) } : {}),
        ...(travel?.mode ? { mode: travel.mode } : {}),
        ...(travel?.fareYuan !== undefined ? { fareYuan: travel.fareYuan } : {}),
        ...(travel?.summary ? { summary: travel.summary } : {}),
        ...(travel?.walkingMeters !== undefined ? { walkingMeters: travel.walkingMeters } : {}),
      };
    }),
    endArrival: schedule.endArrival,
    totalWalkingMinutes: schedule.totalWalkingMinutes,
    longestWalkingMinutes: schedule.longestWalkingMinutes,
    verification: options.validation.verdict,
    checks: options.validation.issues,
    assumptions,
    // 未排入的可选站也显式列出，用户能看见取舍；固定与必去不能靠“省略列表”获得豁免。
    omittedOptional: problem.activities.filter((r) =>
      r.activity.role === "optional" && !selected.has(r.activity.activityId)).map((r) => ({
      activityId: r.activity.activityId,
      name: named(r.activity.placeId).name,
      reason: "本轮组合未纳入此可选项；优先保留必去、固定事项及完整衔接。",
    })),
    ...outdoorAlerts(problem, schedule, options),
  });
}

const BAD_WEATHER = /雨|雪|雹|雷/;

/**
 * V2.10：户外的站在它所在的时段（18 点前看白天预报，之后看夜间）有雨、雷暴，或当天有大风时提示。
 * 只提示、不删站；建议是固定文字，不编造天气以外的事实。
 */
function outdoorAlerts(
  forecast: Pick<DayPlanningProblem, "weather" | "weatherByCity">,
  schedule: DaySchedule,
  options: { places: readonly DayPlaceRecord[]; activities: readonly DayActivityRecord[] },
): { alerts?: DayDraft["alerts"] } {
  if (!forecast.weather && !forecast.weatherByCity) return {};
  const alerts = schedule.activities.flatMap((item) => {
    const record = options.activities.find((r) => r.activity.activityId === item.activityId);
    const place = options.places.find((p) => p.placeId === item.placeId)?.selection.place;
    if (!isOutdoorPlace(record?.kind, place?.categoryCode)) return [];
    // V2.11：按这一站所在城市的预报（一天里跨城市时）。
    const weather = (place?.cityAdcode ? forecast.weatherByCity?.[place.cityAdcode] : undefined) ?? forecast.weather;
    if (!weather) return [];
    const words = [
      ...(item.startsAt < 18 * 60 ? [weather.dayWeather] : []),
      ...(item.endsAt > 18 * 60 ? [weather.nightWeather] : []),
    ].filter((word) => BAD_WEATHER.test(word));
    if (!words.length && !weather.windy) return [];
    const said = [...new Set(words)].join("转");
    return [{
      activityId: item.activityId,
      weather: [said, weather.windy ? "6 级以上大风" : ""].filter(Boolean).join("，"),
      advice: words.length
        ? "这里在户外：可以挪到天气好些的时段、换个室内的地方，或者带好雨具。"
        : "这里在户外：注意安全，可以挪到别的时段或换个室内的地方。",
    }];
  });
  return alerts.length ? { alerts } : {};
}

export function explainDayOutcome(counts: DayCounts, issues: readonly DayIssue[]): string {
  const routeUnknown = issues.some((issue) => issue.code === "day_route_unknown");
  return `本轮进行了 ${counts.searches} 次地点调查、${counts.tries} 次组合试算。${routeUnknown
    ? "有衔接路线无法核实，不能提供可靠时间线。"
    : "本轮未找到满足要求的草稿。"}`;
}
