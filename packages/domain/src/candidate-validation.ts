import type { PlannedActivity } from "./model";
import type {
  CandidateValidationInput,
  CandidateValidationResult,
  CheckedTransition,
  TravelLegInput,
  ValidationIssue,
  ValidationIssueCode,
} from "./candidate-validation-types";
import {
  formatChinaDateTime,
  prepareCandidateInput,
  type PreparedInput,
  type TimedActivity,
} from "./candidate-validation-input";

function addIssue(
  issues: ValidationIssue[],
  category: ValidationIssue["category"],
  code: ValidationIssueCode,
  details: Omit<ValidationIssue, "category" | "code"> = {},
): void {
  issues.push({ category, code, ...details });
}

function insideScope(activity: TimedActivity, context: PreparedInput): boolean {
  return activity.startsAtMs >= context.scopeStartMs && activity.endsAtMs <= context.scopeEndMs;
}

function scheduleChanged(before: PlannedActivity, after: PlannedActivity): boolean {
  return before.placeId !== after.placeId || before.startsAt !== after.startsAt || before.endsAt !== after.endsAt;
}

function metadataChanged(before: PlannedActivity, after: PlannedActivity): boolean {
  return before.priority !== after.priority || before.locked !== after.locked || before.reservationId !== after.reservationId;
}

/** 已完成、跳过、进行中、锁定或关联预约的活动共同组成保护集合，候选不能借修改元信息解除保护。 */
function protectedIds(context: PreparedInput): Set<string> {
  const { state } = context.input;
  const result = new Set([...state.completedActivityIds, ...state.skippedActivityIds]);
  if (state.currentActivityId !== null) result.add(state.currentActivityId);
  for (const activity of context.input.plan.activities) {
    if (activity.locked || activity.reservationId !== undefined) result.add(activity.id);
  }
  return result;
}

// 校验请求和候选是否属于同一行程、同一计划与观察版本；来源对不上时后续“可行”没有业务意义。
function checkBindings(context: PreparedInput, issues: ValidationIssue[]): void {
  const { plan, state, request, candidate } = context.input;
  for (const [fieldPath, journeyId] of [
    ["request.journeyId", request.journeyId],
    ["candidate.journeyId", candidate.journeyId],
  ] as const) {
    if (journeyId !== plan.journeyId) {
      addIssue(issues, "known_violation", "journey_mismatch", { fieldPath });
    }
  }
  for (const [fieldPath, actual, expected] of [
    ["request.basePlanVersion", request.basePlanVersion, plan.version],
    ["request.baseStateVersion", request.baseStateVersion, state.version],
    ["candidate.basePlanVersion", candidate.basePlanVersion, plan.version],
    ["candidate.baseStateVersion", candidate.baseStateVersion, state.version],
  ] as const) {
    if (actual !== expected) addIssue(issues, "known_violation", "stale_base", { fieldPath });
  }
}

// 用稳定活动 ID 对齐前后完整计划，分别检查删除、时间地点变化、元信息变化与保护事项顺序。
function checkEdits(context: PreparedInput, issues: ValidationIssue[]): void {
  const byCandidateId = new Map(context.candidateActivities.map((entry) => [entry.activity.id, entry]));
  const byBaseId = new Map(context.planActivities.map((entry) => [entry.activity.id, entry]));
  const protectedSet = protectedIds(context);

  for (const base of context.planActivities) {
    const id = base.activity.id;
    const candidate = byCandidateId.get(id);
    if (candidate === undefined) {
      if (protectedSet.has(id)) {
        addIssue(issues, "known_violation", "protected_activity_changed", { activityId: id });
      }
      if (!insideScope(base, context)) {
        addIssue(issues, "known_violation", "outside_scope_change", { activityId: id });
      }
      continue;
    }

    const changedSchedule = scheduleChanged(base.activity, candidate.activity);
    const changedMetadata = metadataChanged(base.activity, candidate.activity);
    if (changedMetadata) {
      addIssue(issues, "known_violation", "unauthorized_metadata_change", { activityId: id });
    }
    if (changedSchedule || changedMetadata) {
      if (protectedSet.has(id)) {
        addIssue(issues, "known_violation", "protected_activity_changed", { activityId: id });
      }
      // 修改前后都必须落在允许窗口内，不能把窗口外活动搬进来，或把窗口内活动移出去。
      if (!insideScope(base, context) || !insideScope(candidate, context)) {
        addIssue(issues, "known_violation", "outside_scope_change", { activityId: id });
      }
    }
  }

  for (const candidate of context.candidateActivities) {
    if (byBaseId.has(candidate.activity.id)) continue;
    if (candidate.activity.locked || candidate.activity.reservationId !== undefined) {
      addIssue(issues, "known_violation", "unauthorized_metadata_change", {
        activityId: candidate.activity.id,
      });
    }
    if (!insideScope(candidate, context)) {
      addIssue(issues, "known_violation", "outside_scope_change", {
        activityId: candidate.activity.id,
      });
    }
  }

  const baseProtectedOrder = context.input.plan.activities
    .filter((activity) => protectedSet.has(activity.id))
    .map((activity) => activity.id);
  const candidateProtectedOrder = context.input.candidate.activities
    .filter((activity) => protectedSet.has(activity.id))
    .map((activity) => activity.id);
  if (
    baseProtectedOrder.length !== candidateProtectedOrder.length ||
    baseProtectedOrder.some((id, index) => id !== candidateProtectedOrder[index])
  ) {
    addIssue(issues, "known_violation", "protected_activity_changed", {
      fieldPath: "candidate.activities",
    });
  }
}

