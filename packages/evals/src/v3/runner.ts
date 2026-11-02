import { runSessionBoundaries } from "./boundaries";
import { auditSession } from "./session-scoring";
import { randomUUID } from "node:crypto";
import { generateBaselineCandidate } from "@tripquest/domain";
import {
  createInvestigation, createScriptedModel, runAgent,
  type AgentResult, type DecisionModel, type InvestigationSnapshot,
} from "@tripquest/agent";
import { createRouteTool } from "../route-tool";
import { FIXTURE_EVIDENCE } from "../cases/dataset";
import type { PlanningCall } from "../contracts";
import { scoreFeedback } from "./scoring";
import { runRow, type V2Options } from "../v2/runner";
import { V2_IDS } from "../v2/dataset";
import { clarificationCase, injectedModel, mechanisms, places, sourceCase } from "./cases";

export async function runMechanism(id: string, live?: DecisionModel, signal?: AbortSignal) {
  const c = sourceCase("E13");
  const spec = mechanisms.find((entry) => entry.id === id);
  if (!spec) throw new Error("Unknown mechanism");
  const tool = createRouteTool(c.world, FIXTURE_EVIDENCE);
  const calls: PlanningCall[] = [];
  const model = injectedModel(spec.actions, live ?? createScriptedModel());
  let output: AgentResult | null = null;
  let exception: string | null = null;
  try {
    output = await runAgent(c.input, {
      model, signal, decisionPolicy: "feedback_once", lookupRoute: tool.lookupRoute,
      plan(input) {
        const result = generateBaselineCandidate(input);
        calls.push({ input, result, toolCallsAtPlanning: tool.snapshot().length });
        return result;
      },
    });
  } catch {
    exception = "execution_error";
  } finally {
    tool.close();
  }
  const score = output ? scoreFeedback(c, "model_agent", output, calls, tool.snapshot()) : null;
  const recovered = output?.executionStatus === "completed" && output.repairAttempts === 1;
  const mechanismPassed = !!output && !exception && score?.safety === true &&
    output.executionStatus === spec.execution && output.rejectedActions === spec.rejects &&
    output.repairAttempts === spec.repairs &&
    (live ? output.modelRequests <= 4 : output.modelRequests === spec.models) &&
    (live ? output.routeRequests <= 3 : output.routeRequests === spec.routes) &&
    (spec.execution === "completed" ? score.quality : output.result.status !== "candidate_found");
  return {
    caseId: id, evidenceKind: live ? "scripted-injection + live-repair" : "scripted-injection",
    model: model.model, provider: model.provider,
    expected: { ...spec, actions: undefined }, output, score, recovered, mechanismPassed,
    trace: tool.snapshot(), calls, exception,
    realRequests: model.getRequestCount?.() ?? 0,
    cost: { amount: null, currency: null, note: "费用 unknown；合成注入不是 API 请求" },
  };
}

export async function runClarification(id: string, choice?: string, model = createScriptedModel(), signal?: AbortSignal) {
  const c = clarificationCase(id);
  const tool = createRouteTool(c.world, FIXTURE_EVIDENCE);
  const calls: PlanningCall[] = [];
  const session = createInvestigation(c.input, {
    places, model, signal, decisionPolicy: "feedback_once", lookupRoute: tool.lookupRoute,
    plan(input) {
      const result = generateBaselineCandidate(input);
      calls.push({ input, result, toolCallsAtPlanning: tool.snapshot().length });
      return result;
    },
  });
  let snapshot: InvestigationSnapshot;
  let exception: string | null = null;
  try {
    snapshot = await session.start();
    if (choice === "cancel") snapshot = session.cancel();
    else if (choice !== undefined && snapshot.question) {
      snapshot = await session.answer({
        questionId: snapshot.question.questionId,
        snapshotFingerprint: snapshot.question.snapshotFingerprint,
        choice,
      }, c.input);
    }
  } catch {
    snapshot = session.snapshot();
    exception = "execution_error";
  } finally {
    tool.close();
  }
  const reference = sourceCase(id === "C01" ? "E02" : "E13");
  const score = snapshot.followup && snapshot.output ? scoreFeedback(
    { ...reference, input: snapshot.followup }, "model_agent", snapshot.output,
    calls.slice(1), tool.snapshot(),
  ) : null;
  const transitionFailures = auditSession(snapshot, tool.snapshot());
  const outcomePassed = choice === "cancel" ? snapshot.status === "cancelled"
    : choice === undefined ? snapshot.status === "awaiting_user" && tool.snapshot().length === 0
    : choice === "cannot_answer" ? snapshot.initialResult.status === "needs_information" &&
      snapshot.output === null && snapshot.followup === null && tool.snapshot().length === 0
    : !!score?.passed;
  return {
    caseId: id, evidenceKind: model.mode === "live" ? "natural-live-with-user-answer" : "scripted-session",
    model: model.model, provider: model.provider,
    snapshot, score, transitionFailures, exception, passed: !exception && outcomePassed && !transitionFailures.length, trace: tool.snapshot(), calls,
    realRequests: model.getRequestCount?.() ?? 0,
    cost: { amount: null, currency: null, note: "费用 unknown；用户新信息收益单独记录" },
  };
}

/** All five strategies receive the exact same answered snapshot. No injected failures here. */
export async function runNatural(options: V2Options) {
  const rows = [];
  for (const id of ["E13", "E14", "C01", "C02"]) {
    const session = id.startsWith("C")
      ? await runClarification(id, id === "C01" ? "P-C" : "P-B") : null;
    const base = sourceCase(id === "C01" ? "E02" : id === "C02" ? "E13" : id);
    const c = { ...base, input: session?.snapshot.followup ?? base.input };
    for (const strategy of [...V2_IDS, "model_agent_feedback"] as const) {
      const row = await runRow(c, strategy === "model_agent_feedback" ? "model_agent" : strategy, {
        ...options,
        decisionPolicy: strategy === "model_agent_feedback" ? "feedback_once" : "fail_fast",
      });
      const score = strategy === "model_agent_feedback" && row.output
        ? scoreFeedback(c, "model_agent", row.output, row.planningCalls, row.trace)
        : row.score;
      rows.push({
        ...row, score, caseId: id, plannerId: strategy,
        initialStatus: session?.snapshot.initialResult.status ?? row.output?.result.status,
        answeredSnapshot: session?.snapshot.followupFingerprint ?? null,
        repairUsage: row.output?.repairAttempts ? "used" : "unused",
        passed: !!score?.passed && !row.exception,
      });
    }
  }
  return rows;
}
export async function runFeedbackSuite(options: V2Options) {
  const mechanismRows = [];
  for (const spec of mechanisms) mechanismRows.push(await runMechanism(spec.id));
  const sessions = [];
  for (const [id, choice] of [["C01", "P-C"], ["C02", "P-B"], ["C03", "cannot_answer"]]) {
    sessions.push(await runClarification(id, choice));
  }
  const natural = await runNatural(options);
  const boundaries = await runSessionBoundaries();
  return {
    schemaVersion: 3, runId: randomUUID(), startedAt: new Date().toISOString(),
    git: options.git, datasetVersion: "s43-feedback-session-v1",
    mechanismRows, sessions, natural, boundaries,
    passed: boundaries.every((row) => row.mechanismPassed) && mechanismRows.every((row) => row.mechanismPassed) &&
      sessions.every((row) => row.passed) && natural.every((row) => row.passed),
  };
}
