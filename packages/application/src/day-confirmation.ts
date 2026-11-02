import { z } from "zod";
import { openingFor } from "./opening-hours";
import { createHash } from "node:crypto";
import {
  sameDayPlace,
  scheduleDay,
  validateDayDraft,
  type DayPlanningInput,
  type DayRoute,
} from "@tripquest/domain";
import {
  PLANNING_FIXTURE_PROVIDER,
  PLANNING_FIXTURE_VERSION,
  planningFixturePlaces,
  PlanningFixtureProvider,
} from "@tripquest/providers/planning-fixture";
import { estimateToleranceSeconds, withParking } from "./leg-choice";
import {
  DAY_PLANNING_PROTOCOL,
  MAX_STAY_MINUTES,
  PLACE_KINDS,
  buildDayDraft,
  createDayPlanningProblem,
  dayDraftSchema,
  dayWeatherSchema,
  freezeDayProblem,
  shortenedStays,
  withStays,
  type DayActivityRecord,
  type DayDraft,
  type DayPlaceRecord,
  type DayPlanningProblem,
} from "./day-planning";
import {
  interestIdSchema,
  interestWithin,
  planningInterestSpecs,
  planningPlaceKey,
  planningPlaceSchema,
  planningRequirementsSchema,
} from "./planning-requirements";
import type { MobilityProvider } from "@tripquest/providers";
import { canonicalJson, fingerprint } from "./fingerprint";
import { routeBetween } from "./route-request";

export const DAY_CONFIRMATION_PROTOCOL = "day-draft-confirmation.v1";
/** 确认快照的数据来源；地点与路线必须属于同一条模拟或真实数据链路。 */
export type DaySnapshotSource = "fixture" | "amap";

/** 识别地点所属的数据源；混入多个提供方或未知提供方时返回 null，后续完整校验还会核对路线证据。 */
export function daySnapshotSource(snapshot: DayDraftConfirmationSnapshot): DaySnapshotSource | null {
  const providers = new Set([
    snapshot.problem.requirements.startPlace.place.ref.provider,
    ...snapshot.places.map((item) => item.selection.place.ref.provider),
  ]);
  if (providers.size !== 1) return null;
  const [provider] = providers;
  return provider === "amap" ? "amap" : provider === PLANNING_FIXTURE_PROVIDER ? "fixture" : null;
}
const id = z.string().regex(/^[ap]\d{1,2}$/);
const minute = z.number().int().min(0).max(1439);
const windowSchema = z.strictObject({ startsAt: minute, endsAt: minute });
const openingSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({ status: z.literal("closed"), date: z.iso.date() }),
  z.strictObject({
    status: z.literal("known"),
    date: z.iso.date(),
    windows: z.array(windowSchema).max(12),
    latestEntry: minute.optional(),
  }),
]);
const activitySchema = z.strictObject({
  activityId: id,
  placeId: id,
  role: z.enum(["optional", "required", "fixed", "discovered"]),
  stayMinutes: z.number().int().min(1).max(1439),
  staySource: z.enum(["user", "system_estimate"]),
  fixed: windowSchema.optional(),
  within: windowSchema.optional(),
  opening: openingSchema,
  tickets: z.enum(["unknown", "not_required", "confirmed"]),
});
const placeRecordSchema = z.strictObject({ placeId: id, selection: planningPlaceSchema });
const activityRecordSchema = z.strictObject({
  activity: activitySchema,
  interest: interestIdSchema.optional(),
  kind: z.enum(PLACE_KINDS).optional(),
  floor: z.number().int().min(15).max(MAX_STAY_MINUTES).optional(),
});
const domainPlaceSchema = z.strictObject({
  placeId: id,
  provider: z.string().min(1).max(80),
  externalId: z.string().min(1).max(128),
  snapshot: z.string().max(4096),
});
const inputSchema = z.strictObject({
  date: z.iso.date(),
  timeZone: z.literal("Asia/Shanghai"),
  window: windowSchema,
  startPlaceId: id,
  endPlaceId: id,
  places: z.array(domainPlaceSchema).min(1).max(10),
  activities: z.array(activitySchema).max(8),
  bufferMinutes: z.union([z.literal(5), z.literal(10)]),
  nowMs: z.number().int().nonnegative().safe(),
  leaveLate: z.literal(true).optional(),
});
const problemSchema = z.strictObject({
  protocolVersion: z.literal(DAY_PLANNING_PROTOCOL),
  runId: z.uuid(),
  requirementsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requirements: planningRequirementsSchema,
  input: inputSchema,
  places: z.array(placeRecordSchema).min(1).max(10),
  activities: z.array(activityRecordSchema).max(8),
  weather: dayWeatherSchema.optional(),
  weatherByCity: z.record(z.string().regex(/^\d{6}$/), dayWeatherSchema).optional(),
});
const routeBase = { fromPlaceId: id, toPlaceId: id };
const routeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...routeBase,
    status: z.literal("known"),
    durationSeconds: z.number().int().nonnegative().safe(),
    distanceMeters: z.number().int().nonnegative().safe(),
    provider: z.string().min(1).max(80),
    sourceKind: z.enum(["fixture", "live"]),
    retrievedAt: z.iso.datetime({ offset: true }),
    mode: z.enum(["walking", "transit", "taxi", "bicycling", "driving"]).optional(),
    fareYuan: z.number().nonnegative().max(10_000).optional(),
    summary: z.string().min(1).max(80).optional(),
    walkingMeters: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ ...routeBase, status: z.literal("same_place_assumption") }),
]);
export const dayDraftConfirmationSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(DAY_CONFIRMATION_PROTOCOL),
  problem: problemSchema,
  places: z.array(placeRecordSchema).min(1).max(16),
  activities: z.array(activityRecordSchema).min(1).max(14),
  selectedOrder: z.array(id).min(1).max(6),
  routes: z.array(routeSchema).min(1).max(7),
  draft: dayDraftSchema,
});
export type DayDraftConfirmationSnapshot = z.infer<typeof dayDraftConfirmationSnapshotSchema>;

