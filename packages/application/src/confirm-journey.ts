import { z } from "zod";
import type { ConfirmationJourneyRepository, JourneyClock } from "./contracts";
import { fingerprint } from "./fingerprint";
import { evaluateJourneyAdjustment, type PreviewJourneyCommand } from "./preview-journey";
import { toChinaDateTime } from "./runtime-values";

const commandSchema = z.strictObject({
  journeyId: z.uuid(),
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().nonnegative(),
  observedAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  earliestResumeAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  completedActivityIds: z.array(z.uuid()).max(8),
  noCurrentActivity: z.boolean(),
  locationAtTarget: z.boolean(),
  travelMinutes: z.number().int().min(1).max(240).nullable(),
  strategy: z.enum(["shift", "omit"]),
  semanticFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.uuid(),
});

export type ConfirmJourneyCommand = z.infer<typeof commandSchema>;
export type ConfirmJourneyOutcome =
  | { readonly status: "committed" | "already_committed"; readonly journeyId: string; readonly planVersion: number; readonly observationVersion: number }
  | { readonly status: "stale" | "preview_changed" | "invalid_input" | "not_confirmable" | "not_found" | "idempotency_conflict" | "temporarily_unavailable" };

/**
 * 手动行程的确认边界：重新读取并试算，比较用户看到的语义指纹，最后交事务检查双版本。
 * 预览结果与客户端传回的活动都不能直接作为写入依据。
 */
export async function confirmJourneyAdjustment(
  input: unknown,
  repository: ConfirmationJourneyRepository,
  clock: JourneyClock,
  nextRequestId: () => string,
): Promise<ConfirmJourneyOutcome> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid_input" };
  const command = parsed.data;
  if (new Set(command.completedActivityIds).size !== command.completedActivityIds.length || command.earliestResumeAt < command.observedAt) return { status: "invalid_input" };
  const normalized = { ...command, completedActivityIds: [...command.completedActivityIds].sort() };
  const intentFingerprint = fingerprint(normalized);
  try {
    const journey = await repository.findCurrentJourney(command.journeyId);
    if (journey && journey.creationKind !== "manual") return { status: "not_confirmable" };
    // 先识别同一保存意图的重试，再判断当前版本；响应丢失后的重试应返回原结果，
    // 而不是因为第一次保存已推进版本，就把自己的成功误报为过期。
    const prior = await repository.findConfirmation(command.journeyId, command.idempotencyKey);
    if (prior !== null) return prior.intentFingerprint === intentFingerprint
      ? { status: "already_committed", journeyId: command.journeyId, planVersion: prior.resultPlanVersion, observationVersion: prior.resultObservationVersion }
      : { status: "idempotency_conflict" };

    const previewCommand: PreviewJourneyCommand = {
      journeyId: command.journeyId,
      basePlanVersion: command.basePlanVersion,
      observedAt: command.observedAt,
      earliestResumeAt: command.earliestResumeAt,
      completedActivityIds: normalized.completedActivityIds,
      noCurrentActivity: command.noCurrentActivity,
      locationAtTarget: command.locationAtTarget,
      travelMinutes: command.travelMinutes,
    };
    const evaluated = await evaluateJourneyAdjustment(previewCommand, repository, nextRequestId);
    const { outcome, stored, candidateActivities } = evaluated;
    if (outcome.status === "not_found") return { status: "not_found" };
    if (outcome.status === "stale") return { status: "stale" };
    if (outcome.status === "unavailable") return { status: "temporarily_unavailable" };
    if (outcome.status === "invalid_input") return { status: "invalid_input" };
    if (outcome.status !== "candidate_found" || stored === undefined || candidateActivities === undefined) return { status: "not_confirmable" };
    if (outcome.baseObservationVersion !== command.baseObservationVersion) return { status: "stale" };
    if (outcome.strategy === "keep") return { status: "not_confirmable" };
    if (outcome.strategy !== command.strategy || outcome.semanticFingerprint !== command.semanticFingerprint) return { status: "preview_changed" };

    const committed = await repository.commitConfirmedAdjustment({
      journeyId: command.journeyId,
      idempotencyKey: command.idempotencyKey,
      intentFingerprint,
      basePlanVersion: command.basePlanVersion,
      baseObservationVersion: command.baseObservationVersion,
      expectedJourney: stored,
      strategy: command.strategy,
      previewFingerprint: outcome.semanticFingerprint,
      command: { observedAt: command.observedAt, earliestResumeAt: command.earliestResumeAt, completedActivityIds: normalized.completedActivityIds, noCurrentActivity: true, locationAtTarget: true, travelMinutes: command.travelMinutes },
      candidateActivities,
      confirmedAt: toChinaDateTime(clock.now()),
    });
    if (committed.status === "committed" || committed.status === "already_committed") return { ...committed, journeyId: command.journeyId };
    if (committed.status === "stale" || committed.status === "preview_changed" || committed.status === "idempotency_conflict") return committed;
    return { status: "temporarily_unavailable" };
  } catch {
    return { status: "temporarily_unavailable" };
  }
}
