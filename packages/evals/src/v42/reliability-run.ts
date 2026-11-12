import type { DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { runPlanCase, type PlanRow, type Policy } from "../v21/run";
import type { ReliabilityCase } from "./reliability-dataset";

/** 产品给“想去”地点的通用说法（没有具体原因时）；V4.2 之前一律是它。 */
const GENERIC_REASON = "本轮组合未纳入此可选项；优先保留必去、固定事项及完整衔接。";

export interface ReliabilityRow {
  readonly suite: "reliability";
  readonly caseId: string;
  readonly policy: Policy;
  readonly passed: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly modelRequests: number;
  readonly outcome: PlanRow["outcome"];
  readonly stops: readonly string[];
  readonly times?: readonly string[];
  readonly omitted?: PlanRow["omitted"];
  readonly violations: readonly string[];
  readonly failureCode?: string;
}

/** V4.2（stages/V4.2.md §4）：走产品的一日规划（同 plan 题），再按题目的预期判分。 */
export async function runReliabilityCase(
  item: ReliabilityCase,
  policy: Policy,
  model?: () => DayPlanningDecisionModel,
  signal?: AbortSignal,
): Promise<ReliabilityRow> {
  const row = await runPlanCase(item, policy, model, signal);
  const chosen = row.chosen ?? [];
  const expect = item.reliability;
  const checks = [
    { name: "draft", passed: row.outcome === "draft" },
    { name: "no_violations", passed: row.outcome === "draft" && row.violations.length === 0 },
  ];
  if (expect.kind === "early") {
    // 提前出门的时间只用来赶路：固定事项是第一站。
    checks.push({ name: "fixed_first", passed: chosen[0] === expect.fixed });
  } else if (expect.kind === "control") {
    checks.push({ name: "fixed_in", passed: chosen.includes(expect.fixed) });
  } else if ("placed" in expect) {
    checks.push({ name: "named_placed", passed: chosen.includes(expect.placed) });
  } else {
    const told = row.omitted?.find((entry) => entry.externalId === expect.omitted);
    checks.push({ name: "named_omitted", passed: !chosen.includes(expect.omitted) && !!told });
    checks.push({ name: "reason_told", passed: !!told && told.reason !== GENERIC_REASON });
  }
  return {
    suite: "reliability",
    caseId: item.id,
    policy,
    passed: checks.every((check) => check.passed),
    checks,
    modelRequests: row.modelRequests,
    outcome: row.outcome,
    stops: row.stops,
    ...(row.times ? { times: row.times } : {}),
    ...(row.omitted ? { omitted: row.omitted } : {}),
    violations: row.violations,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  };
}
