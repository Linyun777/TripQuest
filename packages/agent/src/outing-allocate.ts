import { z } from "zod";
import {
  allocateByRules,
  checkAllocation,
  outingFrames,
  roughMinutes,
  settleAllocation,
  type Allocation,
  type DayFrame,
  type OutingPlanInput,
} from "@tripquest/application/outing-allocation";
import { clock } from "@tripquest/application/transfer-day";
import type { ModelReply } from "./contracts";
import { inAgent } from "./agents/run-agent";
import { allocateWithGraph } from "./outing-graph";
import { createJsonDecisionTransport, type LiveModelOptions } from "./live";

/**
 * V2.11 出游分到各天（stages/V2.11.md §3.6 第 3–4 条）：模型一次调用，听懂“第一天轻松点”“X 和 Y 一起”
 * “先杭州后黄山”；代码检查不过就带着问题打回一次，仍不过就用规则分配（规则是基线和兜底，D-048）。
 * 模型只看到名称、编号、城市、停留和粗估的远近，不看坐标。
 */
// v2（V2.11 验收复测）：“Follow the notes”去掉了带引号的中文例句，模型照抄进理由（用户没说，理由写“到达第一天轻松点”）。
export const ALLOCATE_PROMPT_VERSION = "outing-allocate.v2";

export const ALLOCATE_SYSTEM_PROMPT = `You split a multi-day trip in China into days. You get each day (its date, where it starts and
ends, its fixed rides, the free minutes left after rides and fixed events, and the cities it touches), the places and the
interests, and the user's notes. Return only JSON:
{"days":[{"day":1,"visits":["v1"],"interests":["i1"],"reason":"一句中文理由"}]}
- Every day once. Every required place (role required or fixed) on exactly one day; an optional one on at most one day.
- A place or interest with "day" stays on that day; a fixed event stays on its day.
- "perDay" interests go on every day; an interest with a city only on a day that touches that city; others on one day.
- Fit each day: stays (an estimate may shrink to its floor) plus getting around must fit its free minutes (on a day with a
  ride, the part in the place's city: "parts"). Put a place on
  the day whose start or end is near it ("minutesFrom" gives rough one-way minutes from each day); never on a day where
  it is more than 180 minutes away.
- Days with a ride, the first and the last day are lighter. Keep places that are near each other on the same day.
- Follow the user's notes when there are any: a day they want lighter, places they want together, the order of cities.
  The reason never says the user asked for something the notes do not say.
- No empty day unless it has under 120 free minutes. The reason says why in a few words (顺路, 到达那天只有半天, 要赶车).`;

const replySchema = z.object({
  days: z.array(z.object({
    day: z.number().int().min(1).max(7),
    visits: z.array(z.string()).max(24),
    interests: z.array(z.string()).max(12),
    reason: z.string().trim().max(80).optional(),
  })).min(1).max(7),
});

/** 一次 JSON 模型请求（评测里换成计数的、或固定回答的）。 */
export type AllocationRequest = (systemPrompt: string, content: string, signal: AbortSignal) => Promise<ModelReply>;

export interface AllocationResult {
  readonly allocation: Allocation;
  /** 用的是模型的分配，还是规则（没有模型、模型出错或两次检查都不过）。 */
  readonly source: "model" | "rules";
  /** 打回过几次（0 或 1）。 */
  readonly repairs: number;
  readonly modelRequests: number;
  /** 最后一次检查的问题（用了规则时是模型那份的问题）。 */
  readonly problems: readonly string[];
  /** 模型每一次的分配被检查出的问题（通过的那次是空数组）：查打回是检查太严还是输出有问题（验收复测第 3 条）。 */
  readonly attempts: readonly (readonly string[])[];
}

