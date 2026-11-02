import { z } from "zod";
import {
  scheduleReplan,
  validateReplan,
  type DayReplanInput,
  type DayRoute,
} from "@tripquest/domain";
import { PLANNING_FIXTURE_PROVIDER } from "@tripquest/providers/planning-fixture";
import { dayIssueSchema } from "./day-planning";
import { replanCountsSchema, replanGoalSchema, replanScopeSchema } from "./day-replan-contract";
import { canonicalJson, fingerprint } from "./fingerprint";
import { PLANNING_INTERESTS, interestIdSchema, planningPlaceSchema } from "./planning-requirements";
import { toSavedDayView, type SavedDayDetails } from "./saved-day";
import type { StoredDayPlanDetails } from "./generated-day";
import type { StoredJourney } from "./contracts";

const uuid = z.uuid();
const minute = z.number().int().min(0).max(1439);
const window = z.strictObject({ startsAt: minute, endsAt: minute });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export {
  replanCountsSchema,
  replanGoalSchema,
  replanScopeSchema,
  type ReplanCounts,
  type ReplanGoal,
  type ReplanScope,
} from "./day-replan-contract";

/** 直接以正式 UUID 表示的活动事实，重排版本无需再维护局部 ID 绑定。 */
export const storedActivityRecordSchema = z.strictObject({
  activity: z.strictObject({
    activityId: uuid,
    placeId: uuid,
    role: z.enum(["optional", "required", "fixed", "discovered"]),
    stayMinutes: z.number().int().min(1).max(1439),
    staySource: z.enum(["user", "system_estimate"]),
    fixed: window.optional(),
    /** 发现该活动时，对应兴趣要求的时段。 */
    within: window.optional(),
    opening: z.strictObject({ status: z.literal("unknown") }),
    tickets: z.literal("unknown"),
  }),
  interest: interestIdSchema.optional(),
  /** 模型给发现项写的推荐理由，属于我们生成的说明文字。 */
  reason: z.string().min(1).max(80).optional(),
});
export type StoredActivityRecord = z.infer<typeof storedActivityRecordSchema>;

const routeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    fromPlaceId: uuid,
    toPlaceId: uuid,
    status: z.literal("same_place_assumption"),
  }),
  z.strictObject({
    fromPlaceId: uuid,
    toPlaceId: uuid,
    status: z.literal("known"),
    durationSeconds: z.number().int().nonnegative().safe(),
    distanceMeters: z.number().int().nonnegative().safe(),
    provider: z.literal(PLANNING_FIXTURE_PROVIDER),
    sourceKind: z.literal("fixture"),
    retrievedAt: z.iso.datetime({ offset: true }),
  }),
]);

export const futureScheduleSchema = z.strictObject({
  activities: z.array(z.strictObject({
    activityId: uuid,
    placeId: uuid,
    arrivesAt: minute,
    startsAt: minute,
    endsAt: minute,
    waitMinutes: z.number().int().min(0).max(1439),
  })).max(6),
  legs: z.array(z.strictObject({
    fromPlaceId: uuid,
    toPlaceId: uuid,
    departsAt: minute,
    arrivesAt: minute,
    travelMinutes: z.number().int().min(0).max(1439),
    bufferMinutes: z.union([z.literal(0), z.literal(5), z.literal(10)]),
    distanceMeters: z.number().int().nonnegative(),
    source: z.enum(["route_estimate", "same_place_assumption"]),
  })).min(1).max(7),
  endArrival: minute,
  totalWalkingMinutes: z.number().int().nonnegative(),
  longestWalkingMinutes: z.number().int().nonnegative(),
});
export type FutureSchedule = z.infer<typeof futureScheduleSchema>;

export const replanExecutionSchema = z.strictObject({
  mode: z.enum(["scripted", "live"]),
  provider: z.string().regex(/^[A-Za-z0-9_.:/-]{1,80}$/),
  model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
  counts: replanCountsSchema,
});

