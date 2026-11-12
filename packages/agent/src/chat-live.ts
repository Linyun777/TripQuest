import { createJsonDecisionTransport, type LiveModelOptions } from "./live";
import { CHAT_LIMITS, ChatRunError, type ChatDecisionModel } from "./chat-contracts";
import { chatSystemPrompt, serializeChatContext } from "./chat-prompt";

export function createChatLiveModel(options: LiveModelOptions): ChatDecisionModel {
  const { beforeRequest, ...transportOptions } = options;
  const transport = createJsonDecisionTransport({ ...transportOptions, outputTokenLimit: 2048 });
  return {
    mode: "live",
    provider: transport.provider,
    model: transport.model,
    async decide(context, { signal, system }) {
      const content = serializeChatContext(context, CHAT_LIMITS.contextBytes);
      if (signal.aborted) throw new ChatRunError("timeout");
      // Reserve the daily budget outside the SDK, so a refusal reads as live_budget. A caller that
      // already knows why it failed (the ledger itself is unavailable) throws its own ChatRunError.
      try {
        await beforeRequest?.();
      } catch (error) {
        throw error instanceof ChatRunError ? error : new ChatRunError("live_budget");
      }
      if (signal.aborted) throw new ChatRunError("timeout");
      // V3.4：专门 Agent 的提示词由引擎给；没给时按上下文拼（拆开前的做法）。
      return transport.request(system ?? chatSystemPrompt(context), content, signal);
    },
  };
}
