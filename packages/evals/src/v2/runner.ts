import { createHash, randomUUID } from "node:crypto";
import { generateBaselineCandidate } from "@tripquest/domain";
import {
  createScriptedModel,
  runAgent,
  GRAPH_VERSION,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  LIMITS,
  type AgentResult,
  type DecisionModel,
  type Plan,
} from "@tripquest/agent";
import { datasetV2, V2_IDS, type V2Case, type V2PlannerId } from "./dataset";
import { validateV2Cases } from "./validation";
import { scoreV2 } from "./scoring";
import { runAdaptive } from "./adaptive";
import { createRouteTool } from "../route-tool";
import { FIXTURE_EVIDENCE } from "../cases/dataset";
import { canonical } from "../dataset-validation";
import { rulesOnly, fixedWorkflow } from "../planners";
import type { PlanningCall, ToolCall } from "../contracts";

export interface V2Options {
  readonly decisionPolicy?: "fail_fast" | "feedback_once";
  readonly caseIds?: readonly string[];
  readonly plannerIds?: readonly V2PlannerId[];
  readonly modelFactory?: () => DecisionModel;
  readonly profileId?: string;
  readonly profileHash?: string;
  readonly git: { sha: string; dirty: boolean | null };
  readonly signal?: AbortSignal;
  readonly onRow?: (row: V2Row) => void | Promise<void>;
}
export interface V2Row {
  readonly caseId: string;
  readonly title: string;
  readonly plannerId: V2PlannerId;
  readonly modelMode: "none" | "scripted" | "live";
  readonly provider: string | null;
  readonly model: string | null;
  readonly elapsedMs: number;
  readonly output: AgentResult | null;
  readonly expected: V2Case["expected"][V2PlannerId];
  readonly trace: readonly ToolCall[];
  readonly planningCalls: readonly PlanningCall[];
  readonly score: ReturnType<typeof scoreV2> | null;
  readonly exception: string | null;
  readonly cost: {
    modelApiCalls: number;
    mapApiCalls: 0;
    inputTokens: number | null;
    outputTokens: number | null;
    currency: null;
    estimatedAmount: number | null;
    note: string;
  };
}
export async function runRow(c: V2Case, id: V2PlannerId, options: V2Options): Promise<V2Row> {
  const start = performance.now();
  const tool = createRouteTool(c.world, FIXTURE_EVIDENCE);
  const calls: PlanningCall[] = [];
  let model: DecisionModel | null = null;
  let output: AgentResult | null = null;
  let exception: string | null = null;
  const plan: Plan = (input) => {
    if (calls.length >= (id === "rules_only" ? 1 : id === "fixed_workflow" ? 2 : 4)) {
      throw new Error("Plan limit");
    }
    const snapshot = structuredClone(input);
    const result = generateBaselineCandidate(snapshot);
    calls.push({ input: snapshot, result: structuredClone(result), toolCallsAtPlanning: tool.snapshot().length });
    return structuredClone(result);
  };
  try {
    if (id === "model_agent") {
      model = (options.modelFactory ?? createScriptedModel)();
      output = await runAgent(c.input, { plan, lookupRoute: tool.lookupRoute, model: model!, signal: options.signal, decisionPolicy: options.decisionPolicy });
    } else if (id === "adaptive_workflow") {
      output = await runAdaptive(c.input, plan, tool.lookupRoute);
    } else {
      const planner = id === "rules_only" ? rulesOnly : fixedWorkflow;
      const result = await planner.run({
        input: structuredClone(c.input),
        plan,
        lookupRoute: tool.lookupRoute,
        budget: LIMITS.routes,
      });
      const failure = tool.snapshot().find((event) => event.result.status === "failure" &&
        ["authorization_failed", "quota_exceeded"].includes(event.result.failure.code));
      const error = failure?.result.status === "failure"
        ? failure.result.failure.code === "authorization_failed" ? "auth" : "quota"
        : null;
      output = {
        ...result,
        executionStatus: error ? "model_error" : "completed",
        error,
        modelRequests: 0,
        routeRequests: tool.snapshot().length,
        planningCalls: calls.length,
        rejectedActions: 0,
        decisions: [],
        observations: [],
      };
    }
  } catch {
    exception = "execution_error";
  } finally {
    tool.close();
  }
  const trace = tool.snapshot();
  let score: V2Row["score"] = null;
  if (output) {
    try {
      score = scoreV2(c, id, output, calls, trace);
    } catch {
      exception = "scoring_error";
    }
  }
  const live = model?.mode === "live";
  const decisions = output?.decisions ?? [];
  const usageKnown = !!output && decisions.length === output.modelRequests && decisions.every((d) => d.usage !== null);
  return {
    caseId: c.id,
    title: c.title,
    plannerId: id,
    modelMode: model?.mode ?? "none",
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    elapsedMs: performance.now() - start,
    output,
    expected: c.expected[id],
    trace,
    planningCalls: calls,
    score,
    exception,
    cost: {
      modelApiCalls: live ? model?.getRequestCount?.() ?? output?.modelRequests ?? 0 : 0,
      mapApiCalls: 0,
      inputTokens: !live ? 0 : usageKnown ? decisions.reduce((n, d) => n + d.usage!.inputTokens, 0) : null,
      outputTokens: !live ? 0 : usageKnown ? decisions.reduce((n, d) => n + d.usage!.outputTokens, 0) : null,
      currency: null,
      estimatedAmount: live ? null : 0,
      note: live ? "费用 unknown：未绑定经核实的当日费率；缺失 usage 不补零" : "离线，无真实模型调用；scripted 只验证工程",
    },
  };
}
export async function runV2(options: V2Options) {
  validateV2Cases(datasetV2.cases);
  const ids = options.caseIds ?? datasetV2.cases.map((c) => c.id);
  const plannerIds = options.plannerIds ?? V2_IDS;
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !datasetV2.cases.some((c) => c.id === id))) {
    throw new Error("Invalid case selection");
  }
  if (!plannerIds.length || new Set(plannerIds).size !== plannerIds.length || plannerIds.some((id) => !V2_IDS.includes(id))) {
    throw new Error("Invalid planner selection");
  }
  const rows: V2Row[] = [];
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  for (const c of datasetV2.cases.filter((c) => ids.includes(c.id))) {
    for (const id of plannerIds) {
      const row = await runRow(structuredClone(c), id, options);
      rows.push(row);
      await options.onRow?.(row);
      if (row.output?.error === "auth" || row.output?.error === "quota" || options.signal?.aborted) {
        return report(true);
      }
    }
  }
  return report(false);

  function report(stoppedEarly: boolean) {
    return {
      schemaVersion: 2,
      runId,
      startedAt,
      datasetVersion: datasetV2.version,
      datasetHash: createHash("sha256").update(canonical(datasetV2)).digest("hex"),
      git: options.git,
      versions: { graph: GRAPH_VERSION, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION, planner: "v2.1" },
      profileId: options.profileId ?? null,
      profileHash: options.profileHash ?? null,
      limits: LIMITS,
      selectedCases: ids,
      selectedPlanners: plannerIds,
      stoppedEarly,
      skippedRuns: ids.length * plannerIds.length - rows.length,
      rows,
      summary: plannerIds.map((id) => {
        const subset = rows.filter((r) => r.plannerId === id);
        const count = (check: (r: V2Row) => boolean) => subset.filter(check).length;
        return {
          plannerId: id,
          total: subset.length,
          passed: count((r) => !!r.score?.passed && !r.exception),
          quality: count((r) => !!r.score?.quality),
          safety: count((r) => !!r.score?.safety),
          execution: count((r) => !!r.score?.execution && !r.exception),
          candidates: count((r) => r.output?.result.status === "candidate_found"),
          modelApiCalls: subset.reduce((n, r) => n + r.cost.modelApiCalls, 0),
          toolCalls: subset.reduce((n, r) => n + r.trace.length, 0),
          elapsedMs: subset.reduce((n, r) => n + r.elapsedMs, 0),
        };
      }),
    };
  }
}
export type V2Report = Awaited<ReturnType<typeof runV2>>;
