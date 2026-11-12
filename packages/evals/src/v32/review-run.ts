import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { forecastLookup, generateOuting, type GeneratedDay, type OutingInput } from "@tripquest/agent/outing-generate";
import { outingReview, type OutingReviewOutcome } from "@tripquest/agent/outing-graph";
import type { JudgeRequest } from "@tripquest/agent/outing-judge";
import type { ReviewFix, ReviewRequest } from "@tripquest/agent/outing-review";
import { adoptFix, adoptionOutcome, replanDays } from "@tripquest/agent/outing-repair";
import type { LodgingChoice } from "@tripquest/agent/outing-lodging";
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
  /** 审查用的哪种（V4.0 起 agent / single / off；之前的报告是 on / off）。 */
  readonly review: "agent" | "single" | "off" | "on";
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
  /**
   * V4.0（stages/V4.0.md §3.5、§4.1）：每条建议各自模拟采纳（从审查后的方案出发，和用户在卡片上点“采纳”一样改，
   * 再重排受影响的天）：planned 是这几天都排出来了，placed 是采纳的那件事落到了方案上（对调等为 null）。
   * requests 是采纳重排用的模型请求（不算进上面审查这一趟的）。之前的报告没有这一项。
   */
  readonly adoptions?: readonly { readonly action: string; readonly planned: boolean; readonly placed: boolean | null; readonly requests: number }[];
  /**
   * V4.0（只作参考，不是通过标准）：这一趟的建议全部采纳后（按顺序叠加，放不进去的跳过，受影响的天一起重排一次）
   * 的空闲和没排上，看试过的建议值多少。没有建议时等于上面的数。
   */
  readonly allAdopted?: { readonly idleMinutes: number; readonly unplaced: number; readonly requests: number };
  /** V4.7：建议都采纳之后的每天（世界编号、开始时刻），修复题按它判定；没有建议时就是审查后的方案。 */
  readonly finalDays?: readonly { readonly day: number; readonly outcome: string; readonly stops: readonly { readonly id: string; readonly from: number }[] }[];
}

/** 判分只看审查直接改了哪些、建议了哪些（动作类型）；采纳模拟要建议本身。 */
interface ReviewOutcome {
  readonly applied: readonly { readonly action: string }[];
  readonly suggestions: readonly { readonly action: string; readonly fix?: ReviewFix }[];
}

