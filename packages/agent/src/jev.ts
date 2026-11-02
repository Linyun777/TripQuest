import { z } from "zod";

/**
 * V2.9.2 Jev（TypeSafe）客户端（stages/V2.9.2.md §3.1）：只有一个接口 `POST /v1/systemone`，用 fetch
 * 直接调，不加 SDK。只认用到的两种问题：`noul`（是 / 否，返回“是”的概率）和 `choice`（从选项里选）。
 * 同一个 state 上的问题并行、互不影响地回答。返回用 Zod 校验，问到的每个问题都要有同类型的答案。
 * 固定版本号，不用别名（别名会悄悄换模型）；超时 3 秒、不重试，失败一律抛 JevError 交调用方退回。
 * Key 只从参数读，不进任何错误信息。
 */
export const JEV_DEFAULT_MODEL = "jev-1.14.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_TIMEOUT_MS = 3000;

export type JevQuestion =
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> };

export type JevAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | { readonly type: "choice"; readonly choice: string; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> };

export interface JevReply {
  /** 实际回答的版本（报告记录这个，不记请求的名字）。 */
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly inputTokens: number;
}

/** 失败的种类（不含内容），决策记录和评测报告按它统计退回原因。 */
export type JevFailure = "no_key" | "timeout" | "cancelled" | "network" | "unauthorized" | "rate_limited" | "overloaded" | "daily_limit" | "invalid_reply" | `http_${number}`;

export class JevError extends Error {
  readonly code: JevFailure;

  constructor(code: JevFailure) {
    super(`jev ${code}`);
    this.code = code;
  }
}

export interface JevClient {
  readonly model: string;
  ask(state: unknown, questions: Readonly<Record<string, JevQuestion>>, options: { readonly signal: AbortSignal }): Promise<JevReply>;
}

const probability = z.number().min(0).max(1);
const replySchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion("type", [
    z.object({ type: z.literal("noul"), noul: probability }),
    z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }),
  ])),
  usage: z.object({ input_tokens: z.number().int().min(0) }),
});

export interface JevClientOptions {
  readonly apiKey: string | undefined;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  /** 发请求之前（用量账本记一次、超出每日上限时抛 JevError("daily_limit")）。 */
  readonly beforeRequest?: () => Promise<void> | void;
}

export function createJevClient(options: JevClientOptions): JevClient {
  const model = options.model || JEV_DEFAULT_MODEL;
  const send = options.fetch ?? fetch;
  return {
    model,
    async ask(state, questions, { signal }) {
      if (!options.apiKey) throw new JevError("no_key");
      if (signal.aborted) throw new JevError("cancelled");
      try {
        await options.beforeRequest?.();
      } catch (error) {
        throw error instanceof JevError ? error : new JevError("daily_limit");
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS);
      const stop = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        // 即使 fetch 不理会中止信号，也按时结束等待（与对话 Agent 的 bounded 相同）。
        response = await Promise.race([
          send(options.endpoint ?? JEV_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, state, questions }),
            signal: stop,
          }),
          new Promise<never>((_, reject) => stop.addEventListener("abort", () => reject(stop.reason), { once: true })),
        ]);
      } catch {
        throw new JevError(signal.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network");
      }
      if (!response.ok) {
        throw new JevError(response.status === 401 ? "unauthorized" : response.status === 429 ? "rate_limited" : response.status === 529 ? "overloaded" : `http_${response.status}`);
      }
      const parsed = replySchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new JevError("invalid_reply");
      // 问到的每个问题都要有同类型的答案；choice 选中的必须是给出的选项之一。
      for (const [name, question] of Object.entries(questions)) {
        const answer = parsed.data.answers[name];
        if (!answer || answer.type !== question.type) throw new JevError("invalid_reply");
        if (answer.type === "choice" && question.type === "choice" && !(answer.choice in question.criteria)) throw new JevError("invalid_reply");
      }
      return { model: parsed.data.model, answers: parsed.data.answers, inputTokens: parsed.data.usage.input_tokens };
    },
  };
}

/** 从环境变量创建：`TYPESAFE_API_KEY`、`JEV_MODEL`（缺省固定版本）。 */
export function createJevClientFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  extra: Omit<JevClientOptions, "apiKey" | "model"> = {},
): JevClient {
  return createJevClient({ ...extra, apiKey: environment.TYPESAFE_API_KEY, model: environment.JEV_MODEL });
}

/** noul 的“是”的概率（客户端已校验类型）。 */
export function yes(reply: JevReply, name: string): number {
  const answer = reply.answers[name];
  return answer?.type === "noul" ? answer.noul : 0;
}
