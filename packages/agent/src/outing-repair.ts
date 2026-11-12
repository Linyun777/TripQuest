import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { outingFrames, type Allocation } from "@tripquest/application/outing-allocation";
import type { ReviewFix } from "@tripquest/application/outing-review-contract";
import { clock } from "@tripquest/application/transfer-day";
import { planOutingDay, type GeneratedDay, type OutingDependencies, type OutingInput } from "./outing-generate";
import type { ModelReply } from "./contracts";
import {
  checkFixes,
  improved,
  movedAllocation,
  placedRefs,
  reviewContext,
  reviewFindings,
  reviewScore,
  type ReviewRequest,
  type ReviewScore,
} from "./outing-review";
import type { JudgeProblem, JudgeVerdict } from "./outing-judge";
import { currentRun } from "./runs";

/**
 * V4.0 审查-修复（stages/V4.0.md）：一条修改放到一份副本上（输入和分配），再把受影响的天重排。用户采纳建议时卡片
 * 上发生的事（apps/web 的 adoptedDraft）在这里按规划输入做一遍：挪天、对调用“移到第几天”（同时固定在那天），
 * 加兴趣写进那天，不自驾记进 noDriving，去掉地点从卡片和分配里拿掉。评测模拟采纳、审查-修复 Agent 试排都用它。
 */
export interface AdoptedFix {
  readonly input: OutingInput;
  readonly allocation: Allocation;
  /** 要重排的天（按先后）。 */
  readonly affected: readonly number[];
  /** 加兴趣时新兴趣的编号（看它排上没有）。 */
  readonly added?: string;
}

const dayOf = (allocation: Allocation, ref: string) =>
  allocation.days.find((entry) => entry.visits.includes(ref) || entry.interests.includes(ref))?.day;

/** “移到第几天”：分配跟着挪，这一项固定在那天（兴趣同时去掉“每天都要”）。 */
function pinned(input: OutingInput, ref: string, day: number): OutingInput {
  return {
    ...input,
    visits: input.visits.map((visit) => (visit.key === ref ? { ...visit, day } : visit)),
    interests: input.interests.map((interest) => {
      if (interest.id !== ref) return interest;
      const { perDay, ...rest } = interest;
      void perDay;
      return { ...rest, day };
    }),
  };
}

/** 一条修改放到副本上；放不进去（编号不对、不能那样改）返回 null。 */
export function adoptFix(input: OutingInput, allocation: Allocation, fix: ReviewFix): AdoptedFix | null {
  const days = outingFrames(input).map((frame) => frame.day);
  const sorted = (list: readonly number[]) => [...new Set(list)].sort((a, b) => a - b);
  switch (fix.action) {
    case "move_visit":
    case "move_interest": {
      const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
      const from = dayOf(allocation, ref);
      const known = ref.startsWith("v") ? input.visits.some((visit) => visit.key === ref) : input.interests.some((item) => item.id === ref);
      if (!known || !days.includes(fix.toDay)) return null;
      return {
        input: pinned(input, ref, fix.toDay),
        allocation: movedAllocation(allocation, ref, fix.toDay),
        affected: sorted([...(from ? [from] : []), fix.toDay]),
      };
    }
    case "swap_days_content": {
      const [a, b] = fix.days;
      if (a === b || !days.includes(a) || !days.includes(b)) return null;
      const movable = (day: number) => {
        const entry = allocation.days.find((item) => item.day === day);
        const visits = (entry?.visits ?? []).filter((key) => input.visits.find((visit) => visit.key === key)?.role !== "fixed");
        return [...visits, ...(entry?.interests ?? [])];
      };
      let next = input;
      let moved = allocation;
      for (const [ref, to] of [...movable(a).map((ref) => [ref, b] as const), ...movable(b).map((ref) => [ref, a] as const)]) {
        next = pinned(next, ref, to);
        moved = movedAllocation(moved, ref, to);
      }
      return { input: next, allocation: moved, affected: sorted([a, b]) };
    }
    case "add_interest": {
      if (!days.includes(fix.day)) return null;
      const id = `i${input.interests.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0) + 1}`;
      return {
        input: { ...input, interests: [...input.interests, { id, text: fix.text, ...(fix.when ? { when: fix.when } : {}), day: fix.day }] },
        allocation: {
          days: allocation.days.map((entry) => (entry.day === fix.day ? { ...entry, interests: [...entry.interests, id] } : entry)),
        },
        affected: [fix.day],
        added: id,
      };
    }
    case "set_day_travel": {
      if (!days.includes(fix.day) || fix.remove.some((mode) => mode !== "driving")) return null;
      return { input: { ...input, noDriving: sorted([...(input.noDriving ?? []), fix.day]) }, allocation, affected: [fix.day] };
    }
    case "drop_visit": {
      if (!input.visits.some((visit) => visit.key === fix.visit)) return null;
      const from = dayOf(allocation, fix.visit);
      return {
        input: { ...input, visits: input.visits.filter((visit) => visit.key !== fix.visit) },
        allocation: { days: allocation.days.map((entry) => ({ ...entry, visits: entry.visits.filter((key) => key !== fix.visit) })) },
        affected: from ? [from] : [],
      };
    }
  }
}

