import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "@tripquest/providers";
import {
  decide,
  INTENT_FLAGS,
  regexFallback,
  type IntentFlag,
  type IntentInput,
  type IntentRoute,
  type IntentRouter,
} from "./intent";
import { INTENT_EXEMPLARS, type IntentExemplar } from "./intent-exemplars";

/** 住处、楼号、坐标：这样的消息不发给嵌入服务（§3.7），直接用正则。 */
export const WHERE_USER_IS = /小区|公寓|宿舍|我家|家附近|\d+\s*(幢|栋|号楼|单元|室)|\d{2,3}\.\d{3,}/;

/** 一起发出去的上一条助手消息（前 80 字）也可能转述住处（“从 XX 小区出发”）：那样就不带它。 */
export const shareablePrevious = (previous?: string) => {
  const head = previous?.slice(0, 80);
  return head && !WHERE_USER_IS.test(head) ? head : undefined;
};

export interface EmbeddingRouterSettings {
  /** 参与投票的近邻数。 */
  readonly k: number;
  /** 最高相似度低于它时整条“拿不准”。 */
  readonly minSimilarity: number;
  readonly band: { readonly low: number; readonly high: number };
}

/**
 * 由样例库内的留一法选定（stages/V2.9.md §8，2026-10-21）：k=3 的投票最好，但也只有 45/101
 * 完全正确。级联用宽区间，向量只处理有把握的部分，其余问 DeepSeek。
 */
export const DEFAULT_EMBEDDING_ROUTER: EmbeddingRouterSettings = { k: 3, minSimilarity: 0.4, band: { low: 0.45, high: 0.55 } };
export const DEFAULT_CASCADE_ROUTER: EmbeddingRouterSettings = { k: 3, minSimilarity: 0.5, band: { low: 0.25, high: 0.75 } };

/** 嵌入的是什么：本条消息，附上一条助手消息的前 80 字（指代要靠它）。 */
export const routeText = (text: string, previous?: string) =>
  previous ? `${text}\n（上一条：${previous.slice(0, 80)}）` : text;

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);

export interface NeighbourScores {
  readonly scores: Record<IntentFlag, number>;
  readonly best: number;
}

/** 近邻投票：前 k 个样例里，每个判断为真的样例按相似度加权的占比。 */
export function voteNeighbours(
  similarities: readonly { readonly similarity: number; readonly flags: readonly IntentFlag[] }[],
  k: number,
): NeighbourScores {
  const top = [...similarities].sort((a, b) => b.similarity - a.similarity).slice(0, k);
  const total = top.reduce((sum, item) => sum + Math.max(item.similarity, 0), 0) || 1;
  const scores = Object.fromEntries(INTENT_FLAGS.map((flag) => [
    flag,
    top.reduce((sum, item) => sum + (item.flags.includes(flag) ? Math.max(item.similarity, 0) : 0), 0) / total,
  ])) as Record<IntentFlag, number>;
  return { scores, best: top[0]?.similarity ?? 0 };
}

export interface EmbeddingRouterOptions {
  readonly embedder: EmbeddingProvider;
  readonly exemplars?: readonly IntentExemplar[];
  readonly settings?: EmbeddingRouterSettings;
  readonly timeoutMs?: number;
  /** 每次嵌入前记账；返回 false 表示今天的额度用完（退回正则）。 */
  readonly reserve?: () => Promise<boolean>;
  /** 评测用：排除与本条消息同文的样例（留一法）。 */
  readonly leaveOut?: boolean;
  /** 级联：拿不准的判断交给它，而不是正则。 */
  readonly escalate?: IntentRouter;
}

/** 样例库按内容哈希嵌入一次，留在进程内存里；样例变了才重新嵌入。 */
const libraryCache = new Map<string, Promise<(readonly number[])[]>>();

