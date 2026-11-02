import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import { DecisionModelError } from "./contracts";
import { NOTES_LIMITS, type NotesDecisionModel } from "./notes-contracts";
import { NOTES_SYSTEM_PROMPT } from "./notes-prompt";

export function createNotesLiveModel(options: LiveModelOptions): NotesDecisionModel {
  const { beforeRequest, ...transportOptions } = options;
  const transport = createJsonDecisionTransport({ ...transportOptions, outputTokenLimit: 1024 });
  return {
    mode: "live",
    provider: transport.provider,
    model: transport.model,
    async decide(context, { signal }) {
      const content = JSON.stringify(context);
      if (new TextEncoder().encode(content).byteLength > NOTES_LIMITS.contextBytes) throw new DecisionModelError("invalid_output");
      try {
        await beforeRequest?.();
      } catch {
        throw new DecisionModelError("quota");
      }
      return transport.request(NOTES_SYSTEM_PROMPT, content, signal);
    },
  };
}
