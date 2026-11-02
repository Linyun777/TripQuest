import { randomUUID } from "node:crypto";
import { generateBaselineCandidate } from "@tripquest/domain";
import type { Dataset, EvaluationRow, Planner, PlannerOutput, PlanningCall } from "./contracts";
import { TOOL_BUDGET } from "./contracts";
import { validateDataset, datasetHash, canonical } from "./dataset-validation";
import { createRouteTool } from "./route-tool";
import { scoreOutput } from "./scoring";

export interface RunOptions { readonly caseIds?: readonly string[]; readonly git: { sha: string; dirty: boolean | null } }
export async function runEvaluation(dataset: Dataset, planners: readonly Planner[], options: RunOptions) {
  validateDataset(dataset);
  const ids = options.caseIds ?? dataset.cases.map((c) => c.id);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !dataset.cases.some((c) => c.id === id))) throw new Error("Unknown or duplicate case selection");
  if (!planners.length || new Set(planners.map((p) => p.id)).size !== planners.length || planners.some((p) => !["rules_only", "fixed_workflow"].includes(p.id))) throw new Error("Invalid planner selection");
  const startedAt = new Date().toISOString();
  const rows: EvaluationRow[] = [];
  for (const source of dataset.cases.filter((c) => ids.includes(c.id))) for (const planner of planners) {
    const c = structuredClone(source);
    const start = performance.now();
    const initial = generateBaselineCandidate(structuredClone(c.input));
    const tool = createRouteTool(c.world, { provider: "tripquest-eval-fixture", sourceKind: "fixture", retrievedAt: c.input.state.observedAt, attribution: "虚构离线工具世界", datasetVersion: dataset.version });
    const calls: PlanningCall[] = [];
    let output: PlannerOutput | null = null;
    let exception: string | null = null;
    try {
      output = structuredClone(await planner.run({ input: structuredClone(c.input), lookupRoute: tool.lookupRoute, budget: TOOL_BUDGET, plan(input) {
        if (calls.length >= 2) throw new Error("Planning call limit exceeded");
        const snapshot = structuredClone(input);
        const result = generateBaselineCandidate(snapshot);
        calls.push({ input: snapshot, result: structuredClone(result), toolCallsAtPlanning: tool.snapshot().length });
        return structuredClone(result);
      } }));
    } catch { exception = "planner_execution_error"; }
    tool.close();
    const trace = tool.snapshot();
    let score: EvaluationRow["score"] = { passed: false, failures: [exception ?? "no_output"], revalidation: null, unsupportedFactChanges: 0, selectedNonFeasible: false };
    if (output && !exception) {
      try { score = scoreOutput(c, planner.id, output, calls, trace); }
      catch { exception = "scoring_error"; output = null; score = { ...score, failures: [exception] }; }
    }
    const selected = output?.result.status === "candidate_found" ? output.result.selected : null;
    const activities = selected?.candidate.activities;
    const diff = activities ? [...new Set([...c.input.plan.activities.map((a) => a.id), ...activities.map((a) => a.id)])].flatMap((id) => {
      const before = c.input.plan.activities.find((a) => a.id === id) ?? null;
      const after = activities.find((a) => a.id === id) ?? null;
      return canonical(before) === canonical(after) ? [] : [{ id, before, after }];
    }) : [];
    const travelLegs = output?.travelLegs ?? c.input.travelLegs;
    const legEvidence: EvaluationRow["legEvidence"] = travelLegs.map((leg) => {
      const direction = { fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId };
      if (c.input.travelLegs.some((before) => canonical(before) === canonical(leg))) return { ...direction, source: "initial_input" };
      const proof = trace.find((t) => t.fromPlaceId === leg.fromPlaceId && t.toPlaceId === leg.toPlaceId && t.result.status === "ok" && leg.duration.kind === "known" && Math.ceil(t.result.routes[0].durationSeconds / 60) === leg.duration.minutes);
      if (proof?.result.status === "ok") return { ...direction, source: "tool", toolSequence: proof.sequence, durationSeconds: proof.result.routes[0].durationSeconds, convertedMinutes: Math.ceil(proof.result.routes[0].durationSeconds / 60) };
      return { ...direction, source: "unsupported" };
    });
    rows.push({ caseId: c.id, title: c.title, plannerId: planner.id, plannerVersion: planner.version, initialStatus: initial.status, initialIssueCodes: initial.issues.map((i) => i.code), finalStatus: exception ? "exception" : output!.result.status, selectedStrategy: selected?.strategy ?? null, issueCodes: output?.result.issues.map((i) => i.code) ?? [], activityDiff: diff, travelLegs, legEvidence, toolRequests: trace.length, toolFailures: trace.filter((t) => t.result.status === "failure" || t.result.status === "no_route").length, budgetRejections: trace.filter((t) => t.result.status === "budget_exhausted").length, trace, planningCalls: calls, validationCount: calls.reduce((n, call) => n + call.result.attempts.filter((a) => a.outcome === "checked").length, 0) + (score.revalidation ? 1 : 0), elapsedMs: performance.now() - start, expected: c.expected[planner.id], score, exception });
  }
  return {
    schemaVersion: 1, runId: randomUUID(), startedAt, datasetVersion: dataset.version, datasetHash: datasetHash(dataset), git: options.git,
    planners: planners.map(({ id, version }) => ({ id, version })), toolBudget: TOOL_BUDGET,
    scope: "12 hand-authored fictional cases; offline fixed workflow, no model/tool-selection intelligence; no global-optimality claim",
    modelCalls: 0, modelTokens: 0, modelCost: 0, externalApiCalls: 0,
    validationCountDefinition: "strategy planning checked attempts + independent selected-candidate revalidation; excludes initial reporting probe",
    rows, summary: planners.map((planner) => summarize(rows.filter((row) => row.plannerId === planner.id), planner.id)),
  };
}
function summarize(rows: readonly EvaluationRow[], plannerId: string) {
  const count = (fn: (r: EvaluationRow) => boolean) => rows.filter(fn).length;
  return { plannerId, total: rows.length, passed: count((r) => r.score.passed), candidates: count((r) => r.finalStatus === "candidate_found"),
    statuses: Object.fromEntries(["candidate_found", "needs_information", "no_feasible_candidate", "invalid_input", "request_not_current", "unsupported_scenario", "planner_error", "exception"].map((s) => [s, count((r) => r.finalStatus === s)])),
    selectedNonFeasible: count((r) => r.score.selectedNonFeasible), unsupportedFactChanges: rows.reduce((n, r) => n + r.score.unsupportedFactChanges, 0),
    toolRequests: rows.reduce((n, r) => n + r.trace.length, 0), toolCalls: rows.reduce((n, r) => n + r.trace.filter((t) => t.result.status !== "budget_exhausted").length, 0), toolFailures: rows.reduce((n, r) => n + r.trace.filter((t) => t.result.status === "failure" || t.result.status === "no_route").length, 0), budgetRejections: rows.reduce((n, r) => n + r.trace.filter((t) => t.result.status === "budget_exhausted").length, 0),
    elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0), validationCount: rows.reduce((n, r) => n + r.validationCount, 0) };
}
export type EvaluationReport = Awaited<ReturnType<typeof runEvaluation>>;