export const replannedDayDetailsSchema = z
  .strictObject({
    schemaVersion: z.literal("stored-day-plan.v3"),
    planVersion: z.number().int().min(2),
    parentVersion: z.number().int().positive(),
    context: z.strictObject({
      creationRunId: uuid,
      requirementsFingerprint: hash,
      date: z.iso.date(),
      timeZone: z.literal("Asia/Shanghai"),
      window,
      startPlaceId: uuid,
      endPlaceId: uuid,
      bufferMinutes: z.union([z.literal(5), z.literal(10)]),
      interests: z.array(z.enum(PLANNING_INTERESTS)).max(4),
    }),
    places: z
      .array(z.strictObject({ placeId: uuid, selection: planningPlaceSchema }))
      .min(1)
      .max(9),
    progressBasis: z.strictObject({
      observationVersion: z.number().int().positive(),
      reportFingerprint: hash,
      completedActivityIds: z.array(uuid).max(6),
      skippedActivityIds: z.array(uuid).max(6),
      observedAt: z.iso.datetime({ offset: true }),
      earliestResumeAt: z.iso.datetime({ offset: true }),
      locationPlaceId: uuid,
      source: z.literal("user_reported"),
    }),
    archived: z
      .array(z.strictObject({
        record: storedActivityRecordSchema,
        status: z.enum(["completed", "skipped"]),
        planned: window,
        reservationId: uuid.optional(),
      }))
      .max(6),
    future: z.strictObject({
      scope: replanScopeSchema,
      resumePlaceId: uuid,
      resumesAt: minute,
      activities: z
        .array(z.strictObject({
          record: storedActivityRecordSchema,
          reservationId: uuid.optional(),
        }))
        .max(6),
      routes: z.array(routeSchema).min(1).max(7),
      /** 局部调整范围外的尾部按确认时原时刻固定，包括下一个固定事项及其后所有活动。 */
      frozen: z.array(z.strictObject({ activityId: uuid, startsAt: minute, endsAt: minute })).max(6),
      schedule: futureScheduleSchema,
      verification: z.enum(["checked", "pending"]),
      checks: z.array(dayIssueSchema).max(30),
    }),
    replan: z.strictObject({
      runId: uuid,
      goal: replanGoalSchema,
      baseFingerprint: hash,
      candidateFingerprint: hash,
      datasetVersion: z.string().min(1).max(80),
      recheckedAt: z.iso.datetime({ offset: true }),
      acknowledgeUnknowns: z.boolean(),
      execution: replanExecutionSchema,
    }),
  })
  .refine((details) => details.planVersion === details.parentVersion + 1);
export type ReplannedDayDetails = z.infer<typeof replannedDayDetailsSchema>;
export type GeneratedDayDetails = SavedDayDetails | ReplannedDayDetails;

export interface DayStateActivity {
  readonly record: StoredActivityRecord;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly reservationId?: string;
}
export interface DayStateArchived {
  readonly record: StoredActivityRecord;
  readonly status: "completed" | "skipped";
  readonly planned: { readonly startsAt: number; readonly endsAt: number };
  readonly reservationId?: string;
}
/** 把不同存储版本统一成正式 UUID 的状态视图，区分已归档事实和仍在计划中的活动。 */
export interface DayState {
  readonly context: {
    readonly date: string;
    readonly timeZone: "Asia/Shanghai";
    readonly window: { readonly startsAt: number; readonly endsAt: number };
    readonly startPlaceId: string;
    readonly endPlaceId: string;
    readonly bufferMinutes: 5 | 10;
  };
  readonly places: readonly { readonly placeId: string; readonly selection: z.infer<typeof planningPlaceSchema> }[];
  readonly archived: readonly DayStateArchived[];
  readonly future: readonly DayStateActivity[];
  readonly resume?: { readonly placeId: string; readonly startsAt: number };
}
export interface PlanRowLink {
  readonly id: string;
  readonly reservationId?: string;
}

