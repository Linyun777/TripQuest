import type { ChinaDateTime, DayRoute } from "@tripquest/domain";
import { validateReplan } from "@tripquest/domain";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import type {
  JourneyIdGenerator,
  JourneyRepository,
  StoredJourney,
} from "./contracts";
import { DAY_STAY_MINUTES } from "./day-planning";
import {
  buildReplanCandidate,
  evaluateReplan,
  originalContextOf,
  prepareDayReplan,
  replanBaseFingerprint,
  replanEdges,
  replanInput,
  replanUnchanged,
  type DayReplanProblem,
  type ReplanActivityRecord,
  type ReplanConfirmReply,
  type ReplanPlaceRecord,
  type ReplanReceiptPayload,
  type ReplanSelection,
} from "./day-replan";
import {
  assertReplannedDayMatchesJourney,
  dayAt,
  replannedDayDetailsSchema,
  storedFutureInput,
  type ReplannedDayDetails,
} from "./day-state";
import { fingerprint } from "./fingerprint";
import { toChinaDateTime } from "./runtime-values";
import { routeBetween } from "./route-request";

export interface StoredDayReplanConfirmation {
  readonly intentFingerprint: string;
  readonly resultPlanVersion: number;
}
export interface ConfirmedDayReplan {
  readonly receipt: ReplanReceiptPayload;
  readonly intentFingerprint: string;
  readonly next: StoredJourney;
  readonly confirmedAt: ChinaDateTime;
}
export interface DayReplanRepository extends JourneyRepository {
  findDayReplanConfirmation(journeyId: string, runId: string): Promise<StoredDayReplanConfirmation | null>;
  /** 事务锁住行程根记录，复查计划、观测双版本与基础指纹，然后写入一个新版本。 */
  commitDayReplan(command: ConfirmedDayReplan): Promise<ReplanConfirmReply>;
}

export function replanIntentFingerprint(receipt: ReplanReceiptPayload, acknowledgeUnknowns: boolean): string {
  // 签发与过期时间不属于保存意图；已成功的同一确认后来重试，仍应识别为原请求。
  return fingerprint({
    purpose: receipt.purpose,
    runId: receipt.runId,
    journeyId: receipt.journeyId,
    basePlanVersion: receipt.basePlanVersion,
    baseObservationVersion: receipt.baseObservationVersion,
    baseFingerprint: receipt.baseFingerprint,
    candidateFingerprint: receipt.candidateFingerprint,
    scope: receipt.scope,
    goal: receipt.goal,
    datasetVersion: receipt.datasetVersion,
    selection: receipt.selection,
    execution: receipt.execution,
    acknowledgeUnknowns,
  });
}

/** 经过出发前编辑后，原始兴趣可能只存在第一版，不能从第二版当前活动反推创建意图。 */
export async function loadReplanOriginal(stored: StoredJourney, repository: JourneyRepository) {
  const needsInitial = stored.dayDetails?.schemaVersion === "stored-day-plan.v2";
  const initial = needsInitial ? await repository.findJourneyVersion?.(stored.journeyId, 1) : undefined;
  return originalContextOf(stored, initial ?? undefined);
}

/**
 * 从当前事实和本地目录重新构造凭据中选定的活动，并查询新路线。
 * 确认阶段不调用模型，也不调整所选顺序；变化必须重新预览。
 */
