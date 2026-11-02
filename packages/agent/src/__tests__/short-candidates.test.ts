import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TRAVEL } from "@tripquest/application/planning";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { assertDaySnapshotIntegrity } from "@tripquest/application/day-confirmation";
import { createCandidateRunner, createShortScriptedModel, planShortTrip, type CandidateContext, type CandidatePicker, type PickAnswer } from "../short-index";

// V2.4: candidates for one step of a short trip, over the handwritten fixture places.
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const start = { place: places[0], evidence: planningFixtureEvidence(now()) };
const step = (exclude: string[] = []) => ({
  interest: { text: "看展" }, anchor: start, anchorIsStart: true, exclude,
  travel: DEFAULT_TRAVEL, departureAt: "2026-10-08T10:05:00+08:00",
});
const run = (decide?: (context: CandidateContext) => unknown, provider = new PlanningFixtureProvider(now)) => {
  const seen: CandidateContext[] = [];
  const model = createShortScriptedModel(decide && ((context) => {
    seen.push(structuredClone(context));
    return decide(context);
  }));
  return { seen, result: (exclude?: string[]) => createCandidateRunner({ provider, model }).run(step(exclude), { signal: new AbortController().signal }) };
};

describe("V2.4 short-trip candidates", () => {
  it("offers the model's picks with its reasons, a route each, and never what was offered before", async () => {
    const { seen, result } = run((context) => context.stage === "queries"
      ? { queries: ["演示"] }
      : { picks: [{ id: "c2", reason: "离你近 https://x.test", stayMinutes: 45 }, { id: "c1", reason: "适合", stayMinutes: 60 }, { id: "c3", reason: "也行", stayMinutes: 30 }] });
    const offered = await result(["DEMO-WALK"]);
    if (offered.status !== "ok") throw new Error(JSON.stringify(offered));
    // Nearest first for the model; the start itself and the excluded place are left out.
    const found = seen[1].found!.map((item) => item.name);
    expect(found).not.toContain("演示起点");
    expect(found).not.toContain("演示步行街");
    expect(seen[1].found!.map((item) => item.meters)).toEqual([...seen[1].found!.map((item) => item.meters)].sort((a, b) => a - b));
    expect(offered.candidates.map((candidate) => [candidate.selection.place.name, candidate.reason, candidate.stayMinutes]))
      .toEqual([[found[1], "离你近", 45], [found[0], "适合", 60], [found[2], "也行", 30]]);
    expect(offered.candidates.every((candidate) => candidate.route.status === "known" && candidate.meters > 0)).toBe(true);
    expect(offered.fallback).toBe(false);
  });

  it("falls back to the nearest three when the model keeps naming places it was not shown", async () => {
    const { seen, result } = run((context) => context.stage === "queries" ? { queries: ["演示"] } : { picks: [{ id: "c9", reason: "x", stayMinutes: 60 }] });
    const offered = await result();
    expect(seen[2].feedback).toMatch(/^unknown_id: use only c1,/);
    if (offered.status !== "ok") throw new Error(JSON.stringify(offered));
    expect(offered).toMatchObject({ fallback: true, counts: { model: 3 } });
    expect(offered.candidates.map((candidate) => candidate.reason)).toEqual(["离你最近", "离你最近", "离你最近"]);
    expect(offered.candidates.map((candidate) => candidate.meters)).toEqual([...offered.candidates.map((candidate) => candidate.meters)].sort((a, b) => a - b));
  });

  it("asks a replaceable picker first and lets the model pick when it cannot (V2.9.2)", async () => {
    const asked: string[] = [];
    const model = createShortScriptedModel((context) => {
      asked.push(context.stage);
      return context.stage === "queries" ? { queries: ["演示"] } : { picks: ["c1", "c2", "c3"].map((id) => ({ id, reason: "模型挑的", stayMinutes: 45 })) };
    });
    const picker = (answer: PickAnswer | null): CandidatePicker => ({ name: "jev", pick: async () => ({ answer, ...(answer ? {} : { failure: "timeout" }) }) });
    const provider = new PlanningFixtureProvider(now);
    const byJev = await createCandidateRunner({ provider, model, picker: picker({ picks: [{ id: "c2", reason: "Jev 挑的", stayMinutes: 30 }] }) })
      .run(step(), { signal: new AbortController().signal });
    if (byJev.status !== "ok") throw new Error(JSON.stringify(byJev));
    expect(byJev.candidates.map((candidate) => candidate.reason)).toEqual(["Jev 挑的"]);
    expect(asked).toEqual(["queries"]);
    const byModel = await createCandidateRunner({ provider, model, picker: picker(null) }).run(step(), { signal: new AbortController().signal });
    if (byModel.status !== "ok") throw new Error(JSON.stringify(byModel));
    expect(byModel.candidates.map((candidate) => candidate.reason)).toEqual(["模型挑的", "模型挑的", "模型挑的"]);
    expect(asked).toEqual(["queries", "queries", "picks"]);
  });

  it("offers one or two picks as they are, without nearer places that do not fit (V2.9.3)", async () => {
    const { seen, result } = run((context) => context.stage === "queries" ? { queries: ["演示"] } : { picks: [{ id: "c2", reason: "只有这家合适", stayMinutes: 45 }] });
    const offered = await result();
    if (offered.status !== "ok") throw new Error(JSON.stringify(offered));
    expect(seen.every((context) => context.feedback === null)).toBe(true);
    expect(offered).toMatchObject({ fallback: false, counts: { model: 2 } });
    expect(offered.candidates.map((candidate) => candidate.reason)).toEqual(["只有这家合适"]);
  });

  it("answers honestly when nothing fits, and fails only when the provider does", async () => {
    expect((await run((context) => context.stage === "queries" ? { queries: ["演示"] } : { picks: [] }).result()).status).toBe("none");
    expect((await run((context) => context.stage === "queries" ? { queries: ["滑雪场"] } : { picks: [] }).result()).status).toBe("none");
    const broken = new PlanningFixtureProvider(now);
    vi.spyOn(broken, "searchPlaces").mockRejectedValue(new Error("down"));
    expect(await run(undefined, broken).result()).toMatchObject({ status: "failed", code: "provider_error" });
  });

  it("shows business facts beside a candidate but keeps them out of the place record", async () => {
    const provider = new PlanningFixtureProvider(now);
    const search = provider.searchPlaces.bind(provider);
    vi.spyOn(provider, "searchPlaces").mockImplementation(async (request, options) => {
      const reply = await search(request, options);
      return reply.status === "ok"
        ? { ...reply, data: { ...reply.data, items: reply.data.items.map((item) => ({ ...item, business: { rating: 4.5, costYuan: 40 } })) } }
        : reply;
    });
    const decide = (context: CandidateContext) => context.stage === "queries"
      ? { queries: ["演示"] }
      : { picks: ["c1", "c2", "c3"].map((id) => ({ id, reason: "适合", stayMinutes: 60 })) };
    const offered = await run(decide, provider).result();
    if (offered.status !== "ok") throw new Error(JSON.stringify(offered));
    expect(offered.candidates[0].business).toEqual({ rating: 4.5, costYuan: 40 });
    expect(offered.candidates[0].selection.place).not.toHaveProperty("business");
    expect(vi.mocked(provider.searchPlaces).mock.calls[0][0]).toMatchObject({ withBusiness: true, scope: { kind: "nearby", radiusMeters: 3000 } });
  });

  it("plans the picked stops in the user's order and ends at the last one, or back home when asked", async () => {
    const [museum, park] = [places.find((place) => place.name === "演示博物馆")!, places.find((place) => place.name === "演示公园步行街")!];
    const at = (place: typeof museum) => ({ place, evidence: planningFixtureEvidence(now()) });
    const trip = (back?: boolean) => planShortTrip({
      date: "2026-10-08", window: { startsAt: "10:05", endsAt: "14:05" }, start, ...(back ? { back: start } : {}),
      stops: [{ place: at(park), stayMinutes: 60 }, { place: at(museum), stayMinutes: 45 }],
      // The fixture's directed routes are walking only.
      travel: { allowed: ["walking"], prefer: "balanced" }, provider: new PlanningFixtureProvider(now), now, signal: new AbortController().signal,
    });
    const oneWay = await trip();
    if (oneWay.result.status !== "completed" || oneWay.result.outcome !== "draft") throw new Error(JSON.stringify(oneWay.result));
    expect(oneWay.result.draft.activities.map((activity) => activity.stayMinutes)).toEqual([60, 45]);
    expect(oneWay.result.draft.legs.at(-1)).toMatchObject({ travelMinutes: 0, source: "same_place_assumption" });
    expect(oneWay.result.draft.endPlace.name).toBe("演示博物馆");
    expect(() => assertDaySnapshotIntegrity(oneWay.snapshot!, true, "fixture")).not.toThrow();
    const home = await trip(true);
    if (home.result.status !== "completed" || home.result.outcome !== "draft") throw new Error(JSON.stringify(home.result));
    expect(home.result.draft.endPlace.name).toBe("演示起点");
    expect(home.result.draft.legs.at(-1)!.travelMinutes).toBeGreaterThan(0);
  });
});