/** 评测世界的地点没有高德分类码（给了也只有几个），判断要的类型按标签给（产品按分类码和名字算）。 */
const WORLD_TYPES: readonly (readonly [RegExp, string])[] = [
  [/咖啡/, "咖啡厅"], [/茶/, "茶馆"], [/酒吧/, "酒吧"], [/餐厅|火锅|海鲜|面馆|小吃|农家菜|美食/, "餐厅"], [/博物馆|陈列馆/, "博物馆"],
  [/寺/, "寺庙"], [/爬山|登山|山顶|索道/, "山岳"], [/海滩|沙滩/, "海滩"], [/古镇/, "古镇"], [/乐园/, "游乐园"], [/公园/, "公园"], [/步行街/, "步行街"], [/商场/, "商场"], [/剧/, "剧场"],
];
export function worldStopType(name: string): string {
  const tags = worldPlaceByName(name)?.tags.join(" ") ?? name;
  return WORLD_TYPES.find(([pattern]) => pattern.test(tags))?.[1] ?? "景点";
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
    /** V4.7 整体判断的模型请求（OUTING_REVIEW=agent 时产品用它）。 */
    readonly judge?: JudgeRequest;
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
  const givenJudge = models?.judge;
  const judge: JudgeRequest | undefined = givenJudge
    ? async (...args) => {
      modelRequests += 1;
      return givenJudge(...args);
    }
    : undefined;
  const { notes, saved, said } = item as { readonly notes?: string; readonly saved?: readonly string[]; readonly said?: readonly string[] };
  const input = {
    ...allocationInput(item),
    pace: "standard" as const,
    cityAdcode: allocationInput(item).start.place.place.cityAdcode ?? "330100",
    ...(notes ? { notes } : {}),
    ...(saved ? { preferences: saved } : {}),
    ...(said ? { said } : {}),
  };
  let outcome: ReviewOutcome | null = null;
  let finalAllocation = reviewAllocation(item);
  let lodging: readonly LodgingChoice[] = [];
  const dependencies = {
    runner: createDayPlanningRunner({ provider: world, model: counting, now: () => V21_NOW }),
    provider: world,
    now: () => V21_NOW,
    weather: forecastLookup(world, signal),
  };
  const generated = await generateOuting(input, finalAllocation, { ...dependencies, ...(reviewer ? { reviewer } : {}), ...(judge ? { judge, stopType: worldStopType } : {}) }, {
    signal,
    onLodging: (choices) => {
      lodging = choices;
    },
    onReview: (result: OutingReviewOutcome) => {
      finalAllocation = result.allocation;
      outcome = {
        applied: result.applied,
        suggestions: result.suggestions.map((entry) => ({ action: entry.fix.action, ...(entry.fix.action !== "choose_lodging" ? { fix: entry.fix } : {}) })),
      };
    },
  });
  const review = (outcome ?? { applied: [], suggestions: [] }) as ReviewOutcome;
  const cost = {
    modelRequests,
    mapRequests: world.searches.length + world.routes + world.details + world.weatherCalls,
    elapsedMs: Date.now() - started,
  };
  // 采纳模拟（V4.0）：住处按这次定的写回输入，每条建议从审查后的方案出发各试一次，互不影响。
  const reviewed = { ...input, lodging: input.lodging.map((night, index) => lodging.find((choice) => choice.nights.includes(index + 1))?.place ?? night) };
  const adoptions: { action: string; planned: boolean; placed: boolean | null; requests: number }[] = [];
  for (const suggestion of review.suggestions) {
    if (!suggestion.fix) continue;
    const before = modelRequests;
    const adopted = adoptFix(reviewed, finalAllocation, suggestion.fix);
    if (!adopted) {
      adoptions.push({ action: suggestion.action, planned: false, placed: false, requests: 0 });
      continue;
    }
    const replanned = await replanDays(adopted.input, adopted.allocation, adopted.affected, generated, dependencies, signal);
    adoptions.push({ action: suggestion.action, ...adoptionOutcome(adopted, suggestion.fix, replanned), requests: modelRequests - before });
  }
  // 全部采纳（参考）：按顺序叠加到同一份副本上，受影响的天合起来重排一次。
  let together: { input: OutingInput; allocation: Allocation } = { input: reviewed, allocation: finalAllocation };
  const touched = new Set<number>();
  for (const suggestion of review.suggestions) {
    const adopted = suggestion.fix ? adoptFix(together.input, together.allocation, suggestion.fix) : null;
    if (!adopted) continue;
    together = { input: adopted.input, allocation: adopted.allocation };
    for (const day of adopted.affected) touched.add(day);
  }
  const base = score(item, policy, generated, review, cost);
  let allAdopted = { idleMinutes: base.idleMinutes, unplaced: base.unplaced.length, requests: 0 };
  let finalDays = finalView(generated);
  if (touched.size) {
    const before = modelRequests;
    const days = [...touched].sort((a, b) => a - b);
    const replanned = await replanDays(together.input, together.allocation, days, generated, dependencies, signal);
    const merged = generated.map((day) => replanned.find((entry) => entry.day === day.day) ?? day);
    finalDays = finalView(merged);
    // 加的兴趣不在题目的卡片上，没排上只按题目原有的项目算（和上面的“没排上”同一口径）。
    const scored = score(item, policy, merged, review, cost);
    allAdopted = { idleMinutes: scored.idleMinutes, unplaced: scored.unplaced.length, requests: modelRequests - before };
  }
  return { ...base, adoptions, allAdopted, finalDays };
}

/** 每天的站（世界编号、开始时刻）。 */
function finalView(days: readonly GeneratedDay[]): NonNullable<ReviewRow["finalDays"]> {
  return days.map((entry) => ({
    day: entry.day,
    outcome: entry.result.status,
    stops: entry.result.status !== "draft" ? [] : entry.result.parts.flatMap((part) => (part.kind !== "plan" ? [] : part.draft.activities.map((activity) => ({
      id: idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name),
      from: activity.startsAt,
    })))),
  }));
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