export async function rebuildReplanSelection(
  problem: DayReplanProblem,
  selection: ReplanSelection,
  nowMs: number,
) {
  const places: ReplanPlaceRecord[] = [...problem.places];
  const activities: ReplanActivityRecord[] = [...problem.activities];
  // 凭据中的旧活动必须还属于本次可调整区；冻结尾部不能通过传入另一个活动 ID 偷渡到可调整区。
  const adjustable = new Set(problem.adjustable);
  const directory = planningFixturePlaces();
  const order: string[] = [];
  for (const item of selection) {
    if (item.kind === "planned") {
      const found = activities.find((record) => record.storedId === item.activityId);
      if (!found || !adjustable.has(found.activity.activityId)) return null;
      order.push(found.activity.activityId);
      continue;
    }
    const place = directory.find((entry) => entry.ref.externalId === item.externalId);
    if (
      !place || !problem.interests.includes(item.interest) ||
      places.some((entry) => entry.selection.place.ref.externalId === item.externalId)
    ) {
      return null;
    }
    const placeId = `p${places.length + 1}`;
    const activityId = `a${activities.length + 1}`;
    places.push({ placeId, selection: { place, evidence: planningFixtureEvidence(nowMs) } });
    activities.push({
      activity: {
        activityId,
        placeId,
        role: "discovered",
        stayMinutes: DAY_STAY_MINUTES[item.interest],
        staySource: "system_estimate",
        opening: { status: "unknown" },
        tickets: "unknown",
      },
      interest: item.interest,
    });
    order.push(activityId);
  }
  const input = replanInput(problem, places, activities, nowMs);
  const provider = new PlanningFixtureProvider(() => nowMs);
  const routes: DayRoute[] = [];
  for (const edge of replanEdges(input, order)) {
    if (edge.samePlace) {
      routes.push({ fromPlaceId: edge.fromPlaceId, toPlaceId: edge.toPlaceId, status: "same_place_assumption" });
      continue;
    }
    const from = places.find((entry) => entry.placeId === edge.fromPlaceId)!.selection.place;
    const to = places.find((entry) => entry.placeId === edge.toPlaceId)!.selection.place;
    const reply = await provider.findRoutes({
      ...routeBetween(from, to),
      mode: "walking",
      departureAt: dayAt(problem.input.date, 0),
    });
    if (reply.status !== "ok") return null;
    const route = reply.routes[0];
    routes.push({
      fromPlaceId: edge.fromPlaceId,
      toPlaceId: edge.toPlaceId,
      status: "known",
      durationSeconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
      provider: reply.evidence.provider,
      sourceKind: reply.evidence.sourceKind,
      retrievedAt: reply.evidence.retrievedAt,
    });
  }
  const evaluated = evaluateReplan(input, order, routes);
  if (evaluated.status !== "scheduled") return null;
  return {
    places,
    activities,
    routes,
    order,
    schedule: evaluated.schedule,
    validation: evaluated.validation,
    built: buildReplanCandidate({
      problem,
      places,
      activities,
      schedule: evaluated.schedule,
      validation: evaluated.validation,
    }),
  };
}

export async function confirmDayReplan(options: {
  receipt: ReplanReceiptPayload;
  acknowledgeUnknowns: boolean;
  enabled: boolean;
  now: number;
  repository: DayReplanRepository;
  idGenerator: JourneyIdGenerator;
}): Promise<ReplanConfirmReply> {
  const { receipt, repository, now } = options;
  const intentFingerprint = replanIntentFingerprint(receipt, options.acknowledgeUnknowns);
  // 同意图的成功请求优先回放，不受凭据后来过期、计划推进或功能开关变化影响。
  const prior = await repository.findDayReplanConfirmation(receipt.journeyId, receipt.runId);
  if (prior) {
    return prior.intentFingerprint === intentFingerprint
      ? { status: "already_saved", journeyId: receipt.journeyId, planVersion: prior.resultPlanVersion }
      : { status: "intent_conflict" };
  }
  if (!options.enabled) return { status: "disabled" };
  if (now >= receipt.expiresAt) return { status: "expired" };
  const current = await repository.findCurrentJourney(receipt.journeyId);
  if (!current) return { status: "not_found" };
  if (
    current.currentPlan.version !== receipt.basePlanVersion ||
    current.currentObservationVersion !== receipt.baseObservationVersion ||
    replanBaseFingerprint(current) !== receipt.baseFingerprint
  ) {
    return { status: "stale" };
  }
  // 双版本、基础指纹通过后，按最新累计报告重建边界；预览时可用不代表现在仍可用。
  const prepared = prepareDayReplan(current, {
    runId: receipt.runId,
    scope: receipt.scope,
    goal: receipt.goal,
    nowMs: now,
    basePlanVersion: receipt.basePlanVersion,
    baseObservationVersion: receipt.baseObservationVersion,
    original: await loadReplanOriginal(current, repository),
  });
  if (prepared.status !== "ready" || prepared.problem.datasetVersion !== receipt.datasetVersion) {
    return { status: "candidate_changed" };
  }
  const { problem } = prepared;
  const rebuilt = await rebuildReplanSelection(problem, receipt.selection, now);
  if (
    !rebuilt ||
    rebuilt.built.fingerprint !== receipt.candidateFingerprint ||
    replanUnchanged(problem, rebuilt.built.candidate)
  ) {
    return { status: "candidate_changed" };
  }
  if (rebuilt.built.candidate.verification === "pending" && !options.acknowledgeUnknowns) {
    return { status: "acknowledgment_required" };
  }
  // 候选必须与预览指纹完全一致且有实际变化；未知项还需要用户明确接受，之后才构造正式新版本。
  const confirmedAt = toChinaDateTime(new Date(now));
  const details = replannedDetails(problem, rebuilt, {
    receipt,
    acknowledgeUnknowns: options.acknowledgeUnknowns,
    now,
    idGenerator: options.idGenerator,
  });
  const name = (placeId: string) =>
    details.places.find((item) => item.placeId === placeId)!.selection.place.name;
  const rows = details.future.activities.map((item, index) => {
    const { activity } = item.record;
    const times = details.future.schedule.activities[index];
    return {
      id: activity.activityId,
      placeId: activity.placeId,
      startsAt: dayAt(details.context.date, times.startsAt),
      endsAt: dayAt(details.context.date, times.endsAt),
      priority: ["required", "fixed"].includes(activity.role) ? "high" as const : "normal" as const,
      locked: activity.role === "fixed",
      ...(item.reservationId ? { reservationId: item.reservationId } : {}),
    };
  });
  const next: StoredJourney = {
    ...current,
    dayDetails: details,
    updatedAt: confirmedAt,
    currentPlan: {
      ...current.currentPlan,
      version: details.planVersion,
      parentVersion: details.parentVersion,
      changeReason: "user_confirmed_replan",
      activities: rows,
    },
    activitySnapshots: rows.map((row, position) => ({
      activityId: row.id,
      position,
      placeName: name(row.placeId),
    })),
  };
  assertReplannedDayMatchesJourney(details, next);
  return repository.commitDayReplan({ receipt, intentFingerprint, next, confirmedAt });
}

