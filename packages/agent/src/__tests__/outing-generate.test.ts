import { describe, expect, it } from "vitest";
import type { OutingPlanInput } from "@tripquest/application/outing-allocation";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { generateOuting } from "../outing-generate";

// 演示地点里有两家“演示博物馆”：每天都想去博物馆时，第二天应该换另一家。
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(now()) });
const provider = new PlanningFixtureProvider(now);
const input: OutingPlanInput & { pace: "standard"; cityAdcode: string } = {
  dates: { from: "2026-10-15", to: "2026-10-16" },
  dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
  start: { place: selection(0), at: null },
  end: { place: selection(4), at: null },
  lodging: [selection(0)],
  transports: [],
  visits: [],
  interests: [{ id: "i1", text: "演示博物馆", perDay: true }],
  travel: { allowed: ["walking"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
};

describe("V2.11 generating an outing day by day", () => {
  it("plans the days in order and does not reuse a place an earlier day found", async () => {
    const seen: number[] = [];
    const days = await generateOuting(input, {
      days: [{ day: 1, visits: [], interests: ["i1"] }, { day: 2, visits: [], interests: ["i1"] }],
    }, { runner: createDayPlanningRunner({ provider, model: createDayScriptedModel(), now }), provider, now }, {
      signal: new AbortController().signal,
      onDay: (day) => {
        seen.push(day.day);
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(days.map((day) => day.result.status)).toEqual(["draft", "draft"]);
    expect(days[0]!.discovered).toHaveLength(1);
    expect(days[1]!.discovered).toHaveLength(1);
    expect(days[1]!.discovered[0]).not.toBe(days[0]!.discovered[0]);
    // 重排第 2 天时，第 1 天用过的照样排除。
    const again = await generateOuting(input, {
      days: [{ day: 1, visits: [], interests: ["i1"] }, { day: 2, visits: [], interests: ["i1"] }],
    }, { runner: createDayPlanningRunner({ provider, model: createDayScriptedModel(), now }), provider, now }, {
      signal: new AbortController().signal,
      days: [2],
      exclude: days[0]!.discovered,
    });
    expect(again.map((day) => day.day)).toEqual([2]);
    expect(again[0]!.discovered).not.toContain(days[0]!.discovered[0]);
  });
});
