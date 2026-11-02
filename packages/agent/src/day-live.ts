import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import { DAY_LIMITS, DayRunError, type DayPlanningDecisionModel } from "./day-contracts";
import { DAY_SYSTEM_PROMPT, serializeDayContext } from "./day-prompt";

export function createDayLiveModel(options: LiveModelOptions): DayPlanningDecisionModel {
  const { beforeRequest, ...transportOptions } = options;
  const transport = createJsonDecisionTransport(transportOptions);
  return {
    ...transport,
    mode: "live",
    async decide(context, { signal }) {
      const content = serializeDayContext(context, DAY_LIMITS.contextBytes);
      if (signal.aborted) throw new DayRunError("timeout");

      // Keep the caller's budget error outside SDK connection-error wrapping.
      await beforeRequest?.();
      if (signal.aborted) throw new DayRunError("timeout");

      return transport.request(DAY_SYSTEM_PROMPT, content, signal);
    },
  };
}
