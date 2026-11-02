import { validateCandidatePlan } from "@tripquest/domain";
import { V2_IDS, type V2Case } from "./dataset";

export function validateV2Cases(cases: readonly V2Case[]): void {
  if (cases.length !== 14 || new Set(cases.map((c) => c.id)).size !== 14) {
    throw new Error("v2 requires fourteen unique cases");
  }
  for (const c of cases) {
    if (!/^E(0[1-9]|1[0-4])$/.test(c.id)) throw new Error("Invalid case ID");
    const { plan, state } = c.input;
    const checked = validateCandidatePlan({
      ...c.input,
      candidate: {
        id: "input-shape-check",
        journeyId: plan.journeyId,
        basePlanVersion: plan.version,
        baseStateVersion: state.version,
        activities: plan.activities,
      },
    });
    if (checked.verdict === "invalid_input") throw new Error("Invalid fixture input");
    for (const id of V2_IDS) {
      const expected = c.expected[id];
      if (!expected || !expected.reasoning || !Array.isArray(expected.requiredIssues)) {
        throw new Error("Missing business oracle");
      }
      if (expected.status === "candidate_found" && (!expected.activities?.length || !expected.strategy || !expected.arrival)) {
        throw new Error("Incomplete business oracle");
      }
    }
    const seen = new Set<string>();
    for (const edge of c.world) {
      const key = JSON.stringify([edge.fromPlaceId, edge.toPlaceId]);
      if (seen.has(key) || !edge.fromPlaceId || !edge.toPlaceId) throw new Error("Invalid fixture edge");
      seen.add(key);
      const result = edge.result;
      if (result.evidence.sourceKind !== "fixture") throw new Error("Only synthetic routes allowed");
      if (result.status === "ok") {
        const option = result.routes[0];
        if (result.routes.length !== 1 || option.mode !== "walking" ||
          !Number.isSafeInteger(option.durationSeconds) || option.durationSeconds < 0 ||
          !Number.isFinite(option.distanceMeters) || option.distanceMeters < 0) {
          throw new Error("Invalid synthetic route");
        }
      } else if (result.status === "failure") {
        if (!["invalid_request", "authorization_failed", "quota_exceeded", "rate_limited", "timeout",
          "upstream_unavailable", "malformed_response", "cancelled", "unknown"].includes(result.failure.code)) {
          throw new Error("Invalid synthetic failure");
        }
      } else if (result.status !== "no_route" ||
        !["no_path", "origin_unmatched", "destination_unmatched", "distance_limit", "unsupported_mode"].includes(result.reason)) {
        throw new Error("Invalid synthetic result");
      }
    }
  }
}
