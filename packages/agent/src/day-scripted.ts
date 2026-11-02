import type { DayAction, DayDecisionContext, DayPlanningDecisionModel } from "./day-contracts";

const FIXED_INTERESTS = ["culture", "nature", "city_walk", "food"] as const;
const isFixed = (id: string): id is (typeof FIXED_INTERESTS)[number] =>
  (FIXED_INTERESTS as readonly string[]).includes(id);

/** Public-input heuristic, also usable by the fixed-workflow comparison. No reference answers. */
export function chooseDayAction(context: DayDecisionContext): DayAction {
  const latest = context.latestAttempt;
  if (latest?.status === "success") return { action: "finish", attemptId: latest.attemptId };
  const target = context.requirements.pace === "relaxed" ? 3 : 4;
  const hard = context.activities.filter((r) => ["required", "fixed"].includes(r.activity.role));
  // V2.3: free interests want exactly their count of stops (default 1), ordered by time of day;
  // V1 fixed interests keep filling the day up to the pace target.
  const free = context.requirements.interests.filter((interest) => !isFixed(interest.id));
  const found = (id: string) => context.activities.filter((r) => r.activity.role === "discovered" && r.interest === id);
  const short = (interest: (typeof free)[number]) => found(interest.id).length < (interest.count ?? 1);
  const soft = free.length
    ? [
      ...context.activities.filter((r) => r.activity.role === "optional"),
      ...free.flatMap((interest) => found(interest.id).slice(0, interest.count ?? 1)),
    ].sort((a, b) => (a.activity.within?.startsAt ?? 12 * 60) - (b.activity.within?.startsAt ?? 12 * 60))
    : context.activities.filter((r) => ["optional", "discovered"].includes(r.activity.role));
  const wantsMore = free.length ? free.some(short) : context.activities.length < target;
  if (wantsMore && context.remaining.searches > 0 && !latest) {
    for (const anchorPlaceId of [context.requirements.startPlaceId, context.requirements.endPlaceId]) {
      for (const interest of context.requirements.interests) {
        if (free.length && !isFixed(interest.id) && !short(interest)) continue;
        if (context.searches.some((s) => s.interest === interest.id && s.anchorPlaceId === anchorPlaceId)) continue;
        // Fixed interests keep their V1 query; free ones search with the user's own words.
        const id = interest.id;
        return isFixed(id)
          ? { action: "search_places", interest: id, anchorPlaceId }
          : { action: "search_places", interestId: interest.id, query: interest.text.slice(0, 20), anchorPlaceId };
      }
    }
  }
  if (!context.activities.length) {
    return { action: "stop", reason: context.searches.some((s) => s.failureCode)
      ? "insufficient_information" : "no_suitable_places" };
  }
  if (context.remaining.tries > 0) {
    const fixed = hard.filter((r) => r.activity.role === "fixed")
      .sort((a, b) => a.activity.fixed!.startsAt - b.activity.fixed!.startsAt);
    const required = hard.filter((r) => r.activity.role === "required");
    let selected = [...required, ...fixed, ...soft.slice(0, Math.max(0, target - hard.length))];
    if (latest) {
      const late = latest.issues.some((i) => i.code === "day_fixed_late");
      if (late) selected = [...fixed, ...required, ...soft.slice(0, Math.max(0, target - hard.length))];
      else {
        // Each retry removes a soft visit or chooses a remaining alternative; hard fields stay intact.
        const oldSoft = latest.order.filter((id) => soft.some((s) => s.activity.activityId === id));
        const alternative = soft.find((s) => !latest.order.includes(s.activity.activityId));
        const retained = oldSoft.slice(0, -1).map((id) => soft.find((s) => s.activity.activityId === id)!);
        selected = [...fixed, ...required, ...retained,
          ...(latest.issues.some((i) => i.code === "day_route_unknown") && alternative ? [alternative] : [])];
      }
    }
    const order = selected.slice(0, 6).map((r) => r.activity.activityId);
    if (order.length && !context.triedOrders.some((o) => JSON.stringify(o) === JSON.stringify(order))) {
      return { action: "try_itinerary", orderedActivityIds: order };
    }
    const onlyHard = [...fixed, ...required].map((r) => r.activity.activityId);
    if (onlyHard.length && !context.triedOrders.some((o) => JSON.stringify(o) === JSON.stringify(onlyHard))) {
      return { action: "try_itinerary", orderedActivityIds: onlyHard };
    }
  }
  return { action: "stop", reason: latest?.issues.some((i) => i.kind === "unknown")
    ? "insufficient_information" : "constraints_not_met" };
}

export function createDayScriptedModel(
  decide: (context: DayDecisionContext) => unknown = chooseDayAction,
): DayPlanningDecisionModel {
  return {
    mode: "scripted", provider: "tripquest-scripted", model: "day-public-heuristic.v1",
    async decide(context, { signal }) {
      if (signal.aborted) throw new Error("cancelled");
      return { decision: decide(context), usage: null };
    },
  };
}
