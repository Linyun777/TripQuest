import { describe, expect, it } from "vitest";
import type { DayPlanningRunner } from "@tripquest/application/day-planning";
import { outingFrames } from "@tripquest/application/outing-allocation";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { generateWithState } from "../outing-graph";
import { outingSegmentBudget, type OutingInput } from "../outing-generate";
import { AgentRun, MemoryRunSink, runIn } from "../runs";

/**
 * V3.1 出游总控图（stages/V3.1.md §5）：条件边（排不开、出错继续，取消、预算用完停止）、排除列表在天与天之间
 * 传递、只排指定的天、状态能序列化、预算按段数算。演示地点、脚本模型，不发真实请求。
 */
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index]!, evidence: planningFixtureEvidence(now()) });
const provider = new PlanningFixtureProvider(now);
// 三天，每天都想去博物馆（演示地点里只有两家）。
const input: OutingInput = {
  dates: { from: "2026-10-15", to: "2026-10-17" },
  dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
  start: { place: selection(0), at: null },
  end: { place: selection(4), at: null },
  lodging: [selection(0), selection(0)],
  transports: [],
  visits: [],
  interests: [{ id: "i1", text: "演示博物馆", perDay: true }],
  travel: { allowed: ["walking"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
};
const allocation = { days: [1, 2, 3].map((day) => ({ day, visits: [], interests: ["i1"] })) };
const real = () => createDayPlanningRunner({ provider, model: createDayScriptedModel(), now });
/** 指定的那天一日规划器出错（供应商失败），其他天照常排。 */
const failingOn = (date: string, runner = real()): DayPlanningRunner => ({
  run: (problem, options) => problem.requirements.date === date
    ? Promise.resolve({
      runId: problem.runId, counts: { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 }, elapsedMs: 0, usage: null,
      status: "failed", code: "provider_error",
    })
    : runner.run(problem, options),
});
const signal = () => new AbortController().signal;

describe("V3.1 outing graph", () => {
  it("goes on after a day that fails, passes found places to later days, and keeps only small, plain state", async () => {
    const { state, generated } = await generateWithState(input, allocation, { runner: failingOn("2026-10-16"), provider, now }, { signal: signal() });
    expect(generated.map((day) => [day.day, day.result.status])).toEqual([[1, "draft"], [2, "failed"], [3, "draft"]]);
    expect(state.days).toEqual([{ day: 1, status: "draft" }, { day: 2, status: "failed", reason: "provider_error" }, { day: 3, status: "draft" }]);
    // 第 1 天用过的博物馆，第 3 天换另一家。
    expect(generated[2]!.discovered[0]).not.toBe(generated[0]!.discovered[0]);
    expect(state.exclude).toEqual([...generated[0]!.discovered, ...generated[2]!.discovered]);
    // 状态只有编号、天数和状态码：能 JSON 来回、没有函数、很小。
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(JSON.stringify(state).length).toBeLessThan(1024);
    expect(state).toMatchObject({ status: "needs_user", stop: null, pending: [], current: null });
  });

  it("plans only the asked days, with what the other days found excluded", async () => {
    const graph = await generateWithState(input, allocation, { runner: real(), provider, now }, { signal: signal(), days: [2], exclude: ["DEMO-MUSEUM-A"] });
    expect(graph.generated.map((day) => day.day)).toEqual([2]);
    expect(graph.generated[0]!.discovered).toEqual(["DEMO-MUSEUM-B"]);
  });

  it("stops when cancelled; the days already planned stay", async () => {
    const controller = new AbortController();
    const { state, generated } = await generateWithState(input, allocation, { runner: real(), provider, now }, {
      signal: controller.signal,
      onDay: () => controller.abort(),
    });
    expect(generated.map((day) => day.day)).toEqual([1]);
    expect(state).toMatchObject({ stop: "cancelled", status: "completed", pending: [2, 3] });
  });

  it("stops once the shared budget is spent, and says so for the days it did not plan", async () => {
    // 第 1 天把地图预算用光（一日规划器照常把“额度用完”当失败），之后的天不再排。
    const greedy: DayPlanningRunner = {
      run: async (problem) => {
        try {
          for (;;) root.spend("amap");
        } catch {
          return {
            runId: problem.runId, counts: { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 }, elapsedMs: 0, usage: null,
            status: "failed", code: "live_budget",
          };
        }
      },
    };
    const sink = new MemoryRunSink();
    const root = AgentRun.root({ trigger: "outing_generate", userId: "u1", sink });
    const seen: string[] = [];
    const { state, generated } = await runIn(root, () => generateWithState(input, allocation, { runner: greedy, provider, now }, {
      signal: signal(),
      onDay: (day) => {
        seen.push(`${day.day}:${day.result.status === "failed" ? day.result.code : day.result.status}`);
      },
    }), () => ({ status: "ok" }));
    expect(seen).toEqual(["1:live_budget", "2:budget_exhausted", "3:budget_exhausted"]);
    expect(generated).toHaveLength(3);
    expect(state.stop).toBe("budget_exhausted");
    expect(state.days.map((day) => day.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(sink.runs[0]!.status).toBe("budget_exhausted");
    // 总控走过的步骤记在根运行下。
    expect(sink.steps.map((step) => step.name)).toEqual([
      "outing:prepare", "outing:plan_day", "outing:record_day", "outing:next_day", "outing:finish",
    ]);
  });

  it("sizes the shared budget by segments: a day split by a train gets a plan only for the part with places", () => {
    const train = { day: 2, mode: "train" as const, from: selection(5), to: selection(1), departAt: "13:00", arriveAt: "14:00", arriveDay: "same" as const };
    const twoDays = { ...input, dates: { from: "2026-10-15", to: "2026-10-16" }, lodging: [selection(0)] };
    const split = { days: [{ day: 1, visits: [], interests: ["i1"] }, { day: 2, visits: [], interests: ["i1"] }] };
    // 没有交通：两天各一段，分配 3 + 每段 12 次模型；地图 20 + 每段 80。
    expect(outingSegmentBudget(twoDays, split, outingFrames(twoDays))).toMatchObject({ model: 27, amap: 180 });
    // 第 2 天被火车切成两段：兴趣只放进一段，另一段只核对去车站的路线（地图 6）。
    const withTrain = { ...twoDays, transports: [train] };
    expect(outingSegmentBudget(withTrain, split, outingFrames(withTrain))).toMatchObject({ model: 27, amap: 186 });
  });
});
