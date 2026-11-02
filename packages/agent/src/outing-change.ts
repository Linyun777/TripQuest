import {
  applyDraftPatch,
  outingDays,
  type DraftPatch,
  type RequirementsDraft,
} from "@tripquest/application/conversation";
import type { DayPlanningRunner, DayWeather } from "@tripquest/application/day-planning";
import { outingFrames, overfullDays, type Allocation, type OutingPlanInput } from "@tripquest/application/outing-allocation";
import type { MobilityProvider } from "@tripquest/providers";
import type { OutingChangeRequest } from "./chat-contracts";

export type { OutingChangeRequest } from "./chat-contracts";
import type { GeneratedDay } from "./outing-generate";
import { changeWithGraph } from "./outing-graph";
import type { ReviewRequest } from "./outing-review";

/** 出游进行到哪：today 是第几天（出游开始前为 0），done 是已完成的卡片地点。 */
export interface OutingProgress {
  readonly today: number;
  readonly done: readonly string[];
}

export type OutingChangeRefusal = "fixed" | "done" | "no_room" | "today" | "unknown" | "no_change";

export type OutingChangePlan =
  | { readonly status: "refused"; readonly reason: OutingChangeRefusal; readonly detail: string }
  | {
      readonly status: "ok";
      /** 改动后的卡片（含分配）；确认后写回对话。 */
      readonly draft: RequirementsDraft;
      /** 整天重排的天（都还没开始）。 */
      readonly affected: readonly number[];
      /** 从今天挪走的地点：今天的行程里记为跳过。 */
      readonly skipToday?: string;
      readonly generated: readonly GeneratedDay[];
      readonly note: string;
    };

export interface OutingChangeDependencies {
  /** 卡片 → 规划输入（地点按编号补查）；查不到时返回 null。 */
  readonly toInput: (draft: RequirementsDraft) => Promise<OutingPlanInput | null>;
  /** 改住处时查到的地点。 */
  readonly lodging?: { readonly externalId: string; readonly name: string; readonly cityAdcode?: string };
  /** 不受影响的天已经用了的推荐地点。 */
  readonly exclude: (affected: readonly number[]) => readonly string[];
  readonly runner: DayPlanningRunner;
  readonly provider: Pick<MobilityProvider, "findRoutes" | "searchPlaces">;
  readonly now: () => number;
  readonly weather?: (date: string, city: string) => Promise<DayWeather | undefined>;
  /** V3.2：改动后也审查受影响的那几天。 */
  readonly reviewer?: ReviewRequest;
}

/** 改动换算出来的结果：拒绝的理由，或改动后的卡片、规划输入和要重排的天。 */
export type ResolvedChange =
  | Extract<OutingChangePlan, { status: "refused" }>
  | {
      readonly status: "ready";
      readonly draft: RequirementsDraft;
      readonly input: OutingPlanInput & { readonly pace: "relaxed" | "standard"; readonly cityAdcode: string };
      readonly allocation: Allocation;
      readonly affected: readonly number[];
      readonly skipToday?: string;
      readonly note: string;
    };

/**
 * 代码检查后重排受影响的天：固定事项、已完成的站不能挪；只改还没开始的天（今天的剩余部分走 V2.5 的调整）；
 * 目标日按分到各天的检查装得下；其他天不动，它们找到的地点排除掉。住处由调用方查好，以 candidate 传入。
 * V3.1 起由总控图驱动。
 */
export function planOutingChange(
  draft: RequirementsDraft,
  request: OutingChangeRequest | AdoptedChange,
  progress: OutingProgress,
  dependencies: OutingChangeDependencies,
  signal: AbortSignal,
): Promise<OutingChangePlan> {
  return changeWithGraph(draft, request, progress, dependencies, signal);
}

/** 汇总成对外的改动方案（总控图的 diff 节点）。 */
export function changePlan(resolved: Extract<ResolvedChange, { status: "ready" }>, generated: readonly GeneratedDay[]): OutingChangePlan {
  return {
    status: "ok",
    draft: resolved.draft,
    affected: [...new Set(resolved.affected)].sort((a, b) => a - b),
    ...(resolved.skipToday ? { skipToday: resolved.skipToday } : {}),
    generated,
    note: resolved.note,
  };
}

/** 把改动请求换算成改动后的卡片和受影响的天；不合规矩的直接拒绝（固定事项、已去过、已开始的天、装不下）。 */
/**
 * V3.2 采纳审查建议（保存之后）：卡片已由代码按建议改好，受影响的天也算好了；这里和挪地点、改车次一样检查今天以前
 * 的天不能改、目标天装得下，再重排那几天。
 */
export interface AdoptedChange {
  readonly adopted: { readonly draft: RequirementsDraft; readonly affected: readonly number[]; readonly note: string };
}

