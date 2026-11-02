import "server-only";
import {
  DAY_REPLAN_PURPOSE,
  replanBaseFingerprint,
  type DayReplanProblem,
  type ReplanOffer,
  type ReplanResult,
} from "@tripquest/application/day-replan";
import type { JourneyRepository } from "@tripquest/application";
import { readReplanConfig } from "./replan-config";
import { REPLAN_RECEIPT_TTL, signReplanReceipt } from "./replan-receipt";

/**
 * Signs a confirmation receipt for a candidate, but only while both versions and the base
 * facts are still current. Used by the streaming route and when a task result is first read.
 */
export async function issueReplanOffer(options: {
  result: ReplanResult;
  problem: DayReplanProblem;
  execution: { mode: "scripted" | "live"; provider: string; model: string };
  environment: NodeJS.ProcessEnv;
  now: number;
  repository: JourneyRepository;
}): Promise<ReplanOffer | undefined> {
  const { result, problem } = options;
  if (result.status !== "completed" || result.outcome !== "candidate") return undefined;
  const config = readReplanConfig(options.environment);
  if (!config.save.enabled) return { status: "unavailable", reason: "disabled" };
  try {
    const current = await options.repository.findCurrentJourney(problem.journeyId);
    if (
      !current ||
      current.currentPlan.version !== problem.basePlanVersion ||
      current.currentObservationVersion !== problem.baseObservationVersion ||
      replanBaseFingerprint(current) !== problem.baseFingerprint
    ) {
      return { status: "unavailable", reason: "stale" };
    }
    const issuedAt = options.now;
    const receipt = signReplanReceipt({
      purpose: DAY_REPLAN_PURPOSE,
      runId: problem.runId,
      journeyId: problem.journeyId,
      basePlanVersion: problem.basePlanVersion,
      baseObservationVersion: problem.baseObservationVersion,
      baseFingerprint: problem.baseFingerprint,
      candidateFingerprint: result.candidateFingerprint,
      scope: problem.scope,
      goal: problem.goal,
      datasetVersion: problem.datasetVersion,
      selection: result.selection,
      execution: { ...options.execution, counts: result.counts },
      issuedAt,
      expiresAt: issuedAt + REPLAN_RECEIPT_TTL,
    }, config.save.secret);
    return {
      status: "available",
      receipt,
      expiresAt: new Date(issuedAt + REPLAN_RECEIPT_TTL).toISOString(),
      acknowledgeUnknownsRequired: result.candidate.verification === "pending",
    };
  } catch {
    return { status: "unavailable", reason: "receipt_unavailable" };
  }
}
