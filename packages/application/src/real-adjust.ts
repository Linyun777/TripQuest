import { z } from "zod";
import type { ChinaDateTime } from "@tripquest/domain";
import type { InitialJourneyDraft, JourneyIdGenerator, StoredJourney } from "./contracts";
import type { DayDraft, DayPlanningResult } from "./day-planning";
import type { MobilityProvider } from "@tripquest/providers";
import {
  DayRouteUnavailableError,
  assertDaySnapshotIntegrity,
  dayDraftConfirmationSnapshotSchema,
  dayDraftSemanticFingerprint,
  refreshDayRoutes,
  type DayDraftConfirmationSnapshot,
} from "./day-confirmation";
import { fingerprint } from "./fingerprint";
import type { DayProgressCommand, DayProgressError, DayProgressReply, NewDayProgress } from "./day-progress";
import { dayProgressIntentFingerprint } from "./day-progress";
import { storedActivityRecordSchema } from "./day-state";
import {
  DEFAULT_TRAVEL,
  interestCountSchema,
  interestSlotSchema,
  planningRequirementsSchema,
  planningTimeSchema,
  type PlanningPlace,
  type PlanningRequirements,
  type TravelPreference,
} from "./planning-requirements";
import { REAL_DAY_SCHEMA, storedRealDaySchema, type RealPlace, type StoredRealDay } from "./real-day";
import { createCheckedIdFactory, toChinaDateTime } from "./runtime-values";

/**
 * 途中调整把剩余部分转换成新的一日规划，复用多方式与短途规划能力。
 * 未要求删除的站临时作为必去、预约保留原时段；用户确认后才与进度报告一起成为新版本。
 * 正式保存仍只保留编号、名称与自有计划。
 */

const uuid = z.uuid();
const interestText = z.string().trim().min(1).max(40);
/** 调整的新兴趣沿用卡片的时段与站数语义，不能退回只有自由文本而丢约束。 */
const adjustInterestSchema = z.union([
  interestText,
  z.strictObject({ text: interestText, when: interestSlotSchema.optional(), count: interestCountSchema.optional() }),
]);

/** 进入应用层的站点已由对话临时 key 映射为正式活动 ID，后续校验只处理稳定身份。 */
export const adjustRequestSchema = z.strictObject({
  completed: z.array(uuid).max(12),
  skipped: z.array(uuid).max(12),
  replace: z.array(z.strictObject({ activityId: uuid, interest: interestText, when: interestSlotSchema.optional() })).max(3),
  addInterests: z.array(adjustInterestSchema).max(3),
  resumeAt: planningTimeSchema.optional(),
  endsAt: planningTimeSchema.optional(),
  /** 明确选择从最后完成站、设备解析出的附近地点或整天原起点继续，不根据计划时刻猜现实位置。 */
  from: z.enum(["last_done", "here", "start"]).optional(),
});
export type AdjustRequest = z.infer<typeof adjustRequestSchema>;

const toStored = (value: string): ChinaDateTime => `${value.slice(0, 16)}:00+08:00`;
const validClock = (value: string) => Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const at = (date: string, value: number): ChinaDateTime => `${date}T${clock(value)}:00+08:00`;

/** 当前计划与截至此刻的累计完成/跳过状态，包含此前版本已经归档的历史。 */
export function realDayProgress(stored: StoredJourney): { completed: readonly string[]; skipped: readonly string[] } {
  return {
    completed: stored.dayProgress?.completedActivityIds ?? [],
    skipped: stored.dayProgress?.skippedActivityIds ?? [],
  };
}

/** 报告可引用当前版活动与它带来的归档身份，不能引用其他行程或从未出现过的活动。 */
function knownActivities(details: StoredRealDay): Set<string> {
  return new Set([
    ...details.activities.map((item) => item.record.activity.activityId),
    ...(details.archived ?? []).map((item) => item.activityId),
  ]);
}

/** 读取时复核当前报告的身份、地点与归档历史一致；坏持久化数据不能靠类型断言变成可信状态。 */
export function assertRealDayProgressMatches(stored: StoredJourney): void {
  const details = stored.realDay;
  const progress = stored.dayProgress;
  if (!details || !progress) return;
  const known = knownActivities(details);
  const ok = [...progress.completedActivityIds, ...progress.skippedActivityIds].every((id) => known.has(id)) &&
    (details.archived ?? []).every((item) => (item.status === "completed" ? progress.completedActivityIds : progress.skippedActivityIds).includes(item.activityId)) &&
    (progress.locationPlaceId === null || details.places.some((item) => item.placeId === progress.locationPlaceId));
  if (!ok) throw new Error("Real day progress does not match its version");
}

