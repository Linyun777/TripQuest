import { z } from "zod";
import {
  scheduleReplan,
  validateReplan,
  type ChinaDateTime,
  type DayIssue,
  type DayReplanInput,
  type DayRoute,
  type DaySchedule,
} from "@tripquest/domain";
import type {
  MobilityProvider,
  PlaceLookupProvider,
  PlaceSummary,
  ProviderFailureCode,
} from "@tripquest/providers";
import { estimateToleranceSeconds, withParking } from "./leg-choice";
import type {
  InitialJourneyDraft,
  JourneyClock,
  JourneyCity,
  JourneyIdGenerator,
  StoredJourney,
} from "./contracts";
import {
  DAY_CONFIRMATION_PROTOCOL,
  DayRouteUnavailableError,
  assertDaySnapshotIntegrity,
  dayDraftSemanticFingerprint,
  daySnapshotSource,
  refreshDayRoutes,
  type DayDraftConfirmationSnapshot,
} from "./day-confirmation";
import { shortenedStays } from "./day-planning";
import { replanEdges } from "./day-replan";
import { storedActivityRecordSchema } from "./day-state";
import { fingerprint } from "./fingerprint";
import { PLANNING_INTERESTS, TRAVEL_MODES, freeInterestSchema, requirementsCity, travelPreferenceSchema } from "./planning-requirements";

const travelModeSchema = z.enum(TRAVEL_MODES);
import { createCheckedIdFactory, toChinaDateTime } from "./runtime-values";
import { routeBetween } from "./route-request";

/**
 * 真实地点只长期保存高德编号、显示名和自有计划，坐标、地址、分类与路线数值在打开时重查。
 * 这是本机个人模式的最小化保存边界，不代表已取得供应商的长期存储许可。
 */
export const REAL_DAY_SCHEMA = "stored-real-day.v1" as const;

const uuid = z.uuid();
const minute = z.number().int().min(0).max(1439);
const window = z.strictObject({ startsAt: minute, endsAt: minute });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const realPlaceSchema = z.strictObject({
  placeId: uuid,
  provider: z.literal("amap"),
  externalId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: z.string().min(1).max(80).refine((name) => name === name.trim()),
});
export type RealPlace = z.infer<typeof realPlaceSchema>;

export const storedRealDaySchema = z.strictObject({
  schemaVersion: z.literal(REAL_DAY_SCHEMA),
  /** 每次确认调整追加计划版本，旧版继续可读，不覆盖用户当时确认的安排。 */
  planVersion: z.number().int().positive(),
  context: z.strictObject({
    creationRunId: uuid,
    requirementsFingerprint: hash,
    date: z.iso.date(),
    timeZone: z.literal("Asia/Shanghai"),
    window,
    startPlaceId: uuid,
    endPlaceId: uuid,
    bufferMinutes: z.union([z.literal(5), z.literal(10)]),
    pace: z.enum(["relaxed", "standard"]),
    interests: z.array(z.enum(PLANNING_INTERESTS)).max(4),
    /** 用户自己的兴趣原话可保存；与供应商返回的商户详情分开处理。 */
    // 新版本保留仍在使用的旧兴趣并追加新兴趣；已经不再关联任何站的兴趣不继续复制。
    freeInterests: z.array(freeInterestSchema).max(8).optional(),
    /** 去终点一段采用的方式属于自有计划；缺省步行兼容旧存档，实时耗时不保存。 */
    endArrivalMode: travelModeSchema.optional(),
    /** 保存允许方式与偏好，后续调整继续采用；旧版本缺字段时走兼容缺省。 */
    travel: travelPreferenceSchema.optional(),
  }),
  places: z.array(realPlaceSchema).min(1).max(8),
  activities: z.array(z.strictObject({
    record: storedActivityRecordSchema,
    startsAt: minute,
    endsAt: minute,
    reservationId: uuid.optional(),
    /** 保存计划选定的入站方式，缺省步行；路线查询的时长、距离和费用不随之持久化。 */
    arrivalMode: travelModeSchema.optional(),
  })).min(1).max(6),
  acknowledgeUnknowns: z.boolean(),
  /**
   * 生成本版本时已经完成或跳过的站进入归档，不再次参与规划。
   * 归档站的地点名称仍保留，历史展示不依赖实时重新查到原地点。
   */
  archived: z.array(z.strictObject({
    activityId: uuid,
    placeId: uuid,
    status: z.enum(["completed", "skipped"]),
    startsAt: minute,
    endsAt: minute,
  })).max(12).optional(),
  /** 第二版起保存父版本与简短修改原因，说明这份剩余计划从哪里演变而来。 */
  change: z.strictObject({
    parentVersion: z.number().int().positive(),
    note: z.string().min(1).max(60),
    /** 保留整天最初的起点和出发时刻；后续版本的 startPlaceId 表示中途继续位置，不能混淆。 */
    origin: z.strictObject({ placeId: z.uuid(), startsAt: z.number().int().min(0).max(1439) }),
  }).optional(),
});
export type StoredRealDay = z.infer<typeof storedRealDaySchema>;