/** 给模型看的一份：天的框架、地点和兴趣（名称、城市、停留、离每天多远），不含坐标。 */
export function allocationContext(input: OutingPlanInput, frames: readonly DayFrame[], notes?: string) {
  return {
    days: frames.map((frame) => ({
      day: frame.day,
      date: frame.date,
      startsAt: clock(frame.startsAt),
      endsAt: clock(frame.endsAt),
      startsFrom: frame.start.place.name,
      endsIn: frame.end.place.name,
      freeMinutes: frame.available,
      // 有固定交通的天：每段在哪个城市、有多少分钟（一个地点只能用它所在城市那段）。
      ...(frame.parts.length > 1 ? { parts: frame.parts.map((part) => ({ city: part.city ?? null, freeMinutes: part.minutes })) } : {}),
      cities: frame.cities,
      rides: frame.transfers.map((item) => ({
        mode: item.transfer.mode, from: item.transfer.from.place.name, to: item.transfer.to.place.name,
        departAt: clock(item.departAt), arriveAt: item.nextDay ? `next day ${clock(item.arriveAt)}` : clock(item.arriveAt),
      })),
    })),
    visits: input.visits.map((visit) => ({
      id: visit.key,
      name: visit.place.place.name,
      city: visit.place.place.cityAdcode ?? null,
      role: visit.role,
      stayMinutes: visit.stayMinutes,
      ...(visit.floor !== undefined ? { estimateFloor: visit.floor } : {}),
      ...(visit.day ? { day: visit.day } : {}),
      ...(visit.role === "fixed" ? { at: `${visit.startsAt}–${visit.endsAt}` } : {}),
      minutesFrom: Object.fromEntries(frames.map((frame) => [
        `day${frame.day}`, Math.min(...frame.anchors.map((anchor) => roughMinutes(anchor, visit.place, input.travel, "far"))),
      ])),
    })),
    interests: input.interests.map((item) => ({
      id: item.id, text: item.text, ...(item.when ? { when: item.when } : {}), ...(item.city ? { city: item.city } : {}),
      ...(item.day ? { day: item.day } : {}), ...(item.perDay ? { perDay: true } : {}),
    })),
    notes: notes ?? null,
  };
}

export interface AllocateOptions {
  readonly request?: AllocationRequest;
  readonly notes?: string;
  readonly signal: AbortSignal;
}

/** 一日的出游不用分（§3.6 第 6 条）；多天先问模型，检查不过打回一次，仍不过用规则。V3.1 起由总控图驱动。 */
export function allocateOuting(input: OutingPlanInput, options: AllocateOptions): Promise<AllocationResult> {
  return allocateWithGraph(input, options);
}

/** 分配这个子 Agent 本身（总控图的 allocate 节点调用它）。 */
export function runOutingAllocator(input: OutingPlanInput, options: AllocateOptions): Promise<AllocationResult> {
  // V3.0：入口建分配的子运行；输入只有类型，交接只记录。模型被打回、退回规则都记一步。
  return inAgent(
    "outing-allocator",
    { input },
    async (run) => {
      const result = await allocate(input, options);
      for (const problems of result.attempts.slice(0, result.source === "model" ? result.repairs : result.attempts.length)) {
        run?.step("repair", "allocation", { problems: problems.length });
      }
      if (result.source === "rules" && result.modelRequests > 0) run?.step("fallback", "rules", { problems: result.problems.length });
      return result;
    },
    (result) => result.source === "model" ? { status: "ok" }
      : result.modelRequests > 0 ? { status: "fallback", outcome: "rules" } : { status: "ok", outcome: "rules" },
  );
}

async function allocate(input: OutingPlanInput, options: AllocateOptions): Promise<AllocationResult> {
  const frames = outingFrames(input);
  const attempts: string[][] = [];
  const rules = (problems: readonly string[], repairs: number, modelRequests: number): AllocationResult => ({
    allocation: allocateByRules(input, frames), source: "rules", repairs, modelRequests, problems, attempts,
  });
  if (!options.request || frames.length === 1) return rules([], 0, 0);
  const context = JSON.stringify(allocationContext(input, frames, options.notes));
  let feedback: readonly string[] = [];
  let requests = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: ModelReply;
    try {
      requests += 1;
      reply = await options.request(
        ALLOCATE_SYSTEM_PROMPT,
        feedback.length ? `${context}\n\nYour last split had these problems; fix them:\n${feedback.map((item) => `- ${item}`).join("\n")}` : context,
        options.signal,
      );
    } catch {
      return rules(feedback, attempt, requests);
    }
    const parsed = replySchema.safeParse(reply.decision);
    // 代码能确定的先整理（时间对不上的兴趣拿掉、补空天），剩下的才打回。
    const allocation: Allocation | null = parsed.success ? settleAllocation(input, frames, {
      days: frames.map((frame) => {
        const entry = parsed.data.days.find((item) => item.day === frame.day);
        return { day: frame.day, visits: entry?.visits ?? [], interests: entry?.interests ?? [], ...(entry?.reason ? { reason: entry.reason } : {}) };
      }),
    }) : null;
    const problems = allocation ? checkAllocation(input, frames, allocation) : ["output: return {\"days\":[...]} as described"];
    attempts.push(problems.slice(0, 8));
    if (allocation && !problems.length) return { allocation, source: "model", repairs: attempt, modelRequests: requests, problems: [], attempts };
    feedback = problems.slice(0, 8);
  }
  return rules(feedback, 1, requests);
}

export function createAllocationRequest(options: LiveModelOptions): AllocationRequest {
  const transport = createJsonDecisionTransport({ ...options, outputTokenLimit: 1024 });
  return (system, content, signal) => transport.request(system, content, signal);
}