/** 真实行程报告是绑定当前计划/观察双版本的累计状态，不是只包含本次点击的增量。 */
export function checkRealDayProgress(
  stored: StoredJourney,
  command: DayProgressCommand,
): { status: "ok"; progress: NewDayProgress } | { status: "no_change"; observationVersion: number } | { status: DayProgressError } {
  const details = stored.realDay;
  if (stored.creationKind !== "real_day" || !details) return { status: "source_not_allowed" };
  if (command.basePlanVersion !== stored.currentPlan.version || command.baseObservationVersion !== stored.currentObservationVersion) {
    return { status: "stale" };
  }
  const known = knownActivities(details);
  const completed = new Set(command.completedActivityIds);
  const skipped = new Set(command.skippedActivityIds);
  if (completed.size !== command.completedActivityIds.length || skipped.size !== command.skippedActivityIds.length ||
    [...completed].some((id) => skipped.has(id) || !known.has(id)) || [...skipped].some((id) => !known.has(id))) {
    return { status: "invalid_report" };
  }
  // 归档标记只能延续，后续报告可以增加历史，不能把已完成改成跳过或从集合移除。
  for (const item of details.archived ?? []) {
    if (!(item.status === "completed" ? completed : skipped).has(item.activityId)) return { status: "invalid_report" };
  }
  if (command.location.kind === "known" && !details.places.some((item) => item.placeId === (command.location as { placeId: string }).placeId)) {
    return { status: "invalid_report" };
  }
  if (!command.observedAt.startsWith(`${details.context.date}T`) || !command.earliestResumeAt.startsWith(`${details.context.date}T`) ||
    !validClock(command.observedAt) || !validClock(command.earliestResumeAt) || command.earliestResumeAt < command.observedAt) {
    return { status: "invalid_report" };
  }
  // 累计集合和观察时刻都不能倒退，保证旧页面或迟到请求无法撤销新事实。
  const previous = stored.dayProgress;
  const observedAt = toStored(command.observedAt);
  const earliestResumeAt = toStored(command.earliestResumeAt);
  if (previous && (observedAt < previous.observedAt ||
    previous.completedActivityIds.some((id) => !completed.has(id)) ||
    previous.skippedActivityIds.some((id) => !skipped.has(id)))) {
    return { status: "invalid_report" };
  }
  const locationPlaceId = command.location.kind === "known" ? command.location.placeId : null;
  if (previous && previous.earliestResumeAt === earliestResumeAt && previous.locationPlaceId === locationPlaceId &&
    previous.completedActivityIds.length === completed.size && previous.skippedActivityIds.length === skipped.size) {
    return { status: "no_change", observationVersion: previous.version };
  }
  return {
    status: "ok",
    progress: {
      version: stored.currentObservationVersion + 1,
      basePlanVersion: stored.currentPlan.version,
      reportId: command.reportId,
      intentFingerprint: dayProgressIntentFingerprint(stored.journeyId, command),
      observedAt,
      earliestResumeAt,
      completedActivityIds: [...completed],
      skippedActivityIds: [...skipped],
      locationPlaceId,
      source: "user_reported",
    },
  };
}

export type PreparedAdjustment = {
  readonly status: "ok";
  /** null 表示当前要求已无法通过需求层检查，例如保留站的总停留超过窗口；仍可用于有界删站建议。 */
  readonly requirements: PlanningRequirements | null;
  /** 尚未通过完整需求校验的原请求，供后面尝试“明确少一站”的候选，不能直接启动规划。 */
  readonly asked: Readonly<Record<string, unknown>> & { readonly visits: readonly PlanningRequirements["visits"][number][] };
  /** 保留地点的高德编号映射到旧活动 ID，新方案同一站沿用此身份，历史报告才能继续指向它。 */
  readonly keep: ReadonlyMap<string, string>;
  /** 这次调整后的累计完成/跳过集合，包含所有历史版本，不重新安排这些站。 */
  readonly completed: readonly string[];
  readonly skipped: readonly string[];
  /** 本次明确跳过或替换的原站，用于生成删除差异，不把因失败没排上的站混成用户已同意删除。 */
  readonly removed: readonly string[];
  readonly resumeAt: number;
  /** 继续位置对应原行程地点时保存其 ID；若用设备新解析地点则为 null，由新草稿分配正式身份。 */
  readonly startPlaceId: string | null;
};

/**
 * 将剩余站转成一次新规划需求：继续地点与时刻为起点，未动站临时必去，预约维持原时段。
 * 用户要求的新兴趣与替换兴趣另外加入，已完成事实不进入候选池。
 */
