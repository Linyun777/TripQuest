import { allocateOuting, type AllocationRequest } from "@tripquest/agent/outing-allocate";
import {
  allocateByRules,
  checkAllocation,
  dayLoad,
  outingFrames,
  roughMinutes,
  visitStay,
  type Allocation,
  type OutingPlanInput,
} from "@tripquest/application/outing-allocation";
import { estimatedFloor, SLOT_MIN_OVERLAP_MINUTES, slotOverlapMinutes } from "@tripquest/application/planning";
import { worldSelection } from "../v21/world";
import type { AcceptAllocationCase } from "./acceptance-fix-dataset";
import type { AllocationCase } from "./outing-plan-dataset";

/**
 * V2.11 分到各天（§4.5）：同一张卡片，规则分配和模型分配（含打回和兜底）各跑一遍。硬条件看产品的检查；
 * 设计里的质量项单独判：放在一起的在一起、城市先后、该轻的天更轻、同一天的地点比规则分配更集中。
 */
export interface AllocationRow {
  readonly suite: "allocation";
  readonly caseId: string;
  readonly policy: "rules" | "live";
  readonly heldOut: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly source: "model" | "rules";
  readonly repairs: number;
  readonly modelRequests: number;
  /** 同一天里地点之间的粗估路程（分钟，各天相加）。 */
  readonly travelMinutes: number;
  readonly days: Allocation["days"];
  readonly problems: readonly string[];
  /** 退回规则时，模型最后一份的问题。 */
  readonly modelProblems: readonly string[];
  /** 模型每一次分配被检查出的问题（评测这边按产品的检查重算；空数组是那次通过）。 */
  readonly attempts: readonly (readonly string[])[];
}

export function allocationInput(item: AllocationCase): OutingPlanInput {
  return {
    dates: item.dates,
    dailyWindow: item.dailyWindow ?? { startsAt: "09:00", endsAt: "20:00" },
    start: { place: worldSelection(item.start.place), at: item.start.at ?? null },
    end: { place: worldSelection(item.end.place), at: item.end.at ?? null },
    lodging: item.lodging.map((night) => (night === "onBoard" ? "onBoard" : worldSelection(night))),
    transports: item.transfers.map((transfer) => ({
      day: transfer.day,
      mode: transfer.mode,
      from: worldSelection(transfer.from),
      to: worldSelection(transfer.to),
      departAt: transfer.departAt ?? null,
      arriveAt: transfer.arriveAt ?? null,
      arriveDay: transfer.arriveDay ?? "same",
      ...(transfer.confirmed ? { overnightConfirmed: true as const } : {}),
    })),
    visits: item.visits.map((visit, index) => {
      const place = worldSelection(visit.place);
      // 没写停留的（验收复测题）同产品：按类型估计；固定事项不用停留。
      const stay = visit.stayMinutes === undefined && visit.role !== "fixed" ? visitStay({ stayMinutes: null }, place.place.categoryCode) : (() => {
        const stayMinutes = visit.stayMinutes ?? 60;
        const floor = visit.estimate ? estimatedFloor({ stayMinutes, staySource: "estimate" }) : undefined;
        return { stayMinutes, ...(floor !== undefined ? { floor } : {}) };
      })();
      return {
        key: `v${index + 1}`,
        place,
        role: visit.role,
        ...stay,
        ...(visit.startsAt ? { startsAt: visit.startsAt, endsAt: visit.endsAt } : {}),
        ...(visit.day ? { day: visit.day } : {}),
      };
    }),
    interests: item.interests.map((interest) => ({
      id: interest.id, text: interest.text, ...(interest.when ? { when: interest.when } : {}), ...(interest.city ? { city: interest.city } : {}),
      ...(interest.day ? { day: interest.day } : {}), ...(interest.perDay ? { perDay: true as const } : {}),
    })),
    travel: item.travel as OutingPlanInput["travel"],
  };
}