/** V2.10：行程的主要城市；测试里手写、没有城市的行程按杭州。 */
export function journeyCity(journey: Pick<StoredJourney, "city">): JourneyCity {
  return journey.city ?? { adcode: "330100", name: "杭州市" };
}

export interface InitialRealDayDraft extends InitialJourneyDraft {
  readonly creationRunId: string;
  readonly creationIntentFingerprint: string;
  readonly realDay: StoredRealDay;
}
export interface RealDayRepository {
  findRealDayCreation(runId: string): Promise<{ journeyId: string; intentFingerprint: string } | null>;
  createRealDay(draft: InitialRealDayDraft): Promise<RealDaySaveOutcome>;
}
export type RealDaySaveOutcome =
  | { readonly status: "saved" | "already_saved"; readonly journeyId: string; readonly planVersion: 1 }
  | { readonly status: "intent_conflict" };

function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid stored real day");
}
const at = (date: string, minutes: number): ChinaDateTime =>
  `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`;

/** 真实与演示来源共同参与保存意图身份，同一 run 不能从演示保存重放成真实行程。 */
export function realDayIntentFingerprint(title: string, draftFingerprint: string, acknowledgeUnknowns: boolean) {
  return fingerprint({
    protocol: DAY_CONFIRMATION_PROTOCOL,
    source: "amap",
    title: title.trim(),
    draftFingerprint,
    acknowledgeUnknowns,
  });
}

/**
 * 用户确认后按原出行方式复查每段路线，允许规定范围内的交通估计漂移。
 * 业务安排变化需重新预览，保存时剔除实时详情，只留编号、名称和自有计划。
 */
export async function confirmRealDay(options: {
  snapshot: DayDraftConfirmationSnapshot;
  draftFingerprint: string;
  title: string;
  acknowledgeUnknowns: boolean;
  expiresAt: number;
  enabled: boolean;
  routes: MobilityProvider;
  repository: RealDayRepository;
  idGenerator: JourneyIdGenerator;
  clock: JourneyClock;
}): Promise<
  | RealDaySaveOutcome
  | { status: "disabled" | "expired" | "acknowledgment_required" | "draft_changed" | "temporarily_unavailable" }
