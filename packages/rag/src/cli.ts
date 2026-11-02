import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createJourneyDatabase, migrateJourneyDatabase, requireSafeTestDatabaseUrl } from "@tripquest/db";

import { chunkArticle, type ChunkStrategy } from "./chunk";
import { loadCorpus } from "./corpus";
import { ingest } from "./ingest";
import { liveEmbedder, liveReranker, PRODUCT_RERANK_MODEL, QUERY_INSTRUCTION, RERANK_MODELS, type RerankModel } from "./live";
import { renderRecallReport, runRecallEval } from "./recall-eval";
import { DEFAULT_RECALL, recall, type RecallMode } from "./retrieve";
import { KnowledgeStore } from "./store";

/**
 * V2.8 commands, each step observable on its own (§1):
 *   chunks [--strategy heading|fixed] [--id <article>]   show how articles are cut
 *   ingest [--test] [--include-drafts] [--strategy …]    embed and store (dev DB, or the *_test DB)
 *   search <question> [--test] [--mode …]                every recall stage for one question
 *   recall-eval                                          the §4.1 comparison, on the *_test DB only
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const root = join(packageRoot, "..", "..");
const corpusDir = join(packageRoot, "corpus");
const migrations = join(root, "packages", "db", "drizzle");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    strategy: { type: "string", default: "heading" },
    id: { type: "string" },
    test: { type: "boolean", default: false },
    "include-drafts": { type: "boolean", default: false },
    mode: { type: "string", default: DEFAULT_RECALL.mode },
    reranker: { type: "string", default: PRODUCT_RERANK_MODEL },
    instruct: { type: "boolean", default: false },
  },
});
const [command, ...rest] = positionals;
const strategy = values.strategy as ChunkStrategy;
if (strategy !== "heading" && strategy !== "fixed") throw new Error("--strategy is heading or fixed");

function databaseUrl(test: boolean): string {
  if (test) return requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

async function withStore<T>(test: boolean, run: (store: KnowledgeStore) => Promise<T>): Promise<T> {
  const client = createJourneyDatabase(databaseUrl(test), { applicationName: "tripquest-rag", maxConnections: 2, statementTimeoutMillis: 30_000, queryTimeoutMillis: 40_000 });
  try {
    if (test) await migrateJourneyDatabase(client.database, { migrationsFolder: migrations });
    return await run(new KnowledgeStore(client.pool));
  } finally {
    await client.close();
  }
}

async function main() {
  if (command === "chunks") {
    const articles = (await loadCorpus(corpusDir)).filter((article) => !values.id || article.id === values.id);
    for (const article of articles) {
      const chunks = chunkArticle(article, strategy);
      console.log(`\n## ${article.id}（${article.status}，${chunks.length} 块）`);
      for (const chunk of chunks) console.log(`[${chunk.seq}] ${chunk.headingPath}（${[...chunk.body].length} 字）\n${chunk.body}\n`);
    }
    return;
  }
  if (command === "ingest") {
    const articles = await loadCorpus(corpusDir);
    if (values["include-drafts"] && !values.test) throw new Error("drafts go only into the *_test database (--test)");
    const report = await withStore(values.test, (store) => ingest({ store, embedder: liveEmbedder(), articles, strategy, includeDrafts: values["include-drafts"] }));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "search") {
    const question = rest.join(" ").trim();
    if (!question) throw new Error("search needs a question");
    const mode = values.mode as RecallMode;
    const reranker = mode === "hybrid-rerank" ? liveReranker(values.reranker as RerankModel) : null;
    const embedder = liveEmbedder(values.instruct ? { instruct: QUERY_INSTRUCTION } : {});
    const result = await withStore(values.test, (store) => recall({ store, embedder, reranker, settings: { ...DEFAULT_RECALL, mode } }, question));
    if (result.status === "failed") throw new Error(result.safeMessage);
    console.log(`问题：${question}\n结论：${result.status === "found" ? "资料库有" : "资料库没有"}（${result.best.kind} ${result.best.score.toFixed(4)}）`);
    console.log("\n关键词前 5：", result.trace.keyword.slice(0, 5).map((item) => `${item.id} ${item.rank.toFixed(3)}`).join(" · ") || "无");
    console.log("向量前 5：", result.trace.vector.slice(0, 5).map((item) => `${item.id} ${item.similarity.toFixed(3)}`).join(" · ") || "无");
    console.log("融合前 8：", result.trace.fused.slice(0, 8).map((item) => item.id).join(" · "));
    if (result.trace.reranked) console.log("重排：", result.trace.reranked.map((item) => `${item.id} ${item.score.toFixed(3)}`).join(" · "));
    for (const passage of result.passages) console.log(`\n[${passage.id}] ${passage.headingPath}\n${passage.body}`);
    return;
  }
  if (command === "recall-eval") {
    const articles = await loadCorpus(corpusDir);
    const report = await withStore(true, (store) => runRecallEval({
      store,
      articles,
      embedders: { plain: liveEmbedder(), instructed: liveEmbedder({ instruct: QUERY_INSTRUCTION }) },
      rerankers: RERANK_MODELS.map((model) => liveReranker(model)),
      strategies: ["heading", "fixed"],
      log: console.log,
    }));
    const runId = `v28-recall-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const folder = join(root, "eval-results", runId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(folder, "report.md"), renderRecallReport(report, runId));
    console.log(`\n报告：eval-results/${runId}/report.md`);
    return;
  }
  throw new Error("commands: chunks | ingest | search <question> | recall-eval");
}

await main();