/**
 * 只重排这几天（同页面上“重排这一天”）：排除列表是其余各天按兴趣找到的地点，加上前面重排的天新找到的。
 * 返回重排后的那几天；一天出错照实留在结果里（排不开 / 失败），不影响别的天。
 */
export async function replanDays(
  input: OutingInput,
  allocation: Allocation,
  days: readonly number[],
  others: readonly GeneratedDay[],
  dependencies: OutingDependencies,
  signal: AbortSignal,
): Promise<GeneratedDay[]> {
  const frames = outingFrames(input);
  const exclude = others.filter((day) => !days.includes(day.day)).flatMap((day) => day.discovered);
  const result: GeneratedDay[] = [];
  for (const day of days) {
    const frame = frames.find((item) => item.day === day);
    if (!frame) continue;
    const planned = await planOutingDay(input, allocation, frame, exclude, dependencies, { signal });
    exclude.push(...planned.discovered.filter((id) => !exclude.includes(id)));
    result.push(planned);
  }
  return result;
}

/**
 * 采纳后的结果（评测“采纳建议后能不能排出”）：planned 是受影响的天都排出来了；placed 是采纳的那件事落到了方案上
 * （挪的那项排在目标那天、加的兴趣排上了；对调、不自驾、去掉地点只看排出来没有，为 null）。
 */
export function adoptionOutcome(
  adopted: AdoptedFix,
  fix: ReviewFix,
  replanned: readonly GeneratedDay[],
): { readonly planned: boolean; readonly placed: boolean | null } {
  const planned = replanned.length === adopted.affected.length && replanned.every((day) => day.result.status === "draft");
  const on = (day: number) => {
    const found = replanned.find((item) => item.day === day);
    return found ? placedRefs(adopted.input, found) : new Set<string>();
  };
  switch (fix.action) {
    case "move_visit":
      return { planned, placed: on(fix.toDay).has(fix.visit) };
    case "move_interest":
      return { planned, placed: on(fix.toDay).has(fix.interest) };
    case "add_interest":
      return { planned, placed: !!adopted.added && on(fix.day).has(adopted.added) };
    default:
      return { planned, placed: null };
  }
}

// ---- V4.0 审查-修复 Agent（stages/V4.0.md §3.1–3.3）：模型每轮选一个动作，代码检查、试排、判断留下或建议 ----

export const REPAIR_PROMPT_VERSION = "outing-repair.v2";
/** 一次审查的上限（§3.2）：模型请求、试排次数（每次最多重排 2 天）、总时长。V4.7：60 → 75 秒（判断和复查也在里面）。 */
export const REPAIR_LIMITS = { model: 8, trials: 4, ms: 75_000 } as const;
/** V4.7 §3.4：每次审查最多问几次“这条问题解决了没有”；加上开始和结束各一次判断，审查多 5 次模型请求。 */
export const JUDGE_RECHECKS = 3;
export const JUDGE_CALLS = JUDGE_RECHECKS + 2;

const reason = z.string().trim().min(1).max(80);
const dayNo = z.number().int().min(1).max(7);
/** V4.7：这次试排针对哪一条判断问题（judged 里的 q 编号）。 */
const target = z.string().regex(/^q\d$/).optional();
export const repairActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("try_move"), item: z.string().regex(/^(v|i)\d{1,2}$/), toDay: dayNo, reason, target }),
  // 验收反馈（R10）：一次试排同时挪两项，每项各自过检查，留下时整体判断变好。
  z.strictObject({
    action: z.literal("try_moves"),
    moves: z.tuple([
      z.strictObject({ item: z.string().regex(/^(v|i)\d{1,2}$/), toDay: dayNo }),
      z.strictObject({ item: z.string().regex(/^(v|i)\d{1,2}$/), toDay: dayNo }),
    ]),
    reason,
    target,
  }),
  z.strictObject({ action: z.literal("try_swap"), days: z.tuple([dayNo, dayNo]), reason, target }),
  z.strictObject({
    action: z.literal("try_add_interest"),
    day: dayNo,
    text: z.string().trim().min(1).max(40),
    when: z.enum(["morning", "noon", "afternoon", "dusk", "evening"]).optional(),
    reason,
    target,
  }),
  z.strictObject({ action: z.literal("try_travel"), day: dayNo, remove: z.tuple([z.literal("driving")]), reason, target }),
  z.strictObject({ action: z.literal("try_drop"), item: z.string().regex(/^v\d{1,2}$/), reason, target }),
  z.strictObject({ action: z.literal("keep"), trial: z.string().regex(/^t\d{1,2}$/) }),
  z.strictObject({ action: z.literal("suggest"), trial: z.string().regex(/^t\d{1,2}$/) }),
  z.strictObject({ action: z.literal("finish") }),
]);
export type RepairAction = z.infer<typeof repairActionSchema>;

const moveFix = (item: string, toDay: number, why: string): ReviewFix => (item.startsWith("v")
  ? { action: "move_visit", visit: item, toDay, reason: why }
  : { action: "move_interest", interest: item, toDay, reason: why });

/** try_* 换成审查原来的修改（检查规则 checkFixes、采纳 adoptedDraft 都按它）；try_moves 是两条。 */
export function fixesOf(action: Extract<RepairAction, { action: `try_${string}` }>): ReviewFix[] {
  return action.action === "try_moves"
    ? action.moves.map((move) => moveFix(move.item, move.toDay, action.reason))
    : [fixOf(action)];
}

