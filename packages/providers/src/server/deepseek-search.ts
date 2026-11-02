import type {
  ProviderCallOptions,
  ProviderEvidence,
  ProviderFailure,
  ProviderFailureCode,
  ProviderResult,
  WebSearchData,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "../contracts";

/**
 * DeepSeek Search 的摘要属于不可信外部资料，适配层只规范化，不长期保留。
 * 不发送需要 IP 地址的 localization 字段，避免把设备或网络位置用于搜索。
 */
const ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SUMMARY = 800;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const messages: Record<ProviderFailureCode, string> = {
  invalid_request: "搜索词无效。",
  authorization_failed: "联网搜索的配置不可用。",
  quota_exceeded: "联网搜索的余额或额度不足。",
  rate_limited: "联网搜索请求过于频繁，请稍后再试。",
  timeout: "联网搜索超时。",
  upstream_unavailable: "联网搜索暂时不可用。",
  malformed_response: "联网搜索返回的数据格式不符合约定。",
  cancelled: "请求已取消。",
  unknown: "联网搜索返回了未识别的错误。",
};

function failure(code: ProviderFailureCode): ProviderFailure {
  const retry = code === "invalid_request" || code === "cancelled" ? "never"
    : code === "authorization_failed" ? "after_configuration_change"
      : code === "quota_exceeded" ? "after_quota_reset"
        : "after_backoff";
  return { code, retry, safeMessage: messages[code] };
}

/** 按 HTTP 状态映射受控错误；408、429、5xx 等暂时性失败最多重试一次。 */
function statusCode(status: number): { code: ProviderFailureCode; again: boolean } {
  if (status === 401 || status === 403) return { code: "authorization_failed", again: false };
  if (status === 402) return { code: "quota_exceeded", again: false };
  if (status === 429) return { code: "rate_limited", again: true };
  if (status === 408 || status === 504) return { code: "timeout", again: true };
  if (status >= 500) return { code: "upstream_unavailable", again: true };
  if (status === 400 || status === 413) return { code: "invalid_request", again: false };
  return { code: "unknown", again: false };
}

/** 仅保留能展示和引用的结果，网址或字段不符合约定时丢弃这一条。 */
function result(value: unknown): WebSearchResult | null {
  if (!record(value)) return null;
  const title = text(value.title, 200);
  const url = typeof value.url === "string" && value.url.length <= 2048 ? value.url : null;
  if (!title || !url || !/^https?:\/\//.test(url) || !URL.canParse(url)) return null;
  const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.date) && Number.isFinite(Date.parse(value.date))
    ? value.date.slice(0, 10)
    : null;
  // 日期与 authority 是搜索结果的元信息，只辅助展示和选源；不是预约、营业等事实已核实的证明。
  const authority = Number.isInteger(value.authority) && (value.authority as number) >= 0 && (value.authority as number) <= 4
    ? (value.authority as number)
    : null;
  return {
    title,
    url,
    site: text(value.site_name, 60),
    date,
    summary: text(value.summary, MAX_SUMMARY) ?? text(value.snippet, MAX_SUMMARY) ?? "",
    authority,
  };
}

export interface DeepSeekSearchOptions {
  readonly key: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  readonly timeoutMs?: number;
  /** 暂时性失败重试前的间隔，测试可注入 0。 */
  readonly retryGapMs?: number;
}

/** 仅服务端使用，每次调用发一次搜索，暂时性失败至多重试一次。 */
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly #options: DeepSeekSearchOptions;

  constructor(options: DeepSeekSearchOptions) {
    this.#options = options;
  }

  #evidence(): ProviderEvidence {
    return { provider: "deepseek-search", sourceKind: "live", attribution: "DeepSeek 联网搜索", retrievedAt: this.#options.now() };
  }

  async searchWeb(request: WebSearchRequest, options?: ProviderCallOptions): Promise<ProviderResult<WebSearchData>> {
    const query = request.query.trim();
    const question = request.question?.trim().slice(0, 128);
    const count = request.count ?? 5;
    if (!query || [...query].length > 128 || !Number.isInteger(count) || count < 1 || count > 10) {
      return { status: "failure", failure: failure("invalid_request"), evidence: this.#evidence() };
    }
    if (!this.#options.key.trim()) return { status: "failure", failure: failure("authorization_failed"), evidence: this.#evidence() };
    // 只构造搜索协议白名单字段，不直接透传上层对象，避免夹带不需要的位置或业务上下文。
    const body = JSON.stringify({ query, count, ...(question ? { ori_question: question } : {}) });
    let outcome = await this.#attempt(body, options);
    if (outcome.status === "again") {
      await new Promise((resolve) => setTimeout(resolve, this.#options.retryGapMs ?? 1000));
      outcome = await this.#attempt(body, options);
    }
    if (outcome.status === "ok") return { status: "ok", data: { results: outcome.results }, evidence: this.#evidence() };
    return { status: "failure", failure: failure(outcome.code), evidence: this.#evidence() };
  }

  async #attempt(body: string, options?: ProviderCallOptions): Promise<
    | { status: "ok"; results: WebSearchResult[] }
    | { status: "again" | "failure"; code: ProviderFailureCode }
  > {
    if (options?.signal?.aborted) return { status: "failure", code: "cancelled" };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.#options.timeoutMs ?? 6000);
    try {
      const response = await this.#options.fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#options.key}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const { code, again } = statusCode(response.status);
        return { status: again ? "again" : "failure", code };
      }
      const raw = await response.text();
      if (raw.length > MAX_BODY_BYTES) return { status: "failure", code: "malformed_response" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: "failure", code: "malformed_response" };
      }
      if (!record(parsed) || !Array.isArray(parsed.results)) return { status: "failure", code: "malformed_response" };
      return { status: "ok", results: parsed.results.map(result).filter((item): item is WebSearchResult => item !== null) };
    } catch {
      if (options?.signal?.aborted) return { status: "failure", code: "cancelled" };
      // 主动取消直接结束；适配层自身超时或网络失败才允许再试一次。
      return { status: "again", code: controller.signal.aborted ? "timeout" : "upstream_unavailable" };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", cancel);
    }
  }
}
