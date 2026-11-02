import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  DecisionModelError,
  type DecisionModel,
  type ErrorCode,
  type ModelReply,
  type Usage,
} from "./contracts";
import { serializeContext, SYSTEM_PROMPT, FEEDBACK_SYSTEM_PROMPT, FEEDBACK_PROMPT_VERSION } from "./prompt";
import { resolveProfile } from "./profile";
import { currentRun, RunBudgetError } from "./runs";
import { assertLocalTracingOnly } from "./tracing";

export { resolveProfile } from "./profile";
export const ADAPTER_VERSION = "chat-completions-v1";
const safeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/**
 * 运行记录里模型调用的名字：决定里的动作类型（只取标识符形状的）；一次给几个动作的（对话）用 + 连起来；
 * 都没有就记 decision。
 */
const actionName = (decision: unknown): string => {
  const kind = (fields: Record<string, unknown>) =>
    [fields.action, fields.type, fields.kind].find((value): value is string => typeof value === "string" && /^[a-z_]{1,40}$/.test(value));
  const fields = record(decision);
  const listed = Array.isArray(fields.actions) ? [...new Set(fields.actions.map((item) => kind(record(item))).filter(Boolean))] : [];
  return kind(fields) ?? (listed.length ? listed.join("+").slice(0, 80) : "decision");
};

export interface LiveModelOptions {
  config: unknown;
  profileId: string;
  environment: Readonly<Record<string, string | undefined>>;
  allowLoopback?: boolean;
  beforeRequest?: () => void | Promise<void>;
  /** 对话回复比单步规划动作需要更长输出，只允许提升到 2048 tokens（V2.11 出游一次写十来个地点），不能任意扩大。 */
  /** 128：V2.9 意图分类只输出 7 个分数。 */
  outputTokenLimit?: 128 | 512 | 1024 | 2048;
}

export function createLiveModel(options: LiveModelOptions): DecisionModel {
  const transport = createJsonDecisionTransport(options);
  return {
    ...transport,
    decide(context, { signal }) {
      return transport.request(
        context.protocolVersion === FEEDBACK_PROMPT_VERSION ? FEEDBACK_SYSTEM_PROMPT : SYSTEM_PROMPT,
        serializeContext(context),
        signal,
      );
    },
  };
}

