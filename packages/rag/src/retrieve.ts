import type { EmbeddingProvider, ProviderCallOptions, RerankProvider } from "@tripquest/providers";

import { chunkText } from "./chunk";
import { reciprocalRankFusion } from "./fuse";
import { questionTerms } from "./keywords";
import type { KnowledgeStore, StoredChunk } from "./store";

export type RecallMode = "keyword" | "vector" | "hybrid" | "hybrid-rerank";

export interface RecallSettings {
  readonly mode: RecallMode;
  readonly vectorTop: number;
  readonly keywordTop: number;
  /** 融合后保留的小候选集，也是重排模型实际看到的段落。 */
  readonly fusedTop: number;
  /** 最终交给回答模型的段落数量，与前面扩大召回的数量分开。 */
  readonly answerTop: number;
  /**
   * 是否命中知识库由绝对分数决定：优先看最佳重排分，重排不可用时看最佳余弦相似度。
   * RRF 只表达相对名次，不能拿来判断是否应该回答。
   */
  readonly thresholds: { readonly rerank: number; readonly cosine: number };
}

/**
 * 默认参数来自按章节分块的召回评测。20 篇语料扩充后，相似但答错对象的题最高达 0.749，
 * 因此重排阈值提高到 0.79；该批有答案题最低 0.827，留出题误收、误拒均为 0。
 * 余弦阈值只在重排不可用时兜底，该批评测仍有一次误收，不能视为等价保障。
 */
export const DEFAULT_RECALL: RecallSettings = {
  mode: "hybrid-rerank",
  vectorTop: 20,
  keywordTop: 20,
  fusedTop: 8,
  answerTop: 4,
  thresholds: { rerank: 0.79, cosine: 0.53 },
};

export interface Passage extends StoredChunk {
  /** 本段落在最后一个排序阶段的分数；融合分与重排分含义不同，不能跨阶段比较。 */
  readonly score: number;
}

/** 保留各阶段排序供检索命令和召回评测诊断，便于区分没召回、融合排低和重排判断错误。 */
export interface RecallTrace {
  readonly keyword: readonly { id: string; rank: number }[];
  readonly vector: readonly { id: string; similarity: number }[];
  readonly fused: readonly { id: string; score: number }[];
  readonly reranked: readonly { id: string; score: number }[] | null;
}

export type RecallResult =
  | {
    readonly status: "found" | "not_found";
    /** 按最终顺序排列；未命中时仍保留近似结果供诊断，但聊天适配层不会把它们交给模型。 */
    readonly passages: readonly Passage[];
    /** 实际用于命中判断的最高绝对分数及类型，不能用某个段落的展示分数代替。 */
    readonly best: { readonly kind: "rerank" | "cosine" | "none"; readonly score: number };
    readonly trace: RecallTrace;
    readonly requests: { readonly embed: number; readonly rerank: number };
  }
  | { readonly status: "failed"; readonly safeMessage: string; readonly requests: { readonly embed: number; readonly rerank: number } };

export interface RecallDeps {
  readonly store: KnowledgeStore;
  readonly embedder: EmbeddingProvider;
  readonly reranker: RerankProvider | null;
  readonly settings?: RecallSettings;
  /** V2.10：只检索这个城市的文章；不给就查全部（召回评测）。 */
  readonly city?: string;
}

/** 先将问句按 query 类型向量化再检索；文档在入库时向量化，重排阶段另接收候选段落。 */
export async function recall(deps: RecallDeps, question: string, options?: ProviderCallOptions): Promise<RecallResult> {
  const settings = deps.settings ?? DEFAULT_RECALL;
  let vector: readonly number[] | null = null;
  if (settings.mode !== "keyword") {
    const embedded = await deps.embedder.embed({ texts: [question], kind: "query" }, options);
    if (embedded.status !== "ok") return { status: "failed", safeMessage: embedded.failure.safeMessage, requests: { embed: 1, rerank: 0 } };
    vector = embedded.data.vectors[0];
  }
  return recallWithVector(deps, question, vector, options);
}

/** 接收预先算好的问题向量，便于评测跨方案复用，避免反复向量化同一道题。 */
export async function recallWithVector(
  deps: RecallDeps,
  question: string,
  vector: readonly number[] | null,
  options?: ProviderCallOptions,
): Promise<RecallResult> {
  const settings = deps.settings ?? DEFAULT_RECALL;
  const embed = vector && settings.mode !== "keyword" ? 1 : 0;
  const keyword = settings.mode === "vector" ? [] : await deps.store.keyword(questionTerms(question), settings.keywordTop, deps.city);
  const nearest = settings.mode === "keyword" || !vector ? [] : await deps.store.nearest(vector, settings.vectorTop, deps.city);
  const fused = settings.mode === "keyword"
    ? keyword.map((item) => ({ id: item.id, score: item.rank }))
    : settings.mode === "vector"
      ? nearest.map((item) => ({ id: item.id, score: item.similarity }))
      : reciprocalRankFusion([nearest.map((item) => item.id), keyword.map((item) => item.id)]);
  // 关键词分数与余弦相似度不在同一量纲，混合模式只融合名次，再截取小候选集重排。
  // 召回负责尽量找全，重排负责判断问句与段落是否真正相关，避免把全部语料交给生成模型。
  const candidates = fused.slice(0, settings.fusedTop);
  const chunks = await deps.store.chunks(candidates.map((item) => item.id));
  const similarity = new Map(nearest.map((item) => [item.id, item.similarity]));
  const bestCosine = Math.max(0, ...candidates.map((item) => similarity.get(item.id) ?? 0));
  const passage = (id: string, score: number): Passage => ({ ...chunks.get(id)!, score });

  // 段落顺序先与融合结果对齐；重排返回的是输入文档下标，必须映射回这一批对应的段落 ID。
  let ordered = candidates.map((item) => passage(item.id, item.score));
  let reranked: { id: string; score: number }[] | null = null;
  let rerankRequests = 0;
  let best: { kind: "rerank" | "cosine" | "none"; score: number } = settings.mode === "keyword"
    ? { kind: "none", score: 0 }
    : { kind: "cosine", score: bestCosine };
  if (settings.mode === "hybrid-rerank" && deps.reranker && ordered.length > 0) {
    const result = await deps.reranker.rerank({ query: question, documents: ordered.map(chunkText) }, options);
    rerankRequests = 1;
    // 重排失败保留融合名次，并回退到余弦阈值判断；不能沿用未得到的重排结论。
    if (result.status === "ok") {
      reranked = result.data.ranking.map((item) => ({ id: ordered[item.index].id, score: item.score }));
      ordered = reranked.map((item) => passage(item.id, item.score));
      best = { kind: "rerank", score: reranked[0]?.score ?? 0 };
    }
  }
  // 排名第一也可能完全答非所问。用绝对相关分数决定 found；RRF 只有相对名次，
  // 不能用它判断“资料库里有答案”。整次召回未达阈值时，近似命中只供诊断，不交给回答模型。
  const threshold = best.kind === "rerank" ? settings.thresholds.rerank : settings.thresholds.cosine;
  // 纯关键词模式只供检索对照，没有可靠绝对分数，因此不据此向聊天链路宣称“有答案”。
  const found = best.kind !== "none" && ordered.length > 0 && best.score >= threshold;
  return {
    status: found ? "found" : "not_found",
    passages: ordered.slice(0, settings.answerTop),
    best,
    trace: { keyword, vector: nearest, fused, reranked },
    requests: { embed, rerank: rerankRequests },
  };
}