// 预约按独立事实复核；缺少已确认来源是信息不足，候选偏离已确认预约才是确定违反。
function checkReservations(context: PreparedInput, issues: ValidationIssue[]): void {
  const reservations = new Map(context.input.reservations.map((reservation) => [reservation.id, reservation]));
  const candidate = new Map(context.input.candidate.activities.map((activity) => [activity.id, activity]));
  for (const activity of context.input.plan.activities) {
    if (activity.reservationId === undefined) continue;
    const reservation = reservations.get(activity.reservationId);
    if (reservation === undefined || reservation.confirmation.status !== "confirmed") {
      addIssue(issues, "insufficient_information", "reservation_unverified", {
        activityId: activity.id,
      });
      continue;
    }
    const proposed = candidate.get(activity.id);
    if (
      proposed === undefined ||
      proposed.placeId !== reservation.placeId ||
      proposed.startsAt !== reservation.startsAt ||
      proposed.endsAt !== reservation.endsAt ||
      proposed.reservationId !== reservation.id
    ) {
      addIssue(issues, "known_violation", "reservation_conflict", { activityId: activity.id });
    }
  }
}

function checkOverlap(context: PreparedInput, issues: ValidationIssue[]): void {
  for (let index = 1; index < context.candidateActivities.length; index += 1) {
    const previous = context.candidateActivities[index - 1];
    const next = context.candidateActivities[index];
    if (next.startsAtMs < previous.endsAtMs) {
      addIssue(issues, "known_violation", "activity_overlap", {
        activityId: next.activity.id,
        relatedActivityId: previous.activity.id,
      });
    }
  }
}

// 计划里本应开始的活动若用户没报告进度，不猜已完成；未来候选也不能排到最早继续时刻之前。
function checkProgressAndDelay(context: PreparedInput, issues: ValidationIssue[]): void {
  const { state } = context.input;
  const completed = new Set(state.completedActivityIds);
  const skipped = new Set(state.skippedActivityIds);
  const baseById = new Map(context.planActivities.map((entry) => [entry.activity.id, entry]));
  for (const entry of context.planActivities) {
    const id = entry.activity.id;
    if (completed.has(id) || skipped.has(id) || id === state.currentActivityId) continue;
    if (entry.startsAtMs < context.observedAtMs) {
      addIssue(issues, "insufficient_information", "activity_progress_unknown", { activityId: id });
    }
  }
  for (const entry of context.candidateActivities) {
    const id = entry.activity.id;
    if (completed.has(id) || skipped.has(id) || id === state.currentActivityId) continue;
    if (entry.startsAtMs < context.observedAtMs) {
      const original = baseById.get(id);
      if (original === undefined || original.startsAtMs >= context.observedAtMs) {
        addIssue(issues, "known_violation", "delay_conflict", { activityId: id });
      }
    } else if (entry.startsAtMs < context.earliestResumeAtMs) {
      addIssue(issues, "known_violation", "delay_conflict", { activityId: id });
    }
  }
}

function travelLeg(
  legs: readonly TravelLegInput[],
  fromPlaceId: string,
  toPlaceId: string,
): TravelLegInput | undefined {
  return legs.find((leg) => leg.fromPlaceId === fromPlaceId && leg.toPlaceId === toPlaceId);
}

function checkKnownTransition(
  context: PreparedInput,
  issues: ValidationIssue[],
  checkedTransitions: CheckedTransition[],
  fromPlaceId: string,
  to: TimedActivity,
  departsAtMs: number,
  fromActivityId?: string,
): void {
  const toPlaceId = to.activity.placeId;
  let travelMinutes = 0;
  let bufferMinutes = 0;
  if (fromPlaceId !== toPlaceId) {
    const leg = travelLeg(context.input.travelLegs, fromPlaceId, toPlaceId);
    // 有向交通缺失必须报信息不足；零分钟只适用于真正同地衔接，不是缺值的默认兜底。
    if (leg === undefined || leg.duration.kind === "unknown") {
      addIssue(issues, "insufficient_information", "unknown_travel_duration", {
        fromPlaceId,
        toPlaceId,
        activityId: to.activity.id,
        relatedActivityId: fromActivityId,
      });
      return;
    }
    travelMinutes = leg.duration.minutes;
    bufferMinutes = context.input.transferBufferMinutes;
  }
  const earliestArrivalMs = departsAtMs + (travelMinutes + bufferMinutes) * 60_000;
  if (!Number.isSafeInteger(earliestArrivalMs) || Math.abs(earliestArrivalMs) > 8.64e15) {
    addIssue(issues, "invalid_input", "invalid_number", { fieldPath: "travelLegs/transferBufferMinutes" });
    return;
  }
  checkedTransitions.push({
    ...(fromActivityId === undefined ? {} : { fromActivityId }),
    toActivityId: to.activity.id,
    fromPlaceId,
    toPlaceId,
    departsAt: formatChinaDateTime(departsAtMs),
    earliestArrivalAt: formatChinaDateTime(earliestArrivalMs),
    nextStartsAt: to.activity.startsAt,
    travelMinutes,
    bufferMinutes,
  });
  if (earliestArrivalMs > to.startsAtMs) {
    addIssue(issues, "known_violation", "travel_conflict", {
      fromPlaceId,
      toPlaceId,
      activityId: to.activity.id,
      relatedActivityId: fromActivityId,
    });
  }
}

