import type { EmbeddingProvider, RerankProvider } from "@tripquest/providers";

import type { ChunkStrategy } from "./chunk";
import type { Article } from "./corpus";
import { ingest, type IngestReport } from "./ingest";
import { RECALL_CASES, RECALL_DATASET_VERSION, type RecallCase } from "./recall-dataset";
import { DEFAULT_RECALL, recallWithVector, type RecallMode } from "./retrieve";
import type { KnowledgeStore, StoredChunk } from "./store";

const squash = (text: string) => text.replace(/\s+/g, "");

/** 按预先标注的文章 ID 和答案片段判定命中，避免让生成模型自行评自己是否找对。 */
export function answers(passage: Pick<StoredChunk, "documentId" | "body">, expect: NonNullable<RecallCase["expect"]>): boolean {
  return passage.documentId === expect.document && squash(passage.body).includes(squash(expect.snippet));
}

export interface ThresholdChoice {
  readonly threshold: number;
  /** 有答案题被拒为未命中的次数。 */
  readonly falseRejects: number;
  /** 无答案题被误判成命中的次数。 */
  readonly falseAccepts: number;
}

/**
 * 在相邻最高分之间选择总误判最少的阈值；并列时优先减少误接收。
 * 从无关段落作答比转去搜索更糟，候选切点取分数间隙的中点以避免贴住已有样本。
 */
export function chooseThreshold(answerable: readonly number[], unanswerable: readonly number[]): ThresholdChoice {
  const scores = [...new Set([...answerable, ...unanswerable])].sort((a, b) => a - b);
  const cuts = [scores[0] - 0.001, ...scores.slice(1).map((score, index) => (score + scores[index]) / 2), scores.at(-1)! + 0.001];
  let best: ThresholdChoice | null = null;
  for (const threshold of cuts) {
    const choice = {
      threshold: Math.round(threshold * 1000) / 1000,
      falseRejects: answerable.filter((score) => score < threshold).length,
      falseAccepts: unanswerable.filter((score) => score >= threshold).length,
    };
    if (
      !best
      || choice.falseRejects + choice.falseAccepts < best.falseRejects + best.falseAccepts
      || (choice.falseRejects + choice.falseAccepts === best.falseRejects + best.falseAccepts && choice.falseAccepts < best.falseAccepts)
    ) best = choice;
  }
  return best!;
}

export interface RecallConfig {
  readonly name: string;
  readonly mode: RecallMode;
  readonly instruct: boolean;
  readonly reranker: string | null;
}

export interface RecallCaseRow {
  readonly id: string;
  readonly answerable: boolean;
  readonly heldOut: boolean;
  /** 首个包含标注答案的段落名次，从 1 开始；前八名均未命中则记 null。 */
  readonly rank: number | null;
  readonly best: number;
  readonly top: readonly string[];
}

/** Hit@5 记录有答案题的前五命中数，MRR 记录平均倒数排名；误收、误拒按给定阈值另算。 */
export interface RecallScore {
  readonly hitAt5: number;
  readonly mrr: number;
  readonly answerable: number;
  readonly falseRejects: number | null;
  readonly falseAccepts: number | null;
}

export interface RecallConfigReport {
  readonly strategy: ChunkStrategy;
  readonly config: RecallConfig;
  readonly hitAt5: number;
  readonly mrr: number;
  readonly answerable: number;
  /** 只用非留出题选择阈值。 */
  readonly threshold: ThresholdChoice | null;
  /** 留出题使用已经选好的阈值独立评分，不再参与调参。 */
  readonly heldOut: RecallScore | null;
  readonly rows: readonly RecallCaseRow[];
}

export function scoreRows(rows: readonly RecallCaseRow[], threshold: number | null): RecallScore {
  const answerable = rows.filter((row) => row.answerable);
  return {
    hitAt5: answerable.filter((row) => row.rank !== null && row.rank <= 5).length,
    mrr: answerable.length
      ? Math.round((answerable.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / answerable.length) * 1000) / 1000
      : 0,
    answerable: answerable.length,
    falseRejects: threshold === null ? null : answerable.filter((row) => row.best < threshold).length,
    falseAccepts: threshold === null ? null : rows.filter((row) => !row.answerable && row.best >= threshold).length,
  };
}

