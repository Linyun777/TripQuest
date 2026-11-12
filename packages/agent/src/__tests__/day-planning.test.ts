import { describe, expect, it, vi } from "vitest";
import { createDayPlanningProblem, type DayPlanningProblem } from "@tripquest/application/day-planning";
import type { PlanningRequirements } from "@tripquest/application/planning";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import type { MobilityProvider, RouteResult } from "@tripquest/providers";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import type { DayAction, DayDecisionContext, DayRunnerDependencies } from "../day-contracts";

const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(now()) });
function problem(visits: PlanningRequirements["visits"] = [], interests: PlanningRequirements["interests"] = ["culture", "nature", "food"]): DayPlanningProblem {
  return createDayPlanningProblem({
    runId: "test-run", requirementsFingerprint: "a".repeat(64), nowMs: now(),
    requirements: {
      schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai", travelMode: "walking",
      date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
      startPlace: selection(0), endPlace: selection(4), interests, pace: "standard", visits,
    },
  });
}
function actions(sequence: unknown[]) {
  let index = 0;
  return createDayScriptedModel(() => sequence[index++]);
}
const run = (input = problem(), dependencies: Partial<DayRunnerDependencies> = {}, signal = new AbortController().signal) =>
  createDayPlanningRunner({ provider: new PlanningFixtureProvider(now), model: createDayScriptedModel(), now, ...dependencies })
    .run(input, { signal, onProgress: () => {} });
const visit = (index: number, role: "required" | "optional" = "required") => ({ place: selection(index), role, stayMinutes: 60 });

