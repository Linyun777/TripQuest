import {
  generateBaselineCandidate,
  type BaselineStrategy,
  type CheckedTransition,
  type ChinaDateTime,
  type PlannedActivity,
  type ValidationIssueCode,
} from "@tripquest/domain";
import { z } from "zod";

import type { JourneyRepository, StoredJourney } from "./contracts";
import { fingerprint } from "./fingerprint";
import { isJourneyId } from "./runtime-values";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const commandSchema = z.strictObject({
  journeyId: z.uuid(),
  basePlanVersion: z.number().int().positive(),
  observedAt: time,
  earliestResumeAt: time,
  completedActivityIds: z.array(z.uuid()).max(8),
  noCurrentActivity: z.boolean(),
  locationAtTarget: z.boolean(),
  travelMinutes: z.number().int().min(1).max(240).nullable(),
});

export type PreviewJourneyCommand = z.infer<typeof commandSchema>;
export type PreviewIssueCode = ValidationIssueCode |
  "prior_progress_unreported" | "current_activity_unreported" | "unknown_travel_estimate" |
  "unknown_observed_location" | "unsupported_shape";

export interface PreviewDifference {
  readonly activityId: string;
  readonly placeName: string;
  readonly kind: "activity" | "reservation";
  readonly change: "keep" | "shift" | "omit";
  readonly before: { readonly startsAt: ChinaDateTime; readonly endsAt: ChinaDateTime };
  readonly after?: { readonly startsAt: ChinaDateTime; readonly endsAt: ChinaDateTime };
}

export type PreviewJourneyOutcome =
  | { readonly status: "candidate_found"; readonly basePlanVersion: number; readonly baseObservationVersion: number; readonly semanticFingerprint: string; readonly strategy: BaselineStrategy; readonly differences: readonly PreviewDifference[]; readonly transition: CheckedTransition; readonly travelSource: "user_estimate" | "same_place"; readonly transferBufferMinutes: 10 }
  | { readonly status: "needs_information" | "no_feasible_candidate" | "unsupported_scenario"; readonly basePlanVersion: number; readonly issueCodes: readonly PreviewIssueCode[] }
  | { readonly status: "stale"; readonly currentPlanVersion: number }
  | { readonly status: "invalid_input"; readonly issueCodes: readonly PreviewIssueCode[] }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable" };

const invalid = (code: PreviewIssueCode): PreviewJourneyOutcome => ({ status: "invalid_input", issueCodes: [code] });
function integrityError(reportIntegrityError: () => void): PreviewJourneyOutcome {
  reportIntegrityError();
  return { status: "unavailable" };
}
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const at = (date: string, hhmm: string): ChinaDateTime => `${date}T${hhmm}:00+08:00`;

/** 只读取当前聚合并返回试算；预览入口不调用任何仓库写入方法。 */
export async function previewJourneyAdjustment(
  input: unknown,
  repository: Pick<JourneyRepository, "findCurrentJourney">,
  nextRequestId: () => string,
  reportIntegrityError: () => void = () => {},
): Promise<PreviewJourneyOutcome> {
  return (await evaluateJourneyAdjustment(input, repository, nextRequestId, reportIntegrityError)).outcome;
}

/**
 * 早期手动行程的有限试算：一项未来普通活动紧接固定预约，交通时长由用户提供。
 * 不满足这个形状时明确返回不支持；真实地点的一日调整走 real-adjust 的独立链路。
 */
