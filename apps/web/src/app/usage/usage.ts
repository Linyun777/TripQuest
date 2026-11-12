import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CityResolver,
  MobilityProvider,
  PlaceLookupProvider,
  PlaceSearchRequest,
  ProviderCallOptions,
  ProviderEvidence,
  NearbyPlaceProvider,
  RouteRequest,
  WeatherProvider,
  WebSearchProvider,
  WebSearchRequest,
} from "@tripquest/providers";
import { AmapMobilityProvider, DeepSeekSearchProvider } from "@tripquest/providers/server";
import { getSharedJourneyDatabase, UsageLedger, UsageUnavailableError, type JourneyDatabaseClient, type UsageCategory } from "@tripquest/db";
import { KnowledgeStore, knowledgeBase, liveEmbedder, liveReranker, PRODUCT_RERANK_MODEL } from "@tripquest/rag";
import { createRegexCascadeRouter, regexRouter, type IntentRouter } from "@tripquest/agent/intent";
import { createDeepSeekIntentRouter } from "@tripquest/agent/intent-live";
import { createEmbeddingIntentRouter, DEFAULT_CASCADE_ROUTER, DEFAULT_EMBEDDING_ROUTER } from "@tripquest/agent/intent-embedding";
import { jevIntentRouter } from "@tripquest/agent/intent-jev";
import { createJevClientFromEnv } from "@tripquest/agent/jev";
import { createJevPicker } from "@tripquest/agent/short-jev";
import type { CandidatePicker } from "@tripquest/agent/short";
import { RunBudgetError } from "@tripquest/agent/runs";
import { runForUsage } from "../runs/runs";

type KnowledgePool = JourneyDatabaseClient["pool"];

/**
 * V2.12 用量（stages/V2.12.md §3.5）：从本机文件移进数据库（packages/db 的 UsageLedger），按用户记、按用户和全站
 * 两层上限。每次地图、模型、联网、资料库、Jev 请求先预留，预留失败就不发请求。这里只把账本接到各个请求上。
 */
export type UsagePool = UsageCategory;
type PoolKinds = {
  amap: "search" | "detail" | "route" | "weather" | "nearby";
  model: "model";
  web: "web-search";
  embed: "embed-query" | "rerank" | "embed-route";
  jev: "route-jev" | "pick-jev";
};
type UsageKind<P extends UsagePool> = PoolKinds[P];

export interface Usage {
  reserve<P extends UsagePool>(pool: P, kind: UsageKind<P>, purpose: string): Promise<void>;
}

/**
 * 当前用户的用量账本（用户由接口从会话取得）。V3.0：每次预留记上当前根运行，先过用户每日上限，再扣这次
 * 请求的共用预算（模型在传输层扣，评测也走那里）；预算用完抛 RunBudgetError，请求不发。
 */
export function createUserUsage(userId: string, now: () => number = Date.now): Usage {
  return {
    reserve: (pool, kind, purpose) => runForUsage(userId, purpose, async (run) => {
      await new UsageLedger(getSharedJourneyDatabase().pool, userId, process.env, now, () => run.rootId).reserve(pool, kind, purpose);
      if (pool !== "model") run.spend(pool);
    }),
  };
}

/**
 * 模型请求之前的预留，给各个 Agent 的 beforeRequest 用：到上限照旧抛出（Agent 记成“今天的次数用完”）；账本暂时记不了时
 * 抛 unavailable() 给的错误（各 Agent 自己的“暂时出错”），不说成用完。
 */
export function reserveModel(usage: Usage, purpose: string, unavailable: () => Error): () => Promise<void> {
  return async () => {
    try {
      await usage.reserve("model", "model", purpose);
    } catch (error) {
      throw error instanceof UsageUnavailableError ? unavailable() : error;
    }
  };
}

/** 共用预算用完时的说法（和“今天的次数用完了”分开）。 */
export const RUN_BUDGET_MESSAGE = "这次请求太复杂，没能做完。";

/** 个人 Key 对短时突发请求有限流；本进程通过串行预约请求时刻留出最小间隔。 */
export const REAL_AMAP_MIN_GAP_MS = 400;
let lastRequest = 0;
let queue: Promise<void> = Promise.resolve();
function paced(): Promise<void> {
  const turn = queue.then(async () => {
    const wait = lastRequest + REAL_AMAP_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
  });
  queue = turn.catch(() => {});
  return turn;
}

