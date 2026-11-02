import type { EmbeddingProvider, RerankProvider } from "@tripquest/providers";

import { DEFAULT_RECALL, recall, type RecallSettings } from "./retrieve";
import type { KnowledgeStore } from "./store";

export interface KnowledgeAnswerPassage {
  readonly chunkId: string;
  readonly documentId: string;
  readonly title: string;
  readonly headingPath: string;
  readonly text: string;
}

export type KnowledgeAnswer =
  | { readonly status: "found"; readonly passages: readonly KnowledgeAnswerPassage[] }
  | { readonly status: "not_found" }
  | { readonly status: "failed"; readonly code: "daily_limit" | "unavailable" };

/**
 * 把检索结果适配成 Agent 的 ask_knowledge 协议。
 * 整次召回最高分达到阈值才返回候选段落；未达到时只返回未命中，不泄漏近似结果。
 * 向量额度不足会中止查询，重排额度不足则降级到混合召回与余弦阈值。
 */
export function knowledgeBase(deps: {
  readonly store: KnowledgeStore;
  readonly embedder: EmbeddingProvider;
  readonly reranker: RerankProvider | null;
  readonly settings?: RecallSettings;
  readonly reserve?: (kind: "embed-query" | "rerank") => Promise<boolean>;
}) {
  return {
    /** V2.10：cityAdcode 是卡片的城市，只检索这个城市的文章；别的城市查不到就转联网（D-062）。 */
    async ask(question: string, options: { signal: AbortSignal; cityAdcode?: string }): Promise<KnowledgeAnswer> {
      if (deps.reserve && !(await deps.reserve("embed-query"))) return { status: "failed", code: "daily_limit" };
      // 在发起相关模型请求前预留额度；重排是可降级步骤，不能因它没额度就把整次查询当成失败。
      const rerank = deps.reranker && (!deps.reserve || (await deps.reserve("rerank"))) ? deps.reranker : null;
      const settings = deps.settings ?? DEFAULT_RECALL;
      const result = await recall({
        store: deps.store,
        embedder: deps.embedder,
        reranker: rerank,
        settings: rerank ? settings : { ...settings, mode: settings.mode === "hybrid-rerank" ? "hybrid" : settings.mode },
        ...(options.cityAdcode ? { city: options.cityAdcode } : {}),
      }, question, { signal: options.signal });
      if (result.status === "failed") return { status: "failed", code: "unavailable" };
      if (result.status === "not_found") return { status: "not_found" };
      // 只输出回答和引用所需的自有文本与段落身份，内部打分、向量和诊断轨迹留在检索层。
      return {
        status: "found",
        passages: result.passages.map((passage) => ({
          chunkId: passage.id,
          documentId: passage.documentId,
          title: passage.title,
          headingPath: passage.headingPath,
          text: passage.body,
        })),
      };
    },
  };
}