> {
  const { snapshot, repository } = options;
  invariant(daySnapshotSource(snapshot) === "amap");
  assertDaySnapshotIntegrity(snapshot, false, "amap");
  invariant(dayDraftSemanticFingerprint(snapshot) === options.draftFingerprint);
  const title = options.title.trim();
  invariant(title.length >= 1 && title.length <= 80);
  const intentFingerprint = realDayIntentFingerprint(title, options.draftFingerprint, options.acknowledgeUnknowns);
  // 幂等重试先于个人模式开关与凭据过期检查：已完成的写入只返回原行程，
  // 不再查询路线，也不因重试时环境变化而再建一份行程。
  const prior = await repository.findRealDayCreation(snapshot.problem.runId);
  if (prior !== null) {
    return prior.intentFingerprint === intentFingerprint
      ? { status: "already_saved", journeyId: prior.journeyId, planVersion: 1 }
      : { status: "intent_conflict" };
  }
  if (!options.enabled) return { status: "disabled" };
  const now = options.clock.now();
  if (now.getTime() >= options.expiresAt) return { status: "expired" };
  if (snapshot.draft.verification === "pending" && !options.acknowledgeUnknowns) {
    return { status: "acknowledgment_required" };
  }
  try {
    const refreshed = await refreshDayRoutes(snapshot, options.routes, now.getTime());
    if (dayDraftSemanticFingerprint(snapshot, refreshed) !== options.draftFingerprint) {
      return { status: "draft_changed" };
    }
  } catch (error) {
    if (error instanceof DayRouteUnavailableError) return { status: "temporarily_unavailable" };
    return { status: "draft_changed" };
  }

  // 路线复核和用户知悉通过之后才分配正式 UUID；本轮 p/a 临时编号不能直接充当跨版本身份。
  const nextId = createCheckedIdFactory(options.idGenerator);
  const journeyId = nextId("journey");
  const savedAt = toChinaDateTime(now);
  const { draft, problem } = snapshot;
  const used = [draft.startPlace.placeId, draft.endPlace.placeId, ...draft.activities.map((item) => item.placeId)];
  const placeIds = new Map([...new Set(used)].map((draftId) => [draftId, nextId("place")]));
  const place = (draftId: string) => placeIds.get(draftId)!;
  // 显式白名单构造最小地点记录，不能展开 selection.place；那会把坐标、地址和分类一起持久化。
  const places: RealPlace[] = [...placeIds].map(([draftId, placeId]) => {
    const { selection } = snapshot.places.find((item) => item.placeId === draftId)!;
    return {
      placeId,
      provider: "amap",
      externalId: selection.place.ref.externalId,
      name: selection.place.name.slice(0, 80).trim(),
    };
  });
  const reservations: InitialJourneyDraft["reservations"][number][] = [];
  const activities: StoredRealDay["activities"] = [];
  // V2.11 估计的停留排不下时会被缩短（不低于下限）；存的停留要等于实际排的时长，否则写库前的一致性检查对不上。
  // 只认合规的缩短（同确认时重演排程），用户说的停留不会被缩。
  const stays = shortenedStays(snapshot.activities, draft.activities);
  const rows: InitialJourneyDraft["currentPlan"]["activities"][number][] = [];
  for (const [index, item] of draft.activities.entries()) {
    const record = snapshot.activities.find((entry) => entry.activity.activityId === item.activityId)!;
    const arrivalMode = draft.legs[index]?.mode;
    const activityId = nextId("activity");
    const placeId = place(item.placeId);
    const reservationId = item.role === "fixed" ? nextId("reservation") : undefined;
    // 固定事项建立独立预约行，但确认状态仍是 unknown；用户安排了固定时段不等于外部商户已确认预约。
    if (reservationId) {
      reservations.push({
        placeName: places.find((entry) => entry.placeId === placeId)!.name,
        reservation: {
          id: reservationId,
          placeId,
          startsAt: at(draft.date, item.startsAt),
          endsAt: at(draft.date, item.endsAt),
          confirmation: { status: "unknown", source: { kind: "user_reported" }, recordedAt: savedAt },
        },
      });
    }
    activities.push({
      // 这里不升级营业/票务可信度；真实行程保存不会产生“已经核实营业或订票”的新事实。
      record: storedActivityRecordSchema.parse({
        // 营业窗口仅用于生成这一份候选，落库时恢复 unknown，避免把当天商户信息长期缓存。
        activity: {
          ...record.activity,
          activityId,
          placeId,
          stayMinutes: stays.get(item.activityId) ?? record.activity.stayMinutes,
          opening: { status: "unknown" },
        },
        ...(record.interest ? { interest: record.interest } : {}),
        ...(item.reason ? { reason: item.reason } : {}),
      }),
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      ...(reservationId ? { reservationId } : {}),
      ...(arrivalMode && arrivalMode !== "walking" ? { arrivalMode } : {}),
    });
    rows.push({
      id: activityId,
      placeId,
      startsAt: at(draft.date, item.startsAt),
      endsAt: at(draft.date, item.endsAt),
      priority: ["fixed", "required"].includes(item.role) ? "high" : "normal",
      locked: item.role === "fixed",
      ...(reservationId ? { reservationId } : {}),
    });
  }
  const realDay = storedRealDaySchema.parse({
    schemaVersion: REAL_DAY_SCHEMA,
    planVersion: 1,
    context: {
      creationRunId: problem.runId,
      requirementsFingerprint: problem.requirementsFingerprint,
      date: draft.date,
      timeZone: draft.timeZone,
      window: draft.window,
      startPlaceId: place(draft.startPlace.placeId),
      endPlaceId: place(draft.endPlace.placeId),
      bufferMinutes: problem.input.bufferMinutes,
      pace: problem.requirements.pace,
      interests: [...problem.requirements.interests],
      ...(problem.requirements.freeInterests?.length
        ? { freeInterests: [...problem.requirements.freeInterests] }
        : {}),
      ...(draft.legs.at(-1)?.mode && draft.legs.at(-1)?.mode !== "walking"
        ? { endArrivalMode: draft.legs.at(-1)!.mode }
        : {}),
      ...(problem.requirements.travel ? { travel: problem.requirements.travel } : {}),
    },
    places,
    activities,
    acknowledgeUnknowns: options.acknowledgeUnknowns,
  });
  // 同时准备关系表聚合和最小真实详情，先在内存校验一一对应，再交仓储以事务一次保存。
  const saved: InitialRealDayDraft = {
    journeyId,
    title,
    // V2.10：行程的城市来自规划时卡片的城市。
    city: requirementsCity(problem.requirements),
    createdAt: savedAt,
    updatedAt: savedAt,
    creationRunId: problem.runId,
    creationIntentFingerprint: intentFingerprint,
    currentPlan: {
      journeyId,
      date: draft.date,
      timeZone: draft.timeZone,
      version: 1,
      changeReason: "initial_creation",
      activities: rows,
    },
    activitySnapshots: rows.map((row, position) => ({
      activityId: row.id,
      position,
      placeName: places.find((entry) => entry.placeId === row.placeId)!.name,
    })),
    reservations,
    realDay,
  };
  assertRealDayMatchesJourney(realDay, saved);
  return repository.createRealDay(saved);
}

