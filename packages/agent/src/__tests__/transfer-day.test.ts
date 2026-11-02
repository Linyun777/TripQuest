import { describe, expect, it } from "vitest";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { planTransferDay } from "../transfer-day";

// V2.11：用演示地点当车站，测切段、逐段规划和拼接（不是真的跨城市）。
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(now()) });
const provider = new PlanningFixtureProvider(now);
const run = (overrides: Partial<Parameters<typeof planTransferDay>[0]> = {}) => planTransferDay({
  date: "2026-10-15",
  window: { startsAt: "09:00", endsAt: "18:00" },
  start: selection(0),
  end: selection(4),
  transfers: [{ mode: "other", from: selection(2), to: selection(3), departAt: "13:00", arriveAt: "13:30", arriveDay: "same" }],
  visits: [{ place: selection(1), role: "required", stayMinutes: 60 }],
  interests: [],
  travel: { allowed: ["walking", "taxi"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
  ...overrides,
}, { runner: createDayPlanningRunner({ provider, model: createDayScriptedModel(), now }), provider, now }, { signal: new AbortController().signal });

describe("V2.11 planning a day around a fixed ride", () => {
  it("plans the part before the ride with the day planner, keeps the ride's times, then goes on to the end", async () => {
    const result = await run();
    if (result.status !== "draft") throw new Error(JSON.stringify(result));
    expect(result.parts.map((part) => part.kind)).toEqual(["plan", "transfer", "connect"]);
    expect(result.parts[1]).toMatchObject({ departAt: 780, arriveAt: 810, estimated: false });
    expect(result.issues).toEqual([]);
  });

  it("waits for the user to confirm an overnight ride, and says so when a must-see fits nowhere", async () => {
    expect(await run({ transfers: [{ mode: "train", from: selection(2), to: selection(3), departAt: "21:00", arriveAt: "06:00", arriveDay: "next" }] }))
      .toEqual({ status: "needs_confirmation", transfers: [0] });
    const crowded = await run({ transfers: [{ mode: "other", from: selection(2), to: selection(3), departAt: "09:20", arriveAt: "17:40", arriveDay: "same" }] });
    expect(crowded).toMatchObject({ status: "no_plan", segment: -1, reason: "unplaced" });
  });

  it("starting at the station when the train leaves is not late, and an early train moves the departure earlier", async () => {
    // 起点就是车站、出发时刻就是发车时刻：人已经在站里。
    const atStation = await run({ start: selection(2), window: { startsAt: "13:00", endsAt: "18:00" }, visits: [] });
    expect(atStation).toMatchObject({ status: "draft", issues: [] });
    // 只是去赶车：按 9:00 出门赶不上 9:10 的车（要提前进站），往前倒推出门时间并写明。
    const early = await run({ window: { startsAt: "09:00", endsAt: "18:00" }, visits: [], transfers: [{ mode: "other", from: selection(2), to: selection(3), departAt: "09:10", arriveAt: "09:40", arriveDay: "same" }] });
    if (early.status !== "draft") throw new Error(JSON.stringify(early));
    expect(early.parts[0]).toMatchObject({ kind: "connect" });
    expect(early.parts[0].kind === "connect" && early.parts[0].departsAt).toBeLessThan(9 * 60);
    expect(early.notes.some((note) => note.includes("才赶得上车"))).toBe(true);
    expect(early.issues).toEqual([]);
  });
});
