import { evalChatRouter } from "../v293/chat-router";
import { randomUUID } from "node:crypto";
import { createCandidateRunner, createShortScriptedModel, planShortAdjustment, type CandidateDecisionModel } from "@tripquest/agent/short";
import { emptyDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import { DEFAULT_TRAVEL, type PlanningRequirements } from "@tripquest/application/planning";
import { planAdjustment, prepareAdjustment } from "@tripquest/application/real-adjust";
import type { StoredRealDay } from "@tripquest/application/real-day";
import { createChatRunner, type ChatDecisionModel } from "@tripquest/agent/chat";
import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import {

  TRIP_DATE,
  TRIP_NOW,
  TRIP_NOW_CLOCK,
  TRIP_START,
  TRIP_STOPS,
  TRIP_WINDOW,
  adjustChecks,
  scoreAdjust,
  tripStopName,
  type AdjustIntakeCase,
  type AdjustOutcome,
  type AdjustPlanCase,
  type AdjustScore,
} from "./adjust-dataset";
import { base, type PlanCase } from "./plan-dataset";
import { independentViolations, runPlanCase, type Policy } from "./run";
import { FORECASTS, V21_NOW, V21World, WORLD, worldSelection } from "./world";
import { FakeWeb, INFO_WEB } from "./info-dataset";
import { FakeKnowledge, KNOWLEDGE_ON } from "./knowledge-dataset";

/**
 * Off = the step 1 baseline: no saved-trip context, only the history line "（已给出方案：…）"
 * today's product sends. On since step 4.
 */
export const ADJUST_CONTEXT = true;

/** The conversation's card as it stood when the trip was saved. */
export function tripDraft(): RequirementsDraft {
  const square = WORLD.find((place) => place.id === TRIP_START)!;
  const bound = { status: "bound" as const, externalId: square.id, name: square.name };
  return {
    ...emptyDraft(),
    date: TRIP_DATE,
    startsAt: TRIP_WINDOW.startsAt,
    endsAt: TRIP_WINDOW.endsAt,
    start: bound,
    end: bound,
    interests: TRIP_STOPS.map((stop, index) => ({ id: `i${index + 1}`, text: stop.interest })),
    travel: DEFAULT_TRAVEL,
  };
}

export interface AdjustIntakeRow {
  readonly suite: "adjust-intake";
  readonly caseId: string;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly modelRequests: number;
  readonly reply: string;
  readonly webQueries?: readonly string[];
}

/** One message in the saved trip's conversation, through the product's own chat runner. */
export async function runAdjustIntake(item: AdjustIntakeCase, model: () => ChatDecisionModel): Promise<AdjustIntakeRow> {
  const world = new V21World(FORECASTS.dry);
  const history = [
    { role: "user" as const, text: "明天9点从东门广场出发再回来，想看展、看越剧、喝茶" },
    { role: "assistant" as const, text: "好的，已经按你的想法整理好需求卡片。" },
    { role: "assistant" as const, text: "（已给出方案：10月16日 · 看展、越剧相关）" },
    { role: "assistant" as const, text: "（方案已保存为行程）" },
  ];
  const trip = {
    version: 1,
    date: TRIP_DATE,
    stops: (item.stops ?? TRIP_STOPS).map((stop) => ({
      key: stop.key, name: tripStopName(stop), startsAt: stop.startsAt, endsAt: stop.endsAt, status: "todo" as const, for: stop.interest,
    })),
  };
  const input = { draft: tripDraft(), history, userText: item.text, nowMs: TRIP_NOW, ...(ADJUST_CONTEXT ? { trip } : {}) };
  const web = new FakeWeb();
  const result = await createChatRunner({
    ...evalChatRouter(),
    cities: world,
    model: model(),
    places: world,
    weather: world,
    ...(INFO_WEB ? { web } : {}),
    ...(KNOWLEDGE_ON ? { knowledge: new FakeKnowledge() } : {}),
  })
    .run(input, { signal: new AbortController().signal });
  const produced = result.status === "completed" ? result.adjust : undefined;
  const checks = [{ name: "no_failed_turn", passed: result.status === "completed" && !result.reply.fallback }, ...adjustChecks(item.truth, produced)];
  return {
    suite: "adjust-intake",
    caseId: item.id,
    checks,
    passed: checks.every((check) => check.passed),
    modelRequests: result.counts.model,
    reply: result.status === "completed" ? result.reply.text : "",
    webQueries: web.queries,
  };
}

export interface AdjustRow {
  readonly suite: "adjust";
  readonly caseId: string;
  /** "day": today's product (re-plan the day from the card); "adjust": the V2.5 flow. */
  readonly flow: "day" | "adjust";
  readonly policy: Policy;
  readonly outcome: AdjustOutcome;
  readonly score: AdjustScore;
  readonly stops: readonly string[];
  readonly modelRequests: number;
  readonly failureCode?: string;
}

/**
 * The baseline: today the user can only ask the chat to change the card and plan again. The
 * card loses the skipped or replaced interest and gains the new one; the day is planned from
 * its usual start, knowing nothing of what was done or of the time now.
 */
export async function runAdjustAsDay(item: AdjustPlanCase, policy: Policy, model?: () => DayPlanningDecisionModel): Promise<AdjustRow> {
  const stops = item.stops ?? TRIP_STOPS;
  const gone = new Set([...(item.request.skipped ?? []), ...(item.request.replace ?? []).map((change) => change.stop)]);
  const interests = [
    ...stops.filter((stop) => !gone.has(stop.key) && !stop.fixed).map((stop) => stop.interest),
    ...(item.request.replace ?? []).map((change) => change.interest),
    ...(item.request.addInterests ?? []),
  ].map((entry) => (typeof entry === "string" ? { text: entry } : entry));
  const asDay: PlanCase = {
    id: item.id,
    note: item.note,
    date: TRIP_DATE,
    forecast: "dry",
    requirements: base({
      date: TRIP_DATE,
      window: { startsAt: TRIP_WINDOW.startsAt, endsAt: item.request.endsAt ?? TRIP_WINDOW.endsAt },
      startPlace: worldSelection(TRIP_START),
      endPlace: worldSelection(TRIP_START),
      travel: DEFAULT_TRAVEL,
      freeInterests: interests.map((entry, index) => ({ id: `i${index + 1}`, ...entry })),
      visits: stops.filter((stop) => stop.fixed && !gone.has(stop.key))
        .map((stop) => ({ place: worldSelection(stop.placeId), role: "fixed" as const, startsAt: stop.startsAt, endsAt: stop.endsAt })),
    }),
    satisfiedBy: {},
    expect: "draft",
  };
  const row = await runPlanCase(asDay, policy, model);
  const idOf = (name: string) => WORLD.find((place) => place.name === name)!.id;
  const outcome: AdjustOutcome = {
    planned: row.outcome === "draft",
    stops: row.stops.map((name, index) => ({ placeId: idOf(name), startsAt: row.times?.[index] ?? "", endsAt: row.ends?.[index] ?? "" })),
    violations: row.violations,
  };
  return {
    suite: "adjust", caseId: item.id, flow: "day", policy, outcome, score: scoreAdjust(item, outcome),
    stops: row.stops, modelRequests: row.modelRequests, ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  };
}


/** World IDs → stable synthetic UUIDs, for a saved real day built from the trip. */
const uuidOf = (worldId: string) => {
  const index = WORLD.findIndex((place) => place.id === worldId);
  return `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
};
const activityOf = (key: string) => `71000000-0000-4000-8000-${String(Number(key.slice(1))).padStart(12, "0")}`;
const toMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The trip as a saved real day (version 1), the way the product stores it. */
export function savedTrip(item: AdjustPlanCase): StoredRealDay {
  const stops = item.stops ?? TRIP_STOPS;
  const used = [TRIP_START, ...stops.map((stop) => stop.placeId)];
  return {
    schemaVersion: "stored-real-day.v1",
    planVersion: 1,
    context: {
      creationRunId: "72000000-0000-4000-8000-000000000001",
      requirementsFingerprint: "a".repeat(64),
      date: TRIP_DATE,
      timeZone: "Asia/Shanghai",
      window: { startsAt: toMinute(TRIP_WINDOW.startsAt), endsAt: toMinute(TRIP_WINDOW.endsAt) },
      startPlaceId: uuidOf(TRIP_START),
      // A short trip ends at its last stop and keeps no interests (its stops were picked).
      endPlaceId: uuidOf(item.short ? stops.at(-1)!.placeId : TRIP_START),
      bufferMinutes: 5,
      pace: "standard",
      interests: [],
      ...(item.short ? {} : { freeInterests: stops.map((stop, index) => ({ id: `i${index + 1}`, text: stop.interest })) }),
      travel: DEFAULT_TRAVEL,
    },
    places: [...new Set(used)].map((id) => ({ placeId: uuidOf(id), provider: "amap" as const, externalId: id, name: WORLD.find((place) => place.id === id)!.name })),
    activities: stops.map((stop, index) => ({
      record: {
        activity: {
          activityId: activityOf(stop.key), placeId: uuidOf(stop.placeId),
          role: stop.fixed ? "fixed" as const : item.short ? "required" as const : "discovered" as const,
          stayMinutes: toMinute(stop.endsAt) - toMinute(stop.startsAt),
          staySource: stop.fixed || item.short ? "user" as const : "system_estimate" as const,
          ...(stop.fixed ? { fixed: { startsAt: toMinute(stop.startsAt), endsAt: toMinute(stop.endsAt) } } : {}),
          opening: { status: "unknown" as const }, tickets: "unknown" as const,
        },
        ...(stop.fixed || item.short ? {} : { interest: `i${index + 1}` }),
      },
      startsAt: toMinute(stop.startsAt),
      endsAt: toMinute(stop.endsAt),
      ...(stop.fixed ? { reservationId: "73000000-0000-4000-8000-000000000001" } : {}),
    })),
    acknowledgeUnknowns: true,
  };
}

/**
 * The V2.5 flow: what is left becomes a day plan from the museum at 11:10 (or when the user
 * can go on), with untouched stops kept; when it cannot fit, a stop is suggested for dropping.
 */
export async function runAdjustFlow(
  item: AdjustPlanCase,
  policy: Policy,
  model?: () => DayPlanningDecisionModel,
  /** V2.5: a short trip's new interests are picked like its other steps. */
  candidateModel?: () => CandidateDecisionModel,
): Promise<AdjustRow> {
  const details = savedTrip(item);
  const world = new V21World(FORECASTS.dry);
  const live = new Map(details.places.map((place) => [place.placeId, worldSelection(place.externalId)]));
  const prepared = prepareAdjustment({
    details,
    done: { completed: item.completed.map(activityOf), skipped: [] },
    nowMinute: toMinute(TRIP_NOW_CLOCK),
    live,
    request: {
      completed: [],
      skipped: (item.request.skipped ?? []).map(activityOf),
      replace: (item.request.replace ?? []).map((change) => ({ activityId: activityOf(change.stop), interest: change.interest })),
      addInterests: [...(item.request.addInterests ?? [])],
      ...(item.request.resumeAt ? { resumeAt: item.request.resumeAt } : {}),
      ...(item.request.endsAt ? { endsAt: item.request.endsAt } : {}),
    },
  });
  if (prepared.status !== "ok") {
    const outcome: AdjustOutcome = { planned: false, stops: [], violations: [] };
    return { suite: "adjust", caseId: item.id, flow: "adjust", policy, outcome, score: scoreAdjust(item, outcome), stops: [], modelRequests: 0, failureCode: prepared.code };
  }
  let modelRequests = 0;
  const plan = async (requirements: PlanningRequirements) => {
    const problem = createDayPlanningProblem({
      requirements, runId: randomUUID(), requirementsFingerprint: fingerprintRequirements(requirements), nowMs: V21_NOW, leaveLate: true,
    });
    let snapshot: DayDraftConfirmationSnapshot | null = null;
    const decision = policy === "live" && model ? model() : createDayScriptedModel();
    const result = await createDayPlanningRunner({ provider: world, model: decision, now: () => V21_NOW })
      .run(problem, { signal: new AbortController().signal, onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
    modelRequests += result.counts.model;
    return { result, snapshot };
  };
  const request = {
    completed: [], skipped: (item.request.skipped ?? []).map(activityOf),
    replace: (item.request.replace ?? []).map((change) => ({ activityId: activityOf(change.stop), interest: change.interest })),
    addInterests: [...(item.request.addInterests ?? [])],
  };
  // A short trip keeps its order: the product's own short-trip path (V2.5).
  const short = item.short
    ? await planShortAdjustment({
        details, prepared, request, provider: world, now: () => V21_NOW, signal: new AbortController().signal,
        candidates: createCandidateRunner({ provider: world, model: policy === "live" && candidateModel ? candidateModel() : createShortScriptedModel() }),
      })
    : null;
  if (short?.status === "no_place") {
    const outcome: AdjustOutcome = { planned: false, stops: [], violations: [] };
    return { suite: "adjust", caseId: item.id, flow: "adjust", policy, outcome, score: scoreAdjust(item, outcome), stops: [], modelRequests, failureCode: "no_place" };
  }
  const planned = short ?? await planAdjustment(prepared, plan);
  const externalOf = (snapshot: DayDraftConfirmationSnapshot, placeId: string) => snapshot.places.find((entry) => entry.placeId === placeId)!.selection.place.ref.externalId;
  const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  let outcome: AdjustOutcome = { planned: false, stops: [], violations: [] };
  if (planned.status !== "none") {
    const asCase = { requirements: planned.requirements } as unknown as PlanCase;
    const stops = planned.result.draft.activities.map((activity) => ({
      placeId: externalOf(planned.snapshot, activity.placeId), startsAt: clock(activity.startsAt), endsAt: clock(activity.endsAt),
    }));
    const violations = await independentViolations(asCase, planned.result, planned.snapshot);
    if (planned.status === "draft") outcome = { planned: true, stops, violations };
    else {
      // A suggestion is not a plan yet: the user has to agree to dropping that stop.
      const dropped = details.activities.find((entry) => entry.record.activity.activityId === planned.drop)!;
      const suggestDrop = details.places.find((place) => place.placeId === dropped.record.activity.placeId)!.externalId;
      outcome = { planned: false, stops: [], violations, suggestDrop };
    }
  }
  const names = outcome.stops.map((stop) => WORLD.find((place) => place.id === stop.placeId)!.name);
  return {
    suite: "adjust", caseId: item.id, flow: "adjust", policy, outcome, score: scoreAdjust(item, outcome), stops: names, modelRequests,
    ...(planned.status === "none" ? { failureCode: planned.result?.status === "completed" ? planned.result.outcome : planned.result?.status ?? "none" } : {}),
  };
}