/**
 * 保存凭据携带的是重建候选所需的事实，不是整个搜索过程。
 * 仍保留原始活动以复核必去与固定事项，但剔除未采用的新候选和无关路线，缩小确认边界。
 */
export function createDayDraftConfirmationSnapshot(options: {
  problem: DayPlanningProblem;
  places: readonly DayPlaceRecord[];
  activities: readonly DayActivityRecord[];
  routes: readonly DayRoute[];
  draft: DayDraft;
}): DayDraftConfirmationSnapshot {
  const selected = new Set(options.draft.activities.map((item) => item.activityId));
  const activities = options.activities.filter((item) =>
    selected.has(item.activity.activityId) ||
    options.problem.activities.some((original) => original.activity.activityId === item.activity.activityId));
  const neededPlaces = new Set([
    ...options.problem.places.map((item) => item.placeId),
    ...activities.map((item) => item.activity.placeId),
  ]);
  const edges = new Set(options.draft.legs.map(edgeKey));
  return freezeDayProblem(dayDraftConfirmationSnapshotSchema.parse({
    schemaVersion: DAY_CONFIRMATION_PROTOCOL,
    problem: options.problem,
    places: options.places.filter((item) => neededPlaces.has(item.placeId)),
    activities,
    selectedOrder: options.draft.activities.map((item) => item.activityId),
    routes: options.routes.filter((item) => edges.has(edgeKey(item))),
    draft: options.draft,
  }));
}

function edgeKey(edge: { fromPlaceId: string; toPlaceId: string }): string {
  return JSON.stringify([edge.fromPlaceId, edge.toPlaceId]);
}
function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid day confirmation snapshot");
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * 重复确认也要验证快照自身的来源与约束完整性。
 * 是否仍对应当前目录版本，只在查不到已保存结果、准备首次写入时检查。
 */