export function prepareAdjustment(options: {
  details: StoredRealDay;
  done: { completed: readonly string[]; skipped: readonly string[] };
  request: AdjustRequest;
  nowMinute: number;
  /** 按行程地点 UUID 索引本轮实时查询结果，不能从旧记录恢复坐标。 */
  live: ReadonlyMap<string, PlanningPlace>;
  /** 只有用户明确要求从当前位置继续时，才使用本轮设备点解析出的最近地点。 */
  here?: PlanningPlace;
  travel?: TravelPreference;
  /** V2.10：行程的主要城市；缺省取出发点所在的城市。 */
  city?: { adcode: string; name: string };
}): PreparedAdjustment | { status: "invalid"; code: "unknown_stop" | "window" | "fixed_passed" | "nothing_left" | "here_missing" } {
  const { details, request } = options;
  const { context } = details;
  const known = knownActivities(details);
  const mentioned = [...request.completed, ...request.skipped, ...request.replace.map((item) => item.activityId)];
  if (mentioned.some((id) => !known.has(id))) return { status: "invalid", code: "unknown_stop" };
  // 把用户这次报告合入已有事实；完成优先，替换站同时视作不再访问，已处理站不再进入 remaining。
  const completed = [...new Set([...options.done.completed, ...request.completed])];
  const replaced = request.replace.map((item) => item.activityId);
  const skipped = [...new Set([...options.done.skipped, ...request.skipped, ...replaced])].filter((id) => !completed.includes(id));
  const gone = new Set([...completed, ...skipped]);
  const remaining = details.activities.filter((item) => !gone.has(item.record.activity.activityId));

  // 从当前向上取整的五分钟点继续，或按用户更晚的要求；不能早于原行程开始。
  const resumeAt = Math.max(context.window.startsAt, Math.ceil(options.nowMinute / 5) * 5, request.resumeAt ? minutes(request.resumeAt) : 0);
  const endsAt = request.endsAt ? minutes(request.endsAt) : context.window.endsAt;
  if (resumeAt >= endsAt - 15) return { status: "invalid", code: "window" };
  // 未处理预约已经过了开始时刻时先拒绝，不让模型通过移动预约时间来“修好”这个现实冲突。
  if (remaining.some((item) => item.record.activity.role === "fixed" && item.startsAt < resumeAt)) {
    return { status: "invalid", code: "fixed_passed" };
  }
  const interests = [
    ...request.replace.map((item) => ({ text: item.interest, ...(item.when ? { when: item.when } : {}) })),
    ...request.addInterests.map((item) => (typeof item === "string" ? { text: item } : item)),
  ];
  if (!remaining.length && !interests.length) return { status: "invalid", code: "nothing_left" };

  // 默认按已完成站的原结束时间取最后一站；也可明确从设备附近地点或整天起点继续。
  const done = [
    ...(details.archived ?? []).filter((item) => item.status === "completed"),
    ...details.activities.filter((item) => completed.includes(item.record.activity.activityId))
      .map((item) => ({ placeId: item.record.activity.placeId, endsAt: item.endsAt })),
  ].sort((a, b) => a.endsAt - b.endsAt);
  const from = request.from ?? "last_done";
  if (from === "here" && !options.here) return { status: "invalid", code: "here_missing" };
  const startPlaceId = from === "here" ? null : from === "start" ? context.startPlaceId : done.at(-1)?.placeId ?? context.startPlaceId;
  const start = startPlaceId ? options.live.get(startPlaceId)! : options.here!;
  // 原短途若无返程，删站后终点跟随最后保留站，不强制回到旧最后站。
  const endsAtLastStop = details.activities.at(-1)?.record.activity.placeId === context.endPlaceId;
  const endPlaceId = endsAtLastStop ? remaining.at(-1)?.record.activity.placeId ?? startPlaceId : context.endPlaceId;
  const end = endPlaceId ? options.live.get(endPlaceId)! : start;

  // 没被用户完成、跳过或替换的站，在本轮规划里临时升为 required，防止模型为新兴趣腾位时删站。
  // keep 另存外部地点与原活动 ID 的对应关系，重建新版本时沿用身份；原角色不会因此永久升级。
  const keep = new Map<string, string>();
  const visits = remaining.map((item) => {
    const { activity } = item.record;
    const place = options.live.get(activity.placeId)!;
    keep.set(place.place.ref.externalId, activity.activityId);
    return activity.role === "fixed"
      ? { place, role: "fixed" as const, startsAt: clock(activity.fixed!.startsAt), endsAt: clock(activity.fixed!.endsAt) }
      : { place, role: "required" as const, stayMinutes: activity.stayMinutes };
  });
  const asked = {
    schemaVersion: "planning-requirements.v1",
    // V2.10：沿用行程自己的城市（规划时卡片的城市），不随调整后的出发点改变。
    cityAdcode: options.city?.adcode ?? start.place.cityAdcode,
    ...(options.city ? { cityName: options.city.name } : {}),
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: context.date,
    window: { startsAt: clock(resumeAt), endsAt: clock(endsAt) },
    startPlace: start,
    endPlace: end,
    interests: [],
    ...(interests.length ? { freeInterests: interests.map((item, index) => ({ id: `i${index + 1}`, ...item })) } : {}),
    pace: context.pace,
    travel: options.travel ?? context.travel ?? DEFAULT_TRAVEL,
    visits,
  };
  const parsed = planningRequirementsSchema.safeParse(asked);
  return {
    status: "ok", requirements: parsed.success ? parsed.data : null, asked, keep, completed, skipped,
    removed: [...request.skipped, ...replaced].filter((id) => details.activities.some((item) => item.record.activity.activityId === id)),
    resumeAt, startPlaceId,
  };
}

