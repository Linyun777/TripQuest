import { planningRequirementsSchema } from "@tripquest/application/planning";
import type { DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { runPlanCase, type PlanRow, type Policy } from "../v21/run";
import type { PlayCase } from "./play-dataset";

/**
 * V2.10 各种玩法：先把需求交给产品的 schema（现在的产品只认杭州，会在这里拒绝），再用 V2.1 的规划评测
 * 跑并独立校验，最后按本题的停留范围和户外天气提示判分。
 */
export interface PlayRow {
  readonly suite: "play";
  readonly caseId: string;
  readonly policy: Policy;
  readonly heldOut: boolean;
  /** 需求被拒绝时的第一条原因（不含内容）；没被拒绝为 null。 */
  readonly rejected: string | null;
  readonly plan: PlanRow | null;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
}

export async function runPlayCase(item: PlayCase, policy: Policy, model?: () => DayPlanningDecisionModel): Promise<PlayRow> {
  const parsed = planningRequirementsSchema.safeParse(item.requirements);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      suite: "play", caseId: item.id, policy, heldOut: !!item.heldOut,
      rejected: `${issue?.path.join(".") ?? ""}: ${issue?.code ?? "invalid"}`.slice(0, 120),
      plan: null, checks: [{ name: "requirements_accepted", passed: false }], passed: false,
    };
  }
  const plan = await runPlanCase({
    id: item.id,
    note: item.note,
    requirements: parsed.data,
    forecast: "yunling",
    date: item.date,
    satisfiedBy: item.satisfiedBy,
    expect: item.expect,
  }, policy, model);
  const stays = plan.stays ?? {};
  const alerted = plan.alerted ?? [];
  const checks = [
    { name: "outcome", passed: plan.outcomeMatched },
    { name: "no_violations", passed: plan.violations.length === 0 },
    { name: "interests_covered", passed: plan.covered === plan.interests },
    ...(item.stays ? [{
      name: "stays_in_range",
      passed: Object.entries(item.stays).every(([id, [min, max]]) => stays[id] === undefined || (stays[id] >= min && stays[id] <= max)),
    }] : []),
    ...(item.alerts ? [{ name: "outdoor_alert", passed: item.alerts.every((id) => alerted.includes(id)) }] : []),
    ...(item.noAlerts ? [{ name: "no_alert_when_fine", passed: alerted.length === 0 }] : []),
    ...(item.shortened ? [{
      name: "estimate_shortened_and_said",
      passed: stays[item.shortened.id] !== undefined && stays[item.shortened.id] < item.shortened.below &&
        (plan.assumptions ?? []).some((text) => text.includes("原估")),
    }] : []),
    ...(item.notShortened ? [{ name: "not_shortened", passed: !(plan.assumptions ?? []).some((text) => text.includes("原估")) }] : []),
  ];
  const relevant = item.expect === "draft" ? checks : checks.filter((check) => check.name === "outcome");
  return {
    suite: "play", caseId: item.id, policy, heldOut: !!item.heldOut, rejected: null, plan,
    checks: relevant, passed: relevant.every((check) => check.passed),
  };
}
