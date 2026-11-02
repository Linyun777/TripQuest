import type { CandidatePlan, PlannedActivity } from "./model";
import type { CandidateValidationResult, ValidationIssue } from "./candidate-validation-types";
import type {
  BaselineAttempt,
  BaselinePlanningInput,
  BaselinePlanningResult,
  BaselineStatus,
  BaselineStrategy,
} from "./baseline-planning-types";
import {
  formatChinaDateTime,
  prepareCandidateInput,
  type PreparedInput,
  type TimedActivity,
} from "./candidate-validation-input";
import { validateCandidatePlan } from "./candidate-validation";

/** 只排序对象键以稳定快照身份；数组顺序属于业务内容，仍保持原样。 */
function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item,
  );
  if (json === undefined) throw new TypeError("snapshot is not JSON serializable");
  return json;
}

/** 同步 FNV-1a 只生成候选标签，不是抗篡改签名；正式确认另用语义指纹与服务端签名。 */
function snapshotFingerprint(value: unknown): string {
  const json = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < json.length; index += 1) {
    const unit = json.charCodeAt(index);
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit & 0xff)) * 0x100000001b3n);
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit >>> 8)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function candidateFor(
  input: BaselinePlanningInput,
  strategy: BaselineStrategy,
  activities: readonly PlannedActivity[],
): CandidatePlan {
  const { plan, state, request } = input;
  // 即使尝试 keep 也必须有请求身份，不能给未绑定请求的候选生成可复用标签。
  if (request?.id == null) throw new TypeError("request.id is required");
  // 坏数组留给校验器返回精确 invalid_shape；合法活动是扁平记录，逐项复制保证各候选互不共享可变对象。
  const ownedActivities = Array.isArray(activities)
    ? activities.map((activity) =>
        activity !== null && typeof activity === "object" && !Array.isArray(activity)
          ? { ...activity }
          : activity,
      )
    : activities;
  return {
    id: `baseline-v1/${strategy}/${snapshotFingerprint({
      plan,
      state,
      request,
      reservations: input.reservations,
      travelLegs: input.travelLegs,
      transferBufferMinutes: input.transferBufferMinutes,
      strategy,
      activities: ownedActivities,
    })}`,
    journeyId: plan.journeyId,
    basePlanVersion: plan.version,
    baseStateVersion: state.version,
    activities: ownedActivities,
  };
}

