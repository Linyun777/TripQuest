import { createHash } from "node:crypto";
import type { InvestigationSnapshot } from "@tripquest/agent";
import { canonical } from "../dataset-validation";
import type { ToolCall } from "../contracts";

/** Audit the transition independently of session construction and candidate scoring. */
export function auditSession(snapshot: InvestigationSnapshot, trace: readonly ToolCall[]) {
  const failures: string[] = [];
  const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  if (hash(snapshot.initial) !== snapshot.initialFingerprint) failures.push("initial_fingerprint");
  if (snapshot.planningCalls > 5 || (snapshot.output?.modelRequests ?? 0) > 4 || trace.length > 3) {
    failures.push("session_budget");
  }
  if (snapshot.followup) {
    const expected = structuredClone(snapshot.initial);
    const actual = snapshot.followup;
    const choice = snapshot.answer?.choice;
    if (!choice || choice === "cannot_answer" ||
        !snapshot.initial.plan.activities.some((activity) => activity.placeId === choice) ||
        !snapshot.question?.options.some((option) => option.id === choice)) {
      failures.push("unoffered_choice");
    }
    const allowed = {
      ...expected,
      state: { ...expected.state, version: expected.state.version + 1, location: { kind: "known", placeId: choice } },
      request: { ...expected.request, id: actual.request.id, baseStateVersion: expected.state.version + 1 },
    };
    if (canonical(allowed) !== canonical(actual)) failures.push("unexpected_fact_change");
    if (actual.request.id === expected.request.id) failures.push("request_id_reused");
    if (hash(actual) !== snapshot.followupFingerprint) failures.push("followup_fingerprint");
    if (snapshot.answer?.provenance !== "user_answer" ||
        snapshot.answer.parentSessionId !== snapshot.sessionId ||
        snapshot.answer.oldStateVersion !== expected.state.version ||
        snapshot.answer.newStateVersion !== actual.state.version) failures.push("answer_provenance");
  } else if (trace.length || (snapshot.output?.modelRequests ?? 0)) {
    failures.push("unanswered_calls");
  }
  return failures;
}
