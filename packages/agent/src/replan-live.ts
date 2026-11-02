import { REPLAN_LIMITS } from "@tripquest/application/day-replan";
import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import { DayRunError } from "./day-contracts";
import type { ReplanDecisionModel } from "./replan-contracts";
import { REPLAN_SYSTEM_PROMPT, serializeReplanContext } from "./replan-prompt";

export function createReplanLiveModel(options: LiveModelOptions): ReplanDecisionModel {
  const { beforeRequest, ...transportOptions } = options;
  const transport = createJsonDecisionTransport(transportOptions);
  return {
    ...transport,
    mode: "live",
    async decide(context, { signal }) {
      const content = serializeReplanContext(context, REPLAN_LIMITS.contextBytes);
      if (signal.aborted) throw new DayRunError("timeout");
      // The caller's budget guard runs outside the SDK so its error class survives.
      await beforeRequest?.();
      if (signal.aborted) throw new DayRunError("timeout");
      return transport.request(REPLAN_SYSTEM_PROMPT, content, signal);
    },
  };
}