/** 写入前与每次读取都复核最小详情和关系表的活动、时刻、身份是否一致；不一致则拒绝使用。 */
export function assertRealDayMatchesJourney(
  details: StoredRealDay,
  stored: Pick<StoredJourney, "currentPlan" | "activitySnapshots" | "reservations">,
): void {
  const { context, places, activities } = details;
  const plan = stored.currentPlan;
  invariant(plan.version === details.planVersion && plan.date === context.date && plan.timeZone === context.timeZone);
  // 后续版必须绑定父版本，归档站属于历史，不能又作为本版活动行出现。
  invariant((details.planVersion === 1) === !details.change);
  invariant(!details.change || details.change.parentVersion < details.planVersion);
  const archived = details.archived ?? [];
  invariant(new Set(archived.map((item) => item.activityId)).size === archived.length);
  invariant(archived.every((item) => !activities.some((entry) => entry.record.activity.activityId === item.activityId)));
  invariant(new Set(places.map((item) => item.placeId)).size === places.length);
  invariant(new Set(places.map((item) => item.externalId)).size === places.length);
  const name = (placeId: string) => places.find((item) => item.placeId === placeId)?.name;
  invariant(name(context.startPlaceId) && name(context.endPlaceId));
  invariant(archived.every((item) => name(item.placeId)));
  invariant(!details.change || !!name(details.change.origin.placeId));
  // 站点关联的兴趣必须存在于本版本；各轮规划的 i1 会重启，跨版时需重新映射。
  const interests = new Set<string>([...context.interests, ...(context.freeInterests ?? []).map((item) => item.id)]);
  invariant(activities.every((item) => !item.record.interest || interests.has(item.record.interest)));
  invariant(
    plan.activities.length === activities.length &&
    stored.activitySnapshots.length === activities.length,
  );
  let cursor = context.window.startsAt;
  let fixedCount = 0;
  for (const [position, item] of activities.entries()) {
    const { activity } = item.record;
    const row = plan.activities[position];
    const label = stored.activitySnapshots[position];
    invariant(
      item.startsAt >= cursor && item.endsAt - item.startsAt === activity.stayMinutes &&
      item.endsAt <= context.window.endsAt &&
      row.id === activity.activityId &&
      row.placeId === activity.placeId &&
      name(activity.placeId) !== undefined &&
      row.startsAt === at(context.date, item.startsAt) &&
      row.endsAt === at(context.date, item.endsAt) &&
      row.locked === (activity.role === "fixed") &&
      row.priority === (["required", "fixed"].includes(activity.role) ? "high" : "normal") &&
      row.reservationId === item.reservationId &&
      label.activityId === row.id && label.position === position &&
      label.placeName === name(activity.placeId),
    );
    cursor = item.endsAt;
    if (activity.role !== "fixed") {
      invariant(item.reservationId === undefined);
      continue;
    }
    fixedCount += 1;
    invariant(activity.fixed?.startsAt === item.startsAt && activity.fixed.endsAt === item.endsAt);
    const found = stored.reservations.find((entry) => entry.reservation.id === item.reservationId);
    invariant(
      found &&
      found.reservation.placeId === activity.placeId &&
      found.reservation.startsAt === row.startsAt &&
      found.reservation.endsAt === row.endsAt &&
      found.reservation.confirmation.status === "unknown",
    );
  }
  // 跳过预约仍保留独立预约事实；当前版本只关联自己的预约活动，不删除旧事实来掩盖变化。
  const used = new Set(plan.activities.flatMap((row) => (row.reservationId ? [row.reservationId] : [])));
  invariant(used.size === fixedCount && [...used].every((id) => stored.reservations.some((entry) => entry.reservation.id === id)));
}