function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Replan confirmation does not match its receipt");
}

/** 仓库写入前复核：新版本必须同时绑定这张确认凭据和仍未变化的基础状态。 */
export function assertDayReplanCommit(current: StoredJourney, command: ConfirmedDayReplan): void {
  const { receipt, next } = command;
  const details = next.dayDetails;
  invariant(details?.schemaVersion === "stored-day-plan.v3");
  invariant(
    next.journeyId === receipt.journeyId &&
    next.currentPlan.version === receipt.basePlanVersion + 1 &&
    next.currentPlan.parentVersion === receipt.basePlanVersion &&
    details.planVersion === receipt.basePlanVersion + 1 &&
    details.parentVersion === receipt.basePlanVersion &&
    next.currentObservationVersion === receipt.baseObservationVersion &&
    current.currentObservationVersion === receipt.baseObservationVersion &&
    details.progressBasis.observationVersion === receipt.baseObservationVersion &&
    details.progressBasis.reportFingerprint === current.dayProgress?.intentFingerprint,
  );
  invariant(
    details.replan.runId === receipt.runId &&
    details.replan.goal === receipt.goal &&
    details.future.scope === receipt.scope &&
    details.replan.baseFingerprint === receipt.baseFingerprint &&
    details.replan.candidateFingerprint === receipt.candidateFingerprint &&
    details.replan.datasetVersion === receipt.datasetVersion &&
    fingerprint(details.replan.execution) === fingerprint(receipt.execution) &&
    command.intentFingerprint === replanIntentFingerprint(receipt, details.replan.acknowledgeUnknowns),
  );
  // 重排保留原预约记录；不借重排行为重新定义原创建身份。
  invariant(fingerprint(next.reservations) === fingerprint(current.reservations));
  assertReplannedDayMatchesJourney(details, next);
}