export type PlannedAdjustment =
  | { readonly status: "draft"; readonly requirements: PlanningRequirements; readonly result: Extract<DayPlanningResult, { outcome: "draft" }>; readonly snapshot: DayDraftConfirmationSnapshot }
  /** 原要求排不下，少掉 drop 这站才可行；必须在卡片明确建议并让用户确认。 */
  | { readonly status: "suggest"; readonly drop: string; readonly requirements: PlanningRequirements; readonly result: Extract<DayPlanningResult, { outcome: "draft" }>; readonly snapshot: DayDraftConfirmationSnapshot }
  /** noFit 区分明确约束失败与查询/执行故障；有信息缺口时不能通过删站来伪造解决。 */
  | { readonly status: "none"; readonly result: DayPlanningResult | null; readonly noFit: boolean };

/** 原要求之外最多两次删一站试排，控制外部调用与变化幅度，不做无限子集搜索。 */
const DROP_TRIES = 2;

/**
 * 先按原要求规划；明确排不开时，按停留最长、同长靠后优先，最多尝试两次少一站。
 * 成功也只返回建议，原保留站不会被模型无声删除。
 */
export async function planAdjustment(
  prepared: PreparedAdjustment,
  /** 一次规划尝试返回结果和确认快照；null 代表执行故障，不作为约束无解证据。 */
  plan: (requirements: PlanningRequirements) => Promise<{ result: DayPlanningResult | null; snapshot: DayDraftConfirmationSnapshot | null }>,
): Promise<PlannedAdjustment> {
  const fits = (run: { result: DayPlanningResult | null; snapshot: DayDraftConfirmationSnapshot | null }) =>
    run.result?.status === "completed" && run.result.outcome === "draft" && run.snapshot !== null;
  const asked = prepared.requirements ? await plan(prepared.requirements) : null;
  if (asked && fits(asked)) {
    return { status: "draft", requirements: prepared.requirements!, result: asked.result as Extract<DayPlanningResult, { outcome: "draft" }>, snapshot: asked.snapshot! };
  }
  // 仅明确约束失败才尝试删站；未知路线、权限或供应商故障不能触发“少去一站就好了”的建议。
  const noFit = !asked || (asked.result?.status === "completed" && asked.result.outcome === "no_plan" && asked.result.reason === "constraints_not_met");
  if (!noFit) return { status: "none", result: asked.result, noFit: false };
  const visits = prepared.asked.visits;
  // 每个备选都从原 requirements 只去掉一站，而不是逐轮累积删除；返回的是有界建议，不是越删越多。
  const candidates = visits
    .map((visit, index) => ({ visit, index }))
    .filter(({ visit }) => visit.role !== "fixed")
    .sort((a, b) => ("stayMinutes" in b.visit ? b.visit.stayMinutes : 0) - ("stayMinutes" in a.visit ? a.visit.stayMinutes : 0) || b.index - a.index)
    .slice(0, DROP_TRIES);
  for (const { index } of candidates) {
    const rest = visits.filter((_, position) => position !== index);
    if (!rest.length && !("freeInterests" in prepared.asked)) continue;
    const parsed = planningRequirementsSchema.safeParse({ ...prepared.asked, visits: rest });
    if (!parsed.success) continue;
    const requirements = parsed.data;
    const run = await plan(requirements);
    if (fits(run)) {
      const drop = prepared.keep.get(visits[index].place.place.ref.externalId)!;
      return { status: "suggest", drop, requirements, result: run.result as Extract<DayPlanningResult, { outcome: "draft" }>, snapshot: run.snapshot! };
    }
  }
  return { status: "none", result: asked?.result ?? null, noFit: true };
}

/**
 * 短途改动仍保留用户顺序：保留站原位、替换兴趣原位、新兴趣末尾。
 * 有固定预约时返回 null，交一日规划器保留其时段。
 */
export type AdjustSlot =
  | { readonly kind: "kept"; readonly externalId: string; readonly stayMinutes: number }
  | { readonly kind: "new"; readonly interest: { readonly text: string; readonly when?: string } };

