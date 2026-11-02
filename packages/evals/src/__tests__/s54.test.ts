import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDayPlanningProblem,
  type DayPlanningResult,
} from "@tripquest/application/day-planning";
import {
  fingerprintRequirements,
  type DayDraftConfirmationSnapshot,
} from "@tripquest/application/day-confirmation";
import type { ReplanResult } from "@tripquest/application/day-replan";
import {
  createDayPlanningRunner,
  createDayScriptedModel,
} from "@tripquest/agent/day-planning";
import { createReplanRunner, createReplanScriptedModel } from "@tripquest/agent/replanning";
import {
  S54_CASES,
  s54DatasetDigest,
  type DraftCase,
  type ReplanCase,
} from "../s54/dataset";
import { prepareReplanCase } from "../s54/journey";
import { checkDraft, checkReplan } from "../s54/score";
import { runS54Case, type ModelFactories } from "../s54/run";
import { renderS54, summarize } from "../s54/report";
import { s54LiveBudget, S54_ROUND_REQUESTS } from "../s54/budget";
import { parsePlanningOptions } from "../s54/options";
import { FaultInjectingProvider, S54_NOW } from "../s54/world";

const draftCase = (id: string) => S54_CASES.find((item) => item.id === id) as DraftCase;
const replanCase = (id: string) => S54_CASES.find((item) => item.id === id) as ReplanCase;
const signal = () => new AbortController().signal;

async function scriptedDraft(item: DraftCase) {
  const problem = createDayPlanningProblem({
    requirements: item.requirements,
    runId: "00000000-0000-4000-8000-000000000054",
    requirementsFingerprint: fingerprintRequirements(item.requirements),
    nowMs: S54_NOW,
  });
  let snapshot: DayDraftConfirmationSnapshot | undefined;
  const result = await createDayPlanningRunner({
    provider: new FaultInjectingProvider(item.faults),
    model: createDayScriptedModel(),
    now: () => S54_NOW,
  }).run(problem, { signal: signal(), onProgress: () => {}, onDraftReady: (ready) => (snapshot = ready) });
  if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected a draft");
  return { result, snapshot: snapshot! };
}

async function scriptedReplan(item: ReplanCase) {
  const { preparation } = await prepareReplanCase(item);
  if (preparation.status !== "ready") throw new Error("expected a ready replan");
  const result = await createReplanRunner({
    provider: new FaultInjectingProvider(item.faults),
    model: createReplanScriptedModel(),
    now: () => S54_NOW,
  }).run(preparation.problem, { signal: signal(), onProgress: () => {} });
  return { problem: preparation.problem, result };
}

describe("S5.4 dataset", () => {
  it("has 12 draft and 12 replan cases with complete, unique expectations", () => {
    expect(S54_CASES.filter((item) => item.flow === "draft")).toHaveLength(12);
    expect(S54_CASES.filter((item) => item.flow === "replan")).toHaveLength(12);
    expect(new Set(S54_CASES.map((item) => item.id)).size).toBe(24);
    for (const item of S54_CASES) {
      expect(item.note.length).toBeGreaterThan(5);
      if (item.expect === "must_refuse") expect(item.refuseReasons?.length).toBeGreaterThan(0);
    }
  });

  it("has a stable digest that changes when a case changes", () => {
    expect(s54DatasetDigest()).toBe(s54DatasetDigest());
    const edited = S54_CASES.map((item) => item.id === "D01" ? { ...item, expect: "either_honest" as const } : item);
    expect(s54DatasetDigest(edited)).not.toBe(s54DatasetDigest());
  });
});

describe("S5.4 independent recheck catches forged results", () => {
  it("rejects a draft whose fixed visit was moved or whose walk was shortened", async () => {
    const item = draftCase("D03");
    const { result, snapshot } = await scriptedDraft(item);
    expect(await checkDraft(item, result, snapshot)).toEqual([]);

    const moved = structuredClone(result);
    const fixed = moved.draft.activities.find((entry) => entry.startsAt === 9 * 60 + 30)!;
    fixed.startsAt += 5;
    fixed.endsAt += 5;
    expect(await checkDraft(item, moved, snapshot)).toEqual(
      expect.arrayContaining(["day_schedule_mismatch", "fixed_time_changed"]),
    );

    const shortened = structuredClone(result);
    shortened.draft.legs[0].travelMinutes = 1;
    expect(await checkDraft(item, shortened, snapshot)).toContain("day_schedule_mismatch");
  });

  it("rejects a draft that walks a route the case world does not have", async () => {
    const clean = draftCase("D06");
    const { result, snapshot } = await scriptedDraft({ ...clean, faults: undefined });
    // Same draft, judged in the world where START → MUSEUM-B is unknown.
    expect(await checkDraft(clean, result, snapshot)).toContain("day_route_unknown");
  });

  it("rejects a required visit that disappeared from the draft", async () => {
    const item = draftCase("D03");
    const { result, snapshot } = await scriptedDraft(item);
    const required = item.requirements.visits.find((visit) => visit.role === "required")!;
    const forged: Extract<DayPlanningResult, { outcome: "draft" }> = structuredClone(result);
    const place = snapshot.places.find((entry) =>
      entry.selection.place.ref.externalId === required.place.place.ref.externalId)!;
    forged.draft.activities = forged.draft.activities.filter((entry) => entry.placeId !== place.placeId);
    expect(await checkDraft(item, forged, snapshot)).toContain("missing_required");
  });

  it("rejects a replan candidate with a moved frozen activity or a swapped selection", async () => {
    const item = replanCase("R03");
    const { problem, result } = await scriptedReplan(item);
    if (result.status !== "completed" || result.outcome !== "candidate") throw new Error("expected a candidate");
    expect(await checkReplan(item, problem, result)).toEqual([]);

    const frozen = structuredClone(result);
    const tail = frozen.candidate.activities.find((entry) => entry.frozen)!;
    tail.startsAt += 10;
    expect(await checkReplan(item, problem, frozen)).toContain("frozen_changed");

    const r05 = replanCase("R05");
    const other = await scriptedReplan(r05);
    if (other.result.status !== "completed" || other.result.outcome !== "candidate") throw new Error("candidate");
    const swapped: ReplanResult = { ...other.result, selection: [...other.result.selection].reverse() };
    expect(await checkReplan(r05, other.problem, swapped)).toEqual(
      expect.arrayContaining([expect.stringMatching(/candidate_mismatch|candidate_not_rebuildable/)]),
    );
  });

  it("rejects 'unchanged' when the current order no longer works", async () => {
    const item = replanCase("R02");
    const { problem, result } = await scriptedReplan(item);
    const forged: ReplanResult = {
      runId: result.runId,
      counts: result.counts,
      elapsedMs: 0,
      usage: null,
      status: "completed",
      outcome: "unchanged",
      explanation: "伪造：保持原安排",
    };
    expect(await checkReplan(item, problem, forged)).toEqual(["unchanged_but_infeasible"]);
  });
});

