import type { AgentResult } from "@tripquest/agent";
import { scoreV2 } from "../v2/scoring";

/** v2 rejects every refusal; v3 permits exactly one recorded, successful repair. */
export function scoreFeedback(
  ...args: Parameters<typeof scoreV2>
): ReturnType<typeof scoreV2> & { repair: "unused" | "recovered" | "failed" } {
  const base = scoreV2(...args);
  const output: AgentResult = args[2];
  const event = output.feedbackEvents?.[0];
  const recovered = output.repairAttempts === 1 && output.rejectedActions === 1 &&
    output.feedbackEvents?.length === 1 && event !== undefined &&
    output.decisions.some((decision) => decision.sequence === event.sequence && !decision.accepted) &&
    output.decisions.some((decision) => decision.sequence > event.sequence && decision.accepted) &&
    ["completed", "model_stopped"].includes(output.executionStatus);
  const executionFailures = base.executionFailures.filter((failure) =>
    failure !== "rejected_actions" || !recovered,
  );
  return {
    ...base,
    executionFailures,
    execution: executionFailures.length === 0,
    passed: base.quality && base.safety && executionFailures.length === 0,
    repair: output.repairAttempts ? recovered ? "recovered" : "failed" : "unused",
  };
}
