import type { BaselinePlanningInput, TravelLegInput } from "@tripquest/domain";
import { selectedRouteToTravelLeg } from "@tripquest/providers";
import type { Planner } from "./contracts";
import { edgeKey } from "./route-tool";

/** Conservative topology recognition, not a new planning algorithm. */
export function missingRouteEdges(input: BaselinePlanningInput): readonly (readonly [string, string])[] {
  const { state, request, plan } = input;
  if (state.location.kind !== "known" || state.currentActivityId !== null) return [];
  if (input.reservations.some((r) => r.confirmation.status !== "confirmed")) return [];
  const finished = new Set([...state.completedActivityIds, ...state.skippedActivityIds]);
  const remaining = plan.activities.filter((a) => !finished.has(a.id));
  if (remaining.some((a) => Date.parse(a.startsAt) < Date.parse(state.observedAt))) return [];
  if (remaining.length !== 2) return [];
  const [target, reservation] = remaining;
  const start = request.scope.kind === "selected_window" ? request.scope.window.startsAt : request.scope.from;
  const end = request.scope.kind === "selected_window" ? request.scope.window.endsAt : `${plan.date}T23:59:59+08:00`;
  if (target.locked || target.reservationId || !reservation.locked || !reservation.reservationId
    || Date.parse(target.startsAt) < Date.parse(start) || Date.parse(target.endsAt) > Date.parse(end)) return [];
  const seen = new Set<string>();
  return ([
    [state.location.placeId, target.placeId], [target.placeId, reservation.placeId], [state.location.placeId, reservation.placeId],
  ] as const).filter(([from, to]) => {
    const key = edgeKey(from, to);
    if (from === to || seen.has(key)) return false;
    seen.add(key);
    return !input.travelLegs.some((leg) => leg.fromPlaceId === from && leg.toPlaceId === to && leg.duration.kind === "known");
  });
}
export const rulesOnly: Planner = {
  id: "rules_only", version: "1",
  async run({ input, plan }) { return { result: plan(input), travelLegs: structuredClone(input.travelLegs) }; },
};
export const fixedWorkflow: Planner = {
  id: "fixed_workflow", version: "1",
  async run({ input, plan, lookupRoute, budget }) {
    const initial = plan(input);
    if (initial.status !== "needs_information" && initial.status !== "no_feasible_candidate") return { result: initial, travelLegs: input.travelLegs };
    const edges = missingRouteEdges(input);
    if (!edges.length) return { result: initial, travelLegs: input.travelLegs };
    let travelLegs: readonly TravelLegInput[] = structuredClone(input.travelLegs);
    for (const [from, to] of edges.slice(0, budget)) {
      const reply = await lookupRoute(from, to);
      if (reply.status === "budget_exhausted") break;
      if (reply.status === "ok") {
        // This deterministic evaluation policy explicitly selects the sole option.
        if (reply.routes.length !== 1) throw new Error("Offline tool must return one option");
        const leg = selectedRouteToTravelLeg(from, to, reply.routes[0]);
        travelLegs = [...travelLegs.filter((l) => edgeKey(l.fromPlaceId, l.toPlaceId) !== edgeKey(from, to)), leg];
      } else if (reply.status === "failure" && ["authorization_failed", "quota_exceeded"].includes(reply.failure.code)) break;
    }
    return { result: plan({ ...input, travelLegs }), travelLegs };
  },
};
export const planners = [rulesOnly, fixedWorkflow] as const;