export async function runAllocationCase(item: AllocationCase, policy: "rules" | "live", request?: AllocationRequest): Promise<AllocationRow> {
  const input = allocationInput(item);
  const frames = outingFrames(input);
  // 验收复测第 3 条：记下模型每一次的分配被检查出了什么（基线的产品不记，这里按产品的检查重算）。
  const attempts: string[][] = [];
  const recording: AllocationRequest | undefined = request && (async (system, content, signal) => {
    const reply = await request(system, content, signal);
    const days = (reply.decision as { days?: unknown } | null)?.days;
    attempts.push(Array.isArray(days)
      ? checkAllocation(input, frames, {
        days: frames.map((frame) => {
          const entry = days.find((day: { day?: unknown }) => day?.day === frame.day) as { visits?: string[]; interests?: string[] } | undefined;
          return { day: frame.day, visits: entry?.visits ?? [], interests: entry?.interests ?? [] };
        }),
      })
      : ["output"]);
    return reply;
  });
  const result = policy === "live" && recording
    ? await allocateOuting(input, { request: recording, ...(item.notes ? { notes: item.notes } : {}), signal: new AbortController().signal })
    : { allocation: allocateByRules(input, frames), source: "rules" as const, repairs: 0, modelRequests: 0, problems: [] };
  const { allocation } = result;
  const keyOf = (id: string) => `v${item.visits.findIndex((visit) => visit.place === id) + 1}`;
  const dayOf = (id: string) => allocation.days.find((entry) => entry.visits.includes(keyOf(id)))?.day;
  const visitsOn = (day: number) => (allocation.days.find((entry) => entry.day === day)?.visits ?? [])
    .flatMap((key) => input.visits.filter((visit) => visit.key === key));
  const travel = (days: Allocation["days"]) => days.reduce((total, entry) => {
    const places = entry.visits.flatMap((key) => input.visits.filter((visit) => visit.key === key)).map((visit) => visit.place);
    return total + places.slice(1).reduce((sum, place, index) => sum + roughMinutes(places[index], place, input.travel), 0);
  }, 0);
  const share = (day: number) => {
    const frame = frames.find((entry) => entry.day === day)!;
    return frame.available ? dayLoad(frame, visitsOn(day), input.travel) / frame.available : 0;
  };
  const problems = checkAllocation(input, frames, allocation);
  const rulesTravel = travel(allocateByRules(input, frames).days);
  const checks = [
    { name: "hard_rules", passed: problems.length === 0 },
    ...(item.together ?? []).map(([a, b]) => ({ name: `together_${a}_${b}`, passed: !!dayOf(a) && dayOf(a) === dayOf(b) })),
    ...(item.cityOrder ? [{
      name: "city_order",
      passed: input.visits.every((visit) => {
        const day = allocation.days.find((entry) => entry.visits.includes(visit.key))?.day;
        // 有固定交通的那天前后两个城市都算（高铁那天上午杭州、下午云岭）。
        const frame = frames.find((entry) => entry.day === day);
        const city = visit.place.place.cityAdcode;
        // 只管先后里提到的城市（从云岭当天往返岚溪不算违反“先杭州后云岭”）。
        return !day || !city || !item.cityOrder!.includes(city) || city === item.cityOrder![day - 1] ||
          (!!frame?.transfers.length && frame.cities.includes(city));
      }),
    }] : []),
    ...(item.lightDays ? [{
      name: "light_days",
      passed: item.lightDays.every((day) => {
        const others = frames.filter((frame) => !item.lightDays!.includes(frame.day)).map((frame) => share(frame.day));
        return !others.length || share(day) <= Math.max(...others);
      }),
    }] : []),
    // 验收复测第 2 条：有时段的兴趣只放进那段时间在的天（有这样的天时）。
    ...(input.interests.some((interest) => interest.when) ? [{
      name: "timed_interests_fit",
      passed: input.interests.every((interest) => {
        if (!interest.when) return true;
        const fits = (day: number) => {
          const frame = frames.find((entry) => entry.day === day)!;
          return slotOverlapMinutes(interest.when!, { startsAt: frame.startsAt, endsAt: frame.endsAt }) >= SLOT_MIN_OVERLAP_MINUTES;
        };
        if (!frames.some((frame) => fits(frame.day))) return true;
        return allocation.days.filter((entry) => entry.interests.includes(interest.id)).every((entry) => fits(entry.day));
      }),
    }] : []),
    ...(policy === "live" && (item as AcceptAllocationCase).modelKept ? [{ name: "model_kept", passed: result.source === "model" }] : []),
    // 用户要求放在一起的会多些路程，这类题不比集中。
    ...(policy === "live" && !item.together ? [{ name: "as_compact_as_rules", passed: travel(allocation.days) <= rulesTravel * 1.1 + 10 }] : []),
  ];
  return {
    suite: "allocation", caseId: item.id, policy, heldOut: !!item.heldOut, checks, passed: checks.every((check) => check.passed),
    source: result.source, repairs: result.repairs, modelRequests: result.modelRequests, travelMinutes: travel(allocation.days),
    days: allocation.days, problems, modelProblems: result.source === "rules" ? result.problems : [],
    // 产品记下的（代码先整理过再检查）；没有时（基线）用评测这边按原样重算的。
    attempts: "attempts" in result ? result.attempts : attempts,
  };
}
