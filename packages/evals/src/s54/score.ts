import type { PlanningPlace } from "@tripquest/application/planning";
import type { DayPlanningResult } from "@tripquest/application/day-planning";
import {
  confirmationInput,
  type DayDraftConfirmationSnapshot,
} from "@tripquest/application/day-confirmation";
import {
  evaluateReplan,
  replanEdges,
  replanInput,
  type DayReplanProblem,
  type ReplanResult,
} from "@tripquest/application/day-replan";
import { rebuildReplanSelection } from "@tripquest/application/day-replan-confirm";
import {
  sameDayPlace,
  validateDayDraft,
  validateReplan,
  type DayIssue,
  type DayRoute,
  type DaySchedule,
} from "@tripquest/domain";
import type { DraftCase, ReplanCase } from "./dataset";
import { FaultInjectingProvider, S54_NOW, type S54Faults } from "./world";

/** What the scorer found wrong; every entry is a violation the product must never produce. */
export type Violation = string;

/** Route facts from the case's own world, queried here; nothing comes from the agent's run. */
async function truthRoute(
  faults: S54Faults | undefined,
  edge: { fromPlaceId: string; toPlaceId: string },
  from: PlanningPlace["place"],
  to: PlanningPlace["place"],
): Promise<DayRoute> {
  const reply = await new FaultInjectingProvider(faults).findRoutes({
    origin: { place: from.ref, location: from.location },
    destination: { place: to.ref, location: to.location },
    mode: "walking",
    cityAdcode: "330100",
    departureAt: "2026-10-16T00:00:00+08:00",
  });
  if (reply.status !== "ok") {
    return { ...edge, status: "unknown", reason: reply.status };
  }
  const [route] = reply.routes;
  return {
    ...edge,
    status: "known",
    durationSeconds: route.durationSeconds,
    distanceMeters: route.distanceMeters,
    provider: reply.evidence.provider,
    sourceKind: reply.evidence.sourceKind,
    retrievedAt: reply.evidence.retrievedAt,
  };
}

async function truthRoutes(
  faults: S54Faults | undefined,
  edges: readonly { fromPlaceId: string; toPlaceId: string }[],
  place: (id: string) => PlanningPlace["place"],
  domainPlace: (id: string) => Parameters<typeof sameDayPlace>[0],
): Promise<DayRoute[]> {
  const routes: DayRoute[] = [];
  for (const edge of edges) {
    if (routes.some((route) => route.fromPlaceId === edge.fromPlaceId && route.toPlaceId === edge.toPlaceId)) {
      continue;
    }
    routes.push(sameDayPlace(domainPlace(edge.fromPlaceId), domainPlace(edge.toPlaceId))
      ? { ...edge, status: "same_place_assumption" }
      : await truthRoute(faults, edge, place(edge.fromPlaceId), place(edge.toPlaceId)));
  }
  return routes;
}

/** Violations, plus any leg on a route the world does not have: a final plan may not walk it. */
const violations = (issues: readonly DayIssue[]): Violation[] =>
  issues
    .filter((issue) => issue.kind === "violation" || issue.code === "day_route_unknown")
    .map((issue) => issue.code);

/**
 * Rechecks a draft against the case's world: recomputed routes, the domain validator, and
 * the user's required/fixed visits taken from the case itself rather than from the run.
 */
