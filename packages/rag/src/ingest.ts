import { createHash } from "node:crypto";

import type { EmbeddingProvider } from "@tripquest/providers";
import { EMBED_BATCH_LIMIT } from "@tripquest/providers/server";

import { CHUNKER_VERSION, chunkArticle, chunkText, type ChunkStrategy } from "./chunk";
import type { Article } from "./corpus";
import { bigrams } from "./keywords";
import type { KnowledgeStore } from "./store";

export interface IngestReport {
  readonly strategy: ChunkStrategy;
  readonly model: string;
  readonly dimensions: number;
  readonly embedded: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  readonly skippedDrafts: readonly string[];
  readonly chunks: number;
  readonly requests: number;
  readonly tokens: number;
}

/** 正文、来源、分块规则、模型与维数一起决定内容哈希；任一变化都需要重建段落向量。 */
export function contentHash(article: Article, strategy: ChunkStrategy, model: string, dimensions: number): string {
  return createHash("sha256")
    .update(JSON.stringify([CHUNKER_VERSION, strategy, model, dimensions, article.title, article.topic, article.sources, article.body]))
    .digest("hex");
}

export interface IngestOptions {
  readonly store: KnowledgeStore;
  readonly embedder: EmbeddingProvider;
  readonly articles: readonly Article[];
  readonly strategy: ChunkStrategy;
  /** 产品入库只接受已审阅文章；测试库评测可显式包含草稿，不能隐式混入正式知识库。 */
  readonly includeDrafts: boolean;
  readonly now?: () => Date;
}

/** 按文章幂等更新：内容未变跳过向量化，已改变则整篇替换，最后删除已移出当前语料集的文章。 */
export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const { store, embedder } = options;
  const chosen = options.articles.filter((article) => options.includeDrafts || article.status === "reviewed");
  const skippedDrafts = options.articles.filter((article) => !chosen.includes(article)).map((article) => article.id);
  const stored = await store.hashes();
  const embedded: string[] = [];
  const unchanged: string[] = [];
  let requests = 0;
  let tokens = 0;
  let chunkCount = 0;
  for (const article of chosen) {
    const hash = contentHash(article, options.strategy, embedder.model, embedder.dimensions);
    const chunks = chunkArticle(article, options.strategy);
    chunkCount += chunks.length;
    const prior = stored.get(article.id);
    if (prior?.hash === hash) {
      // V2.10：城市不参与内容哈希（改城市不必重新向量化），变了就只更新这一列。
      if (prior.city !== article.city) await store.setCity(article.id, article.city);
      unchanged.push(article.id);
      continue;
    }
    // 先在事务外完成这一篇的所有向量请求，避免数据库连接长时间等待外部服务。
    // 全部成功后才原子替换该文档；某一批失败时旧文档仍可用，重跑会再次比较内容哈希。
    const vectors: (readonly number[])[] = [];
    for (let start = 0; start < chunks.length; start += EMBED_BATCH_LIMIT) {
      const batch = chunks.slice(start, start + EMBED_BATCH_LIMIT);
      const result = await embedder.embed({ texts: batch.map(chunkText), kind: "document" });
      requests += 1;
      if (result.status !== "ok") throw new Error(`${article.id}: ${result.failure.safeMessage}`);
      tokens += result.data.tokens;
      vectors.push(...result.data.vectors);
    }
    await store.replaceDocument({
      id: article.id,
      title: article.title,
      topic: article.topic,
      city: article.city,
      sources: article.sources,
      contentHash: hash,
      chunks: chunks.map((chunk, index) => ({
        seq: chunk.seq,
        headingPath: chunk.headingPath,
        body: chunk.body,
        embedding: vectors[index],
        keywords: bigrams(chunkText(chunk)).join(" "),
      })),
    }, options.now?.() ?? new Date());
    embedded.push(article.id);
  }
  // 清理放在全部选中文章成功之后；向量服务中途失败时，不提前删掉仍在提供检索的旧内容。
  const removed = await store.removeExcept(chosen.map((article) => article.id));
  return {
    strategy: options.strategy,
    model: embedder.model,
    dimensions: embedder.dimensions,
    embedded,
    unchanged,
    removed,
    skippedDrafts,
    chunks: chunkCount,
    requests,
    tokens,
  };
}
