import type {
  DayActivity,
  DayIssue,
  DayPlace,
  DayPlanningInput,
  DayRoute,
  DayScheduledActivity,
  DayScheduledLeg,
  DaySchedulingResult,
} from "./day-planning-types";

export function dayMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function dayTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 同地假设必须同时满足来源、外部身份与快照一致；同名地点或坐标改变都不能直接归零路程。 */
export function sameDayPlace(a: DayPlace, b: DayPlace): boolean {
  return a.provider === b.provider && a.externalId === b.externalId && a.snapshot === b.snapshot;
}

/** 先检查顺序、成员和硬约束，已知会被拒绝的组合不必再花路线 API 额度。 */
export function inspectDayOrder(
  input: DayPlanningInput,
  order: readonly string[],
): DayIssue[] {
  const issues: DayIssue[] = [];
  const minute = (n: number) => Number.isSafeInteger(n) && n >= 0 && n < 1440;
  const dateMs = Date.parse(`${input.date}T00:00:00Z`);
  // Date.parse 会归一化部分无效日历日期，因此还要格式回写比对，防止“2 月 30 日”被悄悄改成三月。
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(input.date) && Number.isFinite(dateMs) &&
    !input.date.startsWith("0000") &&
    new Date(dateMs).toISOString().slice(0, 10) === input.date;
  const placeIds = new Set(input.places.map((p) => p.placeId));
  if (
    !validDate || input.timeZone !== "Asia/Shanghai" ||
    !minute(input.window.startsAt) || !minute(input.window.endsAt) ||
    input.window.startsAt >= input.window.endsAt ||
    ![5, 10].includes(input.bufferMinutes) || !Number.isFinite(input.nowMs) ||
    placeIds.size !== input.places.length ||
    !placeIds.has(input.startPlaceId) || !placeIds.has(input.endPlaceId) ||
    new Set(input.activities.map((a) => a.activityId)).size !== input.activities.length ||
    input.activities.some((a) =>
      !placeIds.has(a.placeId) || !Number.isSafeInteger(a.stayMinutes) ||
      a.stayMinutes <= 0 ||
      (a.role === "fixed" && (!a.fixed || !minute(a.fixed.startsAt) ||
        !minute(a.fixed.endsAt) || a.fixed.endsAt - a.fixed.startsAt !== a.stayMinutes)) ||
      (a.role !== "fixed" && a.fixed !== undefined) ||
      (a.opening.status === "known" && a.opening.windows.some((w) =>
        !minute(w.startsAt) || !minute(w.endsAt) || w.startsAt >= w.endsAt)) ||
      (a.within !== undefined && (!minute(a.within.startsAt) || !minute(a.within.endsAt) ||
        a.within.startsAt >= a.within.endsAt)),
    )
  ) {
    return [{ code: "day_invalid_input", kind: "violation" }];
  }
  if (order.length < 1 || order.length > 6) {
    issues.push({ code: "day_activity_count", kind: "violation" });
  }
  // 未知活动、重复停留与预约时序先在本地排除；活动池中的 required/fixed 最后再核对是否完整保留。
  const seen = new Set<string>();
  let fixedEnd = -1;
  for (const activityId of order) {
    const activity = input.activities.find((a) => a.activityId === activityId);
    if (!activity) {
      issues.push({ code: "day_unknown_activity", kind: "violation", activityId });
    }
    if (seen.has(activityId)) {
      issues.push({ code: "day_duplicate_activity", kind: "violation", activityId });
    }
    seen.add(activityId);
    if (activity?.fixed) {
      if (activity.fixed.startsAt < fixedEnd) {
        issues.push({ code: "day_fixed_order", kind: "violation", activityId });
      }
      fixedEnd = activity.fixed.endsAt;
    }
  }
  for (const a of input.activities) {
    if ((a.role === "required" || a.role === "fixed") && !seen.has(a.activityId)) {
      issues.push({ code: "day_missing_protected", kind: "violation", activityId: a.activityId });
    }
  }
  return issues;
}

/** 检查一条有向边的证据；缺失/unknown 是信息不足，过期或来源错配是已有证据不能使用。 */
export function dayRouteIssue(
  input: DayPlanningInput,
  from: DayPlace,
  to: DayPlace,
  route: DayRoute | undefined,
): DayIssue | undefined {
  const edge = { fromPlaceId: from.placeId, toPlaceId: to.placeId };
  if (!route || route.status === "unknown") {
    return { ...edge, code: "day_route_unknown", kind: "unknown" };
  }
  if (route.status === "same_place_assumption") {
    return sameDayPlace(from, to)
      ? undefined
      : { ...edge, code: "day_same_place_invalid", kind: "violation" };
  }
  // 五分钟新鲜度与非未来时间戳一起检查；同一数值如果没有本轮合法来源，也不能给排程背书。
  const retrieved = Date.parse(route.retrievedAt);
  if (
    route.provider !== from.provider || route.provider !== to.provider ||
    !Number.isFinite(retrieved) || retrieved > input.nowMs || input.nowMs - retrieved > 300_000 ||
    !Number.isSafeInteger(route.durationSeconds) || route.durationSeconds < 0 ||
    !Number.isSafeInteger(route.distanceMeters) || route.distanceMeters < 0 ||
    (route.sourceKind !== "fixture" && route.sourceKind !== "live")
  ) {
    return { ...edge, code: "day_route_evidence", kind: "violation" };
  }
  return undefined;
}