/** 每个高德操作先预留次数，预留失败映射成 quota，避免未记账就发送。 */
export function meteredAmap(options: {
  key: string;
  usage: Usage;
  purpose: string;
  now?: () => number;
}): MobilityProvider & PlaceLookupProvider & WeatherProvider & NearbyPlaceProvider & CityResolver {
  const now = options.now ?? Date.now;
  const amap = new AmapMobilityProvider({
    key: options.key,
    fetch: globalThis.fetch,
    now: () => new Date(now()).toISOString(),
    stepGapMs: REAL_AMAP_MIN_GAP_MS,
  });
  const evidence = (): ProviderEvidence => ({
    provider: "amap",
    sourceKind: "live",
    attribution: "高德地图",
    retrievedAt: new Date(now()).toISOString(),
  });
  const refused = (error?: unknown) => ({
    status: "failure" as const,
    // 账本暂时记不了（数据库连接、锁超时）不是次数用完：按暂时不可用回，不让用户“明天再试”。
    failure: error instanceof UsageUnavailableError
      ? { code: "upstream_unavailable" as const, retry: "after_backoff" as const, safeMessage: "暂时查不了地点，请稍后再试。" }
      : {
          code: "quota_exceeded" as const,
          retry: "after_quota_reset" as const,
          safeMessage: error instanceof RunBudgetError ? RUN_BUDGET_MESSAGE : "今天的地点查询次数已用完，请明天再试。",
        },
    evidence: evidence(),
  });
  const guarded = async <T>(kind: UsageKind<"amap">, call: () => Promise<T>) => {
    try {
      await options.usage.reserve("amap", kind, options.purpose);
    } catch (error) {
      return refused(error);
    }
    await paced();
    return call();
  };
  return {
    searchPlaces: (request: PlaceSearchRequest, call?: ProviderCallOptions) =>
      guarded("search", () => amap.searchPlaces(request, call)),
    // V2.10：城市名换成编码（行政区查询），按一次搜索记账。公交第一次查某个城市时，路线内部会多一次
    // 行政区查询换城市代码（之后缓存），记在这一次路线里。
    resolveCity: (name: string, call?: ProviderCallOptions) =>
      guarded("search", () => amap.resolveCity(name, call)),
    findRoutes: (request: RouteRequest, call?: ProviderCallOptions) =>
      guarded("route", () => amap.findRoutes(request, call)),
    findPlacesById: (ids: readonly string[], call?: ProviderCallOptions) =>
      guarded("detail", () => amap.findPlacesById(ids, call)),
    getWeatherForecast: (cityAdcode: string, call?: ProviderCallOptions) =>
      guarded("weather", () => amap.getWeatherForecast(cityAdcode, call)),
    // 实时天气与预报一样先记高德用量。
    getLiveWeather: (cityAdcode: string, call?: ProviderCallOptions) =>
      guarded("weather", () => amap.getLiveWeather(cityAdcode, call)),
    // 坐标转换与逆地理查询合计两次高德请求，需要预留两次。
    nearestPlace: async (point: { longitude: number; latitude: number }, call?: ProviderCallOptions) => {
      // 两个请求的额度都先预留好，防止做完坐标转换后才发现无法继续查地点。
      try {
        await options.usage.reserve("amap", "nearby", options.purpose);
      } catch (error) {
        return refused(error);
      }
      return guarded("nearby", () => amap.nearestPlace(point, call));
    },
  };
}

/** 联网搜索在请求前预留次数，达到上限则返回 quota，不发送付费请求。 */
export function meteredWebSearch(options: { key: string; usage: Usage; purpose: string; now?: () => number }): WebSearchProvider {
  const now = options.now ?? Date.now;
  const search = new DeepSeekSearchProvider({ key: options.key, fetch: globalThis.fetch, now: () => new Date(now()).toISOString() });
  return {
    async searchWeb(request: WebSearchRequest, call?: ProviderCallOptions) {
      try {
        await options.usage.reserve("web", "web-search", options.purpose);
      } catch (error) {
        const safeMessage = error instanceof RunBudgetError ? RUN_BUDGET_MESSAGE : "今天的联网搜索次数已用完，请明天再试。";
        return {
          status: "failure",
          failure: error instanceof UsageUnavailableError
            ? { code: "upstream_unavailable", retry: "after_backoff", safeMessage: "暂时不能联网搜索，请稍后再试。" }
            : { code: "quota_exceeded", retry: "after_quota_reset", safeMessage },
          evidence: { provider: "deepseek-search", sourceKind: "live", attribution: "DeepSeek 联网搜索", retrievedAt: new Date(now()).toISOString() },
        };
      }
      return search.searchWeb(request, call);
    },
  };
}