export async function resolveOutingChange(
  draft: RequirementsDraft,
  request: OutingChangeRequest | AdoptedChange,
  progress: OutingProgress,
  dependencies: Pick<OutingChangeDependencies, "toInput" | "lodging">,
): Promise<ResolvedChange> {
  const outing = draft.outing;
  const allocation = outing?.allocation;
  if (draft.mode !== "outing" || !outing || !allocation) return { status: "refused", reason: "unknown", detail: "这趟出游还没有分到各天。" };
  const days = outingDays(outing);
  const refuse = (reason: OutingChangeRefusal, detail: string) => ({ status: "refused" as const, reason, detail });
  let patch: DraftPatch;
  let affected: number[];
  let skipToday: string | undefined;
  let note: string;
  const candidates = new Map<string, { externalId: string; name: string; cityAdcode?: string }>();
  if ("adopted" in request) {
    const { affected: days, note: said } = request.adopted;
    if (days.some((day) => day <= progress.today)) return refuse("today", "这条建议改的是已经开始的天，今天的安排请直接说怎么改。");
    return ready(request.adopted.draft, [...days], undefined, said);
  }
  if ("move" in request) {
    const visit = draft.visits.find((item) => item.key === request.move.visit);
    if (!visit) return refuse("unknown", "卡片上没有这个地点。");
    const name = visit.place.status === "bound" ? visit.place.name : visit.key;
    const from = allocation.days.find((entry) => entry.visits.includes(visit.key))?.day;
    const to = request.move.toDay;
    if (visit.role === "fixed") return refuse("fixed", `${name}是固定时间的安排，不能挪到别的天。`);
    if (progress.done.includes(visit.key)) return refuse("done", `${name}已经去过了。`);
    if (from === to) return refuse("no_change", `${name}本来就在第 ${to} 天。`);
    if (to > days) return refuse("unknown", `这趟出游只有 ${days} 天。`);
    if (to <= progress.today) return refuse("today", `第 ${to} 天已经开始了，今天的安排请直接说怎么改。`);
    patch = { moveToDay: { target: visit.key, day: to } };
    affected = [to, ...(from && from > progress.today ? [from] : [])];
    if (from === progress.today) skipToday = visit.key;
    note = `${name}挪到第 ${to} 天`;
  } else if ("transport" in request) {
    const ride = outing.transports.find((item) => item.id === request.transport.id);
    if (!ride) return refuse("unknown", "卡片上没有这趟交通。");
    if (ride.day <= progress.today) return refuse("today", "今天的交通改了，到站后的安排请直接跟我说怎么改。");
    if (!request.transport.departAt && !request.transport.arriveAt) return refuse("no_change", "没说改成几点。");
    // 只说了出发时刻时，到达跟着平移（车程不变）；没有原时刻的不推算。
    const shift = (given: string | null, delta: number) =>
      given === null ? null : clockOf(((minutesOf(given) + delta) % 1440 + 1440) % 1440);
    const departAt = request.transport.departAt ?? (request.transport.arriveAt && ride.departAt && ride.arriveAt
      ? shift(ride.departAt, minutesOf(request.transport.arriveAt) - minutesOf(ride.arriveAt)) : ride.departAt);
    const arriveAt = request.transport.arriveAt ?? (request.transport.departAt && ride.departAt
      ? shift(ride.arriveAt, minutesOf(request.transport.departAt) - minutesOf(ride.departAt)) : ride.arriveAt);
    patch = { updateTransports: [{ id: ride.id, departAt, arriveAt }] };
    affected = [ride.day, ...(ride.arriveDay === "next" && ride.day < days ? [ride.day + 1] : [])];
    note = `第 ${ride.day} 天的交通改成 ${departAt ?? "?"} 出发`;
  } else {
    const night = request.lodging.night;
    if (night >= days) return refuse("unknown", `这趟出游只有 ${days - 1} 晚。`);
    if (night <= progress.today) return refuse("today", "今晚的住处改了，今天剩下的安排请直接跟我说怎么改。");
    if (!dependencies.lodging) return refuse("unknown", `没找到“${request.lodging.mention}”。`);
    candidates.set("c1", dependencies.lodging);
    patch = { setLodging: [{ nights: [night], place: { candidate: "c1" } }] };
    affected = [night, night + 1];
    note = `第 ${night} 晚改住${dependencies.lodging.name}`;
  }
  const applied = applyDraftPatch(draft, patch, candidates);
  if (applied.status !== "ok") return refuse("unknown", "这个改动卡片上放不下。");
  // 改交通或住处不动各天去哪：沿用原来的分配（卡片补丁默认会作废它）；卡片上的住处也照留（V3.3：包括系统暂定的），
  // 只有正在改的那一晚换掉。
  const changing = "lodging" in request ? request.lodging.night : undefined;
  const after = applied.draft.outing!.lodging;
  const lodging = [
    ...after,
    ...outing.lodging.filter((item) => !item.onBoard && item.night !== changing && !after.some((other) => other.night === item.night)),
  ].sort((a, b) => a.night - b.night);
  const next: RequirementsDraft = {
    ...applied.draft,
    outing: { ...applied.draft.outing!, allocation: applied.draft.outing!.allocation ?? allocation, lodging },
  };
  return ready(next, affected, skipToday, note);

  async function ready(next: RequirementsDraft, affected: number[], skipToday: string | undefined, note: string): Promise<ResolvedChange> {
    const input = await dependencies.toInput(next);
    if (!input) return refuse("unknown", "有地点暂时查不到，请稍后再试。");
    const frames = outingFrames(input);
    const nextAllocation: Allocation = next.outing!.allocation!;
    // 只看受影响的天装不装得下（其他天没动）。
    const full = overfullDays(input, frames, nextAllocation).filter((day) => affected.includes(day));
    if (full.length) return refuse("no_room", `第 ${full[0]} 天放不下了：${note}后那天的时间不够。`);
    return {
      status: "ready",
      draft: next,
      input: { ...input, pace: next.pace, cityAdcode: input.start.place.place.cityAdcode ?? "330100" },
      allocation: nextAllocation,
      affected,
      ...(skipToday ? { skipToday } : {}),
      note,
    };
  }
}

const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const clockOf = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