/** 重排版本直接使用正式 UUID，保存已报告的归档事实和已确认的未来安排，不补造执行事实。 */
function replannedDetails(
  problem: DayReplanProblem,
  rebuilt: NonNullable<Awaited<ReturnType<typeof rebuildReplanSelection>>>,
  options: {
    receipt: ReplanReceiptPayload;
    acknowledgeUnknowns: boolean;
    now: number;
    idGenerator: JourneyIdGenerator;
  },
): ReplannedDayDetails {
  const placeIds = new Map<string, string>();
  for (const place of rebuilt.places) {
    placeIds.set(place.placeId, place.storedId ?? options.idGenerator.next("place"));
  }
  const activityIds = new Map<string, string>();
  for (const id of rebuilt.order) {
    const record = rebuilt.activities.find((item) => item.activity.activityId === id)!;
    activityIds.set(id, record.storedId ?? options.idGenerator.next("activity"));
  }
  for (const record of problem.activities) {
    activityIds.set(record.activity.activityId, record.storedId!);
  }
  const place = (id: string) => placeIds.get(id)!;
  const { schedule } = rebuilt;
  const scheduled = new Set(schedule.activities.map((item) => item.activityId));
  const futureRecords = schedule.activities.map((item) =>
    rebuilt.activities.find((record) => record.activity.activityId === item.activityId)!);
  const usedPlaces = new Set([
    problem.state.context.startPlaceId,
    problem.state.context.endPlaceId,
    place(problem.input.resumePlaceId),
    ...problem.archived.map((item) => item.record.activity.placeId),
    ...futureRecords.map((record) => place(record.activity.placeId)),
  ]);
  const progress = problem.progress;
  const draft = {
    schemaVersion: "stored-day-plan.v3" as const,
    planVersion: problem.basePlanVersion + 1,
    parentVersion: problem.basePlanVersion,
    context: {
      creationRunId: problem.context.creationRunId,
      requirementsFingerprint: problem.context.requirementsFingerprint,
      ...problem.state.context,
      interests: [...problem.interests],
    },
    places: rebuilt.places
      .filter((item) => usedPlaces.has(place(item.placeId)))
      .map((item) => ({ placeId: place(item.placeId), selection: item.selection })),
    progressBasis: {
      observationVersion: problem.baseObservationVersion,
      reportFingerprint: problem.reportFingerprint,
      completedActivityIds: [...progress.completedActivityIds],
      skippedActivityIds: [...progress.skippedActivityIds],
      observedAt: progress.observedAt,
      earliestResumeAt: progress.earliestResumeAt,
      locationPlaceId: progress.locationPlaceId!,
      source: "user_reported" as const,
    },
    archived: structuredClone([...problem.archived]),
    future: {
      scope: problem.scope,
      resumePlaceId: place(problem.input.resumePlaceId),
      resumesAt: problem.input.resumesAt,
      activities: futureRecords.map((record) => ({
        record: {
          activity: {
            ...record.activity,
            activityId: activityIds.get(record.activity.activityId)!,
            placeId: place(record.activity.placeId),
          },
          ...(record.interest ? { interest: record.interest } : {}),
        },
        ...(record.reservationId ? { reservationId: record.reservationId } : {}),
      })),
      routes: rebuilt.routes
        .filter((route) => schedule.legs.some((leg) =>
          leg.fromPlaceId === route.fromPlaceId && leg.toPlaceId === route.toPlaceId))
        .map((route) => ({ ...route, fromPlaceId: place(route.fromPlaceId), toPlaceId: place(route.toPlaceId) })),
      frozen: problem.input.frozen.map((item) => ({ ...item, activityId: activityIds.get(item.activityId)! })),
      schedule: {
        ...schedule,
        activities: schedule.activities.map((item) => ({
          ...item,
          activityId: activityIds.get(item.activityId)!,
          placeId: place(item.placeId),
        })),
        legs: schedule.legs.map((leg) => ({
          ...leg,
          fromPlaceId: place(leg.fromPlaceId),
          toPlaceId: place(leg.toPlaceId),
        })),
      },
      verification: "pending" as "checked" | "pending",
      checks: [] as ReplannedDayDetails["future"]["checks"],
    },
    replan: {
      runId: problem.runId,
      goal: problem.goal,
      baseFingerprint: problem.baseFingerprint,
      candidateFingerprint: options.receipt.candidateFingerprint,
      datasetVersion: problem.datasetVersion,
      recheckedAt: new Date(options.now).toISOString(),
      acknowledgeUnknowns: options.acknowledgeUnknowns,
      execution: options.receipt.execution,
    },
  };
  // 最终保存的结论由独立校验器对正式 UUID 对应的事实重新计算，不能沿用模型或预览自报的结论。
  const parsed = replannedDayDetailsSchema.parse(draft);
  const validation = validateReplan(
    storedFutureInput(parsed, options.now),
    parsed.future.schedule,
    parsed.future.routes,
  );
  if (validation.verdict === "rejected" || scheduled.size !== futureRecords.length) {
    throw new Error("Confirmed replan failed validation");
  }
  return replannedDayDetailsSchema.parse({
    ...parsed,
    future: { ...parsed.future, verification: validation.verdict, checks: [...validation.issues] },
  });
}