export function assertDaySnapshotIntegrity(
  snapshot: DayDraftConfirmationSnapshot,
  currentDirectory = true,
  source: DaySnapshotSource = "fixture",
): void {
  const { problem, draft } = snapshot;
  invariant(draft.runId === problem.runId &&
    draft.requirementsFingerprint === problem.requirementsFingerprint);
  // 按生成时约定的算法重算需求指纹，避免把被替换的需求当成原始输入。
  invariant(problem.requirementsFingerprint === fingerprintRequirements(problem.requirements));
  // 不信任凭据里附带的“已规范化问题”：从原需求再构造一次，防止只改底层时间窗或保护角色。
  const rebuilt = createDayPlanningProblem({
    requirements: problem.requirements,
    runId: problem.runId,
    requirementsFingerprint: problem.requirementsFingerprint,
    nowMs: problem.input.nowMs,
    ...(problem.weather ? { weather: problem.weather } : {}),
    ...(problem.weatherByCity ? { weatherByCity: problem.weatherByCity } : {}),
    ...(problem.input.leaveLate ? { leaveLate: true } : {}),
  });
  invariant(equal(problem, rebuilt));
  const originalIds = new Set(problem.activities.map((item) => item.activity.activityId));
  const selectedIds = new Set(snapshot.selectedOrder);
  invariant(selectedIds.size === snapshot.selectedOrder.length);
  invariant(equal(snapshot.selectedOrder, draft.activities.map((item) => item.activityId)));
  invariant(new Set(snapshot.activities.map((item) => item.activity.activityId)).size === snapshot.activities.length);
  invariant(new Set(snapshot.places.map((item) => item.placeId)).size === snapshot.places.length);
  invariant(new Set(snapshot.places.map((item) => planningPlaceKey(item.selection))).size === snapshot.places.length);
  // 原始活动即使未被选中也保留并逐项比较，避免候选通过删除输入来绕过必去、固定约束。
  for (const original of problem.activities) {
    invariant(equal(original, snapshot.activities.find((item) =>
      item.activity.activityId === original.activity.activityId)));
  }
  for (const record of snapshot.activities) {
    const activity = record.activity;
    invariant(snapshot.places.some((place) => place.placeId === activity.placeId));
    if (originalIds.has(activity.activityId)) continue;
    const spec = planningInterestSpecs(problem.requirements).find((item) => item.id === record.interest);
    invariant(selectedIds.has(activity.activityId) && record.interest && spec);
    // 发现项必须原样继承对应兴趣的时段，不能在确认时放宽到全天。
    const within = interestWithin(spec);
    // 停留时长允许模型估计，但必须落在产品规定的 15～600 分钟范围内（V2.10：大景区、爬山可以占大半天）。
    invariant(Number.isInteger(activity.stayMinutes) && activity.stayMinutes >= 15 && activity.stayMinutes <= MAX_STAY_MINUTES);
    invariant(equal(activity, {
      activityId: activity.activityId,
      placeId: activity.placeId,
      role: "discovered",
      stayMinutes: activity.stayMinutes,
      staySource: "system_estimate",
      ...(within ? { within } : {}),
      // 营业约束来自这个地点被选择时携带的当天信息，不能由候选自行另填。
      opening: openingFor(snapshot.places.find((place) => place.placeId === activity.placeId)?.selection.hours, problem.requirements.date),
      tickets: "unknown",
    }));
  }
  for (const original of problem.places) {
    invariant(equal(original, snapshot.places.find((item) => item.placeId === original.placeId)));
  }
  const neededPlaces = new Set([
    ...problem.places.map((item) => item.placeId),
    ...snapshot.activities.map((item) => item.activity.placeId),
  ]);
  invariant(snapshot.places.every((item) => neededPlaces.has(item.placeId)));
  const selections = [
    problem.requirements.startPlace,
    problem.requirements.endPlace,
    ...problem.requirements.visits.map((item) => item.place),
    ...problem.places.map((item) => item.selection),
    ...snapshot.places.map((item) => item.selection),
  ];
  const directory = planningFixturePlaces();
  const version = selections[0].evidence.datasetVersion;
  // 真实链路要求地点与证据都来自高德实时查询；模拟数据则必须共享同一目录版本。
  const fromSource = (provider: string, sourceKind: string, datasetVersion: string | undefined) =>
    source === "amap"
      ? provider === "amap" && sourceKind === "live" && datasetVersion === undefined
      : provider === PLANNING_FIXTURE_PROVIDER && sourceKind === "fixture" && datasetVersion === version;
  invariant(source === "amap" || (typeof version === "string" && version.length > 0));
  for (const selection of selections) {
    invariant(selection.place.ref.provider === (source === "amap" ? "amap" : PLANNING_FIXTURE_PROVIDER) &&
      fromSource(selection.evidence.provider, selection.evidence.sourceKind, selection.evidence.datasetVersion));
    if (currentDirectory && source === "fixture") {
      invariant(version === PLANNING_FIXTURE_VERSION);
      invariant(equal(selection.place, directory.find((place) =>
        planningPlaceKey({ ...selection, place }) === planningPlaceKey(selection))));
    }
    invariant(selection.place.name.trim() === selection.place.name && selection.place.name.length <= 80);
  }
  invariant(new Set(snapshot.routes.map(edgeKey)).size === snapshot.routes.length);
  const edges = new Set(draft.legs.map(edgeKey));
  invariant(snapshot.routes.length === edges.size && snapshot.routes.every((route) => edges.has(edgeKey(route))));
  for (const route of snapshot.routes) {
    if (route.status === "known") {
      invariant(fromSource(route.provider, route.sourceKind, source === "amap" ? undefined : version));
    }
  }
  for (const place of [draft.startPlace, draft.endPlace, ...draft.places]) {
    invariant(fromSource(place.source.provider, place.source.sourceKind, place.source.datasetVersion));
  }
  for (const leg of draft.legs) {
    invariant(leg.source === "same_place_assumption" ? !leg.evidence :
      !!leg.evidence &&
      fromSource(leg.evidence.provider, leg.evidence.sourceKind, leg.evidence.datasetVersion));
  }
  // 最后用快照中的原证据重演排程；字段各自合法还不够，展示草案必须确实由这些事实算出。
  const original = rebuildConfirmedDayDraft(snapshot, snapshot.routes, Date.parse(draft.createdAt));
  invariant(equal(original, draft));
}