export async function evaluateJourneyAdjustment(
  input: unknown,
  repository: Pick<JourneyRepository, "findCurrentJourney">,
  nextRequestId: () => string,
  reportIntegrityError: () => void = () => {},
): Promise<{ readonly outcome: PreviewJourneyOutcome; readonly stored?: StoredJourney; readonly candidateActivities?: readonly PlannedActivity[] }> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return { outcome: invalid("invalid_shape") };
  const command = parsed.data;
  if (!isJourneyId(command.journeyId) || new Set(command.completedActivityIds).size !== command.completedActivityIds.length || minutes(command.earliestResumeAt) < minutes(command.observedAt)) {
    return { outcome: invalid("invalid_shape") };
  }

  let stored: StoredJourney | null;
  try {
    stored = await repository.findCurrentJourney(command.journeyId);
  } catch {
    return { outcome: { status: "unavailable" } };
  }
  if (stored === null) return { outcome: { status: "not_found" } };
  if (stored.journeyId !== command.journeyId || stored.currentPlan.journeyId !== command.journeyId || !Number.isSafeInteger(stored.currentObservationVersion) || stored.currentObservationVersion < 0) return { outcome: integrityError(reportIntegrityError) };
  const plan = stored.currentPlan;
  if (stored.creationKind !== "manual") {
    return { outcome: { status: "unsupported_scenario", basePlanVersion: plan.version, issueCodes: ["unsupported_shape"] } };
  }
  if (plan.version !== command.basePlanVersion) return { outcome: { status: "stale", currentPlanVersion: plan.version } };

  const activities = plan.activities;
  const observed = at(plan.date, command.observedAt);
  const earlier = activities.filter((activity) => activity.endsAt <= observed);
  const future = activities.filter((activity) => activity.startsAt >= observed);
  if (
    plan.timeZone !== "Asia/Shanghai" ||
    activities.length !== earlier.length + future.length ||
    future.length !== 2 ||
    future[0].startsAt <= observed ||
    future[0].locked || future[0].reservationId !== undefined ||
    !future[1].locked || future[1].reservationId === undefined ||
    activities.indexOf(future[1]) !== activities.indexOf(future[0]) + 1 ||
    future[0].endsAt > future[1].startsAt ||
    stored.reservations.find((item) => item.reservation.id === future[1].reservationId)?.reservation.confirmation.status !== "confirmed"
  ) return { outcome: { status: "unsupported_scenario", basePlanVersion: plan.version, issueCodes: ["unsupported_shape"] } };

  // 计划中的“时间已过”不能直接算“已完成”，必须由用户逐项报告，否则先返回缺失信息。
  const earlierIds = new Set(earlier.map((activity) => activity.id));
  if (command.completedActivityIds.some((id) => !earlierIds.has(id))) return { outcome: invalid("invalid_shape") };
  const missing: PreviewIssueCode[] = [];
  if (command.completedActivityIds.length !== earlier.length) missing.push("prior_progress_unreported");
  if (!command.noCurrentActivity) missing.push("current_activity_unreported");
  if (!command.locationAtTarget) missing.push("unknown_observed_location");
  if (command.travelMinutes === null && future[0].placeId !== future[1].placeId) missing.push("unknown_travel_estimate");
  if (missing.length > 0) return { outcome: { status: "needs_information", basePlanVersion: plan.version, issueCodes: missing } };

  const requestId = nextRequestId();
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100) return { outcome: invalid("invalid_shape") };
  const target = future[0];
  const fixed = future[1];
  const result = generateBaselineCandidate({
    plan,
    state: { journeyId: plan.journeyId, version: stored.currentObservationVersion + 1, completedActivityIds: [...command.completedActivityIds].sort(), skippedActivityIds: [], currentActivityId: null, observedAt: observed, location: { kind: "known", placeId: target.placeId } },
    request: { id: requestId, journeyId: plan.journeyId, basePlanVersion: plan.version, baseStateVersion: stored.currentObservationVersion + 1, delay: { observedAt: observed, earliestResumeAt: at(plan.date, command.earliestResumeAt) }, scope: { kind: "selected_window", window: { startsAt: target.startsAt, endsAt: fixed.startsAt } } },
    reservations: stored.reservations.map((item) => item.reservation),
    travelLegs: target.placeId === fixed.placeId ? [] : [{ fromPlaceId: target.placeId, toPlaceId: fixed.placeId, duration: { kind: "known", minutes: command.travelMinutes! } }],
    transferBufferMinutes: 10,
  });
  if (result.status !== "candidate_found") {
    if (result.status === "needs_information" || result.status === "no_feasible_candidate" || result.status === "unsupported_scenario") {
      return { outcome: { status: result.status, basePlanVersion: plan.version, issueCodes: result.issues.map((issue) => issue.code) } };
    }
    return { outcome: integrityError(reportIntegrityError) };
  }

  const difference = mapDifferences(stored, result.selected.candidate.activities, target.id);
  const transition = result.selected.validation.checkedTransitions.find((item) => item.toActivityId === fixed.id && item.fromPlaceId === target.placeId && item.toPlaceId === fixed.placeId);
  const samePlace = target.placeId === fixed.placeId;
  if (difference === null || transition === undefined || transition.travelMinutes !== (samePlace ? 0 : command.travelMinutes) || transition.bufferMinutes !== (samePlace ? 0 : 10) || transition.nextStartsAt !== fixed.startsAt) return { outcome: integrityError(reportIntegrityError) };
  // 指纹同时绑定输入、基础状态与计算结果；确认时任一事实变化都要求重新预览。
  const semanticFingerprint = fingerprint({ command: { ...command, completedActivityIds: [...command.completedActivityIds].sort() }, stored: { journeyId: stored.journeyId, title: stored.title, currentObservationVersion: stored.currentObservationVersion, currentPlan: stored.currentPlan, activitySnapshots: stored.activitySnapshots, reservations: stored.reservations }, strategy: result.selected.strategy, candidateActivities: result.selected.candidate.activities });
  return { outcome: { status: "candidate_found", basePlanVersion: plan.version, baseObservationVersion: stored.currentObservationVersion, semanticFingerprint, strategy: result.selected.strategy, differences: difference, transition, travelSource: samePlace ? "same_place" : "user_estimate", transferBufferMinutes: 10 }, stored, candidateActivities: result.selected.candidate.activities };
}