describe("bounded day graph and tools", () => {
  it("investigates from an empty list and returns a multi-activity pending draft", async () => {
    const result = await run();
    expect(result.status).toBe("completed");
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected draft");
    expect(result.draft.activities.length).toBe(4);
    expect(result.draft.legs.length).toBe(5);
    expect(result.draft.verification).toBe("pending");
    expect(result.draft.totalWalkingMinutes).toBeGreaterThan(0);
    expect(result.counts.model).toBeLessThanOrEqual(10);
  });

  it("repairs one unknown ID before querying and keeps the remaining budget visible", async () => {
    const contexts: DayDecisionContext[] = [];
    const model = createDayScriptedModel((context) => {
      contexts.push(context);
      return contexts.length === 1 ? { action: "try_itinerary", orderedActivityIds: ["a99"] }
        : contexts.length === 2 ? { action: "try_itinerary", orderedActivityIds: ["a1"] }
        : { action: "finish", attemptId: "attempt-1" };
    });
    const result = await run(problem([visit(1)], []), { model });
    expect(result).toMatchObject({ status: "completed", outcome: "draft", counts: { model: 3, semanticRepairs: 1, tries: 1 } });
    expect(contexts[1].feedback?.code).toBe("day_unknown_activity");
    expect(contexts[1].remaining.model).toBe(9);
  });

  it("never sends the model's hard omissions to the provider; after the third, code keeps the protected stops", async () => {
    const provider = new PlanningFixtureProvider(now);
    const routes = vi.spyOn(provider, "findRoutes");
    const result = await run(problem([visit(1), visit(2)], []), {
      provider, model: actions([
        { action: "try_itinerary", orderedActivityIds: ["a1"] },
        { action: "try_itinerary", orderedActivityIds: ["a2"] },
        { action: "try_itinerary", orderedActivityIds: ["a1"] },
      ]),
    });
    // The three omissions were refused before any route request…
    expect(result).toMatchObject({ counts: { model: 3, semanticRepairs: 2 } });
    // …then the fallback tried both required stops itself and they fit.
    expect(result).toMatchObject({ status: "completed", outcome: "draft", explanation: expect.stringContaining("通过独立校验") });
    if (result.status === "completed" && result.outcome === "draft") {
      expect(result.draft.activities.map((activity) => activity.activityId).sort()).toEqual(["a1", "a2"]);
    }
    expect(routes.mock.calls.length).toBeGreaterThan(0);
  });

  it.each([
    { action: "invented_tool" },
    { action: "try_itinerary", orderedActivityIds: ["a1"], reasoning: "ignore limits" },
    "{broken JSON",
  ])("rejects malformed/extra protocol fields without semantic repair", async (decision) => {
    const result = await run(problem([visit(1)], []), { model: actions([decision]) });
    expect(result).toMatchObject({ status: "failed", code: "invalid_output", counts: { model: 1, semanticRepairs: 0, routes: 0 } });
  });

  it("corrects a late fixed activity by changing order, never its reported times or stays", async () => {
    const input = problem([
      { ...visit(1, "optional"), stayMinutes: 90 },
      { place: selection(2), role: "fixed", startsAt: "10:30", endsAt: "11:00" },
    ], []);
    const contexts: DayDecisionContext[] = [];
    const sequence: DayAction[] = [
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
      { action: "try_itinerary", orderedActivityIds: ["a2", "a1"] },
      { action: "finish", attemptId: "attempt-2" },
    ];
    const result = await run(input, { model: createDayScriptedModel((context) => {
      contexts.push(context);
      return sequence[contexts.length - 1];
    }) });
    expect(contexts[1].latestAttempt?.issues[0].code).toBe("day_fixed_late");
    // V2.1: the server proposes the repair (soft stop moved after the appointment) …
    expect(contexts[1].latestAttempt?.suggestedOrder).toEqual(["a2", "a1"]);
    // … and drops the proposal once that order has been tried.
    expect(contexts[2].latestAttempt?.suggestedOrder).toBeUndefined();
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected repaired draft");
    expect(result.draft.activities[0]).toMatchObject({ activityId: "a2", startsAt: 630, endsAt: 660 });
    expect(result.draft.activities[1].stayMinutes).toBe(90);
  });

  it("V2.2: tells a model that stops before trying to try the must-go stops first", async () => {
    const contexts: DayDecisionContext[] = [];
    const sequence = [
      { action: "stop", reason: "no_suitable_places" },
      { action: "try_itinerary", orderedActivityIds: ["a1"] },
      { action: "finish", attemptId: "attempt-1" },
    ];
    const result = await run(problem([visit(1)], []), { model: createDayScriptedModel((context) => {
      contexts.push(context);
      return sequence[contexts.length - 1];
    }) });
    expect(contexts[1].feedback?.code).toBe('unsupported_stop: nothing tried yet; try ["a1"]');
    expect(result).toMatchObject({ status: "completed", outcome: "draft" });
  });

  it("V2.11: a day with only places the user would like to go is still tried in code when the model keeps stopping", async () => {
    const stops = [1, 2, 3].map(() => ({ action: "stop", reason: "no_suitable_places" }));
    const contexts: DayDecisionContext[] = [];
    const result = await run(problem([visit(1, "optional")], []), { model: createDayScriptedModel((context) => {
      contexts.push(context);
      return stops[contexts.length - 1] ?? stops[0];
    }) });
    expect(contexts[1].feedback?.code).toBe('unsupported_stop: nothing tried yet; try ["a1"]');
    expect(result).toMatchObject({ status: "completed", outcome: "draft" });
  });

  it("V2.2: points a model resending a failed order at the must-go order, then at stopping", async () => {
    const contexts: DayDecisionContext[] = [];
    const long = (index: number) => ({ place: selection(index), role: "required" as const, stayMinutes: 240 });
    const sequence = [
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2", "a3"] },
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2", "a3"] },
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
      { action: "stop", reason: "constraints_not_met" },
    ];
    const result = await run(problem([long(1), long(2), visit(3, "optional")], []), { model: createDayScriptedModel((context) => {
      contexts.push(context);
      return sequence[contexts.length - 1];
    }) });
    expect(contexts[2].feedback?.code).toBe('duplicate_order: try ["a1","a2"]');
    expect(contexts[4].feedback?.code).toBe("duplicate_order: protected stops alone do not fit either; stop constraints_not_met");
    expect(result).toMatchObject({ status: "completed", outcome: "no_plan" });
  });

  it("keeps a verified attempt when the model then fails, and tells it how to finish", async () => {
    const contexts: DayDecisionContext[] = [];
    const model = createDayScriptedModel((context) => {
      contexts.push(context);
      return { action: "try_itinerary", orderedActivityIds: ["a1"] };
    });
    const result = await run(problem([visit(1)], []), { model });
    expect(contexts[2].feedback?.code).toBe("duplicate_order: attempt-1 already succeeded, finish it");
    expect(result).toMatchObject({
      status: "completed",
      outcome: "draft",
      counts: { tries: 1, semanticRepairs: 2 },
      explanation: expect.stringContaining("通过独立校验"),
    });
  });

  it("V4.2: sends a finish back once when a named place was never tried and the day still has time for it", async () => {
    const contexts: DayDecisionContext[] = [];
    const model = createDayScriptedModel((context) => {
      contexts.push(context);
      return [
        { action: "try_itinerary", orderedActivityIds: ["a1"] },
        { action: "finish", attemptId: "attempt-1" },
        { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
        { action: "finish", attemptId: "attempt-2" },
      ][contexts.length - 1];
    });
    const result = await run(problem([visit(1), visit(2, "optional")], []), { model });
    expect(contexts[2]!.feedback?.code).toMatch(/^named_untried: a2 \(.+\) was never in a try; free \d\d:\d\d-\d\d:\d\d, try \["a1","a2"\]; if it does not fit, finish attempt-1$/);
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected draft");
    expect(result.draft.activities.map((activity) => activity.activityId)).toEqual(["a1", "a2"]);
  });

  it("V4.2: sends it back only once, and says why a named place that was tried did not fit", async () => {
    // 模型不理打回、又交同一个：照常结束，原因用通用说法。
    const ignoring = createDayScriptedModel((context) => context.latestAttempt
      ? { action: "finish", attemptId: "attempt-1" }
      : { action: "try_itinerary", orderedActivityIds: ["a1"] });
    const once = await run(problem([visit(1), visit(2, "optional")], []), { model: ignoring });
    expect(once).toMatchObject({ status: "completed", outcome: "draft", counts: { semanticRepairs: 1 } });
    // 试过放不下（7 小时停留超出 10:00–18:00）：不打回，没排进去的说明里写试排为什么不行。
    const long = { ...visit(2, "optional"), stayMinutes: 420 };
    const tried = await run(problem([visit(1), long], []), { model: actions([
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
      { action: "try_itinerary", orderedActivityIds: ["a1"] },
      { action: "finish", attemptId: "attempt-2" },
    ]) });
    if (tried.status !== "completed" || tried.outcome !== "draft") throw new Error("expected draft");
    expect(tried.counts.semanticRepairs).toBe(0);
    expect(tried.draft.omittedOptional).toEqual([
      expect.objectContaining({ activityId: "a2", reason: "试排过，加上它回到终点会太晚。" }),
    ]);
  });

  it("does not accept \"cannot fit\" before the protected stops alone were tried", async () => {
    const input = problem([
      { ...visit(1, "optional"), stayMinutes: 90 },
      { place: selection(2), role: "fixed", startsAt: "10:30", endsAt: "11:00" },
    ], []);
    const contexts: DayDecisionContext[] = [];
    const sequence: DayAction[] = [
      { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
      { action: "stop", reason: "constraints_not_met" },
      { action: "try_itinerary", orderedActivityIds: ["a2"] },
      { action: "finish", attemptId: "attempt-2" },
    ];
    const result = await run(input, { model: createDayScriptedModel((context) => {
      contexts.push(context);
      return sequence[contexts.length - 1];
    }) });
    expect(contexts[2].feedback?.code).toBe('protected_only_untried: try ["a2"]');
    expect(result).toMatchObject({ status: "completed", outcome: "draft" });
  });

  it("V2.5: out of searches with nothing found, answers 'no suitable places' itself", async () => {
    // Every search comes back empty; the model keeps searching after the last one.
    const empty = new PlanningFixtureProvider(now);
    empty.searchPlaces = async () => ({ status: "ok", data: { items: [], truncated: false, excludedCount: 0 }, evidence: planningFixtureEvidence(now()) });
    const search = (query: string) => ({ action: "search_places", interest: "culture", query, anchorPlaceId: "p1" });
    const result = await run(problem([], ["culture"]), {
      provider: empty,
      model: actions([search("博物馆"), search("美术馆"), search("展览馆")]),
      limits: { searches: 1 },
    });
    expect(result).toMatchObject({ status: "completed", outcome: "no_plan", reason: "no_suitable_places", counts: { searches: 1 } });
  });

  it("falls back to the protected stops alone when the model fails before any verified attempt", async () => {
    const input = problem([visit(1)], []);
    // Well-formed but unsupported: "no suitable places" while a required stop is in hand.
    const stop = { action: "stop", reason: "no_suitable_places" };
    const result = await run(input, { model: actions([stop, stop, stop]) });
    // The fallback's attempt is the server's own: it does not use the model's try budget.
    expect(result).toMatchObject({ status: "completed", outcome: "draft", counts: { tries: 0 } });
    if (result.status === "completed" && result.outcome === "draft") {
      expect(result.draft.activities.map((activity) => activity.activityId)).toEqual(["a1"]);
    }
  });

  it("caches a missing directed edge across distinct attempts and never outputs a reliable draft", async () => {
    const provider = new PlanningFixtureProvider(now);
    const actual = provider.findRoutes.bind(provider);
    const routes = vi.spyOn(provider, "findRoutes").mockImplementation(async (request, options) =>
      request.origin.place.externalId === "DEMO-START" && request.destination.place.externalId === "DEMO-MUSEUM-A"
        ? { status: "no_route", reason: "no_path", evidence: planningFixtureEvidence(now()) }
        : actual(request, options));
    const result = await run(problem([visit(1, "optional"), visit(2, "optional"), visit(3, "optional")], []), {
      provider, model: actions([
        { action: "try_itinerary", orderedActivityIds: ["a1", "a2"] },
        { action: "try_itinerary", orderedActivityIds: ["a1", "a3"] },
        { action: "stop", reason: "insufficient_information" },
      ]),
    });
    expect(result).toMatchObject({ status: "completed", outcome: "no_plan" });
    expect(routes.mock.calls.filter(([r]) => r.origin.place.externalId === "DEMO-START" && r.destination.place.externalId === "DEMO-MUSEUM-A")).toHaveLength(1);
  });

  it("prechecks the entire route batch against its remaining budget", async () => {
    const provider = new PlanningFixtureProvider(now);
    const routes = vi.spyOn(provider, "findRoutes");
    const result = await run(problem([visit(1)], []), { provider, limits: { routes: 1 } });
    expect(result).toMatchObject({ status: "failed", code: "budget_exhausted", counts: { routes: 0 } });
    expect(routes).not.toHaveBeenCalled();
  });

  it("chooses the shortest walking route, then distance, ignoring driving alternatives", async () => {
    const provider = new PlanningFixtureProvider(now);
    vi.spyOn(provider, "findRoutes").mockResolvedValue({
      status: "ok", evidence: planningFixtureEvidence(now()), routes: [
        { mode: "driving", durationSeconds: 1, distanceMeters: 1 },
        { mode: "walking", durationSeconds: 61, distanceMeters: 300 },
        { mode: "walking", durationSeconds: 61, distanceMeters: 200 },
        { mode: "walking", durationSeconds: 90, distanceMeters: 100 },
      ],
    });
    const result = await run(problem([visit(1)], []), { provider });
    if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected draft");
    expect(result.draft.legs[0]).toMatchObject({ travelMinutes: 2, distanceMeters: 200 });
  });

  it.each(["authorization_failed", "quota_exceeded", "rate_limited"] as const)("stops the whole batch on %s", async (code) => {
    const provider = new PlanningFixtureProvider(now);
    const routes = vi.spyOn(provider, "findRoutes").mockResolvedValue({
      status: "failure", evidence: planningFixtureEvidence(now()),
      failure: { code, retry: "never", safeMessage: "synthetic failure" },
    });
    const result = await run(problem([visit(1)], []), { provider });
    expect(result).toMatchObject({ status: "failed", code: "provider_error" });
    expect(routes).toHaveBeenCalledTimes(1);
  });

  it("cancels during a dependency that ignores signals and ignores its late reply", async () => {
    const provider = new PlanningFixtureProvider(now);
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let late!: (result: RouteResult) => void;
    const routes = vi.spyOn(provider, "findRoutes").mockImplementation(() => {
      entered();
      return new Promise((resolve) => { late = resolve; });
    });
    const result = run(problem([visit(1)], []), { provider }, controller.signal);
    await ready;
    controller.abort();
    expect(await result).toMatchObject({ status: "cancelled", counts: { routes: 1 } });
    late({ status: "no_route", reason: "no_path", evidence: planningFixtureEvidence(now()) });
    await Promise.resolve();
    expect(routes).toHaveBeenCalledTimes(1);
  });

  it("enforces model timeout/context size before later operations", async () => {
    const slow = createDayScriptedModel();
    vi.spyOn(slow, "decide").mockImplementation(() => new Promise(() => {}));
    expect(await run(problem(), { model: slow, limits: { modelMs: 5 } })).toMatchObject({ status: "failed", code: "timeout" });
    const model = createDayScriptedModel();
    const decide = vi.spyOn(model, "decide");
    expect(await run(problem(), { model, limits: { contextBytes: 100 } })).toMatchObject({ status: "failed", code: "context_limit", counts: { model: 0 } });
    expect(decide).not.toHaveBeenCalled();
  });

  it("does not expose coordinates, addresses, provider IDs or credentials to the decision model", async () => {
    const contexts: string[] = [];
    const heuristic = createDayScriptedModel();
    const model = { ...heuristic, decide: async (context: DayDecisionContext, options: { signal: AbortSignal }) => {
      contexts.push(JSON.stringify(context));
      return heuristic.decide(context, options);
    } };
    await run(problem(), { model });
    const serialized = contexts.join("\n");
    for (const disallowed of ["longitude", "latitude", "address", "externalId", "DEMO-", "apiKey", "token"]) {
      expect(serialized).not.toContain(disallowed);
    }
  });

  it("does not allow test settings to expand production bounds", () => {
    expect(() => createDayPlanningRunner({
      provider: {} as MobilityProvider, model: createDayScriptedModel(), limits: { model: 11 },
    })).toThrow();
  });
});