// 这里保留原生成协议的 JSON 键顺序；改成规范化排序会让已签发凭据的需求指纹失效。
export function fingerprintRequirements(requirements: DayPlanningProblem["requirements"]): string {
  return fingerprintText(JSON.stringify(requirements));
}

function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function confirmationInput(
  snapshot: DayDraftConfirmationSnapshot,
  nowMs: number,
): DayPlanningInput {
  return {
    ...snapshot.problem.input,
    nowMs,
    places: snapshot.places.map(({ placeId, selection }) => ({
      placeId,
      ...selection.place.ref,
      snapshot: JSON.stringify(selection.place),
    })),
    // V2.11：方案里缩短了的估计停留按缩短后的排；只认合规的缩短，其余差异会在重演时对不上。
    activities: withStays(snapshot.activities, shortenedStays(snapshot.activities, snapshot.draft.activities))
      .map((item) => item.activity),
  };
}

export function rebuildConfirmedDayDraft(
  snapshot: DayDraftConfirmationSnapshot,
  routes: readonly DayRoute[],
  nowMs: number,
  evidence = new Map(snapshot.draft.legs.flatMap((leg) =>
    leg.evidence ? [[edgeKey(leg), leg.evidence] as const] : [])),
): DayDraft {
  const input = confirmationInput(snapshot, nowMs);
  // 固定用户选中的顺序重算，再用独立校验器复核；确认阶段没有再次让模型规划的自由度。
  const scheduled = scheduleDay(input, snapshot.selectedOrder, routes);
  invariant(scheduled.status === "scheduled");
  const validation = validateDayDraft(input, scheduled.schedule, routes);
  invariant(validation.verdict !== "rejected");
  return buildDayDraft({
    problem: snapshot.problem,
    places: snapshot.places,
    activities: snapshot.activities,
    schedule: scheduled.schedule,
    validation,
    routeEvidence: evidence,
    createdAt: snapshot.draft.createdAt,
    routes,
    stays: shortenedStays(snapshot.activities, snapshot.draft.activities),
    // 推荐理由是签发时的文字说明，重算只更新可计算事实，保留原理由供指纹核对。
    reasons: Object.fromEntries(snapshot.draft.activities.flatMap((activity) =>
      activity.reason ? [[activity.activityId, activity.reason]] : [])),
  });
}

/** 用本地模拟提供方刷新有向路线，确认过程不调用模型或外部地图。 */
export function refreshDayFixtureRoutes(
  snapshot: DayDraftConfirmationSnapshot,
  nowMs: number,
): Promise<DayDraft> {
  return refreshDayRoutes(snapshot, new PlanningFixtureProvider(() => nowMs), nowMs);
}

/** 提供方暂时不可用与路线确实不可达分开处理，前者允许用户稍后重试。 */
export class DayRouteUnavailableError extends Error {
  constructor() {
    super("Route provider unavailable");
  }
}

/**
 * 逐段按预览中的交通方式复查，再重新排程与校验。
 * 步行时长和距离必须一致；其他方式只容许有限时长波动，并保留用户看到的预览数字。
 * 超出容差必须重新预览，不能在保存时悄悄改时间。
 */
