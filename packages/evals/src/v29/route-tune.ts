import { decide, INTENT_FLAGS, type IntentFlag, type IntentInput } from "@tripquest/agent/intent";
import { INTENT_EXEMPLARS, routeText, voteNeighbours, type EmbeddingRouterSettings } from "@tripquest/agent/intent-embedding";
import type { EmbeddingProvider } from "@tripquest/providers";

/**
 * 向量路由的参数只在样例库内用留一法选（stages/V2.9.md §3.2）：每条样例用其余样例投票，
 * 和它自己的标注比。分流题集的留出题不在样例库里，也不参与。
 */
export interface TuneRow {
  readonly settings: EmbeddingRouterSettings;
  /** 只看向量投票（分数 ≥ 0.5 为真、不补任何东西）时完全正确的条数。 */
  readonly voteExact: number;
  /** 有把握（最高相似度够、没有判断落在中间区间）的条数，及其中完全正确的条数。 */
  readonly confident: number;
  readonly confidentExact: number;
  readonly planningMissed: number;
}

export async function tuneEmbeddingRouter(embedder: EmbeddingProvider): Promise<{ rows: TuneRow[]; exemplars: number; requests: number }> {
  const exemplars = INTENT_EXEMPLARS;
  const vectors: (readonly number[])[] = [];
  let requests = 0;
  for (let start = 0; start < exemplars.length; start += 20) {
    const batch = exemplars.slice(start, start + 20);
    const result = await embedder.embed({ texts: batch.map((item) => routeText(item.text, item.previous)), kind: "document" });
    requests += 1;
    if (result.status !== "ok") throw new Error(result.failure.code);
    vectors.push(...result.data.vectors);
  }
  // 查询要按 query 类型再嵌一次（入库用 document、查询用 query，与线上一致）。
  const queries: (readonly number[])[] = [];
  for (let start = 0; start < exemplars.length; start += 20) {
    const batch = exemplars.slice(start, start + 20);
    const result = await embedder.embed({ texts: batch.map((item) => routeText(item.text, item.previous)), kind: "query" });
    requests += 1;
    if (result.status !== "ok") throw new Error(result.failure.code);
    queries.push(...result.data.vectors);
  }
  const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const rows: TuneRow[] = [];
  for (const k of [3, 5, 7, 9]) {
    for (const minSimilarity of [0.4, 0.5, 0.6]) {
      for (const band of [{ low: 0.25, high: 0.75 }, { low: 0.35, high: 0.65 }, { low: 0.45, high: 0.55 }]) {
        let voteExact = 0;
        let confident = 0;
        let confidentExact = 0;
        let planningMissed = 0;
        exemplars.forEach((item, index) => {
          const input: IntentInput = { text: item.text, hasTrip: item.flags.includes("adjust"), cardEmpty: true };
          const similarities = exemplars.flatMap((other, at) => (at === index ? [] : [{ similarity: dot(queries[index], vectors[at]), flags: other.flags }]));
          const vote = voteNeighbours(similarities, k);
          const right = (flags: Readonly<Record<IntentFlag, boolean>>) => INTENT_FLAGS.every((flag) => flags[flag] === item.flags.includes(flag));
          const plain = decide(vote.scores, input, { low: 0.5, high: 0.5 });
          if (right(plain.flags)) voteExact += 1;
          if (item.flags.includes("planning") && !plain.flags.planning) planningMissed += 1;
          const banded = decide(vote.scores, input, band);
          if (vote.best >= minSimilarity && banded.fallback.length === 0) {
            confident += 1;
            if (right(banded.flags)) confidentExact += 1;
          }
        });
        rows.push({ settings: { k, minSimilarity, band }, voteExact, confident, confidentExact, planningMissed });
      }
    }
  }
  // 对照：原型分类。每个判断取正例样例的平均向量与反例的平均向量（都不含自己），离哪边近判哪边。
  const prototype = { exact: 0, planningMissed: 0 };
  exemplars.forEach((item, index) => {
    const input: IntentInput = { text: item.text, hasTrip: item.flags.includes("adjust"), cardEmpty: true };
    const scores = Object.fromEntries(INTENT_FLAGS.map((flag) => {
      const mean = (positive: boolean) => {
        const members = exemplars.flatMap((other, at) => (at !== index && other.flags.includes(flag) === positive ? [vectors[at]] : []));
        if (!members.length) return 0;
        return members.reduce((sum, vector) => sum + dot(queries[index], vector), 0) / members.length;
      };
      return [flag, mean(true) > mean(false) ? 1 : 0];
    })) as Record<IntentFlag, number>;
    const flags = decide(scores, input, { low: 0.5, high: 0.5 }).flags;
    if (INTENT_FLAGS.every((flag) => flags[flag] === item.flags.includes(flag))) prototype.exact += 1;
    if (item.flags.includes("planning") && !flags.planning) prototype.planningMissed += 1;
  });
  console.log(`prototype classifier (leave one out): exact ${prototype.exact}/${exemplars.length}, planning missed ${prototype.planningMissed}`);
  // 先比投票本身对多少（选 k），再比有把握部分的准确率，最后比覆盖（级联里少问 DeepSeek）。
  rows.sort((a, b) =>
    b.voteExact - a.voteExact ||
    b.confidentExact / Math.max(b.confident, 1) - a.confidentExact / Math.max(a.confident, 1) ||
    b.confident - a.confident);
  return { rows, exemplars: exemplars.length, requests };
}