export function fixOf(action: Exclude<Extract<RepairAction, { action: `try_${string}` }>, { action: "try_moves" }>): ReviewFix {
  switch (action.action) {
    case "try_move":
      return action.item.startsWith("v")
        ? { action: "move_visit", visit: action.item, toDay: action.toDay, reason: action.reason }
        : { action: "move_interest", interest: action.item, toDay: action.toDay, reason: action.reason };
    case "try_swap":
      return { action: "swap_days_content", days: action.days, reason: action.reason };
    case "try_add_interest":
      return { action: "add_interest", day: action.day, text: action.text, ...(action.when ? { when: action.when } : {}), reason: action.reason };
    case "try_travel":
      return { action: "set_day_travel", day: action.day, remove: ["driving"], reason: action.reason };
    case "try_drop":
      return { action: "drop_visit", visit: action.item, reason: action.reason };
  }
}

/** 当前方案：输入、分配、每天的结果。keep 之后换成试排的那份。 */
export interface RepairPlan {
  readonly input: OutingInput;
  readonly allocation: Allocation;
  readonly days: readonly GeneratedDay[];
}

/** 一天的指标（给模型看前后对比，也用来写“已试排”）。 */
export interface DayMetrics {
  readonly idleMinutes: number;
  readonly unplaced: number;
  readonly overloaded: boolean;
  readonly wetOutdoor: number;
  readonly planned: boolean;
}

export function dayMetrics(plan: RepairPlan, day: number): DayMetrics {
  const findings = reviewFindings(plan.input, plan.allocation, plan.days, [day]);
  const score = reviewScore(findings);
  return {
    idleMinutes: score.idleMinutes,
    unplaced: score.unplaced,
    overloaded: score.overloadedDays > 0,
    wetOutdoor: score.wetOutdoor,
    planned: plan.days.find((item) => item.day === day)?.result.status === "draft",
  };
}

/** 用户硬约束（§3.3）：排出来的天里，分到这天的必去和固定事项都要在，固定事项按用户的时刻。 */
export function hardViolations(plan: RepairPlan): string[] {
  const problems: string[] = [];
  for (const day of plan.days) {
    if (day.result.status !== "draft") continue;
    const entry = plan.allocation.days.find((item) => item.day === day.day);
    const placed = placedRefs(plan.input, day);
    for (const key of entry?.visits ?? []) {
      const visit = plan.input.visits.find((item) => item.key === key);
      if (visit && visit.role !== "optional" && !placed.has(key)) problems.push(`missing:${key}`);
      if (visit?.day !== undefined && visit.day !== day.day) problems.push(`pinned:${key}`);
    }
  }
  return problems;
}

/** 一次试排（§3.1）：在副本上改、重排受影响的天，记下前后指标。base 是试排时当前方案的版本（keep 之后旧的试排作废）。 */
export interface RepairTrial {
  readonly id: string;
  readonly fix: ReviewFix;
  /** 一次挪两项时的第二项（只能直接留下，不作为建议）。 */
  readonly also?: ReviewFix;
  /** direct：挪没指定天、不是必去的项目，变好可以直接留下；suggest：只能作为建议。 */
  readonly kind: "direct" | "suggest";
  readonly base: number;
  readonly plan: RepairPlan;
  readonly affected: readonly number[];
  readonly before: ReviewScore;
  readonly after: ReviewScore;
  readonly days: readonly { readonly day: number; readonly before: DayMetrics; readonly after: DayMetrics; readonly summary: string }[];
  readonly planned: boolean;
  readonly improved: boolean;
  /**
   * 去掉了“车在别的城市还按自驾”（V3.2 的分数不算这一项，改了之后路上可能更久，空闲多一点）：没有新增排不开的天、
   * 没排上的不变多，就可以建议（开发轮 R04：不自驾试排出来、空闲多 20 分钟，按分数算不上变好）。
   */
  readonly fixesTravel: boolean;
  readonly violations: number;
  /** V4.7：带 target 的试排，判断说解决了没有、有没有新问题（没问或问不出时没有）。 */
  readonly verdict?: JudgeVerdict & { readonly target: string };
}

/** 数字没有变差（四项都不增加、没有新增排不开的天）。 */
function notWorse(before: ReviewScore, after: ReviewScore): boolean {
  if (after.noPlanDays > before.noPlanDays) return false;
  return (["idleMinutes", "unplaced", "overloadedDays", "wetOutdoor"] as const).every((key) => after[key] <= before[key]);
}

/** V4.7 §3.4：判断说这条问题解决了、没有新问题，数字也没变差（可以直接留下）。 */
export function solvedByJudge(trial: RepairTrial): boolean {
  return !!trial.verdict?.resolved && !trial.verdict.newProblem && notWorse(trial.before, trial.after);
}

/**
 * 可以作为建议：判断说解决了、没有新问题，除空闲外的数字没变差。挪走一项后空闲常会跳一下（3 小时以上才算，开发轮 Q01：425 → 555 分），
 * 用户要的事做到了比这更要紧；是否采纳由用户定，“已试排”里写明空闲的变化。自动留下仍按 solvedByJudge。
 */
