import { z } from "zod";
import {
  sameDayPlace,
  scheduleReplan,
  validateReplan,
  type DayActivity,
  type DayIssue,
  type DayReplanInput,
  type DayRoute,
  type DaySchedule,
  type DayValidation,
} from "@tripquest/domain";
import {
  PLANNING_FIXTURE_PROVIDER,
  PLANNING_FIXTURE_VERSION,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import type { StoredJourney } from "./contracts";
import { freezeDayProblem } from "./day-planning";
import type { StoredDayProgress } from "./day-progress";
import {
  dayStateFingerprint,
  minuteOf,
  semanticDay,
  dayState,
  type DayState,
  type DayStateArchived,
  type ReplannedDayDetails,
  type ReplanGoal,
  type ReplanScope,
} from "./day-state";
import { canonicalJson, fingerprint } from "./fingerprint";
import type { PlanningInterest, PlanningInterestId, PlanningPlace } from "./planning-requirements";
import {
  DAY_REPLAN_PROTOCOL,
  DAY_REPLAN_PURPOSE,
  replanCandidateSchema,
  replanComparisonSchema,
  replanSelectionSchema,
  type ReplanCandidate,
  type ReplanComparison,
  type ReplanProgress,
  type ReplanResult,
  type ReplanSelection,
  type replanConflictSchema,
} from "./day-replan-contract";

export * from "./day-replan-contract";

export interface ReplanPlaceRecord {
  /** 模型本轮看到的局部 ID，正式保存时通过绑定找回原身份。 */
  readonly placeId: string;
  /** 已存地点的正式 UUID；本轮新发现的地点尚无此字段。 */
  readonly storedId?: string;
  readonly selection: PlanningPlace;
}
export interface ReplanActivityRecord {
  readonly activity: DayActivity;
  readonly interest?: PlanningInterestId;
  /** 已有活动的正式 UUID；新发现项在确认前不分配正式身份。 */
  readonly storedId?: string;
  readonly reservationId?: string;
  readonly planned?: { readonly startsAt: number; readonly endsAt: number };
}
export interface DayReplanProblem {
  readonly protocolVersion: typeof DAY_REPLAN_PROTOCOL;
  readonly runId: string;
  readonly journeyId: string;
  readonly basePlanVersion: number;
  readonly baseObservationVersion: number;
  readonly baseFingerprint: string;
  readonly reportFingerprint: string;
  readonly scope: ReplanScope;
  readonly goal: ReplanGoal;
  readonly datasetVersion: string;
  readonly interests: readonly PlanningInterest[];
  readonly input: DayReplanInput;
  readonly places: readonly ReplanPlaceRecord[];
  /** 只包含未处理活动，顺序沿用当前计划。 */
  readonly activities: readonly ReplanActivityRecord[];
  readonly adjustable: readonly string[];
  readonly anchorActivityId?: string;
  readonly archived: readonly DayStateArchived[];
  readonly state: DayState;
  readonly progress: StoredDayProgress;
  readonly context: {
    readonly creationRunId: string;
    readonly requirementsFingerprint: string;
  };
}

export type ReplanPreparation =
  | { status: "ready"; problem: DayReplanProblem }
  | { status: "needs_information"; reason: "unreported" | "location_unknown" }
  | { status: "constraints_conflict"; conflicts: z.infer<typeof replanConflictSchema>[] }
  | { status: "invalid_scope" | "source_not_allowed" | "stale" };

export function replanBaseFingerprint(stored: StoredJourney): string {
  if (!stored.dayDetails) throw new Error("Generated day details are missing");
  const progress = stored.dayProgress;
  return fingerprint({
    journeyId: stored.journeyId,
    planVersion: stored.currentPlan.version,
    observationVersion: stored.currentObservationVersion,
    state: dayStateFingerprint(dayState(stored.dayDetails, stored.currentPlan.activities)),
    report: progress ? progress.intentFingerprint : null,
  });
}

/** 首次创建的身份与兴趣，后续版本持续继承，不能被一次重排重新定义。 */
export function originalContextOf(
  stored: StoredJourney,
  initial?: StoredJourney,
): { creationRunId: string; requirementsFingerprint: string; interests: PlanningInterest[] } {
  const details = stored.dayDetails;
  if (details?.schemaVersion === "stored-day-plan.v3") {
    return {
      creationRunId: details.context.creationRunId,
      requirementsFingerprint: details.context.requirementsFingerprint,
      interests: [...details.context.interests],
    };
  }
  const first = details?.schemaVersion === "stored-day-plan.v1" ? details : initial?.dayDetails;
  if (first?.schemaVersion !== "stored-day-plan.v1") throw new Error("Initial generated details are missing");
  return {
    creationRunId: first.planning.problem.runId,
    requirementsFingerprint: first.planning.problem.requirementsFingerprint,
    interests: [...first.planning.problem.requirements.interests],
  };
}

/** 先构建不可变的重排问题；缺信息或已有确定冲突时直接返回，避免无意义的模型与路线请求。 */
export function prepareDayReplan(
  stored: StoredJourney,
  options: {
    runId: string;
    scope: ReplanScope;
    goal: ReplanGoal;
    nowMs: number;
    basePlanVersion: number;
    baseObservationVersion: number;
    original: ReturnType<typeof originalContextOf>;
  },
): ReplanPreparation {
  if (stored.creationKind !== "generated_day" || !stored.dayDetails) {
    return { status: "source_not_allowed" };
  }
  if (
    stored.currentPlan.version !== options.basePlanVersion ||
    stored.currentObservationVersion !== options.baseObservationVersion
  ) {
    return { status: "stale" };
  }
  const state = dayState(stored.dayDetails, stored.currentPlan.activities);
  const directory = planningFixturePlaces();
  if (state.places.some(({ selection }) =>
    selection.place.ref.provider !== PLANNING_FIXTURE_PROVIDER ||
    selection.evidence.sourceKind !== "fixture" ||
    selection.evidence.datasetVersion !== PLANNING_FIXTURE_VERSION ||
    !directory.some((place) => canonicalJson(place) === canonicalJson(selection.place)))) {
    return { status: "source_not_allowed" };
  }
  const progress = stored.dayProgress;
  if (!progress) return { status: "needs_information", reason: "unreported" };
  if (!progress.locationPlaceId) return { status: "needs_information", reason: "location_unknown" };
  const completed = new Set(progress.completedActivityIds);
  const skipped = new Set(progress.skippedActivityIds);
  // 用户已报告的完成和跳过先移入归档，模型只看到剩余活动，不能把历史事实重新排回未来。
  const pool = state.future.filter((item) =>
    !completed.has(item.record.activity.activityId) && !skipped.has(item.record.activity.activityId));
  const archived: DayStateArchived[] = [
    ...state.archived,
    ...state.future
      .filter((item) => !pool.includes(item))
      .map((item) => ({
        record: item.record,
        status: completed.has(item.record.activity.activityId) ? "completed" as const : "skipped" as const,
        planned: { startsAt: item.startsAt, endsAt: item.endsAt },
        ...(item.reservationId ? { reservationId: item.reservationId } : {}),
      })),
  ];
  const resumesAt = minuteOf(progress.earliestResumeAt, state.context.date);
  // 硬事项已被跳过、固定时段已过等冲突无法靠重排消除，应在调用模型前直接交代原因。
  const conflicts: z.infer<typeof replanConflictSchema>[] = [];
  for (const item of archived) {
    const { activity } = item.record;
    if (item.status === "skipped" && ["required", "fixed"].includes(activity.role)) {
      conflicts.push({ code: "hard_skipped", activityId: activity.activityId });
    }
  }
  for (const item of pool) {
    const fixed = item.record.activity.fixed;
    if (fixed && fixed.startsAt < resumesAt) {
      conflicts.push({ code: "fixed_passed", activityId: item.record.activity.activityId });
    }
  }
  if (resumesAt >= state.context.window.endsAt) conflicts.push({ code: "resume_after_end" });
  if (conflicts.length) return { status: "constraints_conflict", conflicts };

  const anchorIndex = pool.findIndex((item) => item.record.activity.role === "fixed");
  if (options.scope === "until_next_fixed" && anchorIndex < 0) return { status: "invalid_scope" };
  const cut = options.scope === "until_next_fixed" ? anchorIndex : pool.length;

  const placeId = new Map(state.places.map((item, index) => [item.placeId, `p${index + 1}`]));
  const local = (id: string) => placeId.get(id)!;
  const places: ReplanPlaceRecord[] = state.places.map((item) => ({
    placeId: local(item.placeId),
    storedId: item.placeId,
    selection: item.selection,
  }));
  const activities: ReplanActivityRecord[] = pool.map((item, index) => ({
    activity: {
      ...item.record.activity,
      activityId: `a${index + 1}`,
      placeId: local(item.record.activity.placeId),
    },
    ...(item.record.interest ? { interest: item.record.interest } : {}),
    storedId: item.record.activity.activityId,
    ...(item.reservationId ? { reservationId: item.reservationId } : {}),
    planned: { startsAt: item.startsAt, endsAt: item.endsAt },
  }));
  // “到下个固定事项为止”冻结的是后面整段原时刻，不只冻结锚点；候选要接得上，也不能顺延尾部。
  const frozen = activities.slice(cut).map((item) => ({
    activityId: item.activity.activityId,
    startsAt: item.planned!.startsAt,
    endsAt: item.planned!.endsAt,
  }));
  const problem: DayReplanProblem = {
    protocolVersion: DAY_REPLAN_PROTOCOL,
    runId: options.runId,
    journeyId: stored.journeyId,
    basePlanVersion: stored.currentPlan.version,
    baseObservationVersion: stored.currentObservationVersion,
    baseFingerprint: replanBaseFingerprint(stored),
    reportFingerprint: progress.intentFingerprint,
    scope: options.scope,
    goal: options.goal,
    datasetVersion: PLANNING_FIXTURE_VERSION,
    interests: options.original.interests,
    input: {
      date: state.context.date,
      timeZone: state.context.timeZone,
      bufferMinutes: state.context.bufferMinutes,
      nowMs: options.nowMs,
      places: places.map(domainPlace),
      resumePlaceId: local(progress.locationPlaceId),
      resumesAt,
      endPlaceId: local(state.context.endPlaceId),
      endsAt: state.context.window.endsAt,
      activities: activities.map((item) => item.activity),
      frozen,
      // 六项上限包含当天已经处理的活动，不能每次重排都重新获得六个新名额。
      capacity: 6 - archived.length,
    },
    places,
    activities,
    adjustable: activities.slice(0, cut).map((item) => item.activity.activityId),
    ...(options.scope === "until_next_fixed" ? { anchorActivityId: activities[cut].activity.activityId } : {}),
    archived,
    state,
    progress,
    context: {
      creationRunId: options.original.creationRunId,
      requirementsFingerprint: options.original.requirementsFingerprint,
    },
  };
  return { status: "ready", problem: freezeDayProblem(structuredClone(problem)) };
}

export function domainPlace({ placeId, selection }: { placeId: string; selection: PlanningPlace }) {
  return { placeId, ...selection.place.ref, snapshot: JSON.stringify(selection.place) };
}

/** 把本轮发现的地点和活动加入求解输入，原问题中的版本、冻结区与容量限制继续保留。 */
export function replanInput(
  problem: DayReplanProblem,
  places: readonly ReplanPlaceRecord[],
  activities: readonly ReplanActivityRecord[],
  nowMs: number,
): DayReplanInput {
  return {
    ...problem.input,
    nowMs,
    places: places.map(domainPlace),
    activities: activities.map((item) => item.activity),
  };
}

/** 按候选顺序展开有向边，同时覆盖冻结尾部和最终返程，局部调整也必须验证完整衔接。 */
export function replanEdges(
  input: DayReplanInput,
  adjustableOrder: readonly string[],
): { fromPlaceId: string; toPlaceId: string; samePlace: boolean }[] {
  const order = [...adjustableOrder, ...input.frozen.map((item) => item.activityId)];
  const path = [
    input.resumePlaceId,
    ...order.map((id) => input.activities.find((item) => item.activityId === id)!.placeId),
    input.endPlaceId,
  ];
  const place = (id: string) => input.places.find((item) => item.placeId === id)!;
  const edges = new Map<string, { fromPlaceId: string; toPlaceId: string; samePlace: boolean }>();
  for (let index = 1; index < path.length; index += 1) {
    const key = `${path[index - 1]}>${path[index]}`;
    edges.set(key, {
      fromPlaceId: path[index - 1],
      toPlaceId: path[index],
      samePlace: sameDayPlace(place(path[index - 1]), place(path[index])),
    });
  }
  return [...edges.values()];
}

export type ReplanEvaluation =
  | { status: "scheduled"; schedule: DaySchedule; validation: DayValidation }
  | { status: "not_scheduled"; issues: readonly DayIssue[] };

/** 确定性排程之后再经独立校验器复核；有明确违规的结果不能作为可用候选。 */
export function evaluateReplan(
  input: DayReplanInput,
  adjustableOrder: readonly string[],
  routes: readonly DayRoute[],
): ReplanEvaluation {
  const scheduled = scheduleReplan(input, adjustableOrder, routes);
  if (scheduled.status !== "scheduled") return scheduled;
  const validation = validateReplan(input, scheduled.schedule, routes);
  if (validation.verdict === "rejected") return { status: "not_scheduled", issues: validation.issues };
  return { status: "scheduled", schedule: scheduled.schedule, validation };
}

/* 候选构造、差异比较与页面协议。 */

const placeKey = (record: ReplanPlaceRecord) =>
  record.storedId ?? `new:${record.selection.place.ref.externalId}`;
const activityKey = (record: ReplanActivityRecord, places: readonly ReplanPlaceRecord[]) =>
  record.storedId ?? `new:${places.find((place) => place.placeId === record.activity.placeId)!
    .selection.place.ref.externalId}`;

function metricsOf(schedule: DaySchedule) {
  return {
    activities: schedule.activities.length,
    walking: schedule.totalWalkingMinutes,
    distance: schedule.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    longest: schedule.longestWalkingMinutes,
    waiting: schedule.activities.reduce((sum, item) => sum + item.waitMinutes, 0),
    endArrival: schedule.endArrival,
  };
}

/** 把局部 ID 转成原 UUID 或 new:<外部地点编号>，使预览和确认能比较同一候选而不依赖本轮编号。 */
export function keyIssues(
  issues: readonly DayIssue[],
  places: readonly ReplanPlaceRecord[],
  activities: readonly ReplanActivityRecord[],
): DayIssue[] {
  const activity = (id?: string) => {
    const found = activities.find((item) => item.activity.activityId === id);
    return found ? activityKey(found, places) : undefined;
  };
  const place = (id?: string) => {
    const found = places.find((item) => item.placeId === id);
    return found ? placeKey(found) : undefined;
  };
  return issues.map((issue) => {
    const activityId = activity(issue.activityId);
    const fromPlaceId = place(issue.fromPlaceId);
    const toPlaceId = place(issue.toPlaceId);
    return {
      ...issue,
      ...(activityId ? { activityId } : {}),
      ...(fromPlaceId ? { fromPlaceId } : {}),
      ...(toPlaceId ? { toPlaceId } : {}),
    };
  });
}

export function buildReplanCandidate(options: {
  problem: DayReplanProblem;
  places: readonly ReplanPlaceRecord[];
  activities: readonly ReplanActivityRecord[];
  schedule: DaySchedule;
  validation: DayValidation;
}): { candidate: ReplanCandidate; selection: ReplanSelection; fingerprint: string } {
  const { problem, places, activities, schedule, validation } = options;
  const place = (id: string) => places.find((item) => item.placeId === id)!;
  const record = (id: string) => activities.find((item) => item.activity.activityId === id)!;
  const frozen = new Set(problem.input.frozen.map((item) => item.activityId));
  const used = new Set([
    problem.input.resumePlaceId,
    problem.input.endPlaceId,
    ...schedule.activities.map((item) => item.placeId),
  ]);
  const candidate = replanCandidateSchema.parse({
    archived: problem.archived.map((item) => ({
      key: item.record.activity.activityId,
      name: problem.state.places.find((entry) => entry.placeId === item.record.activity.placeId)!
        .selection.place.name,
      role: item.record.activity.role,
      status: item.status,
      planned: item.planned,
    })),
    resume: {
      key: placeKey(place(problem.input.resumePlaceId)),
      name: place(problem.input.resumePlaceId).selection.place.name,
      startsAt: problem.input.resumesAt,
    },
    end: {
      key: placeKey(place(problem.input.endPlaceId)),
      name: place(problem.input.endPlaceId).selection.place.name,
      endsAt: problem.input.endsAt,
    },
    activities: schedule.activities.map((item) => {
      const found = record(item.activityId);
      return {
        key: activityKey(found, places),
        placeKey: placeKey(place(item.placeId)),
        name: place(item.placeId).selection.place.name,
        role: found.activity.role,
        origin: found.storedId ? "planned" : "discovered",
        frozen: frozen.has(item.activityId),
        stayMinutes: found.activity.stayMinutes,
        staySource: found.activity.staySource,
        ...(found.interest ? { interest: found.interest } : {}),
        arrivesAt: item.arrivesAt,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        waitMinutes: item.waitMinutes,
      };
    }),
    legs: schedule.legs.map((leg) => ({
      fromKey: placeKey(place(leg.fromPlaceId)),
      toKey: placeKey(place(leg.toPlaceId)),
      departsAt: leg.departsAt,
      arrivesAt: leg.arrivesAt,
      travelMinutes: leg.travelMinutes,
      bufferMinutes: leg.bufferMinutes,
      distanceMeters: leg.distanceMeters,
      source: leg.source,
    })),
    places: places
      .filter((item) => used.has(item.placeId))
      .map((item) => ({ placeId: placeKey(item), selection: item.selection })),
    metrics: metricsOf(schedule),
    verification: validation.verdict === "checked" ? "checked" : "pending",
    checks: keyIssues(validation.issues, places, activities),
  });
  const selection = replanSelectionSchema.parse(schedule.activities
    .filter((item) => !frozen.has(item.activityId))
    .map((item) => {
      const found = record(item.activityId);
      return found.storedId
        ? { kind: "planned", activityId: found.storedId }
        : {
            kind: "discovered",
            externalId: place(found.activity.placeId).selection.place.ref.externalId,
            interest: found.interest,
          };
    }));
  return {
    candidate,
    selection,
    fingerprint: replanCandidateFingerprint(problem, selection, candidate),
  };
}

export function replanCandidateFingerprint(
  problem: Pick<DayReplanProblem, "baseFingerprint" | "scope" | "goal" | "datasetVersion">,
  selection: ReplanSelection,
  candidate: ReplanCandidate,
): string {
  return fingerprint(semanticDay({
    purpose: DAY_REPLAN_PURPOSE,
    baseFingerprint: problem.baseFingerprint,
    scope: problem.scope,
    goal: problem.goal,
    datasetVersion: problem.datasetVersion,
    selection,
    candidate,
  }));
}

/**
 * 只比较实际安排：归档事实、出发位置和时间、未来活动身份与时段。
 * 运行 ID、调整目标、查询时间的变化不算新方案；新的报告位置或恢复时间则算。
 */
export function replanUnchanged(problem: DayReplanProblem, candidate: ReplanCandidate): boolean {
  const current = problem.state;
  const departure = current.resume ?? {
    placeId: current.context.startPlaceId,
    startsAt: current.context.window.startsAt,
  };
  return problem.archived.length === current.archived.length &&
    candidate.resume.key === departure.placeId &&
    candidate.resume.startsAt === departure.startsAt &&
    candidate.activities.length === current.future.length &&
    candidate.activities.every((item, index) =>
      item.key === current.future[index].record.activity.activityId &&
      item.startsAt === current.future[index].startsAt &&
      item.endsAt === current.future[index].endsAt);
}

export function compareReplan(options: {
  problem: DayReplanProblem;
  places: readonly ReplanPlaceRecord[];
  activities: readonly ReplanActivityRecord[];
  candidate: ReplanCandidate;
  baseline: ReplanEvaluation | null;
}): ReplanComparison {
  const { problem, candidate, baseline } = options;
  const after = new Map(candidate.activities.map((item) => [item.key, item]));
  const changes: ReplanComparison["changes"] = problem.activities.map((item) => {
    const next = after.get(item.storedId!);
    const name = problem.places.find((place) => place.placeId === item.activity.placeId)!
      .selection.place.name;
    if (!next) return { key: item.storedId!, name, change: "removed", before: item.planned };
    const moved = next.startsAt !== item.planned!.startsAt || next.endsAt !== item.planned!.endsAt;
    return {
      key: item.storedId!,
      name,
      change: moved ? "moved" : "kept",
      before: item.planned,
      after: { startsAt: next.startsAt, endsAt: next.endsAt },
    };
  });
  for (const item of candidate.activities) {
    if (item.origin === "discovered") {
      changes.push({ key: item.key, name: item.name, change: "added", after: { startsAt: item.startsAt, endsAt: item.endsAt } });
    }
  }
  return replanComparisonSchema.parse({
    changes,
    baseline: baseline === null ? null
      : baseline.status === "scheduled"
        ? {
            status: "scheduled",
            metrics: metricsOf(baseline.schedule),
            sameAsCandidate: baseline.schedule.activities.length === candidate.activities.length &&
              baseline.schedule.activities.every((item, index) =>
                item.startsAt === candidate.activities[index].startsAt &&
                activityKey(options.activities.find((record) =>
                  record.activity.activityId === item.activityId)!, options.places) ===
                  candidate.activities[index].key),
          }
        : { status: "not_scheduled", issues: keyIssues(baseline.issues, options.places, options.activities) },
  });
}

/** 把已保存的重排版本转换成候选的展示结构，键使用正式 UUID。 */
export function storedReplanView(details: ReplannedDayDetails): ReplanCandidate {
  const name = (placeId: string) =>
    details.places.find((item) => item.placeId === placeId)!.selection.place.name;
  const { future } = details;
  return replanCandidateSchema.parse({
    archived: details.archived.map((item) => ({
      key: item.record.activity.activityId,
      name: name(item.record.activity.placeId),
      role: item.record.activity.role,
      status: item.status,
      planned: item.planned,
    })),
    resume: { key: future.resumePlaceId, name: name(future.resumePlaceId), startsAt: future.resumesAt },
    end: {
      key: details.context.endPlaceId,
      name: name(details.context.endPlaceId),
      endsAt: details.context.window.endsAt,
    },
    activities: future.activities.map((item, index) => {
      const times = future.schedule.activities[index];
      const { activity } = item.record;
      return {
        key: activity.activityId,
        placeKey: activity.placeId,
        name: name(activity.placeId),
        role: activity.role,
        origin: "planned",
        frozen: future.frozen.some((slot) => slot.activityId === activity.activityId),
        stayMinutes: activity.stayMinutes,
        staySource: activity.staySource,
        ...(item.record.interest ? { interest: item.record.interest } : {}),
        arrivesAt: times.arrivesAt,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        waitMinutes: times.waitMinutes,
      };
    }),
    legs: future.schedule.legs.map((leg) => ({
      fromKey: leg.fromPlaceId,
      toKey: leg.toPlaceId,
      departsAt: leg.departsAt,
      arrivesAt: leg.arrivesAt,
      travelMinutes: leg.travelMinutes,
      bufferMinutes: leg.bufferMinutes,
      distanceMeters: leg.distanceMeters,
      source: leg.source,
    })),
    places: details.places,
    metrics: {
      activities: future.activities.length,
      walking: future.schedule.totalWalkingMinutes,
      distance: future.schedule.legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      longest: future.schedule.longestWalkingMinutes,
      waiting: future.schedule.activities.reduce((sum, item) => sum + item.waitMinutes, 0),
      endArrival: future.schedule.endArrival,
    },
    verification: future.verification,
    checks: future.checks,
  });
}

/* 运行结果与 NDJSON 流事件协议。 */

export interface DayReplanRunner {
  run(problem: DayReplanProblem, options: {
    signal: AbortSignal;
    onProgress: (progress: ReplanProgress) => void;
  }): Promise<ReplanResult>;
}