/**
 * 资料库复用共享数据库，问句向量和重排分别先预留用量。
 * 只发送问题与自有候选段落；涉及用户当前位置的问题由聊天入口先拒绝。
 */
export function meteredKnowledge(options: { environment: NodeJS.ProcessEnv; usage: Usage; purpose: string; pool: KnowledgePool }) {
  const reserve = async (kind: "embed-query" | "rerank") => {
    try {
      await options.usage.reserve("embed", kind, options.purpose);
      return true;
    } catch {
      return false;
    }
  };
  return knowledgeBase({
    store: new KnowledgeStore(options.pool),
    embedder: liveEmbedder({ environment: options.environment }),
    reranker: liveReranker(PRODUCT_RERANK_MODEL, options.environment),
    reserve,
  });
}

/**
 * V2.9：按 `INTENT_ROUTER` 选分流实现（V4.1 起缺省是级联 regex+deepseek；原来缺省正则，stages/V2.9.md §8）。
 * DeepSeek 分类记进模型账本；向量路由每条消息一次嵌入，记进 embed 账本（embed-route），
 * 与资料库共用 EMBEDDING_DAILY_LIMIT，超额时退回正则。
 */
export function meteredIntentRouter(options: {
  environment: NodeJS.ProcessEnv;
  usage: Usage;
  config: unknown;
}): IntentRouter {
  const env = options.environment;
  // V4.1：缺省是级联（正则拿不准的才问 DeepSeek；stages/V4.1.md 结果，评测达到 §4.3 后切换）。
  const choice = env.INTENT_ROUTER ?? "regex+deepseek";
  // V2.9.2：Jev 分流（只对照，默认不用）；失败、超时、超出每日上限都整条退回正则。
  if (choice === "jev") {
    return jevIntentRouter(createJevClientFromEnv(env, { beforeRequest: () => options.usage.reserve("jev", "route-jev", "chat-route") }));
  }
  if (choice !== "deepseek" && choice !== "embedding" && choice !== "cascade" && choice !== "regex+deepseek") return regexRouter;
  const deepseek = () => createDeepSeekIntentRouter({
    config: options.config,
    profileId: env.AGENT_MODEL_PROFILE ?? "",
    environment: env,
    beforeRequest: () => options.usage.reserve("model", "model", "chat-route"),
  });
  if (choice === "deepseek") return deepseek();
  // V4.1 级联：正则拿不准的才问 DeepSeek（stages/V4.1.md §3.2）。
  if (choice === "regex+deepseek") return createRegexCascadeRouter(deepseek());
  if (!env.DASHSCOPE_API_KEY?.trim()) return regexRouter;
  return createEmbeddingIntentRouter({
    embedder: liveEmbedder({ environment: env }),
    settings: choice === "cascade" ? DEFAULT_CASCADE_ROUTER : DEFAULT_EMBEDDING_ROUTER,
    reserve: async () => {
      try {
        await options.usage.reserve("embed", "embed-route", "chat-route");
        return true;
      } catch {
        return false;
      }
    },
    ...(choice === "cascade" ? { escalate: deepseek() } : {}),
  });
}

/** V2.9.2：`SHORT_PICKER=jev` 时短途挑地点先交给 Jev（只对照，默认不用）；没能完成时照旧由模型挑。 */
export function meteredJevPicker(options: { environment: NodeJS.ProcessEnv; usage: Usage }): CandidatePicker | undefined {
  if (options.environment.SHORT_PICKER !== "jev") return undefined;
  return createJevPicker(createJevClientFromEnv(options.environment, {
    beforeRequest: () => options.usage.reserve("jev", "pick-jev", "plan"),
  }));
}
