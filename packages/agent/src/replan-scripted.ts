import type {
  ReplanAction,
  ReplanDecisionContext,
  ReplanDecisionModel,
} from "./replan-contracts";

type Attempt = ReplanDecisionContext["attempts"][number];

/** Public-input heuristic: no reference answers, only the tool observations in context. */
export function chooseReplanAction(context: ReplanDecisionContext): ReplanAction {
  const tried = new Set(context.attempts.map((item) => JSON.stringify(item.order)));
  const fresh = (order: string[]) => !tried.has(JSON.stringify(order));
  const successes = context.attempts.filter((item) => item.status === "success");
  const baseline = context.attempts.find((item) => item.attemptId === "baseline");
  const activity = (id: string) => context.activities.find((item) => item.activityId === id)!;
  const soft = (id: string) => ["optional", "discovered"].includes(activity(id).role);
  const canTry = context.remaining.tries > 0;

  // An empty remaining day with spare capacity: look for one nearby candidate first.
  const discovered = context.activities.filter((item) => item.adjustable && item.role === "discovered");
  if (
    baseline?.status === "success" && context.goal === "keep_as_much" &&
    context.currentOrder.length === 0 && context.maxFutureActivities > context.frozenOrder.length
  ) {
    if (!context.searches.length && context.remaining.searches > 0 && context.interests.length) {
      return {
        action: "search_places",
        interest: context.interests[0] as Extract<ReplanAction, { action: "search_places" }>["interest"],
        anchorPlaceId: context.resume.placeId,
      };
    }
    const order = discovered.slice(0, 1).map((item) => item.activityId);
    if (canTry && order.length && fresh(order)) return { action: "try_replan", orderedActivityIds: order };
  }

  if (baseline?.status === "success" && context.goal !== "keep_as_much" && canTry && context.attempts.length === 1) {
    // Soft goals: drop one optional stop (relaxed: the last; less_walking: the longest detour).
    const softIds = context.currentOrder.filter(soft);
    const target = context.goal === "relaxed" ? softIds.at(-1) : longestDetour(context, softIds);
    const order = context.currentOrder.filter((id) => id !== target);
    if (target && fresh(order)) return { action: "try_replan", orderedActivityIds: order };
  }

  if (successes.length) return { action: "finish", attemptId: best(context, successes).attemptId };

  if (canTry) {
    // Each retry keeps hard items in their current order and drops one more soft item.
    const latest = context.attempts.at(-1)!;
    const blocked = latest.issues.find((issue) => issue.code === "day_route_unknown");
    const blockedActivity = blocked && context.activities.find((item) =>
      item.adjustable && soft(item.activityId) &&
      (item.placeId === blocked.toPlaceId || item.placeId === blocked.fromPlaceId));
    let order = latest.order.filter((id) => id !== blockedActivity?.activityId);
    if (!blockedActivity) {
      const lastSoft = [...latest.order].reverse().find(soft);
      order = latest.order.filter((id) => id !== lastSoft);
    }
    if (fresh(order) && (order.length < latest.order.length)) {
      return { action: "try_replan", orderedActivityIds: order };
    }
  }
  const unknown = context.attempts.some((item) => item.issues.some((issue) => issue.kind === "unknown"));
  return { action: "stop", reason: unknown ? "insufficient_information" : "constraints_not_met" };
}

function longestDetour(context: ReplanDecisionContext, softIds: string[]): string | undefined {
  const minutes = (from: string, to: string) =>
    context.routes.find((route) => route.fromPlaceId === from && route.toPlaceId === to)?.travelMinutes ?? 0;
  const path = [
    context.resume.placeId,
    ...context.currentOrder.map((id) => context.activities.find((item) => item.activityId === id)!.placeId),
  ];
  let target: string | undefined;
  let longest = -1;
  for (const id of softIds) {
    const index = context.currentOrder.indexOf(id);
    const detour = minutes(path[index], path[index + 1]);
    if (detour > longest) {
      longest = detour;
      target = id;
    }
  }
  return target;
}

function best(context: ReplanDecisionContext, successes: Attempt[]): Attempt {
  const score = (item: Attempt) =>
    context.goal === "less_walking" ? item.walkingMinutes ?? 0
      : context.goal === "relaxed" ? item.order.length * 60 + (item.waitingMinutes ?? 0)
        : -item.order.length;
  return [...successes].sort((a, b) => score(a) - score(b))[0];
}

export function createReplanScriptedModel(
  decide: (context: ReplanDecisionContext) => unknown = chooseReplanAction,
): ReplanDecisionModel {
  return {
    mode: "scripted",
    provider: "tripquest-scripted",
    model: "replan-public-heuristic.v1",
    async decide(context, { signal }) {
      if (signal.aborted) throw new Error("cancelled");
      return { decision: decide(context), usage: null };
    },
  };
}