/** 下面是重开后的实时补全与可达性复核；它不会重写用户已保存的计划。 */

export interface RealDayLeg {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly travelMinutes: number | null;
  readonly distanceMeters: number | null;
  readonly samePlace: boolean;
  /** 本次展示查询到的交通方式和估计数值，不构成新的持久事实。 */
  readonly mode: (typeof TRAVEL_MODES)[number];
  readonly fareYuan?: number;
  readonly summary?: string;
  /** 本次渲染用折线，不写入行程详情。 */
  readonly path?: readonly (readonly [number, number])[];
}
export type RealDayCheck =
  | {
      readonly status: "checked";
      /** 当前路线仍能衔接原计划时刻；营业与票务未知仍然保留，不因此升级成完整核实。 */
      readonly feasible: boolean;
      readonly issues: readonly DayIssue[];
      /** 仅在交通估计允许的漂移范围内可衔接时标记偏紧，并给出约晚到分钟数，避免显示为完全宽裕。 */
      readonly tightMinutes?: number;
      readonly legs: readonly RealDayLeg[];
      readonly schedule: DaySchedule | null;
      /** 即时地点详情只供这一轮展示，不回写数据库。 */
      readonly places: readonly { readonly placeId: string; readonly place: PlaceSummary }[];
      readonly renamed: readonly { readonly placeId: string; readonly current: string }[];
      readonly retrievedAt: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "places_missing" | ProviderFailureCode;
      readonly missing: readonly string[];
    };

