import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { forecastLookup, generateOuting, type GeneratedDay } from "@tripquest/agent/outing-generate";
import { outingReview, type OutingReviewOutcome } from "@tripquest/agent/outing-graph";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import type { Allocation } from "@tripquest/application/outing-allocation";
import { allocationInput } from "../v211/allocation-run";
import { FORECASTS, V21_NOW, V21World, worldPlaceByName } from "../v21/world";
import type { Policy } from "../v21/run";
import type { ReviewAction, ReviewCase, ReviewProblem } from "./review-dataset";

/**
 * V3.2 审查评测（stages/V3.2.md §4）：同一份故意不好的分配，用产品的逐天生成排出来；审查开着（缺省）时排完再审查，OUTING_REVIEW=off 对比不审查。
 * 判分全在这里按排出来的结果算（规则见 review-dataset.ts 的说明），不读产品自己的“问题”。
 */
export interface ReviewRow {
  readonly suite: "review";
  readonly caseId: string;
  readonly policy: Policy;
  readonly heldOut: boolean;
  readonly review: "on" | "off";
  /** 每天的结果和各站（世界编号；交通写成 transfer）。 */
  readonly days: readonly { readonly day: number; readonly outcome: string; readonly stops: readonly string[] }[];
  readonly idleMinutes: number;
  readonly unplaced: readonly string[];
  readonly overloadedDays: number;
  readonly wetOutdoor: number;
  readonly violations: readonly string[];
  /** 审查直接改了几处、给了哪些建议（类型）。 */
  readonly applied: readonly string[];
  readonly suggestions: readonly string[];
  readonly falsePositive: boolean;
  /** 应该出现的建议出现了（直接改掉了同一个问题也算）；这题不看建议时为 null。 */
  readonly suggestionHit: boolean | null;
  /** 应该变好的问题里，还剩哪些（审查后与不审查对比在汇总里做）。 */
  readonly problems: readonly ReviewProblem[];
  readonly modelRequests: number;
  readonly mapRequests: number;
  readonly elapsedMs: number;
}

/** 判分只看审查直接改了哪些、建议了哪些（动作类型）。 */
interface ReviewOutcome {
  readonly applied: readonly { readonly action: string }[];
  readonly suggestions: readonly { readonly action: string }[];
}

const IDLE_MINUTES = 180;
const idOf = (name: string) => worldPlaceByName(name)?.id ?? name;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** 按题目的分到各天（世界编号 / 兴趣编号）换成产品的分配（地点用卡片上的 v 编号）。 */
export function reviewAllocation(item: ReviewCase): Allocation {
  return {
    days: item.split.map((entries, index) => ({
      day: index + 1,
      visits: entries.filter((entry) => !/^i\d+$/.test(entry)).map((place) => `v${item.visits.findIndex((visit) => visit.place === place) + 1}`),
      interests: entries.filter((entry) => /^i\d+$/.test(entry)),
    })),
  };
}

export async function runReviewCase(
  item: ReviewCase,
  policy: Policy,
  models?: {
    readonly day: () => DayPlanningDecisionModel;
    /** 审查 Agent 的模型请求（审查开着时产品用它）。 */
    readonly reviewer?: ReviewRequest;
  },
): Promise<ReviewRow> {
  const started = Date.now();
  const forecast = FORECASTS[item.forecast];
  const world = new V21World(forecast);
  const signal = new AbortController().signal;
  let modelRequests = 0;
  const decisions = policy === "live" && models ? models.day() : createDayScriptedModel();
  const counting: DayPlanningDecisionModel = {
    ...decisions,
    decide: async (context, options) => {
      modelRequests += 1;
      return decisions.decide(context, options);
    },
  };
  const given = models?.reviewer;
  const reviewer: ReviewRequest | undefined = given
    ? async (...args) => {
      modelRequests += 1;
      return given(...args);
    }
    : undefined;
  const input = allocationInput(item);
  let outcome: ReviewOutcome | null = null;
  const generated = await generateOuting({ ...input, pace: "standard", cityAdcode: input.start.place.place.cityAdcode ?? "330100" }, reviewAllocation(item), {
    runner: createDayPlanningRunner({ provider: world, model: counting, now: () => V21_NOW }),
    provider: world,
    now: () => V21_NOW,
    weather: forecastLookup(world, signal),
    ...(reviewer ? { reviewer } : {}),
  }, {
    signal,
    onReview: (result: OutingReviewOutcome) => {
      outcome = { applied: result.applied, suggestions: result.suggestions.map((item) => ({ action: item.fix.action })) };
    },
  });
  const review = (outcome ?? { applied: [], suggestions: [] }) as ReviewOutcome;
  return score(item, policy, generated, review, {
    modelRequests,
    mapRequests: world.searches.length + world.routes + world.details + world.weatherCalls,
    elapsedMs: Date.now() - started,
  });
}

