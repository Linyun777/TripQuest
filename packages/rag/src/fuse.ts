/** RRF 论文（Cormack 等，2009）常用的平滑常数，用于降低第一名与后续名次之间的差距。 */
export const RRF_K = 60;

/**
 * 倒数排名融合：同一段落在每个列表贡献 1 / (k + 名次)，名次从 1 开始。
 * 只合并排名而不直接相加不同量纲的分数；融合得分不代表内容一定相关。
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