export function shortAdjustSlots(details: StoredRealDay, prepared: PreparedAdjustment, request: AdjustRequest): AdjustSlot[] | null {
  if (details.activities.some((item) => item.record.activity.role === "fixed")) return null;
  const externalOf = (placeId: string) => details.places.find((place) => place.placeId === placeId)!.externalId;
  const replaced = new Map(request.replace.map((item) => [item.activityId, item]));
  const gone = new Set([...prepared.completed, ...prepared.skipped]);
  const slots = [...details.activities].sort((a, b) => a.startsAt - b.startsAt).flatMap((item): AdjustSlot[] => {
    const { activityId, placeId, stayMinutes } = item.record.activity;
    const replacement = replaced.get(activityId);
    if (replacement) return [{ kind: "new", interest: { text: replacement.interest, ...(replacement.when ? { when: replacement.when } : {}) } }];
    return gone.has(activityId) ? [] : [{ kind: "kept", externalId: externalOf(placeId), stayMinutes }];
  });
  for (const item of request.addInterests) {
    slots.push({ kind: "new", interest: typeof item === "string" ? { text: item } : { text: item.text, ...(item.when ? { when: item.when } : {}) } });
  }
  return slots;
}

/** 把返回给用户确认的删站建议并入 prepared，确认后该站按明确跳过归档。 */
export function withDrop(prepared: PreparedAdjustment, drop: string, requirements: PlanningRequirements): PreparedAdjustment {
  const keep = new Map([...prepared.keep].filter(([, id]) => id !== drop));
  return { ...prepared, requirements, asked: requirements, keep, skipped: [...prepared.skipped, drop], removed: [...prepared.removed, drop] };
}

/** 真实进度和调整的仓储接口，具体行锁与事务在 PostgreSQL 实现中负责。 */
export interface RealDayAdjustRepository {
  findCurrentJourney(journeyId: string): Promise<StoredJourney | null>;
  /** 按行程和运行身份查询已确认结果，同一意图重试返回原版本。 */
  findRealDayAdjustment(journeyId: string, runId: string): Promise<{ intentFingerprint: string; planVersion: number } | null>;
  /** 持有行程根锁后重验累计报告，原子插入新观察版本。 */
  commitRealDayProgress(input: { journeyId: string; command: DayProgressCommand; recordedAt: ChinaDateTime }): Promise<DayProgressReply>;
  /** 在相同基础双版本下，把调整隐含的报告和新计划原子保存；同 run 同意图重放，异意图冲突。 */
  commitRealDayAdjustment(input: {
    journeyId: string;
    runId: string;
    intentFingerprint: string;
    basePlanVersion: number;
    baseObservationVersion: number;
    progress: DayProgressCommand;
    adjusted: AdjustedDay;
    confirmedAt: ChinaDateTime;
  }): Promise<{ status: "saved" | "already_saved"; planVersion: number } | { status: "stale" | "intent_conflict" | "not_found" }>;
}

/** 事务写入前复核新版本确实跟随当前版，并与这次累计报告一致，不能只依赖锁外预检。 */
export function assertAdjustmentCommit(current: StoredJourney, adjusted: AdjustedDay, progress: { completed: readonly string[]; skipped: readonly string[] }): void {
  const details = current.realDay;
  const next = adjusted.realDay;
  const ok = current.creationKind === "real_day" && !!details &&
    next.planVersion === current.currentPlan.version + 1 && next.change?.parentVersion === current.currentPlan.version &&
    next.context.creationRunId === details.context.creationRunId && next.context.date === details.context.date &&
    // 旧归档全部保留，新归档必须与报告标记相符，不能新增一份用户未报告的完成事实。
    (details.archived ?? []).every((item) => next.archived?.some((entry) => entry.activityId === item.activityId && entry.status === item.status)) &&
    (next.archived ?? []).every((item) => (item.status === "completed" ? progress.completed : progress.skipped).includes(item.activityId)) &&
    [...progress.completed, ...progress.skipped].every((id) => next.archived?.some((entry) => entry.activityId === id) ||
      !next.activities.some((entry) => entry.record.activity.activityId === id));
  if (!ok) throw new Error("Invalid real day adjustment");
}

/** 前后差异只用自有名称与计划时刻，供并排展示，不复制实时商户或路线数据。 */
export type AdjustDiffItem =
  | { readonly kind: "kept" | "moved"; readonly activityId: string; readonly name: string; readonly from: { startsAt: number; endsAt: number }; readonly to: { startsAt: number; endsAt: number } }
  | { readonly kind: "added"; readonly activityId: string; readonly name: string; readonly to: { startsAt: number; endsAt: number } }
  | { readonly kind: "removed"; readonly activityId: string; readonly name: string; readonly from: { startsAt: number; endsAt: number } };

export interface AdjustedDay {
  /** 下一版本的关系表活动、名称快照与最小详情一起构造，写入前复核一致性。 */
  readonly next: Pick<InitialJourneyDraft, "currentPlan" | "activitySnapshots" | "reservations">;
  readonly realDay: StoredRealDay;
  readonly diff: readonly AdjustDiffItem[];
}