export interface RecallEvalReport {
  readonly dataset: { readonly version: string; readonly cases: number; readonly answerable: number };
  readonly embeddingModel: string;
  readonly ingest: readonly IngestReport[];
  readonly results: readonly RecallConfigReport[];
  readonly requests: { readonly embed: number; readonly rerank: number };
}

export interface RecallEvalDeps {
  readonly store: KnowledgeStore;
  readonly articles: readonly Article[];
  /** 相同向量模型分别比较带查询指令和不带指令的效果。 */
  readonly embedders: { readonly plain: EmbeddingProvider; readonly instructed: EmbeddingProvider };
  readonly rerankers: readonly RerankProvider[];
  readonly strategies: readonly ChunkStrategy[];
  readonly log?: (line: string) => void;
}

async function embedQuestions(embedder: EmbeddingProvider, cases: readonly RecallCase[]): Promise<{ vectors: (readonly number[])[]; requests: number }> {
  const vectors: (readonly number[])[] = [];
  let requests = 0;
  for (let start = 0; start < cases.length; start += 20) {
    const result = await embedder.embed({ texts: cases.slice(start, start + 20).map((item) => item.question), kind: "query" });
    requests += 1;
    if (result.status !== "ok") throw new Error(result.failure.safeMessage);
    vectors.push(...result.data.vectors);
  }
  return { vectors, requests };
}

/** 只在测试数据库运行配置对照；每换一种切分策略重建语料，再复用问句向量比较召回方案。 */
export async function runRecallEval(deps: RecallEvalDeps, cases: readonly RecallCase[] = RECALL_CASES): Promise<RecallEvalReport> {
  const log = deps.log ?? (() => {});
  const plain = await embedQuestions(deps.embedders.plain, cases);
  const instructed = await embedQuestions(deps.embedders.instructed, cases);
  let embedRequests = plain.requests + instructed.requests;
  let rerankRequests = 0;
  const configs: RecallConfig[] = [
    { name: "只关键词", mode: "keyword", instruct: false, reranker: null },
    { name: "只向量", mode: "vector", instruct: false, reranker: null },
    { name: "只向量 + 指令", mode: "vector", instruct: true, reranker: null },
    { name: "混合 RRF", mode: "hybrid", instruct: false, reranker: null },
    { name: "混合 RRF + 指令", mode: "hybrid", instruct: true, reranker: null },
    ...deps.rerankers.flatMap((reranker) => [false, true].map((instruct) => ({
      name: `混合 + 重排 ${reranker.model}${instruct ? " + 指令" : ""}`,
      mode: "hybrid-rerank" as const,
      instruct,
      reranker: reranker.model,
    }))),
  ];
  const ingests: IngestReport[] = [];
  const results: RecallConfigReport[] = [];
  for (const strategy of deps.strategies) {
    const report = await ingest({ store: deps.store, embedder: deps.embedders.plain, articles: deps.articles, strategy, includeDrafts: true });
    ingests.push(report);
    embedRequests += report.requests;
    log(`${strategy}: ${report.chunks} chunks (${report.embedded.length} embedded)`);
    for (const config of configs) {
      const reranker = deps.rerankers.find((item) => item.model === config.reranker) ?? null;
      const settings = { ...DEFAULT_RECALL, mode: config.mode, answerTop: DEFAULT_RECALL.fusedTop };
      const rows: RecallCaseRow[] = [];
      for (const [index, item] of cases.entries()) {
        const vector = (config.instruct ? instructed : plain).vectors[index];
        const result = await recallWithVector({ store: deps.store, embedder: deps.embedders.plain, reranker, settings }, item.question, vector);
        if (result.status === "failed") throw new Error(result.safeMessage);
        // 评测某重排模型时不能接受生产兜底结果，否则会把服务失败后的余弦效果误记到该模型名下。
        if (reranker && result.best.kind !== "rerank") throw new Error(`${item.id}: rerank failed`);
        rerankRequests += result.requests.rerank;
        const at = item.expect ? result.passages.findIndex((passage) => answers(passage, item.expect!)) : -1;
        rows.push({
          id: item.id,
          answerable: item.expect !== null,
          heldOut: !!item.heldOut,
          rank: at >= 0 ? at + 1 : null,
          best: Math.round(result.best.score * 10000) / 10000,
          top: result.passages.slice(0, 3).map((passage) => passage.id),
        });
      }
      // 留出题只用于最后评分，不能参与选拒答阈值；否则报告会把针对这批题调过的结果当成泛化。
      // 命中率 / MRR 衡量找得准不准，误接收 / 误拒绝衡量该不该回答，两类指标分别展示。
      const tuning = rows.filter((row) => !row.heldOut);
      const held = rows.filter((row) => row.heldOut);
      const threshold = config.mode !== "keyword"
        ? chooseThreshold(tuning.filter((row) => row.answerable).map((row) => row.best), tuning.filter((row) => !row.answerable).map((row) => row.best))
        : null;
      const tuned = scoreRows(tuning, null);
      results.push({
        strategy,
        config,
        hitAt5: tuned.hitAt5,
        mrr: tuned.mrr,
        answerable: tuned.answerable,
        threshold,
        heldOut: held.length ? scoreRows(held, threshold?.threshold ?? null) : null,
        rows,
      });
      const last = results.at(-1)!;
      log(`  ${config.name}: hit@5 ${last.hitAt5}/${last.answerable}, MRR ${last.mrr}${last.heldOut ? `; held out hit@5 ${last.heldOut.hitAt5}/${last.heldOut.answerable}, MRR ${last.heldOut.mrr}` : ""}`);
    }
  }
  return {
    dataset: { version: RECALL_DATASET_VERSION, cases: cases.length, answerable: cases.filter((item) => item.expect).length },
    embeddingModel: deps.embedders.plain.model,
    ingest: ingests,
    results,
    requests: { embed: embedRequests, rerank: rerankRequests },
  };
}

