import { createHash } from "node:crypto";
import { validateCandidatePlan } from "@tripquest/domain";
import type { Dataset } from "./contracts";
import { PLANNER_IDS } from "./contracts";
import { edgeKey } from "./route-tool";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const datasetHash = (dataset: Dataset): string => createHash("sha256").update(canonical(dataset)).digest("hex");
const statuses = ["candidate_found", "needs_information", "no_feasible_candidate", "invalid_input", "request_not_current", "unsupported_scenario", "planner_error"];
/** Fail before running any strategy; fixtures are an authored, versioned artifact. */
export function validateDataset(dataset: Dataset): void {
  if (!dataset.version || dataset.cases.length !== 12) throw new Error("Dataset requires version and exactly 12 cases");
  const ids = new Set<string>();
  for (const c of dataset.cases) {
    if (!/^E(0[1-9]|1[0-2])$/.test(c.id) || ids.has(c.id)) throw new Error("Invalid or duplicate case ID");
    ids.add(c.id);
    if (c.source !== "hand_authored_fiction" || !c.title) throw new Error("Missing case provenance");
    const input = c.input;
    const shape = validateCandidatePlan({ ...input, candidate: { id: "shape-check", journeyId: input.plan.journeyId, basePlanVersion: input.plan.version, baseStateVersion: input.state.version, activities: input.plan.activities } });
    if (shape.verdict === "invalid_input") throw new Error(`${c.id}: invalid input fixture`);
    for (const id of PLANNER_IDS) {
      const e = c.expected[id];
      if (!e || !statuses.includes(e.status) || !e.reasoning || !Array.isArray(e.requiredIssues) || !Number.isInteger(e.calls) || e.calls < 0 || e.calls > 3) throw new Error(`${c.id}: missing/invalid expected answer`);
      if (e.status === "candidate_found" && (!e.activities?.length || !e.arrival || !["keep", "shift", "omit"].includes(e.strategy ?? ""))) throw new Error(`${c.id}: incomplete candidate oracle`);
    }
    const edges = new Set<string>();
    for (const w of c.world) {
      const key = edgeKey(w.fromPlaceId, w.toPlaceId);
      if (!/^P-[A-Z0-9]+$/.test(w.fromPlaceId) || !/^P-[A-Z0-9]+$/.test(w.toPlaceId) || edges.has(key)) throw new Error(`${c.id}: invalid/duplicate world edge`);
      edges.add(key);
      const r = w.result;
      if (r.evidence.sourceKind !== "fixture" || r.evidence.datasetVersion !== dataset.version || !r.evidence.provider || !r.evidence.attribution || !Number.isFinite(Date.parse(r.evidence.retrievedAt))) throw new Error(`${c.id}: invalid fixture evidence`);
      if (r.status === "ok") {
        if (r.routes.length !== 1 || r.routes[0].mode !== "walking" || !Number.isSafeInteger(r.routes[0].durationSeconds) || r.routes[0].durationSeconds < 0 || !Number.isFinite(r.routes[0].distanceMeters) || r.routes[0].distanceMeters < 0) throw new Error(`${c.id}: malformed route`);
      } else if (r.status === "failure") {
        if (!["invalid_request", "authorization_failed", "quota_exceeded", "rate_limited", "timeout", "upstream_unavailable", "malformed_response", "cancelled", "unknown"].includes(r.failure.code) || !["never", "after_backoff", "after_quota_reset", "after_configuration_change"].includes(r.failure.retry) || !r.failure.safeMessage) throw new Error(`${c.id}: malformed failure`);
      } else if (r.status !== "no_route" || !["no_path", "origin_unmatched", "destination_unmatched", "distance_limit", "unsupported_mode"].includes(r.reason)) throw new Error(`${c.id}: malformed route result`);
    }
  }
}