/**
 * 把已校验的剩余草稿映射为下一正式版本：保留站沿用活动 ID，新站/地点新建 UUID。
 * 完成与跳过进入归档；临时规划编号不能穿透成为正式身份。
 */
export function buildAdjustedDay(options: {
  stored: StoredJourney;
  prepared: PreparedAdjustment;
  draft: DayDraft;
  snapshot: DayDraftConfirmationSnapshot;
  note: string;
  idGenerator: JourneyIdGenerator;
}): AdjustedDay {
  const { stored, prepared, draft, snapshot } = options;
  const details = stored.realDay!;
  const nextId = createCheckedIdFactory(options.idGenerator);
  const version = stored.currentPlan.version + 1;
  const externalOf = (draftPlaceId: string) => snapshot.places.find((item) => item.placeId === draftPlaceId)!.selection.place;
  // 旧地点保留供归档展示；同一外部地点复用正式地点 ID，新地点才分配身份。
  const places: RealPlace[] = [...details.places];
  const placeFor = (draftPlaceId: string) => {
    const summary = externalOf(draftPlaceId);
    const known = places.find((item) => item.externalId === summary.ref.externalId);
    if (known) return known.placeId;
    const placeId = nextId("place");
    places.push({ placeId, provider: "amap", externalId: summary.ref.externalId, name: summary.name.slice(0, 80).trim() });
    return placeId;
  };
  const previous = new Map(details.activities.map((item) => [item.record.activity.activityId, item]));
  // 每轮规划都从 i1 编号，新兴趣要接在旧兴趣最大编号之后，避免“本轮 i1”覆盖旧版不同兴趣。
  const oldInterests = details.context.freeInterests ?? [];
  const next = Math.max(0, ...oldInterests.map((item) => Number(item.id.slice(1))));
  const newInterests = (snapshot.problem.requirements.freeInterests ?? []).map((item, index) => ({ ...item, id: `i${next + index + 1}` }));
  const interestOf = (planned: string | undefined) => {
    const index = (snapshot.problem.requirements.freeInterests ?? []).findIndex((item) => item.id === planned);
    return index < 0 ? planned : newInterests[index].id;
  };
  const activities: StoredRealDay["activities"] = [];
  const rows: InitialJourneyDraft["currentPlan"]["activities"][number][] = [];
  const diff: AdjustDiffItem[] = [];
  for (const [index, item] of draft.activities.entries()) {
    const record = snapshot.activities.find((entry) => entry.activity.activityId === item.activityId)!;
    const placeId = placeFor(item.placeId);
    const externalId = externalOf(item.placeId).ref.externalId;
    // 保留映射和本轮角色共同决定是否延续旧活动，不能只因同名或同地点就把新发现站冒认成旧身份。
    const keptId = item.role !== "discovered" ? prepared.keep.get(externalId) : undefined;
    const earlier = keptId ? previous.get(keptId) : undefined;
    const activityId = keptId ?? nextId("activity");
    const arrivalMode = draft.legs[index]?.mode;
    // 保留站恢复原角色和原理由；规划期临时升为 required 只是保护手段，不能永久把推荐站改成必去。
    const role = (earlier?.record.activity ?? record.activity).role;
    activities.push({
      record: storedActivityRecordSchema.parse({
        // 营业窗口在本轮规划时用过即丢，正式详情重置 unknown，不持久缓存高德营业数据。
        activity: { ...(earlier?.record.activity ?? record.activity), activityId, placeId, stayMinutes: item.stayMinutes, opening: { status: "unknown" } },
        ...(earlier?.record.interest ?? record.interest ? { interest: earlier ? earlier.record.interest : interestOf(record.interest) } : {}),
        ...(earlier?.record.reason ?? item.reason ? { reason: earlier?.record.reason ?? item.reason } : {}),
      }),
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      ...(earlier?.reservationId ? { reservationId: earlier.reservationId } : {}),
      ...(arrivalMode && arrivalMode !== "walking" ? { arrivalMode } : {}),
    });
    rows.push({
      id: activityId,
      placeId,
      startsAt: at(draft.date, item.startsAt),
      endsAt: at(draft.date, item.endsAt),
      priority: ["fixed", "required"].includes(role) ? "high" : "normal",
      locked: role === "fixed",
      ...(earlier?.reservationId ? { reservationId: earlier.reservationId } : {}),
    });
    const name = places.find((entry) => entry.placeId === placeId)!.name;
    const to = { startsAt: item.startsAt, endsAt: item.endsAt };
    diff.push(earlier
      ? { kind: earlier.startsAt === item.startsAt && earlier.endsAt === item.endsAt ? "kept" : "moved", activityId, name, from: { startsAt: earlier.startsAt, endsAt: earlier.endsAt }, to }
      : { kind: "added", activityId, name, to });
  }
  for (const id of prepared.removed) {
    const earlier = previous.get(id)!;
    diff.push({ kind: "removed", activityId: id, name: places.find((entry) => entry.placeId === earlier.record.activity.placeId)!.name, from: { startsAt: earlier.startsAt, endsAt: earlier.endsAt } });
  }
  // 旧归档与本版新完成/跳过站合并；历史不重新排时间，也不再出现在未来活动序列里。
  const archived = [
    ...(details.archived ?? []),
    ...details.activities
      .filter((item) => prepared.completed.includes(item.record.activity.activityId) || prepared.skipped.includes(item.record.activity.activityId))
      .map((item) => ({
        activityId: item.record.activity.activityId,
        placeId: item.record.activity.placeId,
        status: prepared.completed.includes(item.record.activity.activityId) ? "completed" as const : "skipped" as const,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
      })),
  ];
  const startPlaceId = prepared.startPlaceId ?? placeFor(draft.startPlace.placeId);
  const realDay = storedRealDaySchema.parse({
    schemaVersion: REAL_DAY_SCHEMA,
    planVersion: version,
    context: {
      ...details.context,
      requirementsFingerprint: snapshot.problem.requirementsFingerprint,
      window: snapshot.draft.window,
      startPlaceId,
      endPlaceId: placeFor(draft.endPlace.placeId),
      ...(draft.legs.at(-1)?.mode && draft.legs.at(-1)?.mode !== "walking" ? { endArrivalMode: draft.legs.at(-1)!.mode } : { endArrivalMode: undefined }),
      travel: snapshot.problem.requirements.travel,
      // 只保留本版本站点仍关联的旧兴趣与新兴趣，避免长期复制已经不再使用的需求。
      freeInterests: (() => {
        const used = new Set(activities.flatMap((item) => (item.record.interest ? [item.record.interest] : [])));
        return [...oldInterests, ...newInterests].filter((item) => used.has(item.id));
      })(),
    },
    places,
    activities,
    acknowledgeUnknowns: details.acknowledgeUnknowns,
    ...(archived.length ? { archived } : {}),
    change: {
      parentVersion: stored.currentPlan.version,
      note: options.note.slice(0, 60),
      origin: details.change?.origin ?? { placeId: details.context.startPlaceId, startsAt: details.context.window.startsAt },
    },
  });
  const reservations = stored.reservations.filter((entry) => rows.some((row) => row.reservationId === entry.reservation.id));
  return {
    next: {
      currentPlan: {
        journeyId: stored.journeyId,
        date: draft.date,
        timeZone: draft.timeZone,
        version,
        changeReason: "user_confirmed_replan",
        activities: rows,
      },
      activitySnapshots: rows.map((row, position) => ({
        activityId: row.id,
        position,
        placeName: places.find((entry) => entry.placeId === row.placeId)!.name,
      })),
      reservations,
    },
    realDay,
    diff,
  };
}