export function renderRecallReport(report: RecallEvalReport, runId: string): string {
  const lines = [
    `# V2.8 召回评测 ${runId}`,
    "",
    `- 题集 ${report.dataset.version}：${report.dataset.cases} 题（有答案 ${report.dataset.answerable}，无答案 ${report.dataset.cases - report.dataset.answerable}）；阈值只用非留出题选，留出题用选定的阈值另算`,
    `- 嵌入模型 ${report.embeddingModel}；请求：嵌入 ${report.requests.embed} 次，重排 ${report.requests.rerank} 次`,
    ...report.ingest.map((item) => `- ${item.strategy} 切分：${item.chunks} 块，入库 tokens ${item.tokens}`),
    "",
    "| 切分 | 方案 | 命中@5 | MRR | 阈值 | 误拒 | 误收 | 留出命中@5 | 留出 MRR | 留出误拒 | 留出误收 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.results.map((item) => {
      const threshold = item.threshold;
      const held = item.heldOut;
      return [
        item.strategy,
        item.config.name,
        `${item.hitAt5}/${item.answerable}`,
        item.mrr,
        threshold ? threshold.threshold : "—",
        threshold ? threshold.falseRejects : "—",
        threshold ? threshold.falseAccepts : "—",
        held ? `${held.hitAt5}/${held.answerable}` : "—",
        held ? held.mrr : "—",
        held?.falseRejects ?? "—",
        held?.falseAccepts ?? "—",
      ].join(" | ").replace(/^/, "| ").concat(" |");
    }),
    "",
    "## 逐题（排名 / 最高分）",
    "",
  ];
  for (const item of report.results) {
    lines.push(`### ${item.strategy} · ${item.config.name}`, "");
    lines.push(item.rows.map((row) => `${row.id}${row.heldOut ? "*" : ""} ${row.answerable ? (row.rank ?? "×") : "—"} / ${row.best}`).join(" · "), "");
  }
  return `${lines.join("\n")}\n`;
}