/** 各 Agent 共用无自动重试的 JSON 传输层；业务协议各自提供提示词、上下文和后续解析。 */
export function createJsonDecisionTransport(options: LiveModelOptions) {
  assertLocalTracingOnly();
  const { profile, apiKey } = resolveProfile(
    options.config,
    options.profileId,
    options.environment,
    options.allowLoopback,
  );
  let totalRequests = 0;
  return {
    getRequestCount: () => totalRequests,
    mode: "live" as const,
    provider: profile.providerId,
    model: profile.model,
    async request(systemPrompt: string, content: string, signal: AbortSignal): Promise<ModelReply> {
      assertLocalTracingOnly();
      // V3.0：当前运行（没有就不记）。模型调用在这里记一步并扣共用预算。
      const run = currentRun();
      const started = Date.now();
      const recordCall = (name: string, code: string) => {
        if (!run) return;
        if (usage) run.addTokens(usage);
        run.step("model_call", name, {
          code,
          ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheHitTokens: usage.cacheHitTokens } : {}),
        }, Date.now() - started);
      };
      // 同一次业务决策只允许一次底层 HTTP 请求，额外计数闸门防止 SDK 包装层暗中重发。
      // totalRequests 是整个适配器的累计请求数，requestCount 则约束这一次调用。
      let requestCount = 0;
      let usage: Usage | null = null;
      let returnedModel: string | undefined;
      let fingerprint: string | undefined;
      let requestId: string | undefined;
      let failure: ErrorCode | null = null;
      let invalidResponse = false;
      const client = new ChatOpenAI({
        model: profile.model,
        apiKey,
        temperature: profile.temperature,
        maxTokens: options.outputTokenLimit ?? profile.outputTokenLimit,
        // 纠错由图显式控制并计数；SDK 的隐式重试会让实际请求数超过预算，也让评测成本失真。
        maxRetries: 0,
        timeout: 15_000,
        streaming: false,
        useResponsesApi: false,
        modelKwargs: profile.thinkingMode === "disabled"
          ? { thinking: { type: "disabled" } }
          : {},
        configuration: {
          baseURL: profile.baseURL,
          maxRetries: 0,
          fetch: async (url, init) => {
            if (signal.aborted) throw new DecisionModelError("timeout");
            if (requestCount !== 0) throw new DecisionModelError("transport");
            requestCount += 1;
            await options.beforeRequest?.();
            if (signal.aborted) throw new DecisionModelError("timeout");
            // 用户每日上限先过（beforeRequest），再扣这次请求的共用预算；用完不发请求。
            try {
              run?.spend("model");
            } catch (error) {
              if (error instanceof RunBudgetError) failure = "quota";
              throw error;
            }
            totalRequests += 1;
            const response = await fetch(url, {
              ...init,
              signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
              redirect: "error",
            });
            if (!response.ok) {
              failure = response.status === 401 || response.status === 403 ? "auth"
                : response.status === 402 ? "quota"
                : response.status === 429 ? "rate_limit"
                : "transport";
            } else {
              // 仅提取白名单元信息、用量和请求标识；原始响应或推理正文不作为诊断数据保留。
              invalidResponse = true;
              const body = record(await response.clone().json());
              const choices = Array.isArray(body.choices) ? body.choices : [];
              const choice = record(choices[0]);
              const message = record(choice.message);
              // 不只校验 JSON 文本：截断、拒答、工具调用和多答案都不属于本协议的完整决策，统一拒绝。
              invalidResponse = choices.length !== 1 || choice.finish_reason !== "stop" ||
                (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
                !!message.function_call || !!message.refusal ||
                typeof message.content !== "string" || !message.content.trim();
              // usage 可缺省，缺省保留 null，不能把供应商没有返回用量写成零消耗。
              const raw = record(body.usage);
              if (raw && count(raw.prompt_tokens) && count(raw.completion_tokens) && count(raw.total_tokens)) {
                usage = {
                  inputTokens: raw.prompt_tokens,
                  outputTokens: raw.completion_tokens,
                  totalTokens: raw.total_tokens,
                  cacheHitTokens: count(raw.prompt_cache_hit_tokens) ? raw.prompt_cache_hit_tokens : null,
                  cacheMissTokens: count(raw.prompt_cache_miss_tokens) ? raw.prompt_cache_miss_tokens : null,
                };
              }
              returnedModel = safeIdentifier(body.model);
              fingerprint = safeIdentifier(body.system_fingerprint);
              requestId = safeIdentifier(body.id);
            }
            return response;
          },
        },
      });
      try {
        const message = await client.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(content),
        ], {
          signal,
          response_format: { type: "json_object" },
          callbacks: [],
        });
        if (invalidResponse || typeof message.content !== "string") {
          throw new DecisionModelError("invalid_output");
        }
        // JSON mode 只约束返回格式，不能证明业务动作合法。这里保留 unknown，
        // 再交各自协议的 Zod schema 与语义 guard 校验，避免传输层越权解释业务。
        let decision: unknown;
        try {
          decision = JSON.parse(message.content);
        } catch {
          throw new DecisionModelError("invalid_output");
        }
        recordCall(actionName(decision), "ok");
        return { decision, usage, returnedModel, fingerprint, requestId };
      } catch (error) {
        const code: ErrorCode = signal.aborted ? "timeout"
          : error instanceof DecisionModelError ? error.code
            : failure ?? (invalidResponse ? "invalid_output" : "transport");
        recordCall("error", code);
        if (signal.aborted) throw new DecisionModelError("timeout");
        if (error instanceof DecisionModelError) {
          throw new DecisionModelError(error.code, { usage, returnedModel, fingerprint, requestId });
        }
        throw new DecisionModelError(failure ?? (invalidResponse ? "invalid_output" : "transport"));
      }
    },
  };
}