export async function checkDraft(
  item: DraftCase,
  result: Extract<DayPlanningResult, { outcome: "draft" }>,
  snapshot: DayDraftConfirmationSnapshot | undefined,
): Promise<Violation[]> {
  if (!snapshot || snapshot.draft.runId !== result.draft.runId) return ["draft_without_snapshot"];
  const { draft } = result;
  const input = confirmationInput(snapshot, S54_NOW);
  const schedule: DaySchedule = {
    activities: draft.activities.map((item) => ({
      activityId: item.activityId,
      placeId: item.placeId,
      arrivesAt: item.arrivesAt,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      waitMinutes: item.waitMinutes,
    })),
    legs: draft.legs.map((leg) => ({
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      departsAt: leg.departsAt,
      arrivesAt: leg.arrivesAt,
      travelMinutes: leg.travelMinutes,
      bufferMinutes: leg.bufferMinutes,
      distanceMeters: leg.distanceMeters,
      source: leg.source,
    })),
    endArrival: draft.endArrival,
    totalWalkingMinutes: draft.totalWalkingMinutes,
    longestWalkingMinutes: draft.longestWalkingMinutes,
  };
  const place = (id: string) => snapshot.places.find((entry) => entry.placeId === id)!.selection.place;
  const domainPlace = (id: string) => input.places.find((entry) => entry.placeId === id)!;
  const routes = await truthRoutes(item.faults, schedule.legs, place, domainPlace);
  const found = violations(validateDayDraft(input, schedule, routes).issues);

  const externalOf = (placeId: string) => place(placeId).ref.externalId;
  for (const visit of item.requirements.visits) {
    if (visit.role === "optional") continue;
    const scheduled = draft.activities.find((entry) =>
      externalOf(entry.placeId) === visit.place.place.ref.externalId);
    if (!scheduled) {
      found.push(`missing_${visit.role}`);
      continue;
    }
    if (visit.role === "fixed") {
      const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
      if (scheduled.startsAt !== minutes(visit.startsAt) || scheduled.endsAt !== minutes(visit.endsAt)) {
        found.push("fixed_time_changed");
      }
    }
  }
  if (
    externalOf(draft.startPlace.placeId) !== item.requirements.startPlace.place.ref.externalId ||
    externalOf(draft.endPlace.placeId) !== item.requirements.endPlace.place.ref.externalId
  ) {
    found.push("endpoints_changed");
  }
  return [...new Set(found)];
}

/** Rechecks a replan outcome: the confirm-path rebuild, the domain validator and protections. */
export async function checkReplan(
  item: ReplanCase,
  problem: DayReplanProblem,
  result: ReplanResult,
): Promise<Violation[]> {
  const place = (id: string, places = problem.places) =>
    places.find((entry) => entry.placeId === id)!.selection.place;

  if (result.status === "completed" && result.outcome === "unchanged") {
    // Keeping the plan is only honest when the current order is still feasible.
    const input = problem.input;
    const edges = replanEdges(input, problem.adjustable);
    const domainPlace = (id: string) => input.places.find((entry) => entry.placeId === id)!;
    const routes = await truthRoutes(item.faults, edges, (id) => place(id), domainPlace);
    const evaluated = evaluateReplan(input, problem.adjustable, routes);
    return evaluated.status === "scheduled" ? [] : ["unchanged_but_infeasible"];
  }
  if (result.status !== "completed" || result.outcome !== "candidate") return [];

  const found: Violation[] = [];
  const rebuilt = await rebuildReplanSelection(problem, result.selection, S54_NOW);
  if (!rebuilt) return ["candidate_not_rebuildable"];
  if (rebuilt.built.fingerprint !== result.candidateFingerprint) found.push("candidate_mismatch");

  const input = replanInput(problem, rebuilt.places, rebuilt.activities, S54_NOW);
  const domainPlace = (id: string) => input.places.find((entry) => entry.placeId === id)!;
  const routes = await truthRoutes(
    item.faults,
    replanEdges(input, rebuilt.order),
    (id) => place(id, rebuilt.places),
    domainPlace,
  );
  found.push(...violations(validateReplan(input, rebuilt.schedule, routes).issues));

  const { candidate } = result;
  for (const record of problem.activities) {
    if (!["required", "fixed"].includes(record.activity.role)) continue;
    if (!candidate.activities.some((entry) => entry.key === record.storedId)) {
      found.push(`missing_${record.activity.role}`);
    }
  }
  for (const frozen of problem.input.frozen) {
    const storedId = problem.activities.find((record) => record.activity.activityId === frozen.activityId)!.storedId;
    const kept = candidate.activities.find((entry) => entry.key === storedId);
    if (!kept || kept.startsAt !== frozen.startsAt || kept.endsAt !== frozen.endsAt) {
      found.push("frozen_changed");
    }
  }
  const archived = problem.archived.map((entry) => entry.record.activity.activityId).sort().join();
  if (candidate.archived.map((entry) => entry.key).sort().join() !== archived) {
    found.push("history_changed");
  }
  return [...new Set(found)];
}