export function suggestableByJudge(trial: RepairTrial): boolean {
  return !!trial.verdict?.resolved && !trial.verdict.newProblem && notWorse({ ...trial.before, idleMinutes: 0 }, { ...trial.after, idleMinutes: 0 });
}

const hours = (value: number) => `${Math.round(value / 6) / 10} 小时`;

/** 一天方案的一句摘要：几点到几点在哪（只有名称）。 */
function daySummary(input: OutingInput, day: GeneratedDay | undefined): string {
  if (!day) return "没有重排";
  if (day.result.status !== "draft") return `排不开（${day.result.status === "no_plan" ? day.result.reason : day.result.status}）`;
  const stops = day.result.parts.flatMap((part) => (part.kind === "plan"
    ? part.draft.activities.map((activity) => {
      const name = part.draft.places.find((place) => place.placeId === activity.placeId)?.name ?? "";
      return `${clock(activity.startsAt)}-${clock(activity.endsAt)} ${name.slice(0, 20)}`;
    })
    : []));
  void input;
  return stops.join("；").slice(0, 300) || "这天没有地点";
}

/** “已试排：……”（建议上给用户看的一句，§1）。 */
export function triedText(trial: RepairTrial): string {
  const parts = trial.days.map((item) => {
    const changes: string[] = [];
    if (item.before.idleMinutes !== item.after.idleMinutes) {
      changes.push(item.after.idleMinutes > item.before.idleMinutes
        ? `空闲从 ${hours(item.before.idleMinutes)}变成 ${hours(item.after.idleMinutes)}`
        : `空闲从 ${hours(item.before.idleMinutes)}${item.after.idleMinutes ? `降到 ${hours(item.after.idleMinutes)}` : "降到没有"}`);
    }
    if (item.before.unplaced !== item.after.unplaced) changes.push(`没排上的从 ${item.before.unplaced} 个到 ${item.after.unplaced} 个`);
    if (item.before.wetOutdoor !== item.after.wetOutdoor) changes.push(`雨天户外从 ${item.before.wetOutdoor} 站到 ${item.after.wetOutdoor} 站`);
    if (item.before.overloaded && !item.after.overloaded) changes.push("不再太满");
    if (trial.fixesTravel && trial.fix.action === "set_day_travel" && trial.fix.day === item.day) changes.push("不再按自驾排");
    return changes.length ? `第 ${item.day} 天${changes.join("、")}` : "";
  }).filter(Boolean);
  return `已试排：${parts.join("；") || "受影响的天都排得出来"}`.slice(0, 120);
}

export interface RepairContext {
  readonly scope?: readonly number[];
  readonly dependencies: OutingDependencies;
  readonly signal: AbortSignal;
}

/**
 * 执行一个 try_*（§3.1）：先过原来的检查规则（不合格直接回原因，不重排、不花地图请求）；合格的在副本上改、重排受影响
 * 的天。能直接留下的挪动只换分配（同 V3.2 的直接修改）；只能建议的按采纳时卡片上的改法改（固定到那天等）。
 */
export async function tryFix(
  current: RepairPlan,
  version: number,
  id: string,
  fix: ReviewFix,
  context: RepairContext,
  also?: ReviewFix,
  targeted = false,
): Promise<{ readonly trial: RepairTrial } | { readonly rejected: string }> {
  const findings = reviewFindings(current.input, current.allocation, current.days, context.scope);
  const fixes = also ? [fix, also] : [fix];
  const checked = checkFixes(fixes, { input: current.input, allocation: current.allocation, days: current.days, findings, targeted });
  if (checked.rejected.length) return { rejected: checked.rejected[0]!.detail };
  if (also && checked.direct.length !== 2) {
    return { rejected: "two moves at once only for items you may move yourself (not pinned, not required); try them one at a time" };
  }
  const kind = checked.direct.length ? "direct" as const : "suggest" as const;
  if (context.scope && (kind !== "direct" || !("toDay" in fix))) return { rejected: "after a change only moves between the changed days can be tried" };
  // 能直接留下的挪动只换分配（同 V3.2 的直接修改）；两项依次挪。
  const directMove = (): AdoptedFix => {
    let allocation = current.allocation;
    const affected = new Set<number>();
    for (const item of fixes) {
      if (item.action !== "move_visit" && item.action !== "move_interest") continue;
      const ref = item.action === "move_visit" ? item.visit : item.interest;
      const from = dayOf(allocation, ref);
      if (from) affected.add(from);
      affected.add(item.toDay);
      allocation = movedAllocation(allocation, ref, item.toDay);
    }
    return { input: current.input, allocation, affected: [...affected].sort((a, b) => a - b) };
  };
  const adopted = kind === "direct" && "toDay" in fix ? directMove() : adoptFix(current.input, current.allocation, fix);
  if (!adopted) return { rejected: "this change cannot be applied to the trip" };
  // 每次试排最多重排 2 天（§3.2）。
  if (adopted.affected.length > 2) return { rejected: "the two moves together change more than 2 days; move between the same two days" };
  if (context.scope && adopted.affected.some((day) => !context.scope!.includes(day))) {
    return { rejected: "after a change only moves between the changed days can be tried" };
  }
  const replanned = await replanDays(adopted.input, adopted.allocation, adopted.affected, current.days, context.dependencies, context.signal);
  const days = current.days.map((day) => replanned.find((item) => item.day === day.day) ?? day);
  const plan: RepairPlan = { input: adopted.input, allocation: adopted.allocation, days };
  const before = reviewScore(findings);
  const after = reviewScore(reviewFindings(plan.input, plan.allocation, plan.days, context.scope));
  const planned = adopted.affected.every((day) => replanned.find((item) => item.day === day)?.result.status === "draft");
  const breaks = (value: RepairPlan) =>
    reviewFindings(value.input, value.allocation, value.days, context.scope).filter((item) => item.kind === "travel_break").length;
  return {
    trial: {
      id,
      fix,
      ...(also ? { also } : {}),
      kind,
      base: version,
      plan,
      affected: adopted.affected,
      before,
      after,
      days: adopted.affected.map((day) => ({
        day,
        before: dayMetrics(current, day),
        after: dayMetrics(plan, day),
        summary: daySummary(plan.input, replanned.find((item) => item.day === day)),
      })),
      planned,
      improved: improved(before, after),
      fixesTravel: breaks(plan) < breaks(current) && after.noPlanDays <= before.noPlanDays && after.unplaced <= before.unplaced,
      violations: hardViolations(plan).length - hardViolations(current).length,
    },
  };
}