/**
 * 签名调整凭据绑定基础双版本、候选快照和对旧站的处理方式。
 * 其中 prepared 只带自有变更信息；snapshot 仍是本轮临时事实，不能作为永久行程详情保存。
 */
export const adjustOfferSchema = z.strictObject({
  journeyId: uuid,
  runId: uuid,
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().nonnegative(),
  note: z.string().trim().min(1).max(60),
  draftFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: dayDraftConfirmationSnapshotSchema,
  prepared: z.strictObject({
    keep: z.array(z.tuple([z.string().min(1).max(64), uuid])).max(12),
    completed: z.array(uuid).max(24),
    skipped: z.array(uuid).max(24),
    removed: z.array(uuid).max(12),
    resumeAt: z.number().int().min(0).max(1439),
    startPlaceId: uuid.nullable(),
  }),
});
export type AdjustOffer = z.infer<typeof adjustOfferSchema>;

export function adjustOfferOf(input: {
  journey: StoredJourney;
  runId: string;
  note: string;
  prepared: PreparedAdjustment;
  snapshot: DayDraftConfirmationSnapshot;
}): AdjustOffer {
  const { prepared } = input;
  return adjustOfferSchema.parse({
    journeyId: input.journey.journeyId,
    runId: input.runId,
    basePlanVersion: input.journey.currentPlan.version,
    baseObservationVersion: input.journey.currentObservationVersion,
    note: input.note,
    draftFingerprint: dayDraftSemanticFingerprint(input.snapshot),
    snapshot: input.snapshot,
    prepared: {
      keep: [...prepared.keep],
      completed: prepared.completed,
      skipped: prepared.skipped,
      removed: prepared.removed,
      resumeAt: prepared.resumeAt,
      startPlaceId: prepared.startPlaceId,
    },
  });
}