function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Stored day state is inconsistent");
}
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
export const dayAt = (date: string, minutes: number) =>
  `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00` as const;

export function dayState(details: GeneratedDayDetails, rows: readonly PlanRowLink[]): DayState {
  if (details.schemaVersion === "stored-day-plan.v3") {
    const { context } = details;
    return structuredClone({
      context: {
        date: context.date,
        timeZone: context.timeZone,
        window: context.window,
        startPlaceId: context.startPlaceId,
        endPlaceId: context.endPlaceId,
        bufferMinutes: context.bufferMinutes,
      },
      places: details.places,
      archived: details.archived,
      future: details.future.activities.map((item, index) => ({
        record: item.record,
        startsAt: details.future.schedule.activities[index].startsAt,
        endsAt: details.future.schedule.activities[index].endsAt,
        ...(item.reservationId ? { reservationId: item.reservationId } : {}),
      })),
      resume: { placeId: details.future.resumePlaceId, startsAt: details.future.resumesAt },
    });
  }
  // 旧版本通过绑定把草案 ID 还原成正式 UUID；统一视图之后，进度和重排就不必分别处理存储版本。
  const view = toSavedDayView(details);
  const placeIds = new Map(view.placeBindings.map((item) => [item.draftPlaceId, item.placeId]));
  const activityIds = new Map(view.activityBindings.map((item) => [item.draftActivityId, item.activityId]));
  const place = (id: string) => {
    const value = placeIds.get(id);
    invariant(value);
    return value;
  };
  const { context, draft } = view.facts;
  return {
    context: {
      date: context.date,
      timeZone: context.timeZone,
      window: context.window,
      startPlaceId: place(context.startPlaceId),
      endPlaceId: place(context.endPlaceId),
      bufferMinutes: context.bufferMinutes,
    },
    places: view.facts.places.map((item) => ({ placeId: place(item.placeId), selection: item.selection })),
    archived: [],
    future: draft.activities.map((scheduled, index) => {
      const record = view.facts.activities.find((item) =>
        item.activity.activityId === scheduled.activityId);
      const activityId = activityIds.get(scheduled.activityId);
      invariant(record && activityId && rows[index]?.id === activityId);
      return {
        record: {
          activity: { ...record.activity, activityId, placeId: place(record.activity.placeId) },
          ...(record.interest ? { interest: record.interest } : {}),
        },
        startsAt: scheduled.startsAt,
        endsAt: scheduled.endsAt,
        ...(rows[index].reservationId ? { reservationId: rows[index].reservationId } : {}),
      };
    }),
  };
}

/** 只忽略查询和复查元数据，所有业务事实及其顺序仍保留在指纹中。 */
export function semanticDay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticDay);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["retrievedAt", "createdAt", "recheckedAt"].includes(key))
        .map(([key, item]) => [key, semanticDay(item)]),
    );
  }
  return value;
}

export function dayStateFingerprint(state: DayState): string {
  return fingerprint(semanticDay(state));
}

/** 只给未来部分重建排程输入，读取与确认使用同一边界；已归档项继续占用当天容量。 */
export function storedFutureInput(details: ReplannedDayDetails, nowMs: number): DayReplanInput {
  return {
    date: details.context.date,
    timeZone: details.context.timeZone,
    bufferMinutes: details.context.bufferMinutes,
    nowMs,
    places: details.places.map(({ placeId, selection }) => ({
      placeId,
      ...selection.place.ref,
      snapshot: JSON.stringify(selection.place),
    })),
    resumePlaceId: details.future.resumePlaceId,
    resumesAt: details.future.resumesAt,
    endPlaceId: details.context.endPlaceId,
    endsAt: details.context.window.endsAt,
    activities: details.future.activities.map((item) => item.record.activity),
    frozen: details.future.frozen,
    capacity: 6 - details.archived.length,
  };
}

