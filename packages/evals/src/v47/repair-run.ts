import type { DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import type { JudgeRequest } from "@tripquest/agent/outing-judge";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import { runReviewCase, type ReviewRow } from "../v32/review-run";
import type { FinalDay, RepairCase } from "./repair-dataset";

/** V4.7 §4.2：同 V3.2 的审查评测跑一趟，再按题目的判定查建议都采纳之后的方案。 */
export interface RepairRow extends Omit<ReviewRow, "suite"> {
  readonly suite: "repair";
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
}

export async function runRepairCase(
  item: RepairCase,
  models: { readonly day: () => DayPlanningDecisionModel; readonly reviewer?: ReviewRequest; readonly judge?: JudgeRequest },
): Promise<RepairRow> {
  const row = await runReviewCase(item, "live", models);
  const days: readonly FinalDay[] = row.finalDays ?? [];
  const checks = item.checks.map((check) => ({ name: check.name, passed: check.test(days) }));
  return { ...row, suite: "repair", checks, passed: checks.every((check) => check.passed) };
}