function checkedIssues(attempts: readonly BaselineAttempt[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.outcome !== "checked") continue;
    for (const issue of attempt.validation.issues) {
      const key = JSON.stringify(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  return issues;
}

function finished(
  status: Exclude<BaselineStatus, "candidate_found">,
  attempts: BaselineAttempt[],
  extraIssues: readonly ValidationIssue[] = [],
): BaselinePlanningResult {
  return { status, attempts, issues: [...checkedIssues(attempts), ...extraIssues] };
}

function selected(
  strategy: BaselineStrategy,
  candidate: CandidatePlan,
  validation: CandidateValidationResult,
  attempts: BaselineAttempt[],
): BaselinePlanningResult {
  return {
    status: "candidate_found",
    selected: { strategy, candidate, validation },
    attempts,
    issues: checkedIssues(attempts),
  };
}

function checkCandidate(
  input: BaselinePlanningInput,
  strategy: BaselineStrategy,
  activities: readonly PlannedActivity[],
  attempts: BaselineAttempt[],
): { candidate: CandidatePlan; validation: CandidateValidationResult } {
  const candidate = candidateFor(input, strategy, activities);
  const validation = validateCandidatePlan({ ...input, candidate });
  attempts.push({ strategy, outcome: "checked", candidate, validation });
  return { candidate, validation };
}

function editableActivities(context: PreparedInput): readonly TimedActivity[] {
  const { state } = context.input;
  const completed = new Set(state.completedActivityIds);
  const skipped = new Set(state.skippedActivityIds);
  return context.planActivities.filter(({ activity, startsAtMs, endsAtMs }) =>
    startsAtMs >= context.observedAtMs &&
    startsAtMs >= context.scopeStartMs &&
    endsAtMs <= context.scopeEndMs &&
    !completed.has(activity.id) &&
    !skipped.has(activity.id) &&
    activity.id !== state.currentActivityId &&
    !activity.locked &&
    activity.reservationId === undefined,
  );
}

/** 只为构造顺延候选提供已知最早到达下界；最终能否到达仍由完整校验决定。 */
function arrivalFromPrevious(context: PreparedInput, target: TimedActivity): number | null {
  const { state, travelLegs, transferBufferMinutes } = context.input;
  const completed = new Set(state.completedActivityIds);
  const skipped = new Set(state.skippedActivityIds);
  const index = context.planActivities.findIndex(({ activity }) => activity.id === target.activity.id);
  const previous = context.planActivities.slice(0, index).reverse().find(({ activity }) =>
    !completed.has(activity.id) && !skipped.has(activity.id),
  );

  // 进行中或未报告的前站没有可信实际结束时刻，不能把原计划结束当成已发生事实。
  if (previous && (previous.activity.id === state.currentActivityId || previous.startsAtMs < context.observedAtMs)) {
    return null;
  }
  if (!previous && state.location.kind === "unknown") return null;

  const placeId = previous ? previous.activity.placeId : state.location.kind === "known" ? state.location.placeId : null;
  const departsAtMs = previous ? previous.endsAtMs : context.earliestResumeAtMs;
  if (placeId === null) return null;
  if (placeId === target.activity.placeId) return departsAtMs;

  const leg = travelLegs.find(({ fromPlaceId, toPlaceId }) =>
    fromPlaceId === placeId && toPlaceId === target.activity.placeId,
  );
  if (leg?.duration.kind !== "known") return null;
  const arrivalAtMs = departsAtMs + (leg.duration.minutes + transferBufferMinutes) * 60_000;
  return Number.isSafeInteger(arrivalAtMs) ? arrivalAtMs : null;
}

function conclusion(attempts: BaselineAttempt[]): BaselinePlanningResult {
  const hasUnknown = attempts.some((attempt) =>
    attempt.outcome === "checked" && attempt.validation.verdict === "insufficient_information",
  );
  return finished(hasUnknown ? "needs_information" : "no_feasible_candidate", attempts);
}

/**
 * 最多对一项现有活动提出顺延或移除，保持原有顺序并逐个交公开校验器。
 * 候选构造不等于确认保存，查不到交通时也不会在这里补造时长。
 */
export function generateBaselineCandidate(input: BaselinePlanningInput): BaselinePlanningResult {
  const attempts: BaselineAttempt[] = [];
  try {
    // 先检查原计划：能保留就不改。顺延、移除只是有限候选，必须和原计划走同一套校验。
    const keep = checkCandidate(input, "keep", input.plan.activities, attempts);
    if (keep.validation.verdict === "invalid_input") return finished("invalid_input", attempts);
    if (keep.validation.issues.some(({ code }) => code === "stale_base" || code === "journey_mismatch")) {
      return finished("request_not_current", attempts);
    }
    if (keep.validation.verdict === "feasible") {
      return selected("keep", keep.candidate, keep.validation, attempts);
    }

    const preparation = prepareCandidateInput({ ...input, candidate: keep.candidate });
    if (!preparation.valid) return finished("planner_error", attempts, preparation.issues);
    const context = preparation.value;
    const editable = editableActivities(context);
    // 这条早期基线只处理一项可编辑活动；超出能力返回不支持，不把有限搜索失败说成全局无解。
    if (editable.length > 1) {
      attempts.push({ strategy: "shift", outcome: "not_constructed", reasonCode: "multiple_editable_activities" });
      return finished("unsupported_scenario", attempts);
    }
    if (editable.length === 0) return conclusion(attempts);

    const target = editable[0];
    // 顺延起点取原开始、最早继续、前站最早可达的最大值；只延后不缩短停留，避免用压缩游玩时间偷过约束。
    const arrivalAtMs = arrivalFromPrevious(context, target);
    const startsAtMs = Math.max(target.startsAtMs, context.earliestResumeAtMs, arrivalAtMs ?? -Infinity);
    const endsAtMs = startsAtMs + (target.endsAtMs - target.startsAtMs);
    const targetIndex = context.planActivities.findIndex(({ activity }) => activity.id === target.activity.id);
    const next = context.planActivities[targetIndex + 1];

    if (startsAtMs === target.startsAtMs) {
      attempts.push({ strategy: "shift", outcome: "not_constructed", reasonCode: "duplicate" });
    } else if (startsAtMs < context.scopeStartMs || endsAtMs > context.scopeEndMs) {
      attempts.push({ strategy: "shift", outcome: "not_constructed", reasonCode: "outside_scope" });
    } else if (next && endsAtMs > next.startsAtMs) {
      attempts.push({ strategy: "shift", outcome: "not_constructed", reasonCode: "would_reorder" });
    } else {
      const activities = input.plan.activities.map((activity) =>
        activity.id === target.activity.id
          ? { ...activity, startsAt: formatChinaDateTime(startsAtMs), endsAt: formatChinaDateTime(endsAtMs) }
          : activity,
      );
      const shift = checkCandidate(input, "shift", activities, attempts);
      if (shift.validation.verdict === "invalid_input") return finished("planner_error", attempts);
      if (shift.validation.verdict === "feasible") {
        return selected("shift", shift.candidate, shift.validation, attempts);
      }
    }

    // 高优先级即使不是锁定预约也不自动删除；普通站的删除候选仍要复核新产生的前后衔接。
    if (target.activity.priority === "high") {
      attempts.push({ strategy: "omit", outcome: "not_constructed", reasonCode: "omit_not_allowed" });
    } else {
      const activities = input.plan.activities.filter((activity) => activity.id !== target.activity.id);
      const omit = checkCandidate(input, "omit", activities, attempts);
      if (omit.validation.verdict === "invalid_input") return finished("planner_error", attempts);
      if (omit.validation.verdict === "feasible") {
        return selected("omit", omit.candidate, omit.validation, attempts);
      }
    }
    return conclusion(attempts);
  } catch {
    return finished("invalid_input", attempts, [
      { category: "invalid_input", code: "invalid_shape", fieldPath: "input" },
    ]);
  }
}
