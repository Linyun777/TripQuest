import { createDayPlanningRunner, createDayScriptedModel, planTransferDay, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import type { DayVisit } from "@tripquest/application/transfer-day";
import { FORECASTS, V21_NOW, V21World, worldPlaceByName, worldSelection } from "../v21/world";
import type { Policy } from "../v21/run";
import type { TransferDayCase } from "./outing-plan-dataset";

/**
 * V2.11 一天里的固定交通（§4.4）：把题目里的世界地点换成产品的规划输入，交给 planTransferDay（每段用现有的
 * 一日规划器），再按题目的期望判分：结果、整天校验、地点在交通前后、只排到站、写明估计、早到提示。
 */
export interface TransferRow {
  readonly suite: "transfer";
  readonly caseId: string;
  readonly policy: Policy;
  readonly heldOut: boolean;
  readonly outcome: string;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  /** 按时间先后的每一站（世界编号；交通写成 transfer）。 */
  readonly timeline: readonly string[];
  readonly notes: readonly string[];
  readonly issues: readonly string[];
  readonly modelRequests: number;
}

const idOf = (name: string) => worldPlaceByName(name)?.id ?? name;

export async function runTransferCase(item: TransferDayCase, policy: Policy, model?: () => DayPlanningDecisionModel): Promise<TransferRow> {
  const world = new V21World(FORECASTS.dry);
  let modelRequests = 0;
  const decisions = policy === "live" && model ? model() : createDayScriptedModel();
  const counting: DayPlanningDecisionModel = {
    ...decisions,
    decide: async (context, options) => {
      modelRequests += 1;
      return decisions.decide(context, options);
    },
  };
  const visits: DayVisit[] = item.visits.map((visit) => visit.role === "fixed"
    ? { place: worldSelection(visit.place), role: "fixed", startsAt: visit.startsAt!, endsAt: visit.endsAt! }
    : { place: worldSelection(visit.place), role: visit.role, stayMinutes: visit.stayMinutes ?? 60, ...(visit.estimate ? { staySource: "estimate" as const } : {}) });
  const start = worldSelection(item.start);
  const result = await planTransferDay({
    date: item.date,
    window: item.window,
    start,
    end: worldSelection(item.end),
    transfers: item.transfers.map((transfer) => ({
      mode: transfer.mode,
      from: worldSelection(transfer.from),
      to: worldSelection(transfer.to),
      departAt: transfer.departAt ?? null,
      arriveAt: transfer.arriveAt ?? null,
      arriveDay: transfer.arriveDay ?? "same",
      ...(transfer.confirmed ? { overnightConfirmed: true as const } : {}),
    })),
    visits,
    interests: item.interests.map((interest) => ({
      id: interest.id, text: interest.text, ...(interest.when ? { when: interest.when } : {}), ...(interest.city ? { city: interest.city } : {}),
    })),
    travel: item.travel as Parameters<typeof planTransferDay>[0]["travel"],
    pace: "standard",
    cityAdcode: start.place.cityAdcode ?? "330100",
  }, {
    runner: createDayPlanningRunner({ provider: world, model: counting, now: () => V21_NOW }),
    provider: world,
    now: () => V21_NOW,
  }, { signal: new AbortController().signal });

  const outcome = result.status === "draft" ? "draft" : result.status;
  const timeline = result.status !== "draft" ? [] : result.parts.flatMap((part) => part.kind === "transfer" ? ["transfer"]
    : part.kind === "connect" ? [] : part.draft.activities.map((activity) => idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name)));
  const firstTransfer = timeline.indexOf("transfer");
  const lastTransfer = timeline.lastIndexOf("transfer");
  const before = firstTransfer < 0 ? timeline : timeline.slice(0, firstTransfer);
  const after = lastTransfer < 0 ? [] : timeline.slice(lastTransfer + 1);
  const middle = firstTransfer < 0 || lastTransfer === firstTransfer ? [] : timeline.slice(firstTransfer + 1, lastTransfer);
  const notes = result.status === "draft" || result.status === "no_plan" ? result.notes : [];
  const plans = result.status === "draft" ? result.parts.flatMap((part) => (part.kind === "plan" ? [part.draft] : [])) : [];
  const checks = [
    { name: "outcome", passed: outcome === item.expect },
    ...(item.expect !== "draft" ? [] : [
      {
        name: "whole_day_valid",
        passed: result.status === "draft" && !result.issues.length && plans.every((draft) => !draft.checks.some((issue) => issue.kind === "violation")),
      },
      ...(item.before ? [{ name: "before_transfer", passed: item.before.every((id) => before.includes(id)) }] : []),
      ...(item.after ? [{ name: "after_transfer", passed: item.after.every((id) => after.includes(id)) }] : []),
      ...(item.middle ? [{ name: "between_transfers", passed: item.middle.every((id) => middle.includes(id)) }] : []),
      ...(item.nothingBefore ? [{ name: "nothing_before", passed: before.length === 0 }] : []),
      ...(item.estimatedNoted ? [{ name: "estimate_noted", passed: notes.some((note) => note.includes("未填车次")) }] : []),
      ...(item.earlyNoted ? [{
        name: "early_noted",
        passed: notes.some((note) => note.includes("到得早")) && plans.every((draft) => draft.activities.every((activity) => activity.startsAt >= 8 * 60)),
      }] : []),
    ]),
  ];
  return {
    suite: "transfer", caseId: item.id, policy, heldOut: !!item.heldOut, outcome, checks, passed: checks.every((check) => check.passed),
    timeline, notes, issues: result.status === "draft" ? result.issues : [], modelRequests,
  };
}
