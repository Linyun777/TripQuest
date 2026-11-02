import type {
  BaselinePlanningInput,
  BaselinePlanningResult,
} from "@tripquest/domain";
import type { Edge, Observation } from "./contracts";

export const edgeKey = ([from, to]: Edge): string => JSON.stringify([from, to]);

/** 仅支持一项未来普通活动紧接固定预约的旧版拓扑，其他形状不给模型调查权限。 */
export function accessibleEdges(input: BaselinePlanningInput): readonly Edge[] {
  const { state, plan, request } = input;
  if (state.location.kind !== "known" || state.currentActivityId !== null) return [];
  if (input.reservations.some((r) => r.confirmation.status !== "confirmed")) return [];

  const finished = new Set([...state.completedActivityIds, ...state.skippedActivityIds]);
  const remaining = plan.activities.filter((a) => !finished.has(a.id));
  if (remaining.length !== 2) return [];
  if (remaining.some((a) => Date.parse(a.startsAt) < Date.parse(state.observedAt))) return [];

  const [target, reservation] = remaining;
  const start = request.scope.kind === "selected_window"
    ? request.scope.window.startsAt
    : request.scope.from;
  const end = request.scope.kind === "selected_window"
    ? request.scope.window.endsAt
    : `${plan.date}T23:59:59+08:00`;
  if (
    target.locked ||
    target.reservationId ||
    !reservation.locked ||
    !reservation.reservationId ||
    Date.parse(target.startsAt) < Date.parse(start) ||
    Date.parse(target.endsAt) > Date.parse(end)
  ) return [];

  const candidates: Edge[] = [
    [state.location.placeId, target.placeId],
    [target.placeId, reservation.placeId],
    [state.location.placeId, reservation.placeId],
  ];
  const seen = new Set<string>();
  return candidates.filter((edge) => {
    const key = edgeKey(edge);
    if (edge[0] === edge[1] || seen.has(key)) return false;
    seen.add(key);
    return !input.travelLegs.some((leg) =>
      leg.fromPlaceId === edge[0] && leg.toPlaceId === edge[1] && leg.duration.kind === "known",
    );
  });
}

/** 只调查仍可能可行策略里尚缺的路线；硬约束已经使策略失败时继续查询没有意义。 */
export function usefulEdges(
  result: BaselinePlanningResult,
  allowed: readonly Edge[],
  observations: readonly Observation[],
): readonly Edge[] {
  if (["invalid_input", "request_not_current", "unsupported_scenario", "planner_error"].includes(result.status)) {
    return [];
  }
  if (result.status === "candidate_found" && result.selected.strategy !== "omit") return [];

  // 优先补仍可能保留活动的策略所缺的边；若已经因硬约束失败，再查路线也改变不了结论。
  // 即使 omit 已可行，也可继续为 keep / shift 调查，避免把“安全地删掉”当作质量最优。
  const requested = new Set(observations.map((o) => edgeKey(o.edge)));
  const relevant = new Set<string>();
  for (const attempt of result.attempts) {
    if (attempt.outcome !== "checked") continue;
    if (attempt.validation.issues.some((i) => i.category !== "insufficient_information")) continue;
    for (const issue of attempt.validation.issues) {
      if (issue.code === "unknown_travel_duration" && issue.fromPlaceId && issue.toPlaceId) {
        relevant.add(edgeKey([issue.fromPlaceId, issue.toPlaceId]));
      }
    }
    // 优先补可保留活动策略的证据，再考虑省略；安全性相同也要区分推荐质量。
    const choices = allowed.filter((edge) => relevant.has(edgeKey(edge)) && !requested.has(edgeKey(edge)));
    if (choices.length) return choices;
  }
  return [];
}
