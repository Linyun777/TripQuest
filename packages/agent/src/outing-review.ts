import { z } from "zod";
import { isOutdoorPlace } from "@tripquest/application/day-planning";
import { checkAllocation, outingFrames, overfullDays, type Allocation } from "@tripquest/application/outing-allocation";
import { INTEREST_SLOTS } from "@tripquest/application/planning";
import { reviewFixSchema, type ReviewFix } from "@tripquest/application/outing-review-contract";
import { clock } from "@tripquest/application/transfer-day";
import type { ModelReply } from "./contracts";
import type { GeneratedDay, OutingInput } from "./outing-generate";

/**
 * V3.2 出游审查（stages/V3.2.md §3）：一趟出游排完后，代码先按规则找出“排得通但不好”的地方（findings），审查 Agent
 * 只负责从 6 种修改里选“怎么改”；每条修改再由代码检查、分成直接改的（不改变用户意图：挪没指定天的想去地点和兴趣）
 * 和给用户的建议。直接改的重排受影响的天，代码比较前后，变好才留下。
 */
export const REVIEW_PROMPT_VERSION = "outing-review.v1";
/** 审查看的空闲比方案上的提示（4 小时）短一些。 */
export const REVIEW_IDLE_MINUTES = 180;
/** 回住处晚于时间窗结束前这么多分钟、或停留和路程超过可用时间的这个比例，算太满。 */
const LATE_MARGIN_MINUTES = 30;
const BUSY_RATIO = 0.9;
const BAD_WEATHER = /雨|雪|雹|雷/;

export type ReviewFinding =
  | { readonly kind: "idle"; readonly day: number; readonly from: string; readonly to: string; readonly minutes: number }
  | { readonly kind: "unplaced"; readonly day: number; readonly items: readonly string[] }
  | { readonly kind: "no_plan"; readonly day: number; readonly reason: string }
  | { readonly kind: "overloaded"; readonly day: number; readonly lateMinutes: number; readonly busyPercent: number }
  | { readonly kind: "wet_outdoor"; readonly day: number; readonly stops: readonly string[]; readonly weather: string }
  | { readonly kind: "travel_break"; readonly day: number; readonly mode: "driving" };

/** 一天里排上的站（卡片上的地点是 v 编号、兴趣找到的地点带兴趣编号）。 */
interface Stop {
  readonly ref: string | null;
  readonly name: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly role: string;
  readonly outdoor: boolean;
}

function stopsOf(input: OutingInput, day: GeneratedDay): Stop[] {
  if (day.result.status !== "draft") return [];
  return day.result.parts.flatMap((part) => {
    if (part.kind !== "plan") return [];
    const snapshot = day.snapshots.get(part.segment);
    return part.draft.activities.map((activity) => {
      const selection = snapshot?.places.find((place) => place.placeId === activity.placeId)?.selection.place;
      const name = part.draft.places.find((place) => place.placeId === activity.placeId)?.name ?? selection?.name ?? "";
      const visit = input.visits.find((item) => item.place.place.ref.externalId === selection?.ref.externalId);
      const record = snapshot?.activities.find((item) => item.activity.activityId === activity.activityId);
      return {
        ref: visit?.key ?? activity.interest ?? null,
        name,
        startsAt: activity.startsAt,
        endsAt: activity.endsAt,
        role: activity.role,
        outdoor: isOutdoorPlace(record?.kind ?? visit?.kind, selection?.categoryCode),
      };
    });
  });
}

/** 卡片上一项的名字（地点名或兴趣原话）。 */
function itemName(input: OutingInput, ref: string): string {
  return input.visits.find((visit) => visit.key === ref)?.place.place.name
    ?? input.interests.find((interest) => interest.id === ref)?.text
    ?? ref;
}

/**
 * 代码找问题（§3.2）：空闲 ≥ 3 小时、分到这天却没排上、整天排不开、太满、雨天户外、车留在别的城市还按自驾。
 * scope 只看这几天（跨天改动后只看受影响的天）。
 */
