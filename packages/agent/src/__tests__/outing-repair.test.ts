import { afterEach, describe, expect, it, vi } from "vitest";
import type { Allocation } from "@tripquest/application/outing-allocation";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { generateOuting, type OutingInput } from "../outing-generate";
import type { OutingReviewOutcome } from "../outing-graph";
import {
  adoptFix,
  adoptionOutcome,
  keepProblem,
  replanDays,
  runRepair,
  suggestProblem,
  trySuggestions,
  type RepairPlan,
} from "../outing-repair";
import { reviewFindings, suggestionText, type ReviewFix, type ReviewRequest } from "../outing-review";

/**
 * V4.0 审查-修复（stages/V4.0.md §6）：一条修改放到副本上（和用户在卡片上采纳一样），只重排受影响的天。
 * 演示地点、脚本一日规划器，不发真实请求。
 */
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const at = (id: string) => ({ place: places.find((place) => place.ref.externalId === id)!, evidence: planningFixtureEvidence(now()) });
const provider = new PlanningFixtureProvider(now);
const input: OutingInput = {
  dates: { from: "2026-10-15", to: "2026-10-16" },
  dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
  start: { place: at("DEMO-START"), at: null },
  end: { place: at("DEMO-START"), at: null },
  lodging: [at("DEMO-START")],
  transports: [],
  visits: [
    { key: "v1", place: at("DEMO-MUSEUM-A"), role: "optional", stayMinutes: 60 },
    { key: "v2", place: at("DEMO-PARK"), role: "optional", stayMinutes: 120 },
    { key: "v3", place: at("DEMO-GARDEN"), role: "optional", stayMinutes: 120 },
    { key: "v4", place: at("DEMO-WALK"), role: "fixed", stayMinutes: 120, startsAt: "14:00", endsAt: "16:00", day: 2 },
  ],
  interests: [{ id: "i1", text: "喝咖啡" }],
  travel: { allowed: ["walking"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
};
const split: Allocation = { days: [{ day: 1, visits: ["v1"], interests: ["i1"] }, { day: 2, visits: ["v2", "v3", "v4"], interests: [] }] };
const score = { idleMinutes: 0, unplaced: 0, overloadedDays: 0, wetOutdoor: 0, noPlanDays: 0 };
const fix = (value: Record<string, unknown>) => ({ reason: "第 1 天下午空着", ...value }) as ReviewFix;
const deps = { runner: createDayPlanningRunner({ provider, model: createDayScriptedModel(), now }), provider, now };

describe("V4.0 adopting a fix on a copy", () => {
  it("does what adopting on the card does: moves pin the item, swaps leave fixed items, adds get a new id, drops leave the card", () => {
    const moved = adoptFix(input, split, fix({ action: "move_visit", visit: "v2", toDay: 1 }))!;
    expect(moved.affected).toEqual([1, 2]);
    expect(moved.allocation.days.map((day) => day.visits)).toEqual([["v1", "v2"], ["v3", "v4"]]);
    expect(moved.input.visits.find((visit) => visit.key === "v2")?.day).toBe(1);
    // 原来的输入和分配不变（副本）。
    expect(input.visits.find((visit) => visit.key === "v2")?.day).toBeUndefined();
    expect(split.days[0]!.visits).toEqual(["v1"]);

    const swapped = adoptFix(input, split, fix({ action: "swap_days_content", days: [1, 2] }))!;
    expect(swapped.allocation.days.map((day) => [day.visits, day.interests])).toEqual([[["v2", "v3"], []], [["v4", "v1"], ["i1"]]]);

    const added = adoptFix(input, split, fix({ action: "add_interest", day: 1, text: "看夕阳", when: "dusk" }))!;
    expect(added.added).toBe("i2");
    expect(added.input.interests.at(-1)).toEqual({ id: "i2", text: "看夕阳", when: "dusk", day: 1 });
    expect(added.allocation.days[0]!.interests).toEqual(["i1", "i2"]);

    const dropped = adoptFix(input, split, fix({ action: "drop_visit", visit: "v3" }))!;
    expect(dropped.affected).toEqual([2]);
    expect(dropped.input.visits.map((visit) => visit.key)).toEqual(["v1", "v2", "v4"]);

    expect(adoptFix(input, split, fix({ action: "move_visit", visit: "v9", toDay: 1 }))).toBeNull();
    expect(adoptFix(input, split, fix({ action: "set_day_travel", day: 3, remove: ["driving"] }))).toBeNull();
  });

  it("replans only the affected days and says whether the adopted change is on the plan", async () => {
    const days = await generateOuting(input, split, deps, { signal: new AbortController().signal });
    const adopted = adoptFix(input, split, fix({ action: "move_visit", visit: "v2", toDay: 1 }))!;
    const replanned = await replanDays(adopted.input, adopted.allocation, adopted.affected, days, deps, new AbortController().signal);
    expect(replanned.map((day) => day.day)).toEqual([1, 2]);
    expect(adoptionOutcome(adopted, fix({ action: "move_visit", visit: "v2", toDay: 1 }), replanned)).toEqual({ planned: true, placed: true });
  });
});

/** 审查-修复的脚本模型：按顺序回答，用完了就 finish；记下每次看到的上下文。 */
function scripted(...answers: unknown[]) {
  const seen: { tried: { result?: string; trial?: string; why?: string }[]; open: string[] }[] = [];
  const request: ReviewRequest = async (_system, content) => {
    seen.push(JSON.parse(content.split("\n\nYour last answer")[0]!));
    return { decision: answers.shift() ?? { action: "finish" }, usage: null };
  };
  return { request, seen };
}
/** 数一日规划被调了几次（试排才会调）。 */
function counted() {
  const base = createDayPlanningRunner({ provider, model: createDayScriptedModel(), now });
  let calls = 0;
  return { runner: { run: (...args: Parameters<typeof base.run>) => (calls += 1, base.run(...args)) }, calls: () => calls };
}
const describeFix = (plan: RepairPlan, value: ReviewFix) => suggestionText(plan.input, plan.allocation, value);

describe("V4.0 review-repair agent", () => {
  async function start(): Promise<{ plan: RepairPlan; runner: ReturnType<typeof counted> }> {
    const runner = counted();
    const days = await generateOuting(input, split, { ...deps, runner: runner.runner }, { signal: new AbortController().signal });
    return { plan: { input, allocation: split, days }, runner };
  }
  const repair = (plan: RepairPlan, runner: ReturnType<typeof counted>, request: ReviewRequest, limits = {}) =>
    runRepair(plan, request, { dependencies: { ...deps, runner: runner.runner }, signal: new AbortController().signal, describe: describeFix, limits });

  it("refuses protected changes before replanning anything, and never tries the same change twice", async () => {
    const { plan, runner } = await start();
    const before = runner.calls();
    const model = scripted(
      { action: "try_move", item: "v4", toDay: 1, reason: "第 1 天空着" },
      { action: "try_drop", item: "v4", reason: "第 2 天太满" },
      { action: "try_move", item: "v2", toDay: 1, reason: "第 1 天空着" },
      { action: "try_move", item: "v2", toDay: 1, reason: "再试一次" },
      { action: "try_move", item: "v2", toDay: 1, reason: "还是这个" },
      { action: "try_move", item: "v2", toDay: 1, reason: "第三次" },
      { action: "try_move", item: "v3", toDay: 1, reason: "不会走到这里" },
    );
    const outcome = await repair(plan, runner, model.request);
    // 固定事项不能挪、不能去掉：没重排；v2 挪一次重排两天，第二次是同一个改法，不再试。
    expect(runner.calls() - before).toBe(2);
    expect(outcome.trials).toBe(1);
    expect(model.seen[4]!.tried.map((item) => item.result ?? item.trial)).toEqual(["rejected", "rejected", "t1", "rejected"]);
    expect(model.seen[4]!.tried[3]!.why).toBe("this change was already tried");
    // 重复时叫它换一个；白费三步就停（第三次重复之后不再问模型）。
    expect(model.seen).toHaveLength(6);
    expect(outcome.stop).toBe("repeating");
  });

  it("keeps a direct move only when it helps; until then, and after stopping, the current plan is untouched", async () => {
    const { plan, runner } = await start();
    // 回成 {"actions":[…]} 也认（模型常这样写）。
    const model = scripted(
      { actions: [{ action: "try_move", item: "v2", toDay: 1, reason: "第 1 天空着" }] },
      { action: "keep", trial: "t1" },
    );
    const outcome = await repair(plan, runner, model.request);
    expect(outcome.kept.map((trial) => trial.id)).toEqual(["t1"]);
    expect(outcome.plan.allocation.days.map((day) => day.visits)).toEqual([["v1", "v2"], ["v3", "v4"]]);
    // 直接留下的挪动只换分配，不把它固定到那天。
    expect(outcome.plan.input).toBe(input);
    // 只试不留：停下时丢弃，方案还是审查前的。
    const again = await repair(plan, runner, scripted({ action: "try_move", item: "v2", toDay: 1, reason: "第 1 天空着" }).request);
    expect(again.kept).toEqual([]);
    expect(again.plan).toBe(plan);
  });

  it("only suggests an interest it tried, and says what the trial showed", async () => {
    const { plan, runner } = await start();
    const model = scripted(
      { action: "try_add_interest", day: 1, text: "看夕阳", when: "dusk", reason: "第 1 天下午空着" },
      { action: "keep", trial: "t1" },
      { action: "suggest", trial: "t1" },
    );
    const outcome = await repair(plan, runner, model.request);
    const trial = model.seen[1]!.tried[0]!;
    expect(trial.trial).toBe("t1");
    // 加兴趣只能建议，不能直接留下。
    expect(model.seen[2]!.tried[1]).toMatchObject({ result: "refused", why: "t1 changes what the user asked for; only suggest it" });
    if (outcome.suggestions.length) {
      expect(outcome.suggestions[0]!.fix.action).toBe("add_interest");
      expect(outcome.suggestions[0]!.tried).toMatch(/^已试排：/);
    } else {
      // 脚本一日规划器没排上这个兴趣（没变好）就不收。
      expect(model.seen.at(-1)!.tried.at(-1)).toMatchObject({ result: "refused" });
    }
  });

  it("moves two items in one trial only when each passes the checks, re-plans the two days once, and never suggests it", async () => {
    const { plan, runner } = await start();
    const before = runner.calls();
    const model = scripted(
      { action: "try_moves", moves: [{ item: "v2", toDay: 1 }, { item: "v4", toDay: 1 }], reason: "第 1 天空着" },
      { action: "try_moves", moves: [{ item: "v2", toDay: 1 }, { item: "v3", toDay: 1 }], reason: "第 2 天太满、第 1 天空着" },
      { action: "suggest", trial: "t1" },
    );
    const outcome = await repair(plan, runner, model.request);
    // 固定事项那一项被拒，整次不重排；两项都能挪的那次只重排第 1、2 天各一次。
    expect(model.seen[1]!.tried[0]).toMatchObject({ result: "rejected" });
    expect(runner.calls() - before).toBe(2);
    expect(model.seen[2]!.tried[1]).toMatchObject({ trial: "t1", canSuggest: false });
    expect(model.seen[3]!.tried[2]).toMatchObject({ result: "refused", why: "t1 moves two items at once; it can only be kept" });
    expect(outcome.suggestions).toEqual([]);
  });

  it("checks keep and suggest against the plan they were tried on", () => {
    const score = { idleMinutes: 300, unplaced: 0, overloadedDays: 0, wetOutdoor: 0, noPlanDays: 0 };
    const better = { ...score, idleMinutes: 60 };
    const trial = {
      id: "t1", fix: { action: "move_visit", visit: "v2", toDay: 1, reason: "x" } as ReviewFix, kind: "direct" as const, base: 0,
      plan: { input, allocation: split, days: [] }, affected: [1, 2], before: score, after: better, days: [], planned: true, improved: true,
      fixesTravel: false, violations: 0,
    };
    expect(keepProblem(trial, 0)).toBeNull();
    expect(keepProblem(trial, 1)).toMatch(/older plan/);
    expect(keepProblem({ ...trial, violations: 1 }, 0)).toMatch(/breaks/);
    expect(keepProblem({ ...trial, improved: false }, 0)).toMatch(/not make the trip better/);
    expect(suggestProblem({ ...trial, kind: "suggest", planned: false }, 0, false)).toMatch(/without a plan/);
    expect(suggestProblem({ ...trial, kind: "suggest" }, 0, true)).toMatch(/no suggestions/);
    expect(suggestProblem({ ...trial, kind: "suggest" }, 0, false)).toBeNull();
    // 不自驾：分数没变好，但去掉了“车在别的城市”的问题，也可以建议。
    expect(suggestProblem({ ...trial, kind: "suggest", improved: false }, 0, false)).toMatch(/not make the trip better/);
    expect(suggestProblem({ ...trial, kind: "suggest", improved: false, fixesTravel: true }, 0, false)).toBeNull();
  });

  it("stops at the request, trial and time limits, and when nothing is left to fix", async () => {
    const { plan, runner } = await start();
    const chatty = scripted(...Array.from({ length: 20 }, () => ({ type: "keep", trial: "t9" })));
    expect(await repair(plan, runner, chatty.request)).toMatchObject({ stop: "requests", requests: 8 });
    const trialsOnly = scripted(
      { action: "try_move", item: "v2", toDay: 1, reason: "a" },
      { action: "try_move", item: "v3", toDay: 1, reason: "b" },
      { action: "try_move", item: "i1", toDay: 2, reason: "c" },
    );
    const limited = await repair(plan, runner, trialsOnly.request, { trials: 2 });
    expect(limited.trials).toBe(2);
    expect(trialsOnly.seen[3]!.tried.at(-1)).toMatchObject({ result: "rejected", why: "no trials left; keep or suggest a trial that helped, or finish" });
    const slow: ReviewRequest = () => new Promise((resolve) => setTimeout(() => resolve({ decision: { action: "finish" }, usage: null }), 200));
    expect((await repair(plan, runner, slow, { ms: 50 })).stop).toBe("timeout");
    // 问题都没了：不问模型。
    const solved = reviewFindings(input, split, plan.days).length ? null : "solved";
    if (solved) expect((await repair(plan, runner, scripted().request)).requests).toBe(0);
  });
});

describe("V4.7 judged problems", () => {
  const problem = { id: "q1", kind: "unmet_need" as const, days: [2], text: "第二天别爬山", note: "第 2 天排了爬山", items: ["v2"] };
  const asked = (verdict: { resolved: boolean; newProblem: boolean } | null) => {
    const calls: string[] = [];
    return { calls, judgement: { problems: [problem], recheck: async () => { calls.push("recheck"); return verdict ? { ...verdict, asked: true } : null; } } };
  };
  const start = async () => {
    const runner = counted();
    const days = await generateOuting(input, split, { ...deps, runner: runner.runner }, { signal: new AbortController().signal });
    return { plan: { input, allocation: split, days } as RepairPlan, runner: runner.runner };
  };
  const run = (plan: RepairPlan, runner: Awaited<ReturnType<typeof start>>["runner"], request: ReviewRequest, judgement: ReturnType<typeof asked>["judgement"]) =>
    runRepair(plan, request, { dependencies: { ...deps, runner }, signal: new AbortController().signal, describe: () => "挪一下", judgement });

  it("starts on a judged problem alone, keeps a move the numbers do not call better once the judge says it is solved, and stops when it is", async () => {
    const { plan, runner } = await start();
    const solved = asked({ resolved: true, newProblem: false });
    const model = scripted({ action: "try_move", item: "v2", toDay: 1, reason: "第 2 天别爬山", target: "q1" }, { action: "keep", trial: "t1" });
    const outcome = await run({ ...plan, days: plan.days }, runner, model.request, solved.judgement);
    expect(solved.calls).toEqual(["recheck"]);
    expect((model.seen[0] as unknown as { judged: unknown }).judged).toEqual([problem]);
    expect(outcome.kept.map((trial) => trial.id)).toEqual(["t1"]);
    expect(outcome.rechecks).toBe(1);
  });

  it("does not let a new problem or an unknown answer through, unless the numbers are better on their own", () => {
    const base = { id: "t1", base: 0, kind: "direct" as const, planned: true, improved: false, fixesTravel: false, violations: 0, before: score, after: score };
    const judged = (verdict: { resolved: boolean; newProblem: boolean }) => ({ ...base, verdict: { ...verdict, target: "q1" } }) as never;
    expect(keepProblem(judged({ resolved: true, newProblem: false }), 0)).toBeNull();
    expect(keepProblem(judged({ resolved: true, newProblem: true }), 0)).toMatch(/not make the trip better/);
    expect(suggestProblem(judged({ resolved: false, newProblem: false }), 0, false)).toMatch(/not make the trip better/);
    expect(keepProblem(base as never, 0)).toMatch(/not make the trip better/);
    // 数字变差了，判断说解决了也不放行。
    expect(keepProblem({ ...base, after: { ...score, idleMinutes: 10 }, verdict: { resolved: true, newProblem: false, target: "q1" } } as never, 0)).toMatch(/not make the trip better/);
    // 只能建议的改法（指定了天、必去）判断解决了也不能直接留下：能留下的范围没有扩大。
    expect(keepProblem({ ...base, kind: "suggest", verdict: { resolved: true, newProblem: false, target: "q1" } } as never, 0)).toMatch(/only suggest/);
  });
});

describe("V4.0 the repair agent inside the outing graph", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs once after the days are planned, hands back the kept days, allocation and notes, and is skipped when off", async () => {
    vi.stubEnv("OUTING_REVIEW", "agent");
    const model = scripted({ action: "try_move", item: "v2", toDay: 1, reason: "第 1 天下午空着" }, { action: "keep", trial: "t1" });
    let review: OutingReviewOutcome | null = null;
    const days = await generateOuting(input, split, { ...deps, reviewer: model.request }, {
      signal: new AbortController().signal,
      onReview: (outcome) => {
        review = outcome;
      },
    });
    const outcome = review as OutingReviewOutcome | null;
    expect(outcome?.allocation.days.map((day) => day.visits)).toEqual([["v1", "v2"], ["v3", "v4"]]);
    expect(outcome?.applied.map((item) => item.action)).toEqual(["move_visit"]);
    expect(days.find((day) => day.day === 1)?.reviewNote).toMatch(/^审查后调整：/);

    vi.stubEnv("OUTING_REVIEW", "off");
    const quiet = scripted({ action: "finish" });
    await generateOuting(input, split, { ...deps, reviewer: quiet.request }, { signal: new AbortController().signal });
    expect(quiet.seen).toEqual([]);
  });
});