describe("S5.4 runner and report", () => {
  it("records the rule baseline: 22/24, misses only D07 and R02, no violations", async () => {
    const rows = [];
    for (const item of S54_CASES) rows.push(await runS54Case(item, "scripted"));
    expect(rows.flatMap((row) => row.violations)).toEqual([]);
    expect(rows.filter((row) => !row.passed).map((row) => row.caseId)).toEqual(["D07", "R02"]);
    // Preflight refusals never reach a model or a route.
    for (const row of rows.filter((entry) => entry.outcome === "preflight")) {
      expect(row.usage.modelRequests + row.usage.routes).toBe(0);
    }
    const summary = summarize(rows, "scripted");
    expect(summary).toMatchObject({ rows: 24, passed: 22, violations: 0, mustRefuse: { correct: 9, total: 9 } });
    const markdown = renderS54({
      runId: "s54-test",
      startedAt: new Date(S54_NOW).toISOString(),
      dataset: { version: "v", digest: s54DatasetDigest(), cases: 24 },
      git: { sha: "test", dirty: null },
      policies: ["scripted"],
      live: null,
      rows,
    });
    expect(markdown).toContain("| scripted | 22/24 | 12/14 | 9/9 | 0 | 2/2，2 |");
  }, 60_000);

  it("records an injected policy that gives up dishonestly, while the code still answers honestly", async () => {
    // Always "no suitable places", even with places in hand: the product guard rejects it
    // (two semantic repairs since V2.1). Since V2.3 the code then tries the appointments alone,
    // finds they cannot connect, and gives the honest refusal itself; the repairs stay recorded.
    const models: ModelFactories = {
      day: () => ({
        mode: "live",
        provider: "test",
        model: "test-model",
        decide: async () => ({
          decision: { action: "stop", reason: "no_suitable_places" },
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheHitTokens: null, cacheMissTokens: null },
          returnedModel: "test-model-0601",
        }),
      }),
      replan: () => createReplanScriptedModel(),
    };
    const row = await runS54Case(draftCase("D04"), "live", models);
    expect(row).toMatchObject({
      outcome: "no_plan",
      reasons: ["constraints_not_met"],
      passed: true,
      misses: [],
      violations: [],
      returnedModels: ["test-model-0601"],
      // V2.2: the refusal says what to do instead.
      repairCodes: ['unsupported_stop: nothing tried yet; try ["a1","a2"]', 'unsupported_stop: nothing tried yet; try ["a1","a2"]'],
      usage: { modelRequests: 3, tokens: 36, semanticRepairs: 2 },
    });
  });
});

describe("S5.4 live budget and options", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reserves a round once and caps its requests", async () => {
    directory = mkdtempSync(join(tmpdir(), "s54-budget-"));
    const budget = s54LiveBudget(directory, "developer");
    await expect(budget.beforeRequest()).rejects.toThrow("exhausted");
    await budget.reserveRound();
    await expect(budget.reserveRound()).rejects.toThrow("already used");
    for (let index = 0; index < S54_ROUND_REQUESTS; index += 1) await budget.beforeRequest();
    await expect(budget.beforeRequest()).rejects.toThrow("exhausted");
    // Another round has its own allowance in the same ledger.
    const test = s54LiveBudget(directory, "test");
    await test.reserveRound();
    await test.beforeRequest();
    const lines = readFileSync(join(directory, "s54-live-budget.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(S54_ROUND_REQUESTS + 3);
  });

  it("parses options strictly", () => {
    expect(parsePlanningOptions([]).caseIds).toHaveLength(24);
    expect(parsePlanningOptions(["--case", "D01,R03"]).caseIds).toEqual(["D01", "R03"]);
    expect(parsePlanningOptions(["--", "--case", "D01"]).caseIds).toEqual(["D01"]);
    expect(parsePlanningOptions(["--policy", "live", "--live-round", "developer"]).round).toBe("developer");
    expect(() => parsePlanningOptions(["--policy", "live"])).toThrow();
    expect(() => parsePlanningOptions(["--live-round", "developer"])).toThrow();
    expect(() => parsePlanningOptions(["--case", "D01,D01"])).toThrow();
    expect(() => parsePlanningOptions(["--case", "X99"])).toThrow();
    expect(() => parsePlanningOptions(["--policy", "scripted", "--policy", "live"])).toThrow();
  });
});