function same(a: PlannedActivity, b: PlannedActivity): boolean {
  return a.id === b.id && a.placeId === b.placeId && a.priority === b.priority && a.locked === b.locked && a.reservationId === b.reservationId && a.startsAt === b.startsAt && a.endsAt === b.endsAt;
}

function mapDifferences(stored: StoredJourney, candidate: readonly PlannedActivity[], targetId: string): PreviewDifference[] | null {
  const original = stored.currentPlan.activities;
  const beforeIds = new Set(original.map((activity) => activity.id));
  const afterIds = new Set(candidate.map((activity) => activity.id));
  const snapshots = new Map(stored.activitySnapshots.map((item) => [item.activityId, item]));
  if (beforeIds.size !== original.length || afterIds.size !== candidate.length || snapshots.size !== original.length || candidate.some((item) => !beforeIds.has(item.id))) return null;
  if (candidate.some((item, index) => original.findIndex((before) => before.id === item.id) < (index === 0 ? -1 : original.findIndex((before) => before.id === candidate[index - 1].id)))) return null;
  const byId = new Map(candidate.map((activity) => [activity.id, activity]));
  const differences: PreviewDifference[] = [];
  for (let index = 0; index < original.length; index += 1) {
    const before = original[index];
    const after = byId.get(before.id);
    const snapshot = snapshots.get(before.id);
    if (snapshot === undefined || snapshot.position !== index) return null;
    if (after === undefined && before.id !== targetId) return null;
    if (after !== undefined && !same(before, after) && (before.id !== targetId || before.placeId !== after.placeId || before.priority !== after.priority || before.locked !== after.locked || before.reservationId !== after.reservationId)) return null;
    differences.push({ activityId: before.id, placeName: snapshot.placeName, kind: before.reservationId === undefined ? "activity" : "reservation", change: after === undefined ? "omit" : same(before, after) ? "keep" : "shift", before: { startsAt: before.startsAt, endsAt: before.endsAt }, ...(after === undefined ? {} : { after: { startsAt: after.startsAt, endsAt: after.endsAt } }) });
  }
  return differences;
}
