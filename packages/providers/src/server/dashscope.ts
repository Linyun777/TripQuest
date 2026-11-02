import type {
  EmbeddingData,
  EmbeddingProvider,
  EmbeddingRequest,
  ProviderCallOptions,
  ProviderEvidence,
  ProviderFailure,
  ProviderFailureCode,
  ProviderResult,
  RerankData,
  RerankProvider,
  RerankRequest,
} from "../contracts";

/**
 * 百炼原生接口支持 text_type 区分问句和文档，不能用丢失此参数的兼容接口替代。
 * 2026-10-19 实测响应使用 index，文档写 text_index，两种位置字段都兼容。
 * 只发送问题和自有语料，业务地点实时数据不进入此链路。
 */
const EMBED_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";
const RERANK_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 模型单次请求的文本数量限制，按 2026-10-19 接口约定。 */
export const EMBED_BATCH_LIMIT = 20;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const messages: Record<ProviderFailureCode, string> = {
  invalid_request: "资料库查询的请求无效。",
  authorization_failed: "资料库的向量服务配置不可用。",
  quota_exceeded: "资料库的向量服务余额或额度不足。",
  rate_limited: "资料库查询过于频繁，请稍后再试。",
  timeout: "资料库查询超时。",
  upstream_unavailable: "资料库的向量服务暂时不可用。",
  malformed_response: "向量服务返回的数据格式不符合约定。",
  cancelled: "请求已取消。",
  unknown: "向量服务返回了未识别的错误。",
};

function failure(code: ProviderFailureCode): ProviderFailure {
  const retry = code === "invalid_request" || code === "cancelled" ? "never"
    : code === "authorization_failed" ? "after_configuration_change"
      : code === "quota_exceeded" ? "after_quota_reset"
        : "after_backoff";
  return { code, retry, safeMessage: messages[code] };
}

/** HTTP 状态与百炼业务错误共同映射为受控代码；仅 408、429 和 5xx 等暂时性失败允许再试一次。 */
function statusCode(status: number, code: string | null): { code: ProviderFailureCode; again: boolean } {
  if (code === "Arrearage" || code === "AllocationQuota.FreeTierOnly") return { code: "quota_exceeded", again: false };
  if (status === 401 || status === 403) return { code: "authorization_failed", again: false };
  if (status === 429) return { code: "rate_limited", again: true };
  if (status === 408 || status === 504) return { code: "timeout", again: true };
  if (status >= 500) return { code: "upstream_unavailable", again: true };
  if (status === 400 || status === 413) return { code: "invalid_request", again: false };
  return { code: "unknown", again: false };
}

export interface DashScopeOptions {
  readonly key: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** 自动重试前的间隔，测试可设为 0，生产避免立即重复冲击上游。 */
  readonly retryGapMs?: number;
}

type Attempt =
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "again" | "failure"; code: ProviderFailureCode };

class DashScopeClient {
  constructor(readonly options: DashScopeOptions, readonly provider: string) {}

  evidence(): ProviderEvidence {
    return { provider: this.provider, sourceKind: "live", attribution: "阿里云百炼", retrievedAt: this.options.now() };
  }

  async post(endpoint: string, body: unknown, options?: ProviderCallOptions): Promise<Attempt> {
    if (!this.options.key.trim()) return { status: "failure", code: "authorization_failed" };
    const text = JSON.stringify(body);
    let outcome = await this.#attempt(endpoint, text, options);
    if (outcome.status === "again") {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryGapMs ?? 1000));
      outcome = await this.#attempt(endpoint, text, options);
    }
    return outcome;
  }

  async #attempt(endpoint: string, body: string, options?: ProviderCallOptions): Promise<Attempt> {
    if (options?.signal?.aborted) return { status: "failure", code: "cancelled" };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 6000);
    try {
      const response = await this.options.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.key}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      const raw = await response.text();
      if (raw.length > MAX_BODY_BYTES) return { status: "failure", code: "malformed_response" };
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (response.ok) return { status: "failure", code: "malformed_response" };
      }
      if (!response.ok) {
        const code = record(parsed) && typeof parsed.code === "string" ? parsed.code : null;
        const mapped = statusCode(response.status, code);
        return { status: mapped.again ? "again" : "failure", code: mapped.code };
      }
      if (!record(parsed) || !record(parsed.output)) return { status: "failure", code: "malformed_response" };
      return { status: "ok", body: parsed };
    } catch {
      if (options?.signal?.aborted) return { status: "failure", code: "cancelled" };
      // 区分用户取消与内部超时；内部超时、网络失败可再试一次，主动取消不能重试。
      return { status: "again", code: controller.signal.aborted ? "timeout" : "upstream_unavailable" };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", cancel);
    }
  }
}

const tokens = (body: Record<string, unknown>) =>
  record(body.usage) && Number.isInteger(body.usage.total_tokens) ? (body.usage.total_tokens as number) : 0;