/** keep 的检查（§3.1）：能直接留下的那种、基于当前方案、变好、没有新的违例。 */
export function keepProblem(trial: RepairTrial, version: number): string | null {
  if (trial.base !== version) return `${trial.id} was tried on an older plan; try it again`;
  if (trial.kind !== "direct") return `${trial.id} changes what the user asked for; only suggest it`;
  if (!trial.improved && !solvedByJudge(trial)) return `${trial.id} did not make the trip better`;
  if (trial.violations > 0) return `${trial.id} breaks something the user fixed`;
  return null;
}

/** suggest 的检查（§3.1）：基于当前方案、受影响的天都排出来了、至少一项变好且没有一项变差。 */
export function suggestProblem(trial: RepairTrial, version: number, scoped: boolean): string | null {
  if (scoped) return "no suggestions after a change";
  if (trial.also) return `${trial.id} moves two items at once; it can only be kept`;
  if (trial.base !== version) return `${trial.id} was tried on an older plan; try it again`;
  if (!trial.planned) return `${trial.id} leaves a day without a plan`;
  if (!trial.improved && !trial.fixesTravel && !suggestableByJudge(trial)) return `${trial.id} did not make the trip better`;
  if (trial.violations > 0) return `${trial.id} breaks something the user fixed`;
  return null;
}

export const REPAIR_SYSTEM_PROMPT = `You repair a multi-day trip in China that has already been planned day by day. Code has listed the problems
it found ("findings"). You work in steps: each step, return exactly one action as a JSON object whose "action" field names it,
with that action's fields next to it, e.g. {"action":"finish"}.
Actions:
- try_move {"item","toDay","reason"}: move a place (v...) or an interest (i...) to another day.
- try_moves {"moves":[{"item","toDay"},{"item","toDay"}],"reason"}: move two items in one trial, between the same two days, when
  one move alone leaves a day too full or another still empty. Only for items you may keep moving (not pinned, not required).
- try_swap {"days":[a,b],"reason"}: swap what two days do (fixed items stay where they are).
- try_add_interest {"day","text","when"?,"reason"}: add something to do on a day that has idle time. "text" names an activity,
  never a shop, restaurant or place name; "when" is one of morning, noon, afternoon, dusk, evening.
- try_travel {"day","remove":["driving"],"reason"}: stop driving on a day when the car is in another city.
- try_drop {"item","reason"}: drop an optional place from a day that is too full.
- keep {"trial"}: make a trial the current plan.
- suggest {"trial"}: offer a trial to the user as a suggestion.
- finish {}: stop.
Judged problems:
- "judged" lists what a separate judge found about whether the trip fits what the traveller wants: each has an id (q1...), what is wrong, the days and the card items involved. Treat them like findings; there may be judged problems and no findings.
- When a try_* is meant to solve a judged problem, add "target":"q1". Then the day need not have idle time or be too full, and after planning code asks the judge whether it is solved ("resolved", "newProblem" in "tried").
- If a judged problem cannot be solved with these actions, leave it and finish.
How it works:
- Code checks every try_*; if it passes, the affected days are planned again on a copy and you get a trial id with the numbers
  for those days before and after. Nothing changes until you keep a trial.
- Only a trial marked "canKeep" may be kept; only a trial marked "canSuggest" may be suggested (the user decides). Keep what you
  can keep; suggest what can only be suggested.
- After a keep, earlier trials are gone; try again on the new plan if needed.
- Prefer moving. An item listed as "unplaced" must go to a different day whose window and idle time fit it; an item with "when"
  needs a day that is free at that time. A day with idle time should first take an item from a day that is too full or has
  unplaced items.
- Use try_add_interest only for a day with idle time when nothing on the card can be moved there, at most once per day. Drop a
  place only when it cannot be moved to any day.
- For rain, move the outdoor place to a dry day, or swap with a day whose places are indoor.
- Never move or drop fixed items. Items with "pinnedDay" were put on that day by the user; moving them can only be suggested.
- Do not try the same change twice; "tried" says what was tried and what happened. When nothing more would help, finish.
- Watch "budget": when no trials are left, keep or suggest what helped, then finish.
- "reason" is one short sentence in Chinese saying which problem it solves on which day. Do not mention wishes the user did not
  state.
Return only one JSON object {"action": ..., ...} per step.`;