export type AdjustConfirmReply =
  | { status: "saved" | "already_saved"; planVersion: number }
  | { status: "expired" | "stale" | "draft_changed" | "temporarily_unavailable" | "intent_conflict" | "not_found" };

/**
 * 确认时重验凭据所绑定的计划与观察版本，并按原方式复查路线；
 * 只有原业务安排仍成立，剩余计划才与其隐含报告一起落库。
 */
export async function confirmRealDayAdjustment(options: {
  offer: AdjustOffer;
  expiresAt: number;
  routes: MobilityProvider;
  repository: RealDayAdjustRepository;
  idGenerator: JourneyIdGenerator;
  now: Date;
}): Promise<AdjustConfirmReply> {
  const { offer, repository } = options;
  assertDaySnapshotIntegrity(offer.snapshot, false, "amap");
  if (dayDraftSemanticFingerprint(offer.snapshot) !== offer.draftFingerprint) throw new Error("Invalid adjustment offer");
  const intentFingerprint = fingerprint({ protocol: "real-day-adjust.v1", runId: offer.runId, draft: offer.draftFingerprint, note: offer.note });
  // 已提交意图优先重放：即使当前版本或凭据有效期已变化，也不再次执行路线查询或创建下一版。
  const prior = await repository.findRealDayAdjustment(offer.journeyId, offer.runId);
  if (prior) {
    return prior.intentFingerprint === intentFingerprint
      ? { status: "already_saved", planVersion: prior.planVersion }
      : { status: "intent_conflict" };
  }
  if (options.now.getTime() >= options.expiresAt) return { status: "expired" };
  const stored = await repository.findCurrentJourney(offer.journeyId);
  if (!stored || stored.creationKind !== "real_day" || !stored.realDay) return { status: "not_found" };
  if (stored.currentPlan.version !== offer.basePlanVersion || stored.currentObservationVersion !== offer.baseObservationVersion) {
    return { status: "stale" };
  }
  // 供应商暂不可用不等于草稿已经变化；有真实返回且业务指纹不同才要求用户重新看差异。
  try {
    const refreshed = await refreshDayRoutes(offer.snapshot, options.routes, options.now.getTime());
    if (dayDraftSemanticFingerprint(offer.snapshot, refreshed) !== offer.draftFingerprint) return { status: "draft_changed" };
  } catch (error) {
    if (error instanceof DayRouteUnavailableError) return { status: "temporarily_unavailable" };
    return { status: "draft_changed" };
  }
  const prepared: PreparedAdjustment = {
    status: "ok",
    // 确认时只复用 prepared 的站点身份映射与累计标记，真正计划来自经过校验的快照。
    requirements: offer.snapshot.problem.requirements,
    asked: offer.snapshot.problem.requirements,
    ...offer.prepared,
    keep: new Map(offer.prepared.keep),
  };
  const adjusted = buildAdjustedDay({
    stored,
    prepared,
    draft: offer.snapshot.draft,
    snapshot: offer.snapshot,
    note: offer.note,
    idGenerator: options.idGenerator,
  });
  const now = toChinaDateTime(options.now);
  const date = stored.realDay.context.date;
  // 未来行程可在出发前调整，其报告时刻归到行程开始，而不是错误记录成今天的已发生事实。
  const reportClock = now.startsWith(`${date}T`) ? now.slice(11, 16) : clock(stored.realDay.context.window.startsAt);
  const reportAt = `${date}T${reportClock}+08:00` as const;
  const resume = `${date}T${clock(Math.max(offer.prepared.resumeAt, minutes(reportClock)))}+08:00` as const;
  // 调整所隐含的进度报告与新计划在同一事务落库，且一起绑定计划、观察两个基础版本。
  // 否则可能出现“报告已完成，但新计划没保存”或旧候选覆盖更新进度的分裂状态。
  const reply = await repository.commitRealDayAdjustment({
    journeyId: offer.journeyId,
    runId: offer.runId,
    intentFingerprint,
    basePlanVersion: offer.basePlanVersion,
    baseObservationVersion: offer.baseObservationVersion,
    progress: {
      // 一次调整运行复用同一个报告 ID，响应丢失后重试不会重复追加进度。
      reportId: offer.runId,
      basePlanVersion: offer.basePlanVersion,
      baseObservationVersion: offer.baseObservationVersion,
      completedActivityIds: [...offer.prepared.completed],
      skippedActivityIds: [...offer.prepared.skipped],
      observedAt: reportAt,
      earliestResumeAt: resume,
      location: offer.prepared.startPlaceId ? { kind: "known", placeId: offer.prepared.startPlaceId } : { kind: "unknown" },
      noCurrentActivity: true,
    },
    adjusted,
    confirmedAt: toChinaDateTime(options.now),
  });
  return reply.status === "saved" || reply.status === "already_saved" ? { status: reply.status, planVersion: reply.planVersion } : { status: reply.status };
}