export async function refreshDayRoutes(
  snapshot: DayDraftConfirmationSnapshot,
  provider: MobilityProvider,
  nowMs: number,
): Promise<DayDraft> {
  const input = confirmationInput(snapshot, nowMs);
  const routes: DayRoute[] = [];
  const evidence = new Map();
  for (const previous of snapshot.routes) {
    const from = snapshot.places.find((item) => item.placeId === previous.fromPlaceId)!;
    const to = snapshot.places.find((item) => item.placeId === previous.toPlaceId)!;
    if (sameDayPlace(
      input.places.find((place) => place.placeId === from.placeId)!,
      input.places.find((place) => place.placeId === to.placeId)!,
    )) {
      invariant(previous.status === "same_place_assumption");
      routes.push({
        fromPlaceId: from.placeId,
        toPlaceId: to.placeId,
        status: "same_place_assumption",
      });
      continue;
    }
    invariant(previous.status === "known");
    // 复查原交通方式；临时换成另一种方式会改变用户确认的方案。
    const mode = previous.mode ?? "walking";
    const reply = await provider.findRoutes({
      ...routeBetween(from.selection.place, to.selection.place),
      mode,
      departureAt: `${input.date}T00:00:00+08:00`,
    });
    // 超时、限流等失败不能证明路线不可达，不能据此把候选改成另一份安排。
    if (reply.status === "failure") throw new DayRouteUnavailableError();
    invariant(reply.status === "ok");
    const shortest = reply.routes
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.mode === mode)
      .sort((a, b) => a.durationSeconds - b.durationSeconds ||
        a.distanceMeters - b.distanceMeters || a.index - b.index)[0];
    invariant(shortest);
    const route = withParking(shortest);
    if (mode === "walking") {
      invariant(previous.durationSeconds === route.durationSeconds && previous.distanceMeters === route.distanceMeters);
    } else {
      // 路况和班次会造成小幅估算波动；容差内只刷新证据时间，仍保存原安排。
      // 真正影响计划的变化必须交给用户重新确认。
      const drift = Math.abs(route.durationSeconds - previous.durationSeconds);
      invariant(drift <= estimateToleranceSeconds(previous.durationSeconds));
    }
    routes.push({
      ...previous,
      provider: reply.evidence.provider,
      sourceKind: reply.evidence.sourceKind,
      retrievedAt: reply.evidence.retrievedAt,
    });
    evidence.set(edgeKey(previous), reply.evidence);
  }
  // 实时查询完成时间可能晚于调用入口时间，证据新鲜度应按最晚返回时间复核。
  const checkedAt = Math.max(nowMs, ...routes.flatMap((route) =>
    route.status === "known" ? [Date.parse(route.retrievedAt)] : []));
  return rebuildConfirmedDayDraft(snapshot, routes, checkedAt, evidence);
}

/** 只剔除复查会刷新的元数据；活动顺序、路线、时间和其他业务字段仍参与比较。 */
function withoutEvidenceTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEvidenceTimes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["retrievedAt", "createdAt", "nowMs", "runId", "requirementsFingerprint"].includes(key))
      .map(([key, item]) => [key, withoutEvidenceTimes(item)]));
  }
  return value;
}

/**
 * 指纹比较“用户确认的安排是否还是同一份”，忽略刷新证据带来的时间戳变化。
 * 对无业务顺序的集合按 ID 排序；活动顺序、分段路线与时间保留，不能一起排序抹掉差异。
 */
export function dayDraftSemanticFingerprint(
  snapshot: DayDraftConfirmationSnapshot,
  draft: DayDraft = snapshot.draft,
): string {
  const sortById = <T>(items: readonly T[], key: (item: T) => string) =>
    [...items].sort((left, right) => key(left).localeCompare(key(right)));
  return fingerprint(withoutEvidenceTimes({
    protocol: DAY_CONFIRMATION_PROTOCOL,
    requirements: {
      ...snapshot.problem.requirements,
      interests: [...snapshot.problem.requirements.interests].sort(),
    },
    places: sortById(snapshot.places, (item) => item.placeId),
    activities: sortById(snapshot.activities, (item) => item.activity.activityId),
    selectedOrder: snapshot.selectedOrder,
    routes: sortById(snapshot.routes, edgeKey),
    draft: {
      ...draft,
      places: sortById(draft.places, (item) => item.placeId),
      checks: sortById(draft.checks, canonicalJson),
      omittedOptional: sortById(draft.omittedOptional, (item) => item.activityId),
    },
  }));
}