export interface RepairOutcome {
  /** 最后的方案（最后一次 keep 的，或审查前的）。 */
  readonly plan: RepairPlan;
  /** 留下的试排（按先后）。 */
  readonly kept: readonly RepairTrial[];
  /** 给用户的建议，每条都试排过（tried 是“已试排：……”）。 */
  readonly suggestions: readonly { readonly fix: ReviewFix; readonly tried: string }[];
  readonly trials: number;
  readonly requests: number;
  /** V4.7：这次问了几次模型复查（不算开始和结束那两次判断）。 */
  readonly rechecks?: number;
  readonly stop: "finish" | "solved" | "requests" | "timeout" | "cancelled" | "budget_exhausted" | "model_error" | "repeating";
}

type Tried =
  | { readonly step: number; readonly change: string; readonly result: "rejected" | "failed"; readonly why: string }
  | { readonly step: number; readonly trial: string; readonly change: string; readonly canKeep: boolean; readonly canSuggest: boolean;
    readonly planned: boolean;
    readonly better: boolean; readonly resolved?: boolean; readonly newProblem?: boolean; readonly before: ReviewScore; readonly after: ReviewScore;
    readonly days: RepairTrial["days"] }
  | { readonly step: number; readonly action: string; readonly result: "kept" | "suggested" | "refused" | "invalid"; readonly why?: string };

/** {"actions":[…]} 里的动作（顶层没有 action 时）；不是这种写法返回 null。 */
function actionList(decision: unknown): unknown[] | null {
  if (!decision || typeof decision !== "object" || "action" in decision) return null;
  const actions = (decision as { actions?: unknown }).actions;
  return Array.isArray(actions) && actions.length ? actions : null;
}

const fixes = (fix: ReviewFix, also?: ReviewFix) => (also ? [fix, also] : [fix]);
/** 这条修改动的卡片项（v、i 编号）。 */
const itemOfFix = (fix: ReviewFix): string[] => (fix.action === "move_visit" || fix.action === "drop_visit" ? [fix.visit] : fix.action === "move_interest" ? [fix.interest] : []);

/** 一条修改去掉理由后的样子（同一个改法不试第二次）。 */
const changeKey = (fix: ReviewFix) => {
  const { reason: _reason, ...rest } = fix;
  void _reason;
  return JSON.stringify(rest);
};

/**
 * 跑一次审查-修复（§3.1–3.2）：子图 decide → act，循环到 finish、问题都没了、模型请求 / 时长 / 共用预算用完。
 * 停下时没留下的试排一律丢弃。describe 把修改写成中文（给模型看试过什么）。
 */
