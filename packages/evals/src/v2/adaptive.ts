import { accessibleEdges, usefulEdges, LIMITS } from "@tripquest/agent";
import type { Observation, Plan, LookupRoute, AgentResult } from "@tripquest/agent";
import type { BaselinePlanningInput } from "@tripquest/domain";
import { selectedRouteToTravelLeg } from "@tripquest/providers";

export async function runAdaptive(
  input: BaselinePlanningInput,
  plan: Plan,
  lookupRoute: LookupRoute,
): Promise<AgentResult> {
  let travelLegs = structuredClone(input.travelLegs);
  let result = plan(structuredClone(input));
  let planningCalls = 1;
  const observations: Observation[] = [];
  let error: AgentResult["error"] = null;
  const allowed = accessibleEdges(input);
  while (observations.length < LIMITS.routes) {
    const edge = usefulEdges(result, allowed, observations)[0];
    if (!edge) break;
    const reply = await lookupRoute(...edge);
    observations.push({
      edge,
      status: reply.status,
      ...(reply.status === "failure" ? { failureCode: reply.failure.code } : {}),
    });
    if (reply.status === "budget_exhausted") break;
    if (reply.status === "ok") {
      if (reply.routes.length !== 1 || reply.routes[0].mode !== "walking") {
        throw new Error("Malformed synthetic route");
      }
      const leg = selectedRouteToTravelLeg(...edge, reply.routes[0]);
      travelLegs = [...travelLegs.filter((l) =>
        l.fromPlaceId !== edge[0] || l.toPlaceId !== edge[1],
      ), leg];
    }
    result = plan({ ...structuredClone(input), travelLegs: structuredClone(travelLegs) });
    planningCalls += 1;
    if (reply.status === "failure" && ["authorization_failed", "quota_exceeded"].includes(reply.failure.code)) {
      error = reply.failure.code === "authorization_failed" ? "auth" : "quota";
      break;
    }
  }
  return {
    result,
    travelLegs,
    observations,
    planningCalls,
    executionStatus: error ? "model_error" : "completed",
    error,
    modelRequests: 0,
    routeRequests: observations.length,
    decisions: [],
    rejectedActions: 0,
  };
}
