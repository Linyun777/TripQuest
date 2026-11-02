import { DashScopeEmbeddingProvider, DashScopeRerankProvider } from "@tripquest/providers/server";

/** 知识库模型配置（D-064）；重排模型和查询指令是否启用由召回评测选择。 */
export const EMBEDDING_MODEL = "qwen3.7-text-embedding-flash";
export const EMBEDDING_DIMENSIONS = 1024;
export const RERANK_MODELS = ["qwen3-rerank", "qwen3.7-text-rerank"] as const;
export type RerankModel = (typeof RERANK_MODELS)[number];
/** 2026-10-19 召回评测选择不附加查询指令的向量方案。 */
export const PRODUCT_RERANK_MODEL: RerankModel = "qwen3.7-text-rerank";
export const QUERY_INSTRUCTION = "Given a question about Hangzhou's history and culture, retrieve the passage that answers it";

const key = (environment: NodeJS.ProcessEnv = process.env) => {
  const value = environment.DASHSCOPE_API_KEY?.trim();
  if (!value) throw new Error("DASHSCOPE_API_KEY is not set");
  return value;
};
const now = () => new Date().toISOString();

export function liveEmbedder(options: { instruct?: string; environment?: NodeJS.ProcessEnv } = {}): DashScopeEmbeddingProvider {
  return new DashScopeEmbeddingProvider({
    key: key(options.environment),
    fetch: globalThis.fetch,
    now,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    instruct: options.instruct,
  });
}

export function liveReranker(model: RerankModel, environment?: NodeJS.ProcessEnv): DashScopeRerankProvider {
  return new DashScopeRerankProvider({ key: key(environment), fetch: globalThis.fetch, now, model });
}
