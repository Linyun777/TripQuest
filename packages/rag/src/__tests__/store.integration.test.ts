import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
  type JourneyDatabaseClient,
} from "@tripquest/db";
import type { EmbeddingProvider, RerankProvider } from "@tripquest/providers";
import { parseArticle } from "../corpus";
import { ingest } from "../ingest";
import { bigrams } from "../keywords";
import { recall, type RecallSettings } from "../retrieve";
import { KnowledgeStore } from "../store";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Bag of character pairs hashed into 1024 dimensions: similar wording, similar vector. */
function fakeEmbedder(): EmbeddingProvider & { calls: number } {
  const embedder = {
    model: "fake-bigram",
    dimensions: 1024,
    calls: 0,
    async embed(request: { texts: readonly string[] }) {
      embedder.calls += 1;
      const vectors = request.texts.map((text) => {
        const vector = new Array<number>(1024).fill(0);
        for (const term of bigrams(text)) {
          let hash = 0;
          for (const char of term) hash = (hash * 31 + char.codePointAt(0)!) % 1024;
          vector[hash] += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
      });
      return { status: "ok" as const, data: { vectors, tokens: 1 }, evidence: { provider: "fake", sourceKind: "fixture" as const, retrievedAt: "2026-10-19T00:00:00Z", attribution: "test" } };
    },
  };
  return embedder;
}

const article = (id: string, status: "draft" | "reviewed", body: string, city = "330100") => parseArticle(
  `---\nid: ${id}\ntitle: ${id} 标题\ntopic: 测试\ncity: ${city}\nstatus: ${status}\nsources:\n  - https://example.invalid/${id} | 2026-10-19 | 样例\n---\n\n${body}\n`,
  `${id}.md`,
);

const causeway = article("causeway", "reviewed", "## 苏堤\n\n苏堤是北宋苏轼疏浚西湖时修筑的长堤。\n\n## 白堤\n\n白堤是后人为纪念白居易而命名的湖堤。");
const tea = article("tea", "reviewed", "## 品种\n\n西湖龙井的法定品种有群体种、龙井43和龙井长叶。");
const draft = article("draft-only", "draft", "## 草稿\n\n未审核的内容。");

describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.8 knowledge store on PostgreSQL", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let store: KnowledgeStore;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v28-test", maxConnections: 3 });
    await migrateJourneyDatabase(client.database, { migrationsFolder: fileURLToPath(new URL("../../../db/drizzle", import.meta.url)) });
    store = new KnowledgeStore(client.pool);
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM knowledge_documents");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM knowledge_documents");
    await client?.close();
  });

  it("ingests reviewed articles only, skips unchanged ones, and removes what left the corpus", async () => {
    const embedder = fakeEmbedder();
    const first = await ingest({ store, embedder, articles: [causeway, tea, draft], strategy: "heading", includeDrafts: false });
    expect(first).toMatchObject({ embedded: ["causeway", "tea"], skippedDrafts: ["draft-only"], chunks: 3, requests: 2 });
    expect(await store.counts()).toEqual({ documents: 2, chunks: 3 });

    const again = await ingest({ store, embedder, articles: [causeway, tea], strategy: "heading", includeDrafts: false });
    expect(again).toMatchObject({ embedded: [], unchanged: ["causeway", "tea"], requests: 0 });

    const edited = article("tea", "reviewed", "## 品种\n\n龙井43比群体种早采七到十天。");
    const third = await ingest({ store, embedder, articles: [edited], strategy: "heading", includeDrafts: false });
    expect(third).toMatchObject({ embedded: ["tea"], removed: ["causeway"] });
    expect((await store.chunks(["tea:0"])).get("tea:0")?.body).toBe("龙井43比群体种早采七到十天。");
  });

  it("recalls the right passage by both keyword and vector, and decides 'not found' on the absolute score", async () => {
    const embedder = fakeEmbedder();
    await ingest({ store, embedder, articles: [causeway, tea], strategy: "heading", includeDrafts: false });
    const settings: RecallSettings = { mode: "hybrid", vectorTop: 20, keywordTop: 20, fusedTop: 8, answerTop: 2, thresholds: { rerank: 0.5, cosine: 0.2 } };
    const hit = await recall({ store, embedder, reranker: null, settings }, "苏堤是谁修的");
    expect(hit.status).toBe("found");
    if (hit.status === "failed") throw new Error("recall failed");
    expect(hit.passages[0]).toMatchObject({ id: "causeway:0", headingPath: "causeway 标题 > 苏堤", title: "causeway 标题" });
    expect(hit.trace.keyword[0]?.id).toBe("causeway:0");
    expect(hit.trace.vector[0]?.id).toBe("causeway:0");

    const miss = await recall({ store, embedder, reranker: null, settings }, "雷峰塔为什么会倒");
    expect(miss.status).toBe("not_found");

    // The reranker reorders the candidates and its score, not the cosine, makes the decision.
    const reranker: RerankProvider = {
      model: "fake-rerank",
      async rerank(request) {
        const ranking = request.documents.map((text, index) => ({ index, score: text.includes("白居易") ? 0.9 : 0.1 }))
          .sort((a, b) => b.score - a.score);
        return { status: "ok", data: { ranking, tokens: 1 }, evidence: { provider: "fake", sourceKind: "fixture", retrievedAt: "2026-10-19T00:00:00Z", attribution: "test" } };
      },
    };
    const reranked = await recall({ store, embedder, reranker, settings: { ...settings, mode: "hybrid-rerank" } }, "白堤和苏堤");
    expect(reranked.status === "found" && reranked.passages[0].id).toBe("causeway:1");
    expect(reranked.status !== "failed" && reranked.best).toEqual({ kind: "rerank", score: 0.9 });
  });

  it("recalls only the card city's articles, and moving an article to another city needs no new vectors (V2.10)", async () => {
    const embedder = fakeEmbedder();
    await ingest({ store, embedder, articles: [causeway, tea], strategy: "heading", includeDrafts: false });
    const settings: RecallSettings = { mode: "hybrid", vectorTop: 20, keywordTop: 20, fusedTop: 8, answerTop: 2, thresholds: { rerank: 0.5, cosine: 0.2 } };
    const ask = (city: string) => recall({ store, embedder, reranker: null, settings, city }, "苏堤是谁修的");
    expect((await ask("330100")).status).toBe("found");
    const elsewhere = await ask("510100");
    expect(elsewhere.status).toBe("not_found");
    expect(elsewhere.status !== "failed" && [...elsewhere.trace.keyword, ...elsewhere.trace.vector]).toEqual([]);

    const moved = await ingest({ store, embedder, articles: [article("causeway", "reviewed", causeway.body, "510100"), tea], strategy: "heading", includeDrafts: false });
    expect(moved).toMatchObject({ embedded: [], unchanged: ["causeway", "tea"], requests: 0 });
    expect((await ask("510100")).status).toBe("found");
  });
});
