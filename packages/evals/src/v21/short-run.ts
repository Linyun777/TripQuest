import { DEFAULT_TRAVEL, type PlanningPlace } from "@tripquest/application/planning";
import { shortStepDeparture } from "@tripquest/application/conversation";
import type { DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import {
  createCandidateRunner,
  createShortScriptedModel,
  planShortTrip,
  type CandidateDecisionModel,
  type CandidatePicker,
} from "@tripquest/agent/short";
import { base, type PlanCase } from "./plan-dataset";
import { independentViolations, runPlanCase, type Policy } from "./run";
import { scoreShort, type ShortCase, type ShortOutcome, type ShortScore } from "./short-dataset";
import { FORECASTS, V21_NOW, V21_TODAY, V21World, WORLD, worldSelection } from "./world";

/**
 * V2.4 short-trip runs. The planning clock stays at V21_NOW (09:00) and the trip is planned for
 * 14:45 the same day, which is legitimate planning ahead and keeps every fixture fresh.
 */
export const SHORT_STARTS_AT = "14:45";

export interface ShortRow {
  readonly suite: "short";
  readonly caseId: string;
  /** "day": today's product, the day planner (baseline); "short": the V2.4 short flow. */
  readonly flow: "day" | "short";
  readonly policy: Policy;
  readonly outcome: ShortOutcome;
  readonly score: ShortScore;
  readonly stops: readonly string[];
  readonly modelRequests: number;
  readonly failureCode?: string;
}

/**
 * The baseline: what today's product does with the same sentence. Observed in use (D-056):
 * the window runs from now to 18:00 and the day returns to where it started.
 */
export async function runShortAsDay(item: ShortCase, policy: Policy, model?: () => DayPlanningDecisionModel): Promise<ShortRow> {
  const asDay: PlanCase = {
    id: item.id,
    note: item.note,
    date: V21_TODAY,
    forecast: "dry",
    requirements: base({
      date: V21_TODAY,
      window: { startsAt: SHORT_STARTS_AT, endsAt: "18:00" },
      startPlace: worldSelection(item.start),
      endPlace: worldSelection(item.start),
      travel: DEFAULT_TRAVEL,
      freeInterests: item.interests.map((interest) => ({ ...interest })),
    }),
    satisfiedBy: item.satisfiedBy,
    expect: "draft",
  };
  const row = await runPlanCase(asDay, policy, model);
  const idOf = (name: string) => WORLD.find((place) => place.name === name)!.id;
  const outcome: ShortOutcome = {
    planned: row.outcome === "draft",
    stops: row.stops.map(idOf),
    endsAtStart: row.outcome === "draft",
    violations: row.violations,
  };
  return {
    suite: "short",
    caseId: item.id,
    flow: "day",
    policy,
    outcome,
    score: scoreShort(item, outcome),
    stops: row.stops,
    modelRequests: row.modelRequests,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  };
}

/**
 * The V2.4 short flow: candidates around the start, then around each chosen stop; the user is
 * played by taking the first (recommended) candidate each time; then the fixed-order plan.
 */
export async function runShortFlow(item: ShortCase, policy: Policy, model?: () => CandidateDecisionModel, picker?: CandidatePicker): Promise<ShortRow> {
  const world = new V21World(FORECASTS.dry);
  // V2.9.2：SHORT_PICKER=jev 时挑选先交给 Jev（没能完成时照旧由模型挑）。
  const runner = createCandidateRunner({
    provider: world,
    model: policy === "live" && model ? model() : createShortScriptedModel(),
    ...(picker ? { picker } : {}),
  });
  const start = worldSelection(item.start);
  const stops: { place: PlanningPlace; stayMinutes: number }[] = [];
  const steps: { interest: string; offered: string[] }[] = [];
  let modelRequests = 0;
  let failureCode: string | undefined;
  for (const interest of item.interests) {
    const anchor = stops.at(-1)?.place ?? start;
    const result = await runner.run({
      interest: { text: interest.text },
      anchor,
      anchorIsStart: !stops.length,
      exclude: stops.map((stop) => stop.place.place.ref.externalId),
      travel: DEFAULT_TRAVEL,
      // Like the product: each step sets off after the earlier stops (V2.5).
      departureAt: shortStepDeparture(V21_TODAY, item.startsAt ?? SHORT_STARTS_AT, stops.map((stop) => stop.stayMinutes)),
      // Like the product: daily short trips stay in the start's city (V2.11).
      ...(start.place.cityAdcode ? { cityAdcode: start.place.cityAdcode } : {}),
    }, { signal: new AbortController().signal });
    modelRequests += result.counts.model;
    if (result.status !== "ok") {
      failureCode = result.status === "failed" ? result.code : "none";
      break;
    }
    steps.push({ interest: interest.id, offered: result.candidates.map((candidate) => candidate.selection.place.ref.externalId) });
    stops.push({ place: result.candidates[0].selection, stayMinutes: result.candidates[0].stayMinutes });
  }
  let planned = false;
  let violations: string[] = [];
  let endsAtStart = false;
  let times: { startsAt: number; endsAt: number }[] | undefined;
  if (stops.length === item.interests.length) {
    const { result, snapshot } = await planShortTrip({
      date: V21_TODAY,
      // Four hours from the start, as the product fills it.
      window: { startsAt: item.startsAt ?? SHORT_STARTS_AT, endsAt: item.startsAt ? "23:30" : "18:45" },
      start,
      ...(item.back ? { back: start } : {}),
      stops,
      travel: DEFAULT_TRAVEL,
      provider: world,
      now: () => V21_NOW,
      signal: new AbortController().signal,
    });
    if (result.status === "completed" && result.outcome === "draft") {
      planned = true;
      endsAtStart = result.draft.endPlace.name === start.place.name;
      times = result.draft.activities.map((activity) => ({ startsAt: activity.startsAt, endsAt: activity.endsAt }));
      const asCase = { requirements: { visits: stops.map((stop) => ({ place: stop.place, role: "required" as const, stayMinutes: stop.stayMinutes })) } };
      violations = await independentViolations(asCase as unknown as PlanCase, result, snapshot ?? undefined);
    } else {
      failureCode = result.status === "completed" ? result.reason : result.status === "failed" ? result.code : result.status;
    }
  }
  const outcome: ShortOutcome = {
    planned,
    stops: stops.map((stop) => stop.place.place.ref.externalId),
    endsAtStart,
    steps,
    ...(times ? { times } : {}),
    violations,
  };
  return {
    suite: "short",
    caseId: item.id,
    flow: "short",
    policy,
    outcome,
    score: scoreShort(item, outcome),
    stops: stops.map((stop) => stop.place.place.name),
    modelRequests,
    ...(failureCode ? { failureCode } : {}),
  };
}