const position = (item: Record<string, unknown>) => {
  const value = item.index ?? item.text_index;
  return Number.isInteger(value) ? (value as number) : null;
};

export interface DashScopeEmbeddingOptions extends DashScopeOptions {
  readonly dimensions: number;
  /** 可选查询任务指令，仅发给 query；是否启用由召回评测决定。 */
  readonly instruct?: string;
}

/** 仅服务端调用，每批最多 20 段；模型协议返回单位化向量，仍要校验数量、位置与维数。 */
export class DashScopeEmbeddingProvider implements EmbeddingProvider {
  readonly #client: DashScopeClient;
  readonly #options: DashScopeEmbeddingOptions;

  constructor(options: DashScopeEmbeddingOptions) {
    this.#options = options;
    this.#client = new DashScopeClient(options, "dashscope-embedding");
  }

  get model(): string {
    return this.#options.model;
  }

  get dimensions(): number {
    return this.#options.dimensions;
  }

  async embed(request: EmbeddingRequest, options?: ProviderCallOptions): Promise<ProviderResult<EmbeddingData>> {
    const texts = request.texts.map((text) => text.trim());
    if (texts.length < 1 || texts.length > EMBED_BATCH_LIMIT || texts.some((text) => !text)) {
      return { status: "failure", failure: failure("invalid_request"), evidence: this.#client.evidence() };
    }
    // 文档入库与问句检索使用不同 text_type；二者保持同一模型和维度，才能在同一向量空间比较。
    const parameters = {
      dimension: this.#options.dimensions,
      text_type: request.kind,
      ...(request.kind === "query" && this.#options.instruct ? { instruct: this.#options.instruct } : {}),
    };
    const outcome = await this.#client.post(EMBED_ENDPOINT, { model: this.#options.model, input: { texts }, parameters }, options);
    if (outcome.status !== "ok") {
      return { status: "failure", failure: failure(outcome.code), evidence: this.#client.evidence() };
    }
    const items = (outcome.body.output as Record<string, unknown>).embeddings;
    // 按供应商返回的原文位置还原批次，不能把响应顺序当输入顺序。
    // 向量数量、维度和数值完整性一起校验，防止向量挂错段落后检索“看似成功、实际串文”。
    const vectors: number[][] = new Array(texts.length);
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!record(item)) continue;
        const at = position(item);
        const vector = item.embedding;
        if (at === null || at < 0 || at >= texts.length || !Array.isArray(vector)) continue;
        if (vector.length !== this.#options.dimensions || !vector.every((value) => Number.isFinite(value))) continue;
        vectors[at] = vector as number[];
      }
    }
    if (vectors.filter(Boolean).length !== texts.length) {
      return { status: "failure", failure: failure("malformed_response"), evidence: this.#client.evidence() };
    }
    return { status: "ok", data: { vectors, tokens: tokens(outcome.body) }, evidence: this.#client.evidence() };
  }
}

/** 请求对全部候选打分，返回有效下标与分数；调用方按最终排名截取少量段落。 */
export class DashScopeRerankProvider implements RerankProvider {
  readonly #client: DashScopeClient;
  readonly #options: DashScopeOptions;

  constructor(options: DashScopeOptions) {
    this.#options = options;
    this.#client = new DashScopeClient(options, "dashscope-rerank");
  }

  get model(): string {
    return this.#options.model;
  }

  async rerank(request: RerankRequest, options?: ProviderCallOptions): Promise<ProviderResult<RerankData>> {
    const query = request.query.trim();
    if (!query || request.documents.length < 1 || request.documents.length > 50) {
      return { status: "failure", failure: failure("invalid_request"), evidence: this.#client.evidence() };
    }
    const outcome = await this.#client.post(RERANK_ENDPOINT, {
      model: this.#options.model,
      input: { query, documents: request.documents },
      parameters: { top_n: request.documents.length, return_documents: false },
    }, options);
    if (outcome.status !== "ok") {
      return { status: "failure", failure: failure(outcome.code), evidence: this.#client.evidence() };
    }
    const results = (outcome.body.output as Record<string, unknown>).results;
    const ranking = Array.isArray(results)
      ? results.flatMap((item) => {
        if (!record(item)) return [];
        const at = position(item);
        const score = item.relevance_score;
        if (at === null || at < 0 || at >= request.documents.length || typeof score !== "number" || !Number.isFinite(score)) return [];
        return [{ index: at, score }];
      })
      : [];
    if (ranking.length === 0 || new Set(ranking.map((item) => item.index)).size !== ranking.length) {
      return { status: "failure", failure: failure("malformed_response"), evidence: this.#client.evidence() };
    }
    // 保留供应商的原输入下标用于映射段落，排序只按相关分；重复下标已在上面作为畸形响应拒绝。
    ranking.sort((a, b) => b.score - a.score);
    return { status: "ok", data: { ranking, tokens: tokens(outcome.body) }, evidence: this.#client.evidence() };
  }
}