async function embedLibrary(embedder: EmbeddingProvider, exemplars: readonly IntentExemplar[]): Promise<(readonly number[])[]> {
  const key = createHash("sha256").update(JSON.stringify([embedder.model, embedder.dimensions, exemplars])).digest("hex");
  let cached = libraryCache.get(key);
  if (!cached) {
    cached = (async () => {
      const vectors: (readonly number[])[] = [];
      for (let start = 0; start < exemplars.length; start += 20) {
        const batch = exemplars.slice(start, start + 20);
        const result = await embedder.embed({ texts: batch.map((item) => routeText(item.text, item.previous)), kind: "document" });
        if (result.status !== "ok") throw new Error(result.failure.code);
        vectors.push(...result.data.vectors);
      }
      return vectors;
    })();
    libraryCache.set(key, cached);
    // 失败的嵌入不留在缓存里，下次再试。
    cached.catch(() => libraryCache.delete(key));
  }
  return cached;
}

/**
 * 向量语义路由。`escalate` 为空时拿不准的判断用正则补（向量实现）；不为空时交给它（级联）。
 * 嵌入失败、超时、超额或消息含住处时整条退回正则。
 */
export function createEmbeddingIntentRouter(options: EmbeddingRouterOptions): IntentRouter {
  const exemplars = options.exemplars ?? INTENT_EXEMPLARS;
  const settings = options.settings ?? DEFAULT_EMBEDDING_ROUTER;
  const name = options.escalate ? "cascade" : "embedding";
  return {
    name,
    async route(input: IntentInput, { signal }): Promise<IntentRoute> {
      const started = performance.now();
      if (WHERE_USER_IS.test(input.text)) {
        return options.escalate ? options.escalate.route(input, { signal }) : regexFallback(input, name, started, "private");
      }
      let query: readonly number[];
      let library: (readonly number[])[];
      try {
        if (options.reserve && !(await options.reserve())) return regexFallback(input, name, started, "daily_limit");
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 2000)]);
        library = await embedLibrary(options.embedder, exemplars);
        const result = await options.embedder.embed({ texts: [routeText(input.text, shareablePrevious(input.previous))], kind: "query" }, { signal: bounded });
        if (result.status !== "ok") return regexFallback(input, name, started, result.failure.code);
        query = result.data.vectors[0];
      } catch {
        return regexFallback(input, name, started, signal.aborted ? "cancelled" : "error");
      }
      const similarities = exemplars.flatMap((item, index) =>
        options.leaveOut && item.text === input.text ? [] : [{ similarity: dot(query, library[index]), flags: item.flags }]);
      const { scores, best } = voteNeighbours(similarities, settings.k);
      const unsure = best < settings.minSimilarity;
      if (!options.escalate) {
        const { flags, fallback } = unsure
          ? { flags: regexFallback(input, name, started).flags, fallback: [...INTENT_FLAGS] }
          : decide(scores, input, settings.band);
        return { flags, confidence: scores, router: name, fallback, latencyMs: Math.round(performance.now() - started) };
      }
      // 级联：整条拿不准，或有判断落在中间区间时，才问 DeepSeek，并只用它补这些判断。
      const own = decide(scores, input, settings.band);
      const ask = unsure ? [...INTENT_FLAGS] : own.fallback;
      if (!ask.length) return { flags: own.flags, confidence: scores, router: name, fallback: [], latencyMs: Math.round(performance.now() - started) };
      const asked = await options.escalate.route(input, { signal });
      const flags = Object.fromEntries(INTENT_FLAGS.map((flag) => [flag, ask.includes(flag) ? asked.flags[flag] : own.flags[flag]])) as Record<IntentFlag, boolean>;
      return {
        flags,
        confidence: scores,
        router: `${name}+${asked.router}`,
        fallback: asked.router.endsWith("regex") ? ask : [],
        latencyMs: Math.round(performance.now() - started),
        ...(asked.failure ? { failure: asked.failure } : {}),
      };
    },
  };
}
export { INTENT_EXEMPLARS, INTENT_EXEMPLARS_VERSION } from "./intent-exemplars";