function checkTransitions(
  context: PreparedInput,
  issues: ValidationIssue[],
  checkedTransitions: CheckedTransition[],
): void {
  const { state } = context.input;
  const completed = new Set(state.completedActivityIds);
  const skipped = new Set(state.skippedActivityIds);
  const future = context.candidateActivities.filter(
    (entry) =>
      !completed.has(entry.activity.id) &&
      !skipped.has(entry.activity.id) &&
      entry.activity.id !== state.currentActivityId &&
      entry.startsAtMs >= context.observedAtMs,
  );
  if (future.length === 0) return;

  // 第一段从用户实际报告的位置接起，而不是从原计划推测他应该在的地点接起。
  // 仍在进行中的活动结束未知，不能直接使用计划结束时刻充当现实事实。
  const first = future[0];
  if (state.currentActivityId !== null) {
    const current = context.candidateActivities.find((entry) => entry.activity.id === state.currentActivityId);
    addIssue(issues, "insufficient_information", "current_activity_end_unknown", {
      activityId: state.currentActivityId,
      relatedActivityId: first.activity.id,
      fromPlaceId: current?.activity.placeId,
      toPlaceId: first.activity.placeId,
    });
  } else if (state.location.kind === "unknown") {
    addIssue(issues, "insufficient_information", "unknown_location", {
      activityId: first.activity.id,
      toPlaceId: first.activity.placeId,
    });
  } else {
    checkKnownTransition(
      context,
      issues,
      checkedTransitions,
      state.location.placeId,
      first,
      context.earliestResumeAtMs,
    );
  }

  // 检查完整候选中每一对未来相邻活动，包含被修改窗口与未修改部分的交界。
  // 只校验改动内部，会漏掉删除一站后新产生的跨站衔接。
  for (let index = 1; index < future.length; index += 1) {
    const previous = future[index - 1];
    checkKnownTransition(
      context,
      issues,
      checkedTransitions,
      previous.activity.placeId,
      future[index],
      previous.endsAtMs,
      previous.activity.id,
    );
  }
}

/** 检查一份完整候选与给定基础快照是否一致；不生成候选、不调用外部工具，也不提交计划版本。 */
export function validateCandidatePlan(input: CandidateValidationInput): CandidateValidationResult {
  try {
    const prepared = prepareCandidateInput(input);
    if (!prepared.valid) {
      return { verdict: "invalid_input", issues: prepared.issues, checkedTransitions: [] };
    }
    const issues: ValidationIssue[] = [];
    const checkedTransitions: CheckedTransition[] = [];
    // 结构与基础快照合法之后再形成业务结论；不同检查累积问题，避免只报告首项而掩盖保护事项被改。
    checkBindings(prepared.value, issues);
    checkEdits(prepared.value, issues);
    checkReservations(prepared.value, issues);
    checkOverlap(prepared.value, issues);
    checkProgressAndDelay(prepared.value, issues);
    checkTransitions(prepared.value, issues, checkedTransitions);
    if (issues.some((issue) => issue.category === "invalid_input")) {
      return {
        verdict: "invalid_input",
        issues: issues.filter((issue) => issue.category === "invalid_input"),
        checkedTransitions: [],
      };
    }
    // 确定违反优先于信息不足；没有发现冲突但仍有未知，也不能声称 feasible。
    const verdict = issues.some((issue) => issue.category === "known_violation")
      ? "known_violation"
      : issues.length > 0 ? "insufficient_information" : "feasible";
    return { verdict, issues, checkedTransitions };
  } catch {
    // 直接调用纯函数也可能传入带抛错 getter 的坏 JavaScript 对象；按无效输入处理，
    // 不能把解析异常误报成业务上“排不开”，也不让异常穿透到页面。
    return {
      verdict: "invalid_input",
      issues: [{ category: "invalid_input", code: "invalid_shape", fieldPath: "input" }],
      checkedTransitions: [],
    };
  }
}
