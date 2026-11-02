import type { JourneyDatabaseClient } from "@tripquest/db";

import type { ArticleSource } from "./corpus";
import { tsQuery } from "./keywords";

export interface StoredChunk {
  readonly id: string;
  readonly documentId: string;
  readonly seq: number;
  readonly title: string;
  readonly headingPath: string;
  readonly body: string;
}

export interface NewDocument {
  readonly id: string;
  readonly title: string;
  readonly topic: string;
  /** V2.10：文章所属城市。 */
  readonly city: string;
  readonly sources: readonly ArticleSource[];
  readonly contentHash: string;
  readonly chunks: readonly {
    readonly seq: number;
    readonly headingPath: string;
    readonly body: string;
    readonly embedding: readonly number[];
    readonly keywords: string;
  }[];
}

export const chunkId = (documentId: string, seq: number) => `${documentId}:${seq}`;
type Pool = JourneyDatabaseClient["pool"];

const vectorLiteral = (vector: readonly number[]) => `[${vector.join(",")}]`;

/** 知识表沿用共享 PostgreSQL 连接池，使用 SQL 调用 pgvector 与全文检索能力。 */
export class KnowledgeStore {
  constructor(readonly pool: Pool) {}

  async hashes(): Promise<Map<string, { hash: string; city: string }>> {
    const rows = await this.pool.query<{ id: string; content_hash: string; city_adcode: string }>(
      "SELECT id, content_hash, city_adcode FROM knowledge_documents",
    );
    return new Map(rows.rows.map((row) => [row.id, { hash: row.content_hash, city: row.city_adcode }]));
  }

  /** V2.10：只改文章的城市时不必重新向量化。 */
  async setCity(id: string, city: string): Promise<void> {
    await this.pool.query("UPDATE knowledge_documents SET city_adcode = $2 WHERE id = $1", [id, city]);
  }

  /** 单篇文档和全部段落在同一事务原子替换，避免新旧向量与正文交错。 */
  async replaceDocument(document: NewDocument, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 外键级联清理旧段落；删除和插入在同一事务，读者不会看到只有文档却没有段落的中间状态。
      await client.query("DELETE FROM knowledge_documents WHERE id = $1", [document.id]);
      await client.query(
        "INSERT INTO knowledge_documents (id, title, topic, city_adcode, sources, content_hash, ingested_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [document.id, document.title, document.topic, document.city, JSON.stringify(document.sources), document.contentHash, now],
      );
      for (const chunk of document.chunks) {
        await client.query(
          "INSERT INTO knowledge_chunks (id, document_id, seq, heading_path, body, embedding, keywords) VALUES ($1, $2, $3, $4, $5, $6::vector, $7)",
          [chunkId(document.id, chunk.seq), document.id, chunk.seq, chunk.headingPath, chunk.body, vectorLiteral(chunk.embedding), chunk.keywords],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** 删除不再属于当前语料集或已退回草稿的文章，关联段落随外键级联删除。 */
  async removeExcept(ids: readonly string[]): Promise<string[]> {
    const rows = await this.pool.query<{ id: string }>(
      "DELETE FROM knowledge_documents WHERE NOT (id = ANY($1::text[])) RETURNING id",
      [ids],
    );
    return rows.rows.map((row) => row.id).sort();
  }

  /**
   * 用余弦距离查最近段落，查询形式兼容 HNSW 索引；相似度为 1 − 距离。
   * V2.10：给了城市就只查这个城市的文章（在成都问“这座寺”，不能检索到灵隐寺那一段）。
   */
  async nearest(embedding: readonly number[], limit: number, city?: string): Promise<{ id: string; similarity: number }[]> {
    const rows = await this.pool.query<{ id: string; similarity: number }>(
      city
        ? `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS similarity
             FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
            WHERE d.city_adcode = $3
            ORDER BY c.embedding <=> $1::vector LIMIT $2`
        : "SELECT id, 1 - (embedding <=> $1::vector) AS similarity FROM knowledge_chunks ORDER BY embedding <=> $1::vector LIMIT $2",
      city ? [vectorLiteral(embedding), limit, city] : [vectorLiteral(embedding), limit],
    );
    return rows.rows.map((row) => ({ id: row.id, similarity: Number(row.similarity) }));
  }

  /** 命中任意关键词后按 ts_rank 排序，并用长度归一化参数 1 减轻长段落优势。 */
  async keyword(terms: readonly string[], limit: number, city?: string): Promise<{ id: string; rank: number }[]> {
    const query = tsQuery(terms);
    if (!query) return [];
    const rows = await this.pool.query<{ id: string; rank: number }>(
      `SELECT c.id, ts_rank(c.keyword_vector, to_tsquery('simple', $1), 1) AS rank
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.keyword_vector @@ to_tsquery('simple', $1) AND ($3::text IS NULL OR d.city_adcode = $3)
        ORDER BY rank DESC, c.id
        LIMIT $2`,
      [query, limit, city ?? null],
    );
    return rows.rows.map((row) => ({ id: row.id, rank: Number(row.rank) }));
  }

  // SQL 的 ANY 不保证按传入 ID 排序；返回 Map，由召回层按融合或重排后的 ID 顺序还原段落。
  async chunks(ids: readonly string[]): Promise<Map<string, StoredChunk>> {
    if (ids.length === 0) return new Map();
    const rows = await this.pool.query<{ id: string; document_id: string; seq: number; title: string; heading_path: string; body: string }>(
      `SELECT c.id, c.document_id, c.seq, d.title, c.heading_path, c.body
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::text[])`,
      [ids],
    );
    return new Map(rows.rows.map((row) => [row.id, {
      id: row.id,
      documentId: row.document_id,
      seq: row.seq,
      title: row.title,
      headingPath: row.heading_path,
      body: row.body,
    }]));
  }

  /** 点击引用时读取对应段落及所属文章的来源列表，引用定位到段落而非整篇标题。 */
  async passage(id: string): Promise<(StoredChunk & { sources: ArticleSource[] }) | null> {
    const rows = await this.pool.query<{ id: string; document_id: string; seq: number; title: string; heading_path: string; body: string; sources: ArticleSource[] }>(
      `SELECT c.id, c.document_id, c.seq, d.title, c.heading_path, c.body, d.sources
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.id = $1`,
      [id],
    );
    const row = rows.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      documentId: row.document_id,
      seq: row.seq,
      title: row.title,
      headingPath: row.heading_path,
      body: row.body,
      sources: row.sources,
    };
  }

  async counts(): Promise<{ documents: number; chunks: number }> {
    const rows = await this.pool.query<{ documents: string; chunks: string }>(
      "SELECT (SELECT count(*) FROM knowledge_documents) AS documents, (SELECT count(*) FROM knowledge_chunks) AS chunks",
    );
    return { documents: Number(rows.rows[0].documents), chunks: Number(rows.rows[0].chunks) };
  }
}
