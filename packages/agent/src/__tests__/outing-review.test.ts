import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayPlanningRunner } from "@tripquest/application/day-planning";
import type { Allocation } from "@tripquest/application/outing-allocation";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { generateWithState, type OutingReviewOutcome } from "../outing-graph";
import { generateOuting, type OutingInput } from "../outing-generate";
import { checkFixes, reviewFindings, type ReviewFix, type ReviewRequest } from "../outing-review";

/**
 * V3.2 出游审查（stages/V3.2.md §6）：代码找问题（含不该报的）、修改检查、直接修改变好才留下 / 变差退回、轮数上限、
 * 审查关着时和 V3.1 一样。演示地点、脚本一日规划器、脚本审查 Agent，不发真实请求。
 */
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const at = (id: string) => ({ place: places.find((place) => place.ref.externalId === id)!, evidence: planningFixtureEvidence(now()) });
const provider = new PlanningFixtureProvider(now);
// 两天：第 1 天只有博物馆（下午空着），第 2 天三处。
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
    { key: "v4", place: at("DEMO-WALK"), role: "required", stayMinutes: 120, day: 2 },
  ],
  interests: [],
  travel: { allowed: ["walking"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
};
const split: Allocation = { days: [{ day: 1, visits: ["v1"], interests: [] }, { day: 2, visits: ["v2", "v3", "v4"], interests: [] }] };
/** 第 2 天再加一处咖啡馆：太满（停留和路程超过九成），挪一处到第 1 天两天都变好。 */
const busy: OutingInput = { ...input, visits: [...input.visits, { key: "v5", place: at("DEMO-CAFE"), role: "optional", stayMinutes: 120 }] };
const busySplit: Allocation = { days: [split.days[0]!, { ...split.days[1]!, visits: [...split.days[1]!.visits, "v5"] }] };
const runner = () => createDayPlanningRunner({ provider, model: createDayScriptedModel(), now });
const signal = () => new AbortController().signal;
/** 审查 Agent 的脚本：按顺序回答，用完了就说没有可改的。 */
function reviewer(...answers: unknown[]) {
  const calls: unknown[] = [];
  const request: ReviewRequest = async (_system, content) => {
    calls.push(JSON.parse(content.split("\n\n")[0]!));
    return { decision: answers.shift() ?? { fixes: [] }, usage: null };
  };
  return { request, calls };
}
const fix = (value: Record<string, unknown>) => ({ reason: "第 1 天下午空着", ...value }) as ReviewFix;

afterEach(() => vi.unstubAllEnvs());

describe("V3.2 outing review", () => {
  it("finds idle time and only reports it once it reaches 3 hours; a full, dry, walking trip has nothing else", async () => {
    const days = await generateOuting(input, split, { runner: runner(), provider, now }, { signal: signal() });
    const findings = reviewFindings(input, split, days);
    const idle = findings.filter((item) => item.kind === "idle");
    expect(idle.map((item) => item.day)).toEqual([1]);
    expect(idle.every((item) => item.kind === "idle" && item.minutes >= 180)).toBe(true);
    expect(findings.filter((item) => item.kind !== "idle")).toEqual([]);
    // 车留在别的城市：坐高铁离开之后的天才算，离开之前不算；这一天不自驾了也不算。
    const train: OutingInput = { ...input, travel: { allowed: ["walking", "driving"], prefer: "balanced" }, transports: [
      { day: 2, mode: "train" as const, from: at("DEMO-FOOD"), to: at("DEMO-CAFE"), departAt: "17:00", arriveAt: "17:30", arriveDay: "same" as const },
    ] };
    const breaks = (value: OutingInput) => reviewFindings(value, split, days).filter((item) => item.kind === "travel_break").map((item) => item.day);
    expect(breaks(train)).toEqual([]);
    const early: OutingInput = { ...train, transports: [{ ...train.transports[0]!, day: 1 }] };
    expect(breaks(early)).toEqual([2]);
    expect(breaks({ ...early, noDriving: [2] })).toEqual([]);
  });

  it("checks every fix: unknown items, fixed or full days, place names and added travel modes are refused; pinned or required ones become suggestions", async () => {
    const days = await generateOuting(input, split, { runner: runner(), provider, now }, { signal: signal() });
    const findings = reviewFindings(input, split, days);
    const withFixed = {
      ...input,
      visits: [...input.visits, { key: "v5", place: at("DEMO-MUSEUM-B"), role: "fixed" as const, stayMinutes: 60, startsAt: "15:00", endsAt: "16:00", day: 2 }],
      interests: [{ id: "i1", text: "夜游老街", day: 1 }],
    };
    const allocation = { days: [split.days[0]!, { ...split.days[1]!, visits: [...split.days[1]!.visits, "v5"] }] };
    const checked = checkFixes([
      fix({ action: "move_visit", visit: "v9", toDay: 1 }),
      fix({ action: "move_visit", visit: "v5", toDay: 1 }),
      fix({ action: "move_visit", visit: "v4", toDay: 1 }),
      fix({ action: "move_visit", visit: "v2", toDay: 1 }),
      fix({ action: "move_visit", visit: "v2", toDay: 1 }),
      fix({ action: "add_interest", day: 1, text: "演示公园花园" }),
      fix({ action: "add_interest", day: 2, text: "喝杯咖啡" }),
      fix({ action: "add_interest", day: 1, text: "夜游老街" }),
      fix({ action: "set_day_travel", day: 2, remove: ["walking"] }),
    ], { input: withFixed, allocation, days, findings });
    expect(checked.direct).toEqual([expect.objectContaining({ action: "move_visit", visit: "v2", toDay: 1 })]);
    // v4 是必去、指定了第 2 天：只能作为建议。
    expect(checked.suggestions).toEqual([expect.objectContaining({ action: "move_visit", visit: "v4" })]);
    expect(checked.rejected.map((item) => item.why)).toEqual([
      "unknown_item", "fixed", "same_day", "place_name", "no_idle_time", "already_on_card", "not_allowed",
    ]);
  });

  it("keeps a direct fix that makes the trip better, and says so on the day", async () => {
    vi.stubEnv("OUTING_REVIEW", "on");
    const script = reviewer({ fixes: [fix({ action: "move_visit", visit: "v2", toDay: 1 })] });
    let outcome: OutingReviewOutcome | null = null;
    const shown: number[] = [];
    const { state, generated } = await generateWithState(busy, busySplit, { runner: runner(), provider, now, reviewer: script.request }, {
      signal: signal(),
      onDay: (day) => {
        shown.push(day.day);
      },
      onReview: (given) => {
        outcome = given;
      },
    });
    expect(state.allocation!.days.map((day) => day.visits)).toEqual([["v1", "v2"], ["v3", "v4", "v5"]]);
    expect(outcome!.applied).toEqual([expect.objectContaining({ action: "move_visit" })]);
    expect(generated.find((day) => day.day === 1)!.reviewNote).toMatch(/^审查后调整：演示公园步行街从第 2 天挪到第 1 天/);
    // 页面只看到审查后的各天，每天一次。
    expect(shown).toEqual([1, 2]);
    // 审查 Agent 只看到结构：没有坐标、地址。
    expect(JSON.stringify(script.calls[0])).not.toMatch(/longitude|address|虚构/);
  });

  it("puts the days back when a fix made the trip worse, refuses it the second time, and stops after two rounds", async () => {
    vi.stubEnv("OUTING_REVIEW", "on");
    // 第 2 天本来不满：挪走一处后第 2 天下午空出 3 小时以上，总空闲反而变多，退回。
    const move = (visit: string) => ({ fixes: [fix({ action: "move_visit", visit, toDay: 1 })] });
    const script = reviewer(move("v2"), move("v2"), move("v3"), move("v3"));
    const { state, generated } = await generateWithState(input, split, { runner: runner(), provider, now, reviewer: script.request }, { signal: signal() });
    expect(state.reverted).toBe(2);
    expect(state.round).toBe(2);
    expect(state.allocation).toEqual(split);
    expect(generated.every((day) => !day.reviewNote)).toBe(true);
    // 第二轮又提 v2：试过、没变好，打回一次后改提 v3；两轮一共 3 次请求。
    expect(script.calls).toHaveLength(3);
  });

  it("puts the days back when re-planning a direct fix is cancelled, so the allocation matches the days", async () => {
    vi.stubEnv("OUTING_REVIEW", "on");
    const script = reviewer({ fixes: [fix({ action: "move_visit", visit: "v2", toDay: 1 })] });
    const controller = new AbortController();
    const real = runner();
    let dayOne = 0;
    // 审查把 v2 挪到第 1 天；第 1 天重排完就取消，第 2 天来不及重排。
    const cancelling: DayPlanningRunner = {
      run: async (problem, options) => {
        const result = await real.run(problem, options);
        if (problem.requirements.date === "2026-10-15" && ++dayOne === 2) controller.abort();
        return result;
      },
    };
    let outcome: OutingReviewOutcome | null = null;
    const { state, generated } = await generateWithState(busy, busySplit, { runner: cancelling, provider, now, reviewer: script.request }, {
      signal: controller.signal,
      onReview: (given) => {
        outcome = given;
      },
    });
    expect(dayOne).toBe(2);
    expect(state.stop).toBe("cancelled");
    expect(state.allocation).toEqual(busySplit);
    expect(outcome!.allocation).toEqual(busySplit);
    expect(outcome!.applied).toEqual([]);
    // 每天排的地点都是分配给这天的，没有“审查后调整”。
    const nameOf = (key: string) => busy.visits.find((visit) => visit.key === key)!.place.place.name;
    for (const day of generated) {
      const result = day.result;
      expect(result.status).toBe("draft");
      if (result.status !== "draft") continue;
      const planned = result.parts.flatMap((part) => part.kind === "plan"
        ? part.draft.activities.map((activity) => part.draft.places.find((place) => place.placeId === activity.placeId)!.name)
        : []);
      const assigned = busySplit.days.find((entry) => entry.day === day.day)!.visits.map(nameOf);
      expect(planned.length).toBeGreaterThan(0);
      expect(planned.every((name) => assigned.includes(name))).toBe(true);
      expect(day.reviewNote).toBeUndefined();
    }
  });

  it("with the review off it plans exactly like V3.1 (no reviewer) and never asks the reviewer", async () => {
    vi.stubEnv("OUTING_REVIEW", "off");
    const script = reviewer({ fixes: [fix({ action: "move_visit", visit: "v2", toDay: 1 })] });
    const reviewed = await generateWithState(input, split, { runner: runner(), provider, now, reviewer: script.request }, { signal: signal() });
    const plain = await generateOuting(input, split, { runner: runner(), provider, now }, { signal: signal() });
    expect(script.calls).toEqual([]);
    expect(reviewed.state.reviewed).toBe(false);
    expect(reviewed.generated.map((day) => day.discovered)).toEqual(plain.map((day) => day.discovered));
    expect(reviewed.generated.map((day) => day.result.status)).toEqual(plain.map((day) => day.result.status));
  });
});