export async function runRepair(
  start: RepairPlan,
  request: ReviewRequest,
  context: RepairContext & {
    readonly describe: (plan: RepairPlan, fix: ReviewFix) => string;
    readonly limits?: Partial<typeof REPAIR_LIMITS>;
    readonly now?: () => number;
    /** V4.7：判断问题和怎么复查（没有判断时只按代码找的问题修）。 */
    readonly judgement?: {
      readonly problems: readonly JudgeProblem[];
      readonly recheck: (problem: JudgeProblem, before: RepairPlan, after: RepairPlan, affected: readonly number[]) => Promise<(JudgeVerdict & { readonly asked: boolean }) | null>;
    };
  },
): Promise<RepairOutcome> {
  const limits = { ...REPAIR_LIMITS, ...context.limits };
  const now = context.now ?? Date.now;
  const started = now();
  const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(limits.ms)]);
  let plan = start;
  let version = 0;
  let requests = 0;
  let trials = 0;
  let pendingAction: RepairAction | null = null;
  /**
   * 白费的步数（再试试过的改法、留下或建议被拒）：到 3 就停（开发轮 R10 同一个挪法连发 4 次）。验收反馈：原来到 2 就停，
   * R11 一轮第一次挪没变好、同一个挪法再发两次就停了，没换别的试；重复时明确叫它换一个，再给一次机会。
   */
  let wasted = 0;
  let feedback: string | null = null;
  const tried: Tried[] = [];
  /** 还没解决的判断问题；问模型的复查次数。 */
  const open = new Map((context.judgement?.problems ?? []).map((problem) => [problem.id, problem]));
  let rechecks = 0;
  const keys = new Set<string>();
  const byId = new Map<string, RepairTrial>();
  const kept: RepairTrial[] = [];
  let suggestions: { fix: ReviewFix; tried: string; days: readonly number[] }[] = [];
  const run = currentRun();
  const findingsNow = () => reviewFindings(plan.input, plan.allocation, plan.days, context.scope);

  const stopNow = (): RepairOutcome["stop"] | null => {
    if (context.signal.aborted) return "cancelled";
    if (currentRun()?.root.exhausted) return "budget_exhausted";
    if (now() - started >= limits.ms || deadline.aborted) return "timeout";
    if (!findingsNow().length && !open.size) return "solved";
    if (requests >= limits.model) return "requests";
    return null;
  };

  const State = Annotation.Root({ step: Annotation<number>(), stop: Annotation<RepairOutcome["stop"] | null>() });
  const graph = new StateGraph(State)
    .addNode("decide", async (state: typeof State.State) => {
      const stop = stopNow();
      if (stop) return { stop };
      const findings = findingsNow();
      const content = JSON.stringify({
        trip: reviewContext(plan.input, plan.allocation, plan.days, findings),
        ...(open.size ? { judged: [...open.values()] } : {}),
        budget: {
          requestsLeft: limits.model - requests,
          trialsLeft: limits.trials - trials,
          secondsLeft: Math.max(0, Math.round((limits.ms - (now() - started)) / 1000)),
        },
        tried: tried.slice(-12),
        open: [...byId.values()].filter((trial) => trial.base === version).map((trial) => trial.id),
      });
      requests += 1;
      let reply: ModelReply;
      try {
        // 请求自己不理会取消时也按时停（60 秒是整趟审查的上限）。
        reply = await Promise.race([
          request(REPAIR_SYSTEM_PROMPT, feedback ? `${content}\n\nYour last answer: ${feedback}` : content, deadline),
          new Promise<never>((_, reject) => {
            if (deadline.aborted) reject(new Error("aborted"));
            deadline.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
      } catch {
        return { stop: deadline.aborted && !context.signal.aborted ? "timeout" as const : context.signal.aborted ? "cancelled" as const : "model_error" as const };
      }
      // 模型常按对话 Agent 的写法回 {"actions":[…]}（开发轮 14 题都是）：只有一个就当它，多于一个只用第一个并告诉它。
      const listed = actionList(reply.decision);
      const parsed = repairActionSchema.safeParse(listed ? listed[0] : reply.decision);
      if (listed && listed.length > 1 && parsed.success) feedback = "only the first action was used; return one action per step";
      if (!parsed.success) {
        // 说清哪一项不对（字段名和问题，不带内容），否则模型会原样再发（开发轮 14 题全是这样）。
        const issues = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`.slice(0, 120));
        feedback = `not accepted (${issues.join("; ")}); return exactly one action as JSON with only the fields described`;
        tried.push({ step: state.step, action: "unreadable", result: "invalid", why: feedback });
        const keys = reply.decision && typeof reply.decision === "object" ? Object.keys(reply.decision).slice(0, 8) : [typeof reply.decision];
        run?.step("repair", "invalid", { issues, keys });
        return { step: state.step + 1 };
      }
      if (!(listed && listed.length > 1)) feedback = null;
      pendingAction = parsed.data;
      return {};
    })
    .addNode("act", async (state: typeof State.State) => {
      const action = pendingAction!;
      pendingAction = null;
      const step = state.step;
      if (action.action === "finish") {
        run?.step("tool_call", "finish", {});
        return { stop: "finish" as const, step: step + 1 };
      }
      if (action.action === "keep" || action.action === "suggest") {
        const trial = byId.get(action.trial);
        const problem = !trial ? `${action.trial} is not a trial`
          : action.action === "keep" ? keepProblem(trial, version) : suggestProblem(trial, version, !!context.scope);
        if (problem || !trial) {
          tried.push({ step, action: `${action.action} ${action.trial}`, result: "refused", why: problem ?? "" });
          run?.step("check", action.action, { trial: action.trial, refused: problem });
          wasted += 1;
          return { step: step + 1, ...(wasted >= 3 ? { stop: "repeating" as const } : {}) };
        }
        if (action.action === "keep") {
          plan = trial.plan;
          version += 1;
          kept.push(trial);
          if (trial.verdict?.resolved) open.delete(trial.verdict.target);
          // 改了这几天之后，涉及同几天的建议不再作数（它们是在旧方案上试的）。
          suggestions = suggestions.filter((item) => !item.days.some((day) => trial.affected.includes(day)));
          tried.push({ step, action: `keep ${trial.id}`, result: "kept" });
        } else if (!suggestions.some((item) => changeKey(item.fix) === changeKey(trial.fix))) {
          suggestions.push({ fix: trial.fix, tried: triedText(trial), days: trial.affected });
          tried.push({ step, action: `suggest ${trial.id}`, result: "suggested" });
        }
        run?.step("tool_call", action.action, { trial: trial.id, fix: trial.fix.action, before: trial.before, after: trial.after });
        return { step: step + 1 };
      }
      const [fix, also] = fixesOf(action) as [ReviewFix, ReviewFix | undefined];
      const change = [fix, ...(also ? [also] : [])].map((item) => context.describe(plan, item)).join("；");
      const key = [fix, ...(also ? [also] : [])].map(changeKey).sort().join("+");
      if (keys.has(key)) {
        tried.push({ step, change, result: "rejected", why: "this change was already tried" });
        feedback = "that change was already tried (see \"tried\"); pick a different item or day, or finish";
        run?.step("check", action.action, { rejected: "duplicate" });
        wasted += 1;
        return { step: step + 1, ...(wasted >= 3 ? { stop: "repeating" as const } : {}) };
      }
      if (trials >= limits.trials) {
        tried.push({ step, change, result: "rejected", why: "no trials left; keep or suggest a trial that helped, or finish" });
        run?.step("check", action.action, { rejected: "no_trials_left" });
        return { step: step + 1 };
      }
      keys.add(key);
      const id = `t${trials + 1}`;
      // 模型常忘了写 target（开发轮 Q09）：这次改的卡片项正是某条判断问题涉及的，就算针对它。
      const named = fixes(fix, also).flatMap(itemOfFix);
      const aimed = ("target" in action && action.target ? open.get(action.target) : undefined)
        ?? [...open.values()].find((problem) => problem.items.some((item) => named.includes(item)));
      const outcome = await tryFix(plan, version, id, fix, { ...context, signal: deadline }, also, !!aimed).catch(() => null);
      if (!outcome) {
        trials += 1;
        tried.push({ step, change, result: "failed", why: "planning the affected days failed; the plan is unchanged" });
        run?.step("tool_call", action.action, { failed: true });
        return { step: step + 1 };
      }
      if ("rejected" in outcome) {
        tried.push({ step, change, result: "rejected", why: outcome.rejected });
        run?.step("check", action.action, { rejected: outcome.rejected.slice(0, 80) });
        return { step: step + 1 };
      }
      trials += 1;
      let trial = outcome.trial;
      if (aimed && trial.planned && context.judgement && rechecks < JUDGE_RECHECKS) {
        const verdict = await context.judgement.recheck(aimed, plan, trial.plan, trial.affected).catch(() => null);
        if (verdict?.asked) rechecks += 1;
        if (verdict) trial = { ...trial, verdict: { resolved: verdict.resolved, newProblem: verdict.newProblem, target: aimed.id } };
      }
      byId.set(trial.id, trial);
      tried.push({
        // canKeep / canSuggest 由代码按留下、建议的检查算好（R04：不自驾分数没变好，模型就不知道它可以建议）。
        step, trial: trial.id, change,
        canKeep: keepProblem(trial, version) === null,
        canSuggest: suggestProblem(trial, version, !!context.scope) === null,
        planned: trial.planned, better: trial.improved,
        ...(trial.verdict ? { resolved: trial.verdict.resolved, newProblem: trial.verdict.newProblem } : {}),
        before: trial.before, after: trial.after, days: trial.days,
      });
      run?.step("tool_call", action.action, {
        trial: trial.id, change: change.slice(0, 40), kind: trial.kind, days: trial.affected, planned: trial.planned, improved: trial.improved,
        ...(trial.verdict ? { target: trial.verdict.target, resolved: trial.verdict.resolved, newProblem: trial.verdict.newProblem } : {}),
        before: trial.before, after: trial.after,
      });
      return { step: step + 1 };
    })
    .addEdge(START, "decide")
    .addConditionalEdges("decide", (state: typeof State.State) => (state.stop ? END : pendingAction ? "act" : "decide"))
    .addConditionalEdges("act", (state: typeof State.State) => (state.stop ? END : "decide"))
    .compile();
  const final = await graph.invoke({ step: 1, stop: null }, { recursionLimit: 64 }) as typeof State.State;
  return {
    plan,
    kept,
    suggestions: suggestions.map(({ fix, tried: text }) => ({ fix, tried: text })),
    trials,
    requests,
    rechecks,
    stop: final.stop ?? "finish",
  };
}

/**
 * V4.1 建议先试排（stages/V4.1.md §3.5）：单步审查给出的“加兴趣”建议按顺序最多试 2 条，每条用模拟采纳（adoptFix +
 * 只重排受影响的天）试排一次；排上了（这天排出、加的兴趣在方案里）才留下，写“已试排：……”；排不上、出错、超时都不给，
 * 超出 2 条的不试也不给。别的建议（挪天、对调、不自驾、去掉地点）原样保留。
 */
export const SUGGESTION_TRIALS = 2;

export async function trySuggestions(
  plan: RepairPlan,
  suggestions: readonly ReviewFix[],
  dependencies: OutingDependencies,
  signal: AbortSignal,
): Promise<{ readonly kept: readonly { readonly fix: ReviewFix; readonly tried?: string }[]; readonly tried: number; readonly landed: number }> {
  const kept: { fix: ReviewFix; tried?: string }[] = [];
  let tried = 0;
  let landed = 0;
  for (const fix of suggestions) {
    if (fix.action !== "add_interest") {
      kept.push({ fix });
      continue;
    }
    if (tried >= SUGGESTION_TRIALS || signal.aborted) continue;
    tried += 1;
    const adopted = adoptFix(plan.input, plan.allocation, fix);
    if (!adopted?.added) continue;
    const replanned = await replanDays(adopted.input, adopted.allocation, adopted.affected, plan.days, dependencies,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)])).catch(() => null);
    if (!replanned || !adoptionOutcome(adopted, fix, replanned).planned || !adoptionOutcome(adopted, fix, replanned).placed) continue;
    landed += 1;
    const day = replanned.find((item) => item.day === fix.day);
    const slot = day?.result.status === "draft"
      ? day.result.parts.flatMap((part) => (part.kind === "plan" ? part.draft.activities.filter((activity) => activity.interest === adopted.added)
        .map((activity) => `${clock(activity.startsAt)}–${clock(activity.endsAt)} 在${part.draft.places.find((place) => place.placeId === activity.placeId)?.name ?? ""}`) : []))[0]
      : undefined;
    kept.push({ fix, tried: `已试排：第 ${fix.day} 天加“${fix.text}”后${slot ? ` ${slot}` : "排得上"}`.slice(0, 120) });
  }
  return { kept, tried, landed };
}
