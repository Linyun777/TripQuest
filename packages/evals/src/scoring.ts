import { validateCandidatePlan } from "@tripquest/domain";
import type { BaselinePlanningInput, TravelLegInput } from "@tripquest/domain";
import type { EvaluationCase, PlannerId, PlannerOutput, PlanningCall, Score, ToolCall } from "./contracts";
import { canonical } from "./dataset-validation";
import { edgeKey } from "./route-tool";

const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** 只有实际请求且成功返回的有向路线可扩展原事实，不能用模型自报路线给自身结果补证。 */
export function auditFacts(original: BaselinePlanningInput, legs: readonly TravelLegInput[], trace: readonly ToolCall[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    const key = edgeKey(leg.fromPlaceId, leg.toPlaceId);
    if (seen.has(key)) errors.push(`duplicate edge ${key}`);
    seen.add(key);
    const before = original.travelLegs.find((l) => edgeKey(l.fromPlaceId, l.toPlaceId) === key);
    if (equal(before, leg)) continue;
    if (before?.duration.kind === "known") { errors.push(`overwritten known ${key}`); continue; }
    const proof = trace.some((t) => edgeKey(t.fromPlaceId, t.toPlaceId) === key && t.result.status === "ok" && t.result.routes.length === 1 && leg.duration.kind === "known" && leg.duration.minutes === Math.ceil(t.result.routes[0].durationSeconds / 60));
    if (!proof) errors.push(`unsupported route ${key}`);
  }
  for (const leg of original.travelLegs) if (!seen.has(edgeKey(leg.fromPlaceId, leg.toPlaceId))) errors.push("removed original fact");
  return errors;
}
export function scoreOutput(c: EvaluationCase, plannerId: PlannerId, output: PlannerOutput, calls: readonly PlanningCall[], trace: readonly ToolCall[]): Score {
  const expected = c.expected[plannerId];
  const failures: string[] = [];
  const factErrors = auditFacts(c.input, output.travelLegs, trace);
  for (const call of calls) {
    const { travelLegs, ...facts } = call.input;
    const { travelLegs: originalLegs, ...originalFacts } = c.input;
    void originalLegs;
    if (!equal(facts, originalFacts)) factErrors.push("planner changed protected input facts");
    // 每次规划只能使用当时已经取得的工具证据；截断轨迹后再审计，防止事后查到路线
    // 给先前凭空使用的时长补证。只看最终事实集会漏掉这种时间上的因果错误。
    factErrors.push(...auditFacts(c.input, travelLegs, trace.slice(0, call.toolCallsAtPlanning)));
  }
  failures.push(...new Set(factErrors));
  if (calls.length < 1 || calls.length > (plannerId === "rules_only" ? 1 : 2)) failures.push("planning call limit");
  if (calls.length && !equal(calls[0].input, c.input)) failures.push("initial input changed");
  if (calls.length && !equal(output.travelLegs, calls.at(-1)?.input.travelLegs)) failures.push("reported legs differ from planning input");
  if (trace.length !== expected.calls || (plannerId === "rules_only" && trace.length !== 0)) failures.push("unexpected tool call count");
  if (trace.length > 3 || trace.some((t) => t.result.status === "budget_exhausted")) failures.push("tool budget exceeded");
  if (output.result.status !== expected.status) failures.push(`status: expected ${expected.status}, got ${output.result.status}`);
  for (const code of expected.requiredIssues) if (!output.result.issues.some((i) => i.code === code)) failures.push(`missing issue ${code}`);
  let revalidation: Score["revalidation"] = null;
  let selectedNonFeasible = false;
  if (output.result.status === "candidate_found") {
    const selected = output.result.selected;
    revalidation = validateCandidatePlan({ ...c.input, travelLegs: output.travelLegs, candidate: selected.candidate });
    selectedNonFeasible = revalidation.verdict !== "feasible";
    if (selectedNonFeasible) failures.push(`selected candidate revalidation: ${revalidation.verdict}`);
    if (selected.strategy !== expected.strategy) failures.push("wrong selected strategy");
    if (!equal(selected.candidate.activities, expected.activities)) failures.push("schedule differs from handwritten oracle");
    for (const a of c.input.plan.activities) {
      if (a.locked || a.reservationId || c.input.state.completedActivityIds.includes(a.id)) {
        if (!equal(a, selected.candidate.activities.find((b) => b.id === a.id))) failures.push(`protected activity changed: ${a.id}`);
      }
    }
    // 独立重算时间与衔接，不采用规划器嵌入的“已验证”或“可到达”结论作为判分依据。
    if (expected.arrival) {
      const remaining = selected.candidate.activities.filter((a) => !c.input.state.completedActivityIds.includes(a.id) && !c.input.state.skippedActivityIds.includes(a.id));
      const index = remaining.findIndex((a) => a.id === expected.arrival?.activityId);
      const prior = remaining[index - 1];
      const target = remaining[index];
      const from = prior?.placeId ?? (c.input.state.location.kind === "known" ? c.input.state.location.placeId : null);
      const departure = prior?.endsAt ?? c.input.request.delay.earliestResumeAt;
      const leg = output.travelLegs.find((l) => l.fromPlaceId === from && l.toPlaceId === target?.placeId);
      const minutes = from === target?.placeId ? 0 : leg?.duration.kind === "known" ? leg.duration.minutes + c.input.transferBufferMinutes : NaN;
      if (!target || Date.parse(departure) + minutes * 60_000 !== Date.parse(expected.arrival.at)) failures.push("independent arrival differs from human arithmetic");
    }
  } else if ("selected" in output.result && output.result.selected) failures.push("non-candidate result contains selection");
  return { passed: failures.length === 0, failures, revalidation, unsupportedFactChanges: new Set(factErrors).size, selectedNonFeasible };
}
