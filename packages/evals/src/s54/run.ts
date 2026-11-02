import { randomUUID } from "node:crypto";
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
  type DayPlanningDecisionModel,
} from "@tripquest/agent/day-planning";
import {
  createReplanRunner,
  createReplanScriptedModel,
  type ReplanDecisionModel,
} from "@tripquest/agent/replanning";
import type { DraftCase, ReplanCase, S54Case } from "./dataset";
import { prepareReplanCase } from "./journey";
import { checkDraft, checkReplan, type Violation } from "./score";
import { FaultInjectingProvider, S54_NOW } from "./world";

export type Policy = "scripted" | "live";

/** Live models come from the CLI; scripted ones are built here and need no network. */
export interface ModelFactories {
  readonly day: () => DayPlanningDecisionModel;
  readonly replan: () => ReplanDecisionModel;
}

export interface S54Row {
  readonly caseId: string;
  readonly flow: S54Case["flow"];
  readonly title: string;
  readonly policy: Policy;
  readonly expect: S54Case["expect"];
  /** draft | candidate | unchanged | no_plan | no_candidate | preflight | failed | cancelled */
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly passed: boolean;
  readonly misses: readonly string[];
  readonly violations: readonly Violation[];
  readonly metrics: null | {
    readonly activities: number;
    readonly walking: number;
    readonly longest: number;
    readonly waiting: number;
    /** Minutes between arriving at the end place and the end of the window. */
    readonly slack: number;
  };
  readonly baseline: null | { readonly activities: number; readonly walking: number; readonly waiting: number };
  readonly chosen?: "baseline" | "agent";
  readonly goalMet?: boolean;
  readonly usage: {
    readonly modelRequests: number;
    readonly tokens: number | null;
    readonly searches: number;
    readonly tries: number;
    readonly routes: number;
    readonly semanticRepairs: number;
    readonly elapsedMs: number;
  };
  readonly returnedModels: readonly string[];
  /** Guard codes the product sent back on a repair turn (its own feedback, not model output). */
  readonly repairCodes: readonly string[];
  readonly exception?: string;
}

/** Records which model answered and the guard feedback it was given; never prompts or replies. */
function observed<T extends {
  decide(context: never, options: { signal: AbortSignal }): Promise<{ returnedModel?: string }>;
}>(model: T, seen: Set<string>, repairs: string[]): T {
  const decide = model.decide.bind(model) as (
    context: unknown,
    options: { signal: AbortSignal },
  ) => Promise<{ returnedModel?: string }>;
  return {
    ...model,
    decide: async (context: unknown, options: { signal: AbortSignal }) => {
      const feedback = (context as { feedback?: { code?: unknown } | null }).feedback;
      if (typeof feedback?.code === "string") repairs.push(feedback.code);
      const reply = await decide(context, options);
      if (reply.returnedModel) seen.add(reply.returnedModel);
      return reply;
    },
  };
}

const scripted: ModelFactories = {
  day: () => createDayScriptedModel(),
  replan: () => createReplanScriptedModel(),
};