const LOOKUP_BATCH = 10;

/**
 * 按保存编号重查地点，再按原已选方式查询各段路线，把活动钉在原时刻独立复核。
 * 不为了适配新路线自动重排；需要改变安排时让用户走调整确认。
 */
export async function hydrateRealDay(
  details: StoredRealDay,
  dependencies: { places: PlaceLookupProvider; routes: MobilityProvider; nowMs: number; signal?: AbortSignal },
): Promise<RealDayCheck> {
  const { context } = details;
  const live = new Map<string, PlaceSummary>();
  let retrievedAt = "";
  for (let index = 0; index < details.places.length; index += LOOKUP_BATCH) {
    const batch = details.places.slice(index, index + LOOKUP_BATCH);
    const reply = await dependencies.places.findPlacesById(
      batch.map((item) => item.externalId),
      { signal: dependencies.signal },
    );
    if (reply.status !== "ok") return { status: "unavailable", reason: reply.failure.code, missing: [] };
    if (reply.data.missing.length) {
      return {
        status: "unavailable",
        reason: "places_missing",
        missing: batch.filter((item) => reply.data.missing.includes(item.externalId)).map((item) => item.placeId),
      };
    }
    retrievedAt = reply.evidence.retrievedAt;
    for (const item of batch) {
      // 可达性复核只需要位置；商户详情不继续携带，避免展示对象被误当成可持久化数据。
      const found = reply.data.items.find((entry) => entry.ref.externalId === item.externalId)!;
      live.set(item.placeId, { ...found, business: undefined });
    }
  }

  // 重新打开只核对已保存时刻能否衔接，不把最新路线算成一份替代计划。
  // 所有活动都钉在原时段；如果不再可达，页面应提示调整，由用户确认新版本。
  const activities = details.activities.map((item) => item.record.activity);
  const input: DayReplanInput = {
    date: context.date,
    timeZone: context.timeZone,
    bufferMinutes: context.bufferMinutes,
    nowMs: dependencies.nowMs,
    places: details.places.map((item) => ({
      placeId: item.placeId,
      provider: "amap",
      externalId: item.externalId,
      snapshot: JSON.stringify(live.get(item.placeId)),
    })),
    resumePlaceId: context.startPlaceId,
    resumesAt: context.window.startsAt,
    endPlaceId: context.endPlaceId,
    endsAt: context.window.endsAt,
    activities,
    // 把原活动钉在已保存时段，只检查原方式是否仍来得及，不允许重排器替用户悄悄改时间。
    frozen: details.activities.map((item) => ({
      activityId: item.record.activity.activityId,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    })),
    capacity: 6,
  };
  const routes: DayRoute[] = [];
  const legs: RealDayLeg[] = [];
  // 重开只询问原选方式；重新比较交通方式会让“复核”变成另一份用户未确认的计划。
  const savedModes = [
    ...details.activities.map((item) => item.arrivalMode ?? "walking"),
    context.endArrivalMode ?? "walking",
  ];
  for (const [index, edge] of replanEdges(input, []).entries()) {
    const mode = savedModes[index] ?? "walking";
    if (edge.samePlace) {
      routes.push({ fromPlaceId: edge.fromPlaceId, toPlaceId: edge.toPlaceId, status: "same_place_assumption" });
      legs.push({ ...edge, travelMinutes: 0, distanceMeters: 0, mode: "walking" });
      continue;
    }
    const from = live.get(edge.fromPlaceId)!;
    const to = live.get(edge.toPlaceId)!;
    const reply = await dependencies.routes.findRoutes({
      ...routeBetween(from, to),
      mode,
      departureAt: `${context.date}T00:00:00+08:00`,
    }, { signal: dependencies.signal });
    if (reply.status === "failure") return { status: "unavailable", reason: reply.failure.code, missing: [] };
    // 不同阶段沿用相同方式，但供应商可能返回多条候选；只从原方式中选时长最短的一条进行复核。
    const shortest = reply.status === "ok"
      ? [...reply.routes].filter((item) => item.mode === mode).sort((left, right) => left.durationSeconds - right.durationSeconds)[0]
      : undefined;
    const route = shortest && withParking(shortest);
    if (reply.status !== "ok" || !route) {
      routes.push({ fromPlaceId: edge.fromPlaceId, toPlaceId: edge.toPlaceId, status: "unknown", reason: reply.status === "no_route" ? reply.reason : "no_path" });
      legs.push({ ...edge, travelMinutes: null, distanceMeters: null, mode });
      continue;
    }
    routes.push({
      fromPlaceId: edge.fromPlaceId,
      toPlaceId: edge.toPlaceId,
      status: "known",
      durationSeconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
      provider: reply.evidence.provider,
      sourceKind: reply.evidence.sourceKind,
      retrievedAt: reply.evidence.retrievedAt,
      ...(mode !== "walking" ? { mode } : {}),
    });
    legs.push({
      ...edge,
      travelMinutes: Math.ceil(route.durationSeconds / 60),
      distanceMeters: route.distanceMeters,
      mode,
      ...(route.fareYuan !== undefined ? { fareYuan: route.fareYuan } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
      ...(route.path?.length ? { path: route.path } : {}),
    });
  }

  // 证据时间戳在查询完成时生成，因此复核时钟至少取最后一条回答的时刻，避免把新证据误判为来自未来。
  const checkedInput = {
    ...input,
    nowMs: Math.max(input.nowMs, ...routes.flatMap((route) =>
      route.status === "known" ? [Date.parse(route.retrievedAt)] : [])),
  };
  const check = (candidate: readonly DayRoute[]) => {
    const scheduled = scheduleReplan(checkedInput, [], candidate);
    const validation = scheduled.status === "scheduled" ? validateReplan(checkedInput, scheduled.schedule, candidate) : null;
    return {
      feasible: scheduled.status === "scheduled" && validation!.verdict !== "rejected",
      issues: scheduled.status === "scheduled" ? validation!.issues : scheduled.issues,
      schedule: scheduled.status === "scheduled" ? scheduled.schedule : null,
    };
  };
  // feasible 只描述此刻对原时刻的检查结果，和“是否已经写入数据库”是两件事；重开查询没有写入口。
  const strict = check(routes);
  // 先按最新路线严格检查；失败且包含交通估计时，再按允许漂移做一次边界判断。
  // 仅漂移内可衔接会显示“偏紧”，不改存档时刻，也不把任意迟到都当正常波动。
  const drifting = routes.some((route) => route.status === "known" && route.mode && route.mode !== "walking");
  const relaxed = !strict.feasible && drifting
    ? check(routes.map((route) => route.status === "known" && route.mode && route.mode !== "walking"
      ? { ...route, durationSeconds: Math.max(0, route.durationSeconds - estimateToleranceSeconds(route.durationSeconds)) }
      : route))
    : null;
  const late = strict.issues.flatMap((issue) =>
    issue.actual !== undefined && issue.expected !== undefined && issue.actual > issue.expected ? [issue.actual - issue.expected] : []);
  const result = relaxed?.feasible ? relaxed : strict;
  return {
    status: "checked",
    feasible: result.feasible,
    issues: result.issues,
    ...(relaxed?.feasible ? { tightMinutes: Math.max(1, ...late) } : {}),
    legs,
    schedule: result.schedule,
    places: [...live].map(([placeId, place]) => ({ placeId, place })),
    renamed: details.places
      .filter((item) => live.get(item.placeId)!.name !== item.name)
      .map((item) => ({ placeId: item.placeId, current: live.get(item.placeId)!.name })),
    retrievedAt,
  };
}