export function score(
  item: ReviewCase,
  policy: Policy,
  generated: readonly GeneratedDay[],
  review: ReviewOutcome,
  cost: { readonly modelRequests: number; readonly mapRequests: number; readonly elapsedMs: number },
): ReviewRow {
  const wetDates = new Set(FORECASTS[item.forecast].filter((day) => day.wet).map((day) => day.date));
  let idleMinutes = 0;
  let overloadedDays = 0;
  let wetOutdoor = 0;
  const violations: string[] = [];
  const placedOn = new Map<string, number>();
  const interestsPlaced = new Set<string>();
  const days = generated.map((entry) => {
    const { result } = entry;
    if (result.status !== "draft") return { day: entry.day, outcome: result.status, stops: [] as string[] };
    const stops: string[] = [];
    let overloaded = false;
    for (const part of result.parts) {
      if (part.kind === "transfer") {
        stops.push("transfer");
        const given = item.transfers.find((transfer) => transfer.day === entry.day && transfer.mode === part.mode);
        if (given?.departAt && minutes(given.departAt) !== part.departAt) violations.push(`train_moved:d${entry.day}`);
        if (given?.arriveAt && minutes(given.arriveAt) !== part.arriveAt) violations.push(`train_moved:d${entry.day}`);
        continue;
      }
      const segment = result.split.segments[part.segment];
      if (!segment) continue;
      if (part.kind === "connect") {
        const wait = segment.endsAt - part.arrivesAt;
        if (wait >= IDLE_MINUTES) idleMinutes += wait;
        continue;
      }
      const { draft } = part;
      const gaps = [
        ...draft.activities.slice(1).map((activity, index) =>
          activity.startsAt - draft.activities[index]!.endsAt - draft.legs[index + 1]!.travelMinutes - draft.legs[index + 1]!.bufferMinutes),
        segment.endsAt - draft.endArrival,
      ];
      for (const gap of gaps) if (gap >= IDLE_MINUTES) idleMinutes += gap;
      const busy = draft.activities.reduce((total, activity) => total + activity.endsAt - activity.startsAt, 0) +
        draft.legs.reduce((total, leg) => total + leg.travelMinutes, 0);
      if (draft.endArrival > segment.endsAt - 30 || busy > 0.9 * (segment.endsAt - segment.startsAt)) overloaded = true;
      for (const activity of draft.activities) {
        const id = idOf(draft.places.find((place) => place.placeId === activity.placeId)!.name);
        stops.push(id);
        if (activity.interest) interestsPlaced.add(activity.interest);
        if (activity.role === "discovered") continue;
        placedOn.set(id, entry.day);
        const visit = item.visits.find((candidate) => candidate.place === id);
        if (wetDates.has(entry.date) && worldPlaceByName(draft.places.find((place) => place.placeId === activity.placeId)!.name)?.indoor === false) wetOutdoor += 1;
        if (!visit) continue;
        if (visit.role === "fixed" && (activity.startsAt !== minutes(visit.startsAt!) || activity.endsAt !== minutes(visit.endsAt!))) {
          violations.push(`fixed_moved:${id}`);
        }
        if (visit.role !== "fixed" && visit.stayMinutes !== undefined && !visit.estimate && activity.endsAt - activity.startsAt !== visit.stayMinutes) {
          violations.push(`stay_changed:${id}`);
        }
      }
      // 兴趣找到的地点也可能在户外：雨天按地点算。
      for (const activity of draft.activities.filter((candidate) => candidate.role === "discovered")) {
        const place = worldPlaceByName(draft.places.find((candidate) => candidate.placeId === activity.placeId)!.name);
        if (wetDates.has(entry.date) && place?.indoor === false) wetOutdoor += 1;
      }
    }
    if (overloaded) overloadedDays += 1;
    return { day: entry.day, outcome: "draft", stops };
  });
  for (const visit of item.visits) {
    const day = placedOn.get(visit.place);
    if (visit.day && day !== undefined && day !== visit.day) violations.push(`pinned_moved:${visit.place}`);
    const allDrafted = days.every((entry) => entry.outcome === "draft");
    if (visit.role !== "optional" && day === undefined && allDrafted) violations.push(`required_missing:${visit.place}`);
  }
  const unplaced = [
    ...item.visits.filter((visit) => !placedOn.has(visit.place)).map((visit) => visit.place),
    ...item.interests.filter((interest) => !interestsPlaced.has(interest.id)).map((interest) => interest.id),
  ];
  const problems: ReviewProblem[] = [
    ...(idleMinutes > 0 ? ["idle" as const] : []),
    ...(unplaced.length ? ["unplaced" as const] : []),
    ...(overloadedDays ? ["overloaded" as const] : []),
    ...(wetOutdoor ? ["wet" as const] : []),
  ];
  const applied = review.applied.map((fix) => fix.action);
  const suggestions = review.suggestions.map((fix) => fix.action);
  const wanted = item.expect.suggest;
  return {
    suite: "review",
    caseId: item.id,
    policy,
    heldOut: !!item.heldOut,
    review: outingReview(),
    days,
    idleMinutes,
    unplaced,
    overloadedDays,
    wetOutdoor,
    violations: [...new Set(violations)],
    applied,
    suggestions,
    falsePositive: !!item.expect.noChange && (applied.length > 0 || suggestions.length > 0),
    suggestionHit: wanted ? wanted.some((action: ReviewAction) => suggestions.includes(action) || applied.includes(action)) : null,
    problems,
    ...cost,
  };
}