/** 在给定顺序下寻找最早可容纳完整停留的营业窗口；固定事项使用原时刻，不被提前或顺延。 */
function activityStart(activity: DayActivity, reached: number, date: string): number | null {
  if (activity.fixed) return activity.fixed.startsAt;
  // 兴趣时段的开始是下界；提前到达也要等待，不能为了排得下把晚间兴趣挪到下午。
  const arrival = Math.max(reached, activity.within?.startsAt ?? reached);
  const opening = activity.opening;
  if (opening.status === "unknown" || opening.date !== date) return arrival;
  if (opening.status === "closed") return null;
  const windows = [...opening.windows].sort((a, b) => a.startsAt - b.startsAt);
  // 不是“到达时开门”就够：开始时刻不能晚于最晚入场，整个停留还必须在某一个营业区间内完成。
  for (const window of windows) {
    const start = Math.max(arrival, window.startsAt);
    if (start + activity.stayMinutes <= window.endsAt &&
      (opening.latestEntry === undefined || start <= opening.latestEntry)) return start;
  }
  return null;
}

/**
 * 给定活动顺序和有向路线事实，从当天起始分钟依次排入交通、缓冲、等待与停留。
 * 这里不搜索最优顺序，也不补造未知路线；固定事项保持原时刻，赶不上就返回明确问题。
 */
export function scheduleDay(
  input: DayPlanningInput,
  orderedActivityIds: readonly string[],
  routes: readonly DayRoute[],
): DaySchedulingResult {
  const invalid = inspectDayOrder(input, orderedActivityIds);
  if (invalid.length) return { status: "not_scheduled", issues: invalid };
  const activities: DayScheduledActivity[] = [];
  const legs: DayScheduledLeg[] = [];
  let cursor = input.window.startsAt;
  let previous = input.startPlaceId;
  const selected = orderedActivityIds.map((id) => input.activities.find((a) => a.activityId === id)!);
  // 末尾的 null 代表去终点的最后一段路，使返程同样受时间窗和路线证据约束。
  for (const activity of [...selected, null]) {
    const destination = activity?.placeId ?? input.endPlaceId;
    const from = input.places.find((p) => p.placeId === previous)!;
    const to = input.places.find((p) => p.placeId === destination)!;
    const route = routes.find((r) => r.fromPlaceId === previous && r.toPlaceId === destination);
    const issue = dayRouteIssue(input, from, to, route);
    if (issue) return { status: "not_scheduled", issues: [issue] };
    const known = route!;
    // 路线秒数向上取整成分钟，防止每段向下取整累计成迟到；跨地点再加产品设定的缓冲。
    const travelMinutes = known.status === "known" ? Math.ceil(known.durationSeconds / 60) : 0;
    const bufferMinutes = known.status === "same_place_assumption" ? 0 : input.bufferMinutes;
    const arrival = cursor + travelMinutes + bufferMinutes;
    legs.push({
      fromPlaceId: previous,
      toPlaceId: destination,
      departsAt: cursor,
      arrivesAt: arrival,
      travelMinutes,
      bufferMinutes,
      distanceMeters: known.status === "known" ? known.distanceMeters : 0,
      source: known.status === "same_place_assumption" ? "same_place_assumption" : "route_estimate",
    });
    if (!activity) {
      cursor = arrival;
      break;
    }
    const start = activityStart(activity, arrival, input.date);
    if (start === null) {
      return { status: "not_scheduled", issues: [{
        code: "day_opening_conflict", kind: "violation", activityId: activity.activityId,
      }] };
    }
    if (activity.within && start + activity.stayMinutes > activity.within.endsAt) {
      return { status: "not_scheduled", issues: [{
        code: "day_time_of_day", kind: "violation", activityId: activity.activityId,
        expected: activity.within.endsAt, actual: start + activity.stayMinutes,
      }] };
    }
    // 预约开始时刻不能移动；哪怕只晚一分钟，也返回冲突而不是把预约顺延到可到达时间。
    if (activity.fixed && arrival > start) {
      return { status: "not_scheduled", issues: [{
        code: "day_fixed_late", kind: "violation", activityId: activity.activityId,
        expected: start, actual: arrival,
      }] };
    }
    activities.push({
      activityId: activity.activityId,
      placeId: activity.placeId,
      arrivesAt: arrival,
      startsAt: start,
      endsAt: start + activity.stayMinutes,
      waitMinutes: start - arrival,
    });
    cursor = start + activity.stayMinutes;
    previous = destination;
  }
  // 最后 cursor 已包含去终点的交通，不能只检查最后一个活动结束就宣称整天排得下。
  if (cursor > input.window.endsAt) {
    return { status: "not_scheduled", issues: [{
      code: "day_window_exceeded", kind: "violation",
      expected: input.window.endsAt, actual: cursor,
    }] };
  }
  // 将到站前的等待转移到上一处：例如晚间第一站不必下午就出门，在家晚些出发即可。
  // 只平移这段出发/到达并清零等待，活动时段不动，后续站和最终到达时刻也不变。
  if (input.leaveLate) {
    activities.forEach((activity, index) => {
      if (activity.waitMinutes <= 0) return;
      const leg = legs[index];
      legs[index] = { ...leg, departsAt: leg.departsAt + activity.waitMinutes, arrivesAt: leg.arrivesAt + activity.waitMinutes };
      activities[index] = { ...activity, arrivesAt: activity.startsAt, waitMinutes: 0 };
    });
  }
  return {
    status: "scheduled",
    schedule: {
      activities,
      legs,
      endArrival: cursor,
      totalWalkingMinutes: legs.reduce((sum, leg) => sum + leg.travelMinutes, 0),
      longestWalkingMinutes: Math.max(...legs.map((leg) => leg.travelMinutes)),
    },
  };
}
