import type {
  DayActivity,
  DayIssue,
  DayPlace,
  DayPlanningInput,
  DayRoute,
  DaySchedule,
  DayScheduledLeg,
  DaySchedulingResult,
  DayValidation,
} from "./day-planning-types";
import { dayRouteIssue, scheduleDay } from "./day-planning";
import { validateDayDraft } from "./day-validation";

/** 冻结活动必须保留原顺序和起止时刻，不能因局部调整而移动。 */
export interface DayFrozenActivity {
  readonly activityId: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/** 用户报告之后尚未发生的部分；时间仍按原行程当天的分钟数计，起点改为继续地点和最早继续时刻。 */
export interface DayReplanInput {
  readonly date: string;
  readonly timeZone: "Asia/Shanghai";
  readonly bufferMinutes: 5 | 10;
  readonly nowMs: number;
  readonly places: readonly DayPlace[];
  readonly resumePlaceId: string;
  readonly resumesAt: number;
  readonly endPlaceId: string;
  readonly endsAt: number;
  /** 候选池同时包含可调整活动与全部冻结活动，校验不能只看模型有权修改的部分。 */
  readonly activities: readonly DayActivity[];
  /** 窗口后的活动作为冻结尾部；调整剩余全天时没有这个尾部。 */
  readonly frozen: readonly DayFrozenActivity[];
  /** 扣除已归档身份后可容纳的未来活动数量，不能通过重规划突破整天容量。 */
  readonly capacity: number;
}

/** 把未来部分转为普通单日输入，复用排程与校验；起点和时间窗从用户报告继续。 */
export function futureDayInput(input: DayReplanInput): DayPlanningInput {
  return {
    date: input.date,
    timeZone: input.timeZone,
    window: { startsAt: input.resumesAt, endsAt: input.endsAt },
    startPlaceId: input.resumePlaceId,
    endPlaceId: input.endPlaceId,
    places: input.places,
    activities: input.activities,
    bufferMinutes: input.bufferMinutes,
    nowMs: input.nowMs,
  };
}

/**
 * 只在排程视图里把冻结普通站临时当固定时段，提前到达应等待而非提前开逛。
 * 原始业务角色不变，这不是把普通活动改成真正预约。
 */
function pinnedDayInput(input: DayReplanInput): DayPlanningInput {
  const frozen = new Map(input.frozen.map((item) => [item.activityId, item]));
  return {
    ...futureDayInput(input),
    activities: input.activities.map((activity) => {
      const slot = frozen.get(activity.activityId);
      return slot && activity.role !== "fixed"
        ? { ...activity, role: "fixed", fixed: { startsAt: slot.startsAt, endsAt: slot.endsAt } }
        : activity;
    }),
  };
}

/** 普通冻结站迟到归类为越过修改范围；不能误报成外部预约事实被修改。 */
function frozenLateness(input: DayReplanInput, issues: readonly DayIssue[]): DayIssue[] {
  return issues.map((issue) => {
    const pinned = issue.code === "day_fixed_late" &&
      input.frozen.some((item) => item.activityId === issue.activityId) &&
      input.activities.find((item) => item.activityId === issue.activityId)?.role !== "fixed";
    return pinned ? { ...issue, code: "day_frozen_changed" } : issue;
  });
}

/** 即使未来活动序列为空，也不能把池里仍要求保留的必去/固定站丢掉。 */
function missingProtected(input: DayReplanInput): DayIssue[] {
  return input.activities
    .filter((activity) => activity.role === "required" || activity.role === "fixed")
    .map((activity) => ({
      code: "day_missing_protected" as const,
      kind: "violation" as const,
      activityId: activity.activityId,
    }));
}

/** 先检查模型是否越权排列冻结活动以及未来容量，再由完整顺序校验处理业务约束。 */
export function inspectReplanOrder(
  input: DayReplanInput,
  adjustableOrder: readonly string[],
): DayIssue[] {
  const issues: DayIssue[] = [];
  const frozen = new Set(input.frozen.map((item) => item.activityId));
  for (const activityId of adjustableOrder) {
    if (frozen.has(activityId)) {
      issues.push({ code: "day_frozen_changed", kind: "violation", activityId });
    }
  }
  if (
    !Number.isSafeInteger(input.capacity) || input.capacity < 0 ||
    adjustableOrder.length + input.frozen.length > input.capacity
  ) {
    issues.push({ code: "day_activity_count", kind: "violation" });
  }
  return issues;
}

/** 按可调整序列加冻结尾部试排，尾部固定原时刻，并检查进出修改窗口的交通衔接。 */
export function scheduleReplan(
  input: DayReplanInput,
  adjustableOrder: readonly string[],
  routes: readonly DayRoute[],
): DaySchedulingResult {
  const preflight = inspectReplanOrder(input, adjustableOrder);
  if (preflight.length) return { status: "not_scheduled", issues: preflight };
  // 窗口外的未来活动作为冻结尾部接回完整时间线；排可调整部分时也必须算到这些站，
  // 因而不能通过延后窗口内活动，悄悄挤占后面已承诺的时段。
  const order = [...adjustableOrder, ...input.frozen.map((item) => item.activityId)];
  if (!order.length) {
    const missing = missingProtected(input);
    if (missing.length) return { status: "not_scheduled", issues: missing };
  }
  const day = pinnedDayInput(input);
  const scheduled = order.length
    ? scheduleDay(day, order, routes)
    : scheduleDirect(day, routes);
  if (scheduled.status !== "scheduled") {
    return { status: "not_scheduled", issues: frozenLateness(input, scheduled.issues) };
  }
  const moved = frozenIssues(input, scheduled.schedule);
  return moved.length ? { status: "not_scheduled", issues: moved } : scheduled;
}

/** 重新验证未来时间线，不采信 scheduleReplan 的结论；空未来与普通未来分别复核。 */
export function validateReplan(
  input: DayReplanInput,
  schedule: DaySchedule,
  routes: readonly DayRoute[],
): DayValidation {
  const order = schedule.activities.map((item) => item.activityId);
  const adjustable = order.slice(0, Math.max(0, order.length - input.frozen.length));
  const issues = [
    ...inspectReplanOrder(input, adjustable),
    ...frozenIssues(input, schedule),
  ];
  const day = pinnedDayInput(input);
  const checked = order.length
    ? validateDayDraft(day, schedule, routes)
    : validateDirect(day, schedule, routes);
  if (!order.length) issues.push(...missingProtected(input));
  issues.push(...frozenLateness(input, checked.issues));
  return {
    verdict: issues.some((issue) => issue.kind === "violation") ? "rejected"
      : issues.length ? "pending" : "checked",
    issues,
  };
}

/** 冻结活动必须出现在最终序列尾部，且身份、顺序和时刻逐项一致，不能仅检查“还在列表里”。 */
function frozenIssues(input: DayReplanInput, schedule: DaySchedule): DayIssue[] {
  // 比较完整尾部而非只比冻结 ID 集合；换顺序、挪时刻或插入额外站都会破坏范围保护。
  const tail = schedule.activities.slice(schedule.activities.length - input.frozen.length);
  if (tail.length !== input.frozen.length) {
    return [{ code: "day_frozen_changed", kind: "violation" }];
  }
  return input.frozen.flatMap((frozen, index) => {
    const item = tail[index];
    return item.activityId === frozen.activityId &&
      item.startsAt === frozen.startsAt &&
      item.endsAt === frozen.endsAt
      ? []
      : [{
          code: "day_frozen_changed" as const,
          kind: "violation" as const,
          activityId: frozen.activityId,
          expected: frozen.startsAt,
          actual: item?.startsAt,
        }];
  });
}

/**
 * 没有未来活动仍需要一条从继续地点到终点的合法路线。
 * 独立处理空序列，保留新建一日规划必须至少一站的规则，不为调整场景放宽全局约束。
 */
function scheduleDirect(
  input: DayPlanningInput,
  routes: readonly DayRoute[],
): DaySchedulingResult {
  const leg = directLeg(input, routes);
  if ("issue" in leg) return { status: "not_scheduled", issues: [leg.issue] };
  if (leg.arrivesAt > input.window.endsAt) {
    return { status: "not_scheduled", issues: [{
      code: "day_window_exceeded", kind: "violation",
      expected: input.window.endsAt, actual: leg.arrivesAt,
    }] };
  }
  return {
    status: "scheduled",
    schedule: {
      activities: [],
      legs: [leg],
      endArrival: leg.arrivesAt,
      totalWalkingMinutes: leg.travelMinutes,
      longestWalkingMinutes: leg.travelMinutes,
    },
  };
}

function validateDirect(
  input: DayPlanningInput,
  schedule: DaySchedule,
  routes: readonly DayRoute[],
): DayValidation {
  const leg = directLeg(input, routes);
  if ("issue" in leg) return { verdict: "rejected", issues: [leg.issue] };
  const issues: DayIssue[] = [];
  const [actual] = schedule.legs;
  if (
    schedule.activities.length !== 0 || schedule.legs.length !== 1 ||
    actual.fromPlaceId !== leg.fromPlaceId || actual.toPlaceId !== leg.toPlaceId ||
    actual.departsAt !== leg.departsAt || actual.arrivesAt !== leg.arrivesAt ||
    actual.travelMinutes !== leg.travelMinutes || actual.bufferMinutes !== leg.bufferMinutes ||
    actual.distanceMeters !== leg.distanceMeters || actual.source !== leg.source ||
    schedule.endArrival !== leg.arrivesAt ||
    schedule.totalWalkingMinutes !== leg.travelMinutes ||
    schedule.longestWalkingMinutes !== leg.travelMinutes
  ) {
    issues.push({ code: "day_schedule_mismatch", kind: "violation" });
  }
  if (leg.arrivesAt > input.window.endsAt) {
    issues.push({
      code: "day_window_exceeded", kind: "violation",
      expected: input.window.endsAt, actual: leg.arrivesAt,
    });
  }
  return { verdict: issues.length ? "rejected" : "checked", issues };
}

function directLeg(
  input: DayPlanningInput,
  routes: readonly DayRoute[],
): DayScheduledLeg | { issue: DayIssue } {
  const place = (id: string) => input.places.find((item) => item.placeId === id);
  const from = place(input.startPlaceId);
  const to = place(input.endPlaceId);
  if (
    !from || !to || !Number.isSafeInteger(input.window.startsAt) ||
    input.window.startsAt < 0 || input.window.startsAt >= input.window.endsAt ||
    input.window.endsAt >= 1440
  ) {
    return { issue: { code: "day_invalid_input", kind: "violation" } };
  }
  // 直接去终点也遵守唯一有向路线和证据规则；零活动不等于零路程，更不等于无需检查。
  const matching = routes.filter((route) =>
    route.fromPlaceId === from.placeId && route.toPlaceId === to.placeId);
  const route = matching.length === 1 ? matching[0] : undefined;
  const issue = dayRouteIssue(input, from, to, route);
  if (issue) return { issue };
  const known = route!;
  const travelMinutes = known.status === "known" ? Math.ceil(known.durationSeconds / 60) : 0;
  const bufferMinutes = known.status === "same_place_assumption" ? 0 : input.bufferMinutes;
  return {
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    departsAt: input.window.startsAt,
    arrivesAt: input.window.startsAt + travelMinutes + bufferMinutes,
    travelMinutes,
    bufferMinutes,
    distanceMeters: known.status === "known" ? known.distanceMeters : 0,
    source: known.status === "same_place_assumption" ? "same_place_assumption" : "route_estimate",
  };
}