describe("V4.1 single-review suggestions are tried first", () => {
  it("tries at most two added interests, drops the ones that do not land and any beyond two, and keeps other kinds untried", async () => {
    const runner = counted();
    const days = await generateOuting(input, split, { ...deps, runner: runner.runner }, { signal: new AbortController().signal });
    const before = runner.calls();
    const result = await trySuggestions({ input, allocation: split, days }, [
      fix({ action: "move_visit", visit: "v2", toDay: 1 }),
      fix({ action: "add_interest", day: 1, text: "看夕阳", when: "dusk" }),
      fix({ action: "add_interest", day: 2, text: "逛书店" }),
      fix({ action: "add_interest", day: 1, text: "第三条不试" }),
    ], { ...deps, runner: runner.runner }, new AbortController().signal);
    expect(result.tried).toBe(2);
    // 每条只重排它那一天。
    expect(runner.calls() - before).toBe(2);
    expect(result.kept[0]).toEqual({ fix: fix({ action: "move_visit", visit: "v2", toDay: 1 }) });
    expect(result.kept.some((item) => item.fix.action === "add_interest" && item.fix.text === "第三条不试")).toBe(false);
    expect(result.kept.length).toBe(1 + result.landed);
    for (const item of result.kept.slice(1)) expect(item.tried).toMatch(/^已试排：第 \d 天加“/);
  });
});
