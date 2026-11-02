import type {
  DayIssue,
  DayPlanningInput,
  DayRoute,
  DaySchedule,
  DayValidation,
} from "./day-planning-types";
import { dayRouteIssue, inspectDayOrder } from "./day-planning";

/** 从冻结输入与路线事实重新推导时间线，不调用 scheduleDay，也不信任排程器自己的成功标记。 */
export function validateDayDraft(
  input: DayPlanningInput,
  schedule: DaySchedule,
  routes: readonly DayRoute[],
): DayValidation {
  const issues: DayIssue[] = inspectDayOrder(input, schedule.activities.map((a) => a.activityId));
  const mismatch = (activityId?: string) => {
    issues.push({ code: "day_schedule_mismatch", kind: "violation", ...(activityId ? { activityId } : {}) });
  };
  // 先检查成员、保护事项和段数，后面才能安全地一一对应活动与入站路线；结构错就直接拒绝。
  if (issues.length || schedule.legs.length !== schedule.activities.length + 1) {
    if (!issues.length) mismatch();
    return { verdict: "rejected", issues };
  }
  let cursor = input.window.startsAt;
  let previous = input.startPlaceId;
  let totalWalking = 0;
  let longestWalking = 0;
  for (let i = 0; i < schedule.legs.length; i += 1) {
    const item = schedule.activities[i];
    const activity = item && input.activities.find((a) => a.activityId === item.activityId)!;
    const destination = activity?.placeId ?? input.endPlaceId;
    const leg = schedule.legs[i];
    // leaveLate 允许在上一站结束后多停留再出发，但不允许比上一站结束更早出发。
    // 独立校验必须理解这种空闲时间，否则会把合法晚出门方案误判成时间线断裂。
    if (input.leaveLate && Number.isSafeInteger(leg.departsAt) && leg.departsAt >= cursor) {
      cursor = leg.departsAt;
    }
    const from = input.places.find((p) => p.placeId === previous)!;
    const to = input.places.find((p) => p.placeId === destination)!;
    // 每个方向只能有一条已选路线，重复事实也拒绝；不能由校验器随意挑一个更有利的时长。
    const matching = routes.filter((r) => r.fromPlaceId === previous && r.toPlaceId === destination);
    if (matching.length !== 1) mismatch(activity?.activityId);
    const route = matching[0];
    const issue = dayRouteIssue(input, from, to, route);
    if (issue) issues.push(issue);
    if (!route || route.status === "unknown") {
      return { verdict: "rejected", issues };
    }
    const minutes = route.status === "known" ? Math.ceil(route.durationSeconds / 60) : 0;
    const buffer = route.status === "same_place_assumption" ? 0 : input.bufferMinutes;
    const arrival = cursor + minutes + buffer;
    // 到达时刻从上一结束时刻、路线秒数向上取整与缓冲重新计算，再逐字段比对候选声明。
    // 即使 startsAt/endsAt 看起来合理，伪造 arrivals 或展示用距离也会被发现。
    if (
      leg.fromPlaceId !== previous || leg.toPlaceId !== destination ||
      leg.departsAt !== cursor || leg.arrivesAt !== arrival ||
      leg.travelMinutes !== minutes || leg.bufferMinutes !== buffer ||
      leg.distanceMeters !== (route.status === "known" ? route.distanceMeters : 0) ||
      leg.source !== (route.status === "known" ? "route_estimate" : "same_place_assumption")
    ) mismatch(activity?.activityId);
    totalWalking += minutes;
    longestWalking = Math.max(longestWalking, minutes);
    if (activity) {
      if (
        item.placeId !== activity.placeId || item.arrivesAt !== arrival ||
        !Number.isSafeInteger(item.startsAt) || !Number.isSafeInteger(item.endsAt) ||
        item.startsAt < arrival || item.endsAt - item.startsAt !== activity.stayMinutes ||
        item.waitMinutes !== item.startsAt - arrival ||
        item.startsAt < input.window.startsAt || item.endsAt > input.window.endsAt
      ) mismatch(activity.activityId);
      if (activity.fixed && (item.startsAt !== activity.fixed.startsAt || item.endsAt !== activity.fixed.endsAt)) {
        mismatch(activity.activityId);
      }
      if (activity.within && (item.startsAt < activity.within.startsAt || item.endsAt > activity.within.endsAt)) {
        issues.push({ code: "day_time_of_day", kind: "violation", activityId: activity.activityId });
      }
      // 营业未知只产生待核实问题，明确关闭或停留越界才是违反；票务也保留独立的未知状态。
      const opening = activity.opening;
      if (opening.status === "unknown" || opening.date !== input.date) {
        issues.push({ code: "day_opening_unknown", kind: "unknown", activityId: activity.activityId });
      } else if (opening.status === "closed" ||
        !opening.windows.some((w) => item.startsAt >= w.startsAt && item.endsAt <= w.endsAt) ||
        (opening.latestEntry !== undefined && item.startsAt > opening.latestEntry)) {
        issues.push({ code: "day_opening_conflict", kind: "violation", activityId: activity.activityId });
      }
      if (activity.tickets === "unknown") {
        issues.push({ code: "day_tickets_unknown", kind: "unknown", activityId: activity.activityId });
      }
      cursor = item.endsAt;
      previous = activity.placeId;
    } else cursor = arrival;
  }
  if (cursor > input.window.endsAt) {
    issues.push({ code: "day_window_exceeded", kind: "violation", expected: input.window.endsAt, actual: cursor });
  }
  // 汇总值也重算，防止活动逐项合法但总行程时长或最终到达摘要与实际路线不一致。
  if (schedule.endArrival !== cursor || schedule.totalWalkingMinutes !== totalWalking ||
    schedule.longestWalkingMinutes !== longestWalking) mismatch();
  // 营业、票务未知可作为待核实草稿展示；已知违反必须拒绝。
  // 路线未知已在前面提前拒绝，因为没有交通时长就不能给出可信的完整时间线。
  return {
    verdict: issues.some((issue) => issue.kind === "violation") ? "rejected"
      : issues.length ? "pending" : "checked",
    issues,
  };
}
