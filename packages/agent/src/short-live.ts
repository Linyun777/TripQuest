import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import type { CandidateDecisionModel } from "./short-candidates";
import { SHORT_SYSTEM_PROMPT } from "./short-prompt";

/** V2.4: the candidate picker on the configured model; budget errors fall back to the nearest. */
export function createShortLiveModel(options: LiveModelOptions): CandidateDecisionModel {
  const { beforeRequest, ...transportOptions } = options;
  const transport = createJsonDecisionTransport(transportOptions);
  return {
    ...transport,
    mode: "live",
    async decide(context, { signal }) {
      await beforeRequest?.();
      return transport.request(SHORT_SYSTEM_PROMPT, JSON.stringify(context), signal);
    },
  };
}