export async function runS54Case(
  item: S54Case,
  policy: Policy,
  live?: ModelFactories,
  signal: AbortSignal = new AbortController().signal,
): Promise<S54Row> {
  const factories = policy === "live" ? live : scripted;
  if (!factories) throw new Error("Live model factories are required for the live policy");
  try {
    return item.flow === "draft"
      ? await runDraft(item, policy, factories, signal)
      : await runReplan(item, policy, factories, signal);
  } catch (error) {
    return {
      caseId: item.id,
      flow: item.flow,
      title: item.title,
      policy,
      expect: item.expect,
      outcome: "exception",
      reasons: [],
      passed: false,
      misses: ["exception"],
      violations: [],
      metrics: null,
      baseline: null,
      usage: { modelRequests: 0, tokens: null, searches: 0, tries: 0, routes: 0, semanticRepairs: 0, elapsedMs: 0 },
      returnedModels: [],
      repairCodes: [],
      exception: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
}

async function runDraft(
  item: DraftCase,
  policy: Policy,
  factories: ModelFactories,
  signal: AbortSignal,
): Promise<S54Row> {
  const problem = createDayPlanningProblem({
    requirements: item.requirements,
    runId: randomUUID(),
    requirementsFingerprint: fingerprintRequirements(item.requirements),
    nowMs: S54_NOW,
  });
  const seen = new Set<string>();
  const repairs: string[] = [];
  const provider = new FaultInjectingProvider(item.faults);
  let snapshot: DayDraftConfirmationSnapshot | undefined;
  const result: DayPlanningResult = await createDayPlanningRunner({
    provider,
    model: observed(factories.day(), seen, repairs),
    now: () => S54_NOW,
  }).run(problem, {
    signal,
    onProgress: () => {},
    onDraftReady: (ready) => {
      snapshot = ready;
    },
  });

  let outcome: string = result.status;
  let reasons: string[] = [];
  let violations: Violation[] = [];
  let metrics: S54Row["metrics"] = null;
  if (result.status === "completed" && result.outcome === "draft") {
    outcome = "draft";
    violations = await checkDraft(item, result, snapshot);
    const { draft } = result;
    metrics = {
      activities: draft.activities.length,
      walking: draft.totalWalkingMinutes,
      longest: draft.longestWalkingMinutes,
      waiting: draft.activities.reduce((sum, entry) => sum + entry.waitMinutes, 0),
      slack: draft.window.endsAt - draft.endArrival,
    };
  } else if (result.status === "completed") {
    outcome = "no_plan";
    reasons = [result.reason];
  } else if (result.status === "failed") {
    reasons = [result.code];
  }

  const misses = expectationMisses(item, outcome, reasons, violations);
  if (item.expect === "must_plan" && metrics && metrics.activities < (item.minActivities ?? 1)) {
    misses.push("too_few_activities");
  }
  return {
    caseId: item.id,
    flow: "draft",
    title: item.title,
    policy,
    expect: item.expect,
    outcome,
    reasons,
    passed: misses.length === 0,
    misses,
    violations,
    metrics,
    baseline: null,
    usage: {
      modelRequests: result.counts.model,
      tokens: result.usage?.totalTokens ?? null,
      searches: provider.searches,
      tries: result.counts.tries,
      routes: provider.routes,
      semanticRepairs: result.counts.semanticRepairs,
      elapsedMs: result.elapsedMs,
    },
    returnedModels: [...seen],
    repairCodes: repairs,
  };
}

async function runReplan(
  item: ReplanCase,
  policy: Policy,
  factories: ModelFactories,
  signal: AbortSignal,
): Promise<S54Row> {
  const { preparation } = await prepareReplanCase(item);
  const row = {
    caseId: item.id,
    flow: "replan" as const,
    title: item.title,
    policy,
    expect: item.expect,
  };
  if (preparation.status !== "ready") {
    // Refused before any model or route request, exactly as the product does.
    const reasons = preparation.status === "constraints_conflict"
      ? preparation.conflicts.map((conflict) => `preflight:${conflict.code}`)
      : [`preflight:${"reason" in preparation ? preparation.reason : preparation.status}`];
    const misses = expectationMisses(item, "preflight", reasons, []);
    return {
      ...row,
      outcome: "preflight",
      reasons,
      passed: misses.length === 0,
      misses,
      violations: [],
      metrics: null,
      baseline: null,
      usage: { modelRequests: 0, tokens: null, searches: 0, tries: 0, routes: 0, semanticRepairs: 0, elapsedMs: 0 },
      returnedModels: [],
      repairCodes: [],
    };
  }

  const { problem } = preparation;
  const seen = new Set<string>();
  const repairs: string[] = [];
  const provider = new FaultInjectingProvider(item.faults);
  const result: ReplanResult = await createReplanRunner({
    provider,
    model: observed(factories.replan(), seen, repairs),
    now: () => S54_NOW,
  }).run(problem, { signal, onProgress: () => {} });

  let outcome: string = result.status;
  let reasons: string[] = [];
  let metrics: S54Row["metrics"] = null;
  let baseline: S54Row["baseline"] = null;
  let chosen: S54Row["chosen"];
  let goalMet: boolean | undefined;
  const violations = await checkReplan(item, problem, result);
  if (result.status === "completed" && result.outcome === "candidate") {
    outcome = "candidate";
    chosen = result.chosen;
    const m = result.candidate.metrics;
    metrics = {
      activities: m.activities,
      walking: m.walking,
      longest: m.longest,
      waiting: m.waiting,
      slack: result.candidate.end.endsAt - m.endArrival,
    };
    const base = result.comparison.baseline;
    if (base?.status === "scheduled") {
      baseline = { activities: base.metrics.activities, walking: base.metrics.walking, waiting: base.metrics.waiting };
    }
  } else if (result.status === "completed" && result.outcome === "unchanged") {
    outcome = "unchanged";
  } else if (result.status === "completed") {
    outcome = "no_candidate";
    reasons = [result.reason];
  } else if (result.status === "failed") {
    reasons = [result.code];
  }

  const misses = expectationMisses(item, outcome, reasons, violations);
  if (item.goalCheck && (outcome === "candidate" || outcome === "unchanged")) {
    goalMet = outcome === "unchanged" || !baseline || metrics === null
      ? true
      : item.goal === "less_walking"
        ? metrics.walking <= baseline.walking
        : metrics.activities <= baseline.activities || metrics.waiting <= baseline.waiting;
    if (!goalMet) misses.push("goal_not_met");
  }
  return {
    ...row,
    outcome,
    reasons,
    passed: misses.length === 0,
    misses,
    violations,
    metrics,
    baseline,
    ...(chosen ? { chosen } : {}),
    ...(goalMet === undefined ? {} : { goalMet }),
    usage: {
      modelRequests: result.counts.model,
      tokens: result.usage?.totalTokens ?? null,
      searches: provider.searches,
      tries: result.counts.tries,
      routes: provider.routes,
      semanticRepairs: result.counts.semanticRepairs,
      elapsedMs: result.elapsedMs,
    },
    returnedModels: [...seen],
    repairCodes: repairs,
  };
}

const PLANNED = new Set(["draft", "candidate", "unchanged"]);
const REFUSED = new Set(["no_plan", "no_candidate", "preflight"]);

/** Hand-written acceptance rules; a violation always fails, whatever the outcome. */
function expectationMisses(
  item: S54Case,
  outcome: string,
  reasons: readonly string[],
  violations: readonly Violation[],
): string[] {
  const misses: string[] = [];
  if (violations.length) misses.push("violation");
  if (item.expect === "must_plan" && !PLANNED.has(outcome)) misses.push("expected_plan");
  if (item.expect === "must_refuse") {
    if (!REFUSED.has(outcome)) misses.push("expected_refusal");
    else if (item.refuseReasons && !reasons.some((reason) => item.refuseReasons!.includes(reason))) {
      misses.push("wrong_refusal_reason");
    }
  }
  if (item.expect === "either_honest" && !PLANNED.has(outcome) && !REFUSED.has(outcome)) {
    misses.push("not_honest_outcome");
  }
  return misses;
}