/** 读取与写入前都复核重排详情；任一不一致就终止，避免把损坏状态当成合法计划。 */
export function assertReplannedDayMatchesJourney(
  details: ReplannedDayDetails,
  stored: Pick<StoredJourney, "currentPlan" | "activitySnapshots" | "reservations">,
): void {
  const { context, future, archived, progressBasis } = details;
  const plan = stored.currentPlan;
  invariant(
    plan.version === details.planVersion &&
    plan.parentVersion === details.parentVersion &&
    plan.date === context.date &&
    plan.timeZone === context.timeZone &&
    (details.replan.acknowledgeUnknowns || future.verification !== "pending"),
  );
  const placeIds = details.places.map((item) => item.placeId);
  invariant(new Set(placeIds).size === placeIds.length);
  invariant(new Set(details.places.map((item) =>
    item.selection.place.ref.externalId)).size === placeIds.length);
  invariant(details.places.every(({ selection }) =>
    selection.place.ref.provider === PLANNING_FIXTURE_PROVIDER &&
    selection.evidence.provider === PLANNING_FIXTURE_PROVIDER &&
    selection.evidence.sourceKind === "fixture" &&
    selection.evidence.datasetVersion === details.replan.datasetVersion));
  const known = new Set(placeIds);
  // 身份唯一性跨越归档和未来两区，不能用相同活动 ID 同时表示“已完成”和“待执行”。
  const records = [...archived.map((item) => item.record), ...future.activities.map((item) => item.record)];
  const activityIds = records.map((item) => item.activity.activityId);
  invariant(new Set(activityIds).size === activityIds.length && activityIds.length <= 6);
  invariant(
    [context.startPlaceId, context.endPlaceId, future.resumePlaceId, progressBasis.locationPlaceId]
      .every((id) => known.has(id)) &&
    progressBasis.locationPlaceId === future.resumePlaceId &&
    records.every((item) => known.has(item.activity.placeId)),
  );
  // 累计报告中的每个活动必须按原标记归档，既不能漏项，也不能擅自多标记已完成。
  const reported = new Map([
    ...progressBasis.completedActivityIds.map((id) => [id, "completed"] as const),
    ...progressBasis.skippedActivityIds.map((id) => [id, "skipped"] as const),
  ]);
  invariant(reported.size === archived.length && archived.every((item) =>
    reported.get(item.record.activity.activityId) === item.status));
  invariant(future.resumesAt ===
    minuteOf(progressBasis.earliestResumeAt, context.date));
  const input = storedFutureInput(details, Date.parse(details.replan.recheckedAt));
  const order = future.activities.map((item) => item.record.activity.activityId);
  const adjustable = order.slice(0, order.length - future.frozen.length);
  // 存储的时间表不是可信结论：以保存的事实重新排程，再独立校验，要求时间表与违规列表都一致。
  const scheduled = scheduleReplan(input, adjustable, future.routes);
  invariant(scheduled.status === "scheduled" && equal(scheduled.schedule, future.schedule));
  const validation = validateReplan(input, future.schedule, future.routes);
  invariant(
    validation.verdict !== "rejected" &&
    validation.verdict === future.verification &&
    equal(validation.issues, future.checks),
  );
  const edges = new Set(future.schedule.legs.map((leg) => `${leg.fromPlaceId}>${leg.toPlaceId}`));
  invariant(future.routes.length === edges.size &&
    future.routes.every((route) => edges.has(`${route.fromPlaceId}>${route.toPlaceId}`)));
  invariant(plan.activities.length === future.activities.length &&
    stored.activitySnapshots.length === future.activities.length);
  const name = (placeId: string) =>
    details.places.find((item) => item.placeId === placeId)!.selection.place.name;
  let fixedCount = 0;
  const reservation = (id: string | undefined, startsAt: number, endsAt: number, placeId: string) => {
    const found = stored.reservations.find((item) => item.reservation.id === id);
    invariant(
      found &&
      found.reservation.placeId === placeId &&
      found.reservation.startsAt === dayAt(context.date, startsAt) &&
      found.reservation.endsAt === dayAt(context.date, endsAt) &&
      found.reservation.confirmation.status === "unknown" &&
      found.reservation.confirmation.source.kind === "user_reported",
    );
  };
  for (const [position, item] of future.activities.entries()) {
    const { activity } = item.record;
    const times = future.schedule.activities[position];
    const row = plan.activities[position];
    const label = stored.activitySnapshots[position];
    invariant(
      row.id === activity.activityId &&
      row.placeId === activity.placeId &&
      row.startsAt === dayAt(context.date, times.startsAt) &&
      row.endsAt === dayAt(context.date, times.endsAt) &&
      row.locked === (activity.role === "fixed") &&
      row.priority === (["required", "fixed"].includes(activity.role) ? "high" : "normal") &&
      row.reservationId === item.reservationId &&
      label.activityId === row.id &&
      label.position === position &&
      label.placeName === name(activity.placeId),
    );
    if (activity.role !== "fixed") {
      invariant(item.reservationId === undefined);
      continue;
    }
    fixedCount += 1;
    reservation(item.reservationId, activity.fixed!.startsAt, activity.fixed!.endsAt, activity.placeId);
  }
  // 固定事项归档后仍引用原预约；归档只是移动展示区域，不撤销原有硬约束与身份。
  for (const item of archived) {
    const { activity } = item.record;
    if (activity.role !== "fixed") {
      invariant(item.reservationId === undefined);
      continue;
    }
    fixedCount += 1;
    invariant(equal(item.planned, activity.fixed));
    reservation(item.reservationId, item.planned.startsAt, item.planned.endsAt, activity.placeId);
  }
  invariant(stored.reservations.length === fixedCount);
}