export function reviewFindings(
  input: OutingInput,
  allocation: Allocation,
  days: readonly GeneratedDay[],
  scope?: readonly number[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const firstLeave = input.transports
    .filter((item) => item.mode === "train" || item.mode === "flight")
    .map((item) => item.day)
    .sort((a, b) => a - b)[0];
  for (const day of days) {
    if (scope && !scope.includes(day.day)) continue;
    const entry = allocation.days.find((item) => item.day === day.day);
    const given = [...(entry?.visits ?? []), ...(entry?.interests ?? [])];
    const { result } = day;
    if (result.status !== "draft") {
      const reason = result.status === "no_plan" ? result.reason : result.status === "failed" ? result.code : result.status;
      findings.push({ kind: "no_plan", day: day.day, reason });
      if (given.length) findings.push({ kind: "unplaced", day: day.day, items: given });
      continue;
    }
    const stops = stopsOf(input, day);
    const placed = new Set(stops.map((stop) => stop.ref).filter((ref): ref is string => !!ref));
    const missing = given.filter((ref) => !placed.has(ref));
    if (missing.length) findings.push({ kind: "unplaced", day: day.day, items: missing });
    let late = 0;
    let busy = 0;
    for (const part of result.parts) {
      if (part.kind === "transfer") continue;
      const segment = result.split.segments[part.segment];
      if (!segment) continue;
      const idle = (from: number, to: number) => {
        if (to - from >= REVIEW_IDLE_MINUTES) {
          findings.push({ kind: "idle", day: day.day, from: clock(from), to: clock(to), minutes: to - from });
        }
      };
      if (part.kind === "connect") {
        idle(part.arrivesAt, segment.endsAt);
        continue;
      }
      const { draft } = part;
      draft.activities.slice(1).forEach((activity, index) => {
        const leg = draft.legs[index + 1]!;
        idle(draft.activities[index]!.endsAt, activity.startsAt - leg.travelMinutes - leg.bufferMinutes);
      });
      idle(draft.endArrival, segment.endsAt);
      late = Math.max(late, draft.endArrival - (segment.endsAt - LATE_MARGIN_MINUTES));
      const used = draft.activities.reduce((total, activity) => total + activity.endsAt - activity.startsAt, 0) +
        draft.legs.reduce((total, leg) => total + leg.travelMinutes, 0);
      busy = Math.max(busy, used / Math.max(1, segment.endsAt - segment.startsAt));
    }
    if (late > 0 || busy > BUSY_RATIO) {
      findings.push({
        kind: "overloaded",
        day: day.day,
        lateMinutes: Math.max(0, late),
        busyPercent: Math.round(busy * 100),
      });
    }
    const weather = Object.values(day.weather ?? {}).map((item) => item.dayWeather).find((word) => BAD_WEATHER.test(word));
    const wet = weather ? stops.filter((stop) => stop.outdoor) : [];
    if (weather && wet.length) {
      findings.push({ kind: "wet_outdoor", day: day.day, stops: wet.map((stop) => stop.ref ?? stop.name), weather });
    }
    // 车留在出发的城市：坐高铁、飞机离开之后还能自驾就有问题——以后的天，和离开那天交通之后还有安排的段。
    const planAfterTransfer = result.parts.some((part, index) =>
      part.kind === "plan" && result.parts.slice(0, index).some((item) => item.kind === "transfer"));
    const afterLeaving = day.day > (firstLeave ?? Infinity) || (day.day === firstLeave && planAfterTransfer);
    if (input.travel.allowed.includes("driving") && !input.noDriving?.includes(day.day) && afterLeaving) {
      findings.push({ kind: "travel_break", day: day.day, mode: "driving" });
    }
  }
  return findings;
}

export interface ReviewScore {
  readonly idleMinutes: number;
  readonly unplaced: number;
  readonly overloadedDays: number;
  readonly wetOutdoor: number;
  readonly noPlanDays: number;
}

export function reviewScore(findings: readonly ReviewFinding[]): ReviewScore {
  return {
    idleMinutes: findings.reduce((total, item) => total + (item.kind === "idle" ? item.minutes : 0), 0),
    unplaced: findings.reduce((total, item) => total + (item.kind === "unplaced" ? item.items.length : 0), 0),
    overloadedDays: findings.filter((item) => item.kind === "overloaded").length,
    wetOutdoor: findings.reduce((total, item) => total + (item.kind === "wet_outdoor" ? item.stops.length : 0), 0),
    noPlanDays: findings.filter((item) => item.kind === "no_plan").length,
  };
}

/** 变好才留下（§3.5）：没有新增排不开的天，四项里至少一项减少、没有一项增加。 */
export function improved(before: ReviewScore, after: ReviewScore): boolean {
  if (after.noPlanDays > before.noPlanDays) return false;
  const keys = ["idleMinutes", "unplaced", "overloadedDays", "wetOutdoor"] as const;
  return keys.every((key) => after[key] <= before[key]) && keys.some((key) => after[key] < before[key]);
}

/** 审查 Agent 的输入（§3.3）：只有结构和编号、名称、时刻，没有坐标、地址。 */
const clockText = z.string().regex(/^\d{2}:\d{2}$/);
export const reviewInputSchema = z.strictObject({
  days: z.array(z.strictObject({
    day: z.number().int().min(1).max(7),
    date: z.iso.date(),
    window: z.string().max(20),
    status: z.enum(["planned", "not_planned"]),
    lodging: z.string().max(80).optional(),
    weather: z.string().max(40).optional(),
    transfers: z.array(z.strictObject({
      mode: z.string().max(10),
      from: z.string().max(80),
      to: z.string().max(80),
      departAt: clockText,
      arriveAt: clockText,
    })).max(4),
    stops: z.array(z.strictObject({
      ref: z.string().max(10).optional(),
      name: z.string().max(80),
      from: clockText,
      to: clockText,
      outdoor: z.boolean(),
    })).max(16),
  })).min(1).max(7),
  items: z.array(z.strictObject({
    ref: z.string().regex(/^(v|i)\d{1,2}$/),
    name: z.string().max(80),
    kind: z.enum(["place", "interest"]),
    role: z.enum(["optional", "required", "fixed", "interest"]),
    day: z.number().int().min(1).max(7).optional(),
    pinnedDay: z.number().int().min(1).max(7).optional(),
    stayMinutes: z.number().int().optional(),
    stayFrom: z.enum(["user", "estimate"]).optional(),
    when: z.string().max(10).optional(),
    outdoor: z.boolean().optional(),
  })).max(30),
  findings: z.array(z.record(z.string(), z.unknown())).max(30),
  notes: z.string().max(300).optional(),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export { reviewFixSchema, type ReviewFix };
export const reviewOutputSchema = z.strictObject({ fixes: z.array(reviewFixSchema).max(4) });

export const REVIEW_SYSTEM_PROMPT = `You review a multi-day trip in China that has already been planned day by day. Code has listed the
problems it found ("findings"). Propose fixes that solve those problems, at most 4, each one of these actions:
- move_visit {"visit","toDay"}: move a place on the card to another day.
- move_interest {"interest","toDay"}: move an interest (something to do, not a place) to another day.
- swap_days_content {"days":[a,b]}: swap what two days do, e.g. to keep outdoor places away from a rainy day.
- add_interest {"day","text","when"?}: add something to do on a day that has idle time. "text" names an activity, never a shop,
  restaurant or place name; "when" is one of morning, noon, afternoon, dusk, evening.
- set_day_travel {"day","remove":[...]}: stop a way of getting around on a day, e.g. driving when the car is in another city.
- drop_visit {"visit"}: drop an optional place from a day that is too full.
Rules:
- Only fix the listed findings; leave days without findings alone. If nothing would help, return {"fixes":[]}.
- Prefer moving. An item listed as "unplaced" must go to a different day whose window and idle time fit it; an item with
  "when" needs a day that is free at that time. A day with idle time should first take an item moved from a day that is too
  full or has unplaced items.
- Use add_interest only for a day with idle time when nothing on the card can be moved there, at most once per day.
- Drop a place only when it cannot be moved to any day.
- For rain, move the outdoor place to a dry day, or swap with a day whose places are indoor.
- Never move or drop fixed items. Items with "pinnedDay" were put on that day by the user; propose moving them only if that is
  clearly better, the user will be asked.
- Move things to a day that has idle time and is in the same city.
- Every fix has "reason": one short sentence in Chinese saying which problem it solves on which day. Do not mention wishes the
  user did not state.
Return only JSON: {"fixes":[...]}.`;

const visitOf = (input: OutingInput, ref: string) => input.visits.find((visit) => visit.key === ref);
const interestOf = (input: OutingInput, ref: string) => input.interests.find((interest) => interest.id === ref);
const dayOfItem = (allocation: Allocation, ref: string) =>
  allocation.days.find((entry) => entry.visits.includes(ref) || entry.interests.includes(ref))?.day;

/** 给审查 Agent 的上下文（只有结构）。 */
export function reviewContext(
  input: OutingInput,
  allocation: Allocation,
  days: readonly GeneratedDay[],
  findings: readonly ReviewFinding[],
): ReviewInput {
  const frames = outingFrames(input);
  return reviewInputSchema.parse({
    days: days.map((day) => {
      const frame = frames.find((item) => item.day === day.day)!;
      const weather = Object.values(day.weather ?? {}).map((item) => item.dayWeather).join("、").slice(0, 40);
      const lodging = input.lodging[day.day - 1];
      return {
        day: day.day,
        date: day.date,
        window: `${clock(frame.startsAt)}-${clock(frame.endsAt)}`,
        status: day.result.status === "draft" ? "planned" : "not_planned",
        ...(lodging && lodging !== "onBoard" ? { lodging: lodging.place.name.slice(0, 80) } : {}),
        ...(weather ? { weather } : {}),
        transfers: frame.transfers.map((item) => ({
          mode: item.transfer.mode,
          from: item.transfer.from.place.name.slice(0, 80),
          to: item.transfer.to.place.name.slice(0, 80),
          departAt: clock(item.departAt),
          arriveAt: clock(item.arriveAt),
        })),
        stops: stopsOf(input, day).slice(0, 16).map((stop) => ({
          ...(stop.ref ? { ref: stop.ref } : {}),
          name: stop.name.slice(0, 80),
          from: clock(stop.startsAt),
          to: clock(stop.endsAt),
          outdoor: stop.outdoor,
        })),
      };
    }),
    items: [
      ...input.visits.map((visit) => ({
        ref: visit.key,
        name: visit.place.place.name.slice(0, 80),
        kind: "place" as const,
        role: visit.role,
        ...(dayOfItem(allocation, visit.key) ? { day: dayOfItem(allocation, visit.key) } : {}),
        ...(visit.day ? { pinnedDay: visit.day } : {}),
        ...(visit.role !== "fixed"
          ? { stayMinutes: visit.stayMinutes, stayFrom: visit.floor !== undefined ? "estimate" as const : "user" as const }
          : {}),
        outdoor: isOutdoorPlace(visit.kind, visit.place.place.categoryCode),
      })),
      ...input.interests.map((interest) => ({
        ref: interest.id,
        name: interest.text.slice(0, 80),
        kind: "interest" as const,
        role: "interest" as const,
        ...(dayOfItem(allocation, interest.id) ? { day: dayOfItem(allocation, interest.id) } : {}),
        ...(interest.day ? { pinnedDay: interest.day } : {}),
        ...(interest.when ? { when: interest.when } : {}),
      })),
    ].slice(0, 30),
    findings: findings.slice(0, 30).map((item) => ({ ...item })),
    ...(input.notes ? { notes: input.notes.slice(0, 300) } : {}),
  });
}

/** 两轮审查的建议按对象去重：同一天只加一个兴趣、同一项只挪一次、同两天只对调一次。 */
export function suggestionKey(fix: ReviewFix): string {
  switch (fix.action) {
    case "move_visit": return `move:${fix.visit}`;
    case "move_interest": return `move:${fix.interest}`;
    case "swap_days_content": return `swap:${[...fix.days].sort().join("-")}`;
    case "add_interest": return `add:${fix.day}`;
    case "set_day_travel": return `travel:${fix.day}`;
    case "drop_visit": return `drop:${fix.visit}`;
  }
}

/** 一条修改去掉理由后的样子（比较是不是同一条）。 */
export function fixKey(fix: ReviewFix): string {
  const { reason, ...rest } = fix;
  void reason;
  return JSON.stringify(rest);
}

/** 把一项挪到另一天后的分配（用户在卡片上挪也是这样：从原来那天去掉，加到目标那天）。 */
export function movedAllocation(allocation: Allocation, ref: string, toDay: number): Allocation {
  const field = ref.startsWith("v") ? "visits" : "interests";
  return {
    days: allocation.days.map((entry) => ({
      ...entry,
      [field]: entry.day === toDay
        ? [...entry[field].filter((item) => item !== ref), ref]
        : entry[field].filter((item) => item !== ref),
    })),
  };
}

export interface CheckedFixes {
  /** 不改变用户意图、通过检查的：直接重排受影响的天。 */
  readonly direct: readonly ReviewFix[];
  /** 给用户的建议：采纳后走改动流程，确认才保存。 */
  readonly suggestions: readonly ReviewFix[];
  readonly rejected: readonly { readonly action: string; readonly why: string; readonly detail: string }[];
}

/** 像店名的兴趣：审查 Agent 不能指定具体的地方。 */
const PLACE_LIKE = /(店|酒店|饭店|餐厅|分店|旗舰|门店)$|\d/;

/**
 * 代码检查每条修改（§3.4）并分类：编号要是这趟里的、动作和对象要对得上（固定事项不能挪、不能去掉必去）、挪过去的天
 * 装得下且分配检查不变差、雨天对调要真的少淋雨、加兴趣只能落在有空闲的那天且不能写成店名、出行方式只能去掉不能加、
 * 同一项不能改两次。直接改：挪没指定天、不是必去的想去地点，和没指定天的兴趣；其余作为建议。
 */
export function checkFixes(
  fixes: readonly ReviewFix[],
  context: {
    readonly input: OutingInput;
    readonly allocation: Allocation;
    readonly days: readonly GeneratedDay[];
    readonly findings: readonly ReviewFinding[];
    /** 上一轮试过、重排后没变好退回的修改（fixKey），不再接受。 */
    readonly tried?: readonly string[];
  },
): CheckedFixes {
  const { input, findings } = context;
  const frames = outingFrames(input);
  let allocation = context.allocation;
  const direct: ReviewFix[] = [];
  const suggestions: ReviewFix[] = [];
  const rejected: { action: string; why: string; detail: string }[] = [];
  const touched = new Set<string>();
  const reject = (fix: ReviewFix, why: string, detail: string) => rejected.push({ action: fix.action, why, detail });
  const valid = (day: number) => frames.some((frame) => frame.day === day);
  // 指定了天的项作为建议时，采纳会把指定的天一起改成目标天（卡片的“移到第几天”），按改过的卡片算装不装得下。
  const fits = (next: Allocation, day: number, given = input) =>
    !overfullDays(given, frames, next).includes(day) &&
    checkAllocation(given, frames, next).length <= checkAllocation(given, frames, allocation).length;
  const repinned = (ref: string, day: number): OutingInput => ({
    ...input,
    visits: input.visits.map((visit) => (visit.key === ref && visit.day !== undefined ? { ...visit, day } : visit)),
    interests: input.interests.map((interest) =>
      (interest.id === ref && interest.day !== undefined ? { ...interest, day } : interest)),
  });
  for (const fix of fixes) {
    if (context.tried?.includes(fixKey(fix))) {
      reject(fix, "tried", "this was tried and did not make the trip better");
      continue;
    }
    switch (fix.action) {
      case "move_visit":
      case "move_interest": {
        const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
        const visit = fix.action === "move_visit" ? visitOf(input, ref) : undefined;
        const interest = fix.action === "move_interest" ? interestOf(input, ref) : undefined;
        if (!visit && !interest) {
          reject(fix, "unknown_item", `${ref} is not on the card`);
          break;
        }
        if (visit?.role === "fixed") {
          reject(fix, "fixed", `${ref} is fixed and cannot move`);
          break;
        }
        if (!valid(fix.toDay)) {
          reject(fix, "unknown_day", `there is no day ${fix.toDay}`);
          break;
        }
        if (dayOfItem(allocation, ref) === fix.toDay) {
          reject(fix, "same_day", `${ref} is already on day ${fix.toDay}; pick another day`);
          break;
        }
        if (touched.has(ref)) {
          reject(fix, "conflict", `${ref} is changed twice`);
          break;
        }
        const next = movedAllocation(allocation, ref, fix.toDay);
        const pinned = (visit?.day ?? interest?.day) !== undefined;
        if (!fits(next, fix.toDay, pinned ? repinned(ref, fix.toDay) : input)) {
          reject(fix, "no_room", `day ${fix.toDay} has no room or no fitting time for ${ref}`);
          break;
        }
        touched.add(ref);
        if (pinned || visit?.role === "required") {
          suggestions.push(fix);
        } else {
          direct.push(fix);
          allocation = next;
        }
        break;
      }
      case "swap_days_content": {
        const [a, b] = fix.days;
        if (a === b || !valid(a) || !valid(b)) {
          reject(fix, "unknown_day", "pick two different days of the trip");
          break;
        }
        if (touched.has(`d${a}`) || touched.has(`d${b}`)) {
          reject(fix, "conflict", "a day is swapped twice");
          break;
        }
        if (!fewerWetOutdoor(input, allocation, context.days, a, b)) {
          // 打回时由代码算出哪两天对调真的少淋雨（V2.11 分配打回时写明哪几天时间对得上，同一个做法）。
          const better = frames.flatMap((x) => frames
            .filter((y) => y.day > x.day && fewerWetOutdoor(input, allocation, context.days, x.day, y.day))
            .map((y) => `${x.day} and ${y.day}`));
          reject(fix, "not_drier", `swapping days ${a} and ${b} does not put fewer outdoor places on a rainy day` +
            (better.length ? `; swapping days ${better.slice(0, 2).join(" or ")} would` : "; no swap helps"));
          break;
        }
        touched.add(`d${a}`);
        touched.add(`d${b}`);
        suggestions.push(fix);
        break;
      }
      case "add_interest": {
        const idle = findings.find((item) => item.kind === "idle" && item.day === fix.day);
        if (!idle || idle.kind !== "idle") {
          reject(fix, "no_idle_time", `day ${fix.day} has no idle time`);
          break;
        }
        const names = [
          ...input.visits.map((visit) => visit.place.place.name),
          ...context.days.flatMap((day) => stopsOf(input, day).map((stop) => stop.name)),
        ];
        const namesPlace = names.some((name) => name && (fix.text.includes(name) || name.includes(fix.text)));
        if (PLACE_LIKE.test(fix.text) || namesPlace) {
          reject(fix, "place_name", "name an activity, not a shop or place");
          break;
        }
        // 卡片上已经有的兴趣（例如刚采纳、但这天排不上）不再建议一遍。
        const same = input.interests.find((item) => item.text.includes(fix.text) || fix.text.includes(item.text));
        if (same) {
          reject(
            fix,
            "already_on_card",
            `"${same.text}" is already on the card and could not be placed; suggest something else or nothing`,
          );
          break;
        }
        if (touched.has(`a${fix.day}`) || direct.some((item) => "toDay" in item && item.toDay === fix.day)) {
          reject(fix, "one_per_day", `day ${fix.day} already gets something`);
          break;
        }
        if (fix.when) {
          const slot = INTEREST_SLOTS[fix.when];
          const [from, to] = [minutes(idle.from), minutes(idle.to)];
          if (Math.min(slot.endsAt, to) - Math.max(slot.startsAt, from) < 30) {
            reject(fix, "not_in_idle_time", `day ${fix.day} is free only ${idle.from}-${idle.to}`);
            break;
          }
        }
        touched.add(`a${fix.day}`);
        suggestions.push(fix);
        break;
      }
      case "set_day_travel": {
        const brokenDay = findings.some((item) => item.kind === "travel_break" && item.day === fix.day);
        if (!brokenDay || fix.remove.some((mode) => mode !== "driving")) {
          reject(fix, "not_allowed", "only stop driving on a day when the car is in another city");
          break;
        }
        if (touched.has(`t${fix.day}`)) {
          reject(fix, "conflict", "a day changed twice");
          break;
        }
        touched.add(`t${fix.day}`);
        suggestions.push(fix);
        break;
      }
      case "drop_visit": {
        const visit = visitOf(input, fix.visit);
        if (!visit) {
          reject(fix, "unknown_item", `${fix.visit} is not on the card`);
          break;
        }
        if (visit.role !== "optional") {
          reject(fix, "protected", `${fix.visit} is required or fixed`);
          break;
        }
        const day = dayOfItem(allocation, fix.visit);
        const full = findings.some((item) =>
          (item.kind === "overloaded" || item.kind === "no_plan" || item.kind === "unplaced") && item.day === day);
        if (!full) {
          reject(fix, "day_not_full", "only drop from a day that is too full");
          break;
        }
        if (touched.has(fix.visit)) {
          reject(fix, "conflict", `${fix.visit} is changed twice`);
          break;
        }
        touched.add(fix.visit);
        suggestions.push(fix);
        break;
      }
    }
  }
  return { direct, suggestions, rejected };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** 两天对调后，下雨那天的户外地点（卡片上的）是不是变少了。 */
function fewerWetOutdoor(
  input: OutingInput,
  allocation: Allocation,
  days: readonly GeneratedDay[],
  a: number,
  b: number,
): boolean {
  const wet = (day: number) => Object.values(days.find((item) => item.day === day)?.weather ?? {})
    .some((item) => BAD_WEATHER.test(item.dayWeather));
  const outdoorOn = (day: number) => (allocation.days.find((entry) => entry.day === day)?.visits ?? [])
    .filter((key) => {
      const visit = visitOf(input, key);
      return visit && visit.role !== "fixed" && isOutdoorPlace(visit.kind, visit.place.place.categoryCode);
    }).length;
  const before = (wet(a) ? outdoorOn(a) : 0) + (wet(b) ? outdoorOn(b) : 0);
  const after = (wet(a) ? outdoorOn(b) : 0) + (wet(b) ? outdoorOn(a) : 0);
  return after < before;
}

export type ReviewRequest = (systemPrompt: string, content: string, signal: AbortSignal) => Promise<ModelReply>;

/** 问审查 Agent 一次；输出不合格、或给的修改全被检查拒掉时打回一次。 */
export async function proposeFixes(
  request: ReviewRequest,
  context: ReviewInput,
  check: (fixes: readonly ReviewFix[]) => CheckedFixes,
  signal: AbortSignal,
): Promise<{ checked: CheckedFixes; requests: number; repairs: number }> {
  const content = JSON.stringify(context);
  let feedback: readonly string[] = [];
  let requests = 0;
  let last: CheckedFixes = { direct: [], suggestions: [], rejected: [] };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: ModelReply;
    try {
      requests += 1;
      const problems = feedback.map((item) => `- ${item}`).join("\n");
      reply = await request(
        REVIEW_SYSTEM_PROMPT,
        feedback.length ? `${content}\n\nYour last answer had these problems; fix them:\n${problems}` : content,
        signal,
      );
    } catch {
      return { checked: last, requests, repairs: attempt };
    }
    const parsed = reviewOutputSchema.safeParse(reply.decision);
    if (!parsed.success) {
      feedback = ["output: return {\"fixes\":[...]} with the actions and fields described"];
      continue;
    }
    last = check(parsed.data.fixes);
    // 有修改被检查拒掉就打回一次（说明原因），第二次的结果就是最终结果。
    if (!last.rejected.length || attempt === 1) return { checked: last, requests, repairs: attempt };
    feedback = last.rejected.map((item) => `${item.action}: ${item.detail}`).slice(0, 6);
  }
  return { checked: last, requests, repairs: 1 };
}

/** 方案上写的“审查后调整：…”。 */
export function fixNote(input: OutingInput, allocation: Allocation, fix: ReviewFix): string {
  if (fix.action === "move_visit" || fix.action === "move_interest") {
    const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
    const from = dayOfItem(allocation, ref);
    const fromDay = from ? `从第 ${from} 天` : "";
    return `审查后调整：${itemName(input, ref)}${fromDay}挪到第 ${fix.toDay} 天（${fix.reason}）`.slice(0, 120);
  }
  return `审查后调整：${fix.reason}`.slice(0, 120);
}

const MODE_NAMES: Record<Extract<ReviewFix, { action: "set_day_travel" }>["remove"][number], string> = {
  driving: "自驾",
  taxi: "打车",
  transit: "坐公交地铁",
  walking: "步行",
  bicycling: "骑车",
};

/** 一条建议给人看的说法（卡片上）。 */
export function suggestionText(input: OutingInput, allocation: Allocation, fix: ReviewFix): string {
  switch (fix.action) {
    case "move_visit":
    case "move_interest": {
      const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
      const from = dayOfItem(allocation, ref);
      return `把${itemName(input, ref)}${from ? `从第 ${from} 天` : ""}挪到第 ${fix.toDay} 天`;
    }
    case "swap_days_content":
      return `第 ${fix.days[0]} 天和第 ${fix.days[1]} 天的安排对调`;
    case "add_interest":
      return `第 ${fix.day} 天${fix.when ? INTEREST_SLOTS[fix.when].label : ""}加“${fix.text}”`;
    case "set_day_travel":
      return `第 ${fix.day} 天不${fix.remove.map((mode) => MODE_NAMES[mode]).join("、")}`;
    case "drop_visit":
      return `去掉${itemName(input, fix.visit)}`;
  }
}
