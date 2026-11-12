import type { JudgeRequest } from "@tripquest/agent/outing-judge";
import { worldStopType } from "../v32/review-run";
import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { allocateOuting, type AllocationRequest } from "@tripquest/agent/outing-allocate";
import { forecastLookup, generateOuting } from "@tripquest/agent/outing-generate";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import { allocateByRules, outingFrames } from "@tripquest/application/outing-allocation";
import { FORECASTS, V21_NOW, V21World, worldPlaceByName } from "../v21/world";
import type { Policy } from "../v21/run";
import { allocationInput } from "./allocation-run";
import type { AcceptOutingCase } from "./acceptance-fix-dataset";
import type { OutingE2eCase } from "./outing-plan-dataset";

/**
 * V2.11 出游端到端（§4.6）：同一张卡片先分到各天（live 用模型分配，scripted 用规则），再用产品的逐天生成
 * （generateOuting）一天天排。判分：每天通过独立校验、必去都排上、跨天不重复、按时到站和到最后的结束地点；
 * 另记总耗时、模型请求和地图请求。
 */
export interface OutingRow {
  readonly suite: "outing-e2e";
  readonly caseId: string;
  readonly policy: Policy;
  readonly heldOut: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  /** 每天的结果和各站（世界编号；交通写成 transfer）。 */
  readonly days: readonly {
    readonly day: number;
    readonly outcome: string;
    readonly stops: readonly string[];
    readonly explanation?: string;
    /** 方案的提示（验收复测第 4 条看“空着”的提示）。 */
    readonly notes?: readonly string[];
    /** 卡片上的地点各停留几分钟（世界编号 → 分钟）。 */
    readonly stays?: Readonly<Record<string, number>>;
    /** 这一天最长的一段空闲（分钟）：一段排完后到这段结束、或到站后等车的时间。 */
    readonly idleMinutes?: number;
  }[];
  readonly allocationSource: "model" | "rules";
  readonly modelRequests: number;
  readonly mapRequests: number;
  readonly elapsedMs: number;
}

const idOf = (name: string) => worldPlaceByName(name)?.id ?? name;

export async function runOutingCase(
  item: OutingE2eCase,
  policy: Policy,
  models?: {
    readonly day: () => DayPlanningDecisionModel;
    readonly allocator: AllocationRequest;
    /** V3.2：审查开着（缺省）时排完审查，和产品一样。 */
    readonly reviewer?: ReviewRequest;
    /** V4.7 整体判断（OUTING_REVIEW=agent 时产品用它）。 */
    readonly judge?: JudgeRequest;
  },
): Promise<OutingRow> {
  const started = Date.now();
  const world = new V21World(FORECASTS.dry);
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
  const given = policy === "live" ? models?.reviewer : undefined;
  const reviewer: ReviewRequest | undefined = given
    ? async (...args) => {
      modelRequests += 1;
      return given(...args);
    }
    : undefined;
  const input = allocationInput(item);
  const frames = outingFrames(input);
  const allocated = policy === "live" && models
    ? await allocateOuting(input, { request: models.allocator, ...(item.notes ? { notes: item.notes } : {}), signal })
    : { allocation: allocateByRules(input, frames), source: "rules" as const, modelRequests: 0 };
  modelRequests += allocated.modelRequests;
  const generated = await generateOuting({ ...input, pace: "standard", cityAdcode: input.start.place.place.cityAdcode ?? "330100" }, allocated.allocation, {
    runner: createDayPlanningRunner({ provider: world, model: counting, now: () => V21_NOW }),
    provider: world,
    now: () => V21_NOW,
    weather: forecastLookup(world, signal),
    ...(reviewer ? { reviewer } : {}),
    ...(policy === "live" && models?.judge ? { judge: models.judge, stopType: worldStopType } : {}),
  }, { signal });

  const days = generated.map((entry) => {
    const { result } = entry;
    if (result.status !== "draft") {
      return { day: entry.day, outcome: result.status, stops: [], ...(result.status === "no_plan" ? { explanation: `段 ${result.segment} ${result.reason}：${result.explanation}` } : {}) };
    }
    const stops = result.parts.flatMap((part) => part.kind === "transfer" ? ["transfer"] : part.kind === "connect" ? []
      : part.draft.activities.map((activity) => idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name)));
    const stays: Record<string, number> = {};
    for (const part of result.parts) {
      if (part.kind !== "plan") continue;
      for (const activity of part.draft.activities) {
        const id = idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name);
        if (item.visits.some((visit) => visit.place === id)) stays[id] = activity.endsAt - activity.startsAt;
      }
    }
    // 空闲：一段里两站之间（扣掉路上的时间）、一段排完到这段结束（回住处后），或只是去车站的一段到站后等到进站。
    const idleMinutes = Math.max(0, ...result.parts.flatMap((part) => {
      if (part.kind === "transfer") return [0];
      const segment = result.split.segments[part.segment];
      if (!segment) return [0];
      if (part.kind === "connect") return [segment.endsAt - part.arrivesAt];
      const between = part.draft.activities.slice(1).map((activity, index) =>
        activity.startsAt - part.draft.activities[index]!.endsAt - part.draft.legs[index + 1]!.travelMinutes - part.draft.legs[index + 1]!.bufferMinutes);
      return [...between, segment.endsAt - part.draft.endArrival];
    }));
    return { day: entry.day, outcome: "draft", stops, notes: result.notes, stays, idleMinutes };
  });
  const placed = days.flatMap((entry) => entry.stops.filter((stop) => stop !== "transfer"));
  const required = item.visits.filter((visit) => visit.role !== "optional").map((visit) => visit.place);
  const onTime = generated.every((entry) => {
    if (entry.result.status !== "draft") return true;
    const last = entry.result.parts.at(-1);
    return !entry.result.issues.length && (last?.kind !== "plan" || last.draft.endArrival <= entry.frame.endsAt);
  });
  const checks = [
    { name: "all_days", passed: item.expect !== "all_days" || days.every((entry) => entry.outcome === "draft") },
    {
      name: "days_valid",
      passed: generated.every((entry) => entry.result.status !== "draft" || entry.result.parts.every((part) =>
        part.kind !== "plan" || !part.draft.checks.some((issue) => issue.kind === "violation"))),
    },
    { name: "required_placed", passed: required.every((id) => placed.includes(id)) },
    { name: "no_repeat", passed: new Set(placed).size === placed.length },
    { name: "on_time", passed: onTime },
    // 验收复测第 4 条：没写停留的地点按类型估计（不是一律 60 分钟）；空着 4 小时以上的天要提示。
    ...((item as AcceptOutingCase).minStay ? [{
      name: "estimated_stays",
      passed: days.every((entry) => Object.values(entry.stays ?? {}).every((minutes) => minutes >= (item as AcceptOutingCase).minStay!)),
    }] : []),
    ...((item as AcceptOutingCase).idleNoted ? [{
      name: "idle_noted",
      passed: days.every((entry) => (entry.idleMinutes ?? 0) < 240 || (entry.notes ?? []).some((note) => /空着/.test(note))),
    }] : []),
  ];
  return {
    suite: "outing-e2e", caseId: item.id, policy, heldOut: !!item.heldOut, checks, passed: checks.every((check) => check.passed), days,
    allocationSource: allocated.source, modelRequests,
    mapRequests: world.searches.length + world.routes + world.details + world.weatherCalls,
    elapsedMs: Date.now() - started,
  };
}