/** 首次创建的上下文和硬事项必须一直存在，可以归档也可以继续计划，但不能被后续版本删除或改写。 */
export function assertReplanPreservesInitial(
  details: ReplannedDayDetails,
  initial: StoredDayPlanDetails,
): void {
  const before = dayState(initial, initial.activityBindings.map((item) => ({ id: item.activityId })));
  invariant(
    details.context.creationRunId === initial.planning.problem.runId &&
    details.context.requirementsFingerprint === initial.planning.problem.requirementsFingerprint &&
    equal(details.context.interests, initial.planning.problem.requirements.interests) &&
    equal(
      { ...before.context },
      {
        date: details.context.date,
        timeZone: details.context.timeZone,
        window: details.context.window,
        startPlaceId: details.context.startPlaceId,
        endPlaceId: details.context.endPlaceId,
        bufferMinutes: details.context.bufferMinutes,
      },
    ),
  );
  const records = [
    ...details.archived.map((item) => item.record),
    ...details.future.activities.map((item) => item.record),
  ];
  for (const item of before.future) {
    if (!["required", "fixed"].includes(item.record.activity.role)) continue;
    const kept = records.find((record) =>
      record.activity.activityId === item.record.activity.activityId);
    invariant(kept && equal(kept, item.record));
    const place = details.places.find((entry) => entry.placeId === item.record.activity.placeId);
    const original = before.places.find((entry) => entry.placeId === item.record.activity.placeId);
    invariant(place && original && equal(place.selection.place, original.selection.place));
  }
}

/** 仅接受指定日期、显式 +08:00 的时刻，再转换为当天分钟数，避免时区或跨日值混入排程。 */
export function minuteOf(value: string, date: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00)?(?:\.000)?\+08:00$/.exec(value);
  invariant(match && match[1] === date);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  invariant(hours < 24 && minutes < 60);
  return hours * 60 + minutes;
}

export type { DayRoute };
