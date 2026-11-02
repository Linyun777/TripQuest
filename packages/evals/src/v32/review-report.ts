import type { ReviewRow } from "./review-run";

const median = (values: readonly number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** 报告里的一节：这一次运行（审查开或关）的合计和每题的明细；开关两边的对比由回归脚本做。 */
export function renderReview(rows: readonly ReviewRow[] | undefined): string[] {
  const live = (rows ?? []).filter((row) => row.policy === "live");
  if (!live.length) return [];
  const sum = (pick: (row: ReviewRow) => number) => live.reduce((total, row) => total + pick(row), 0);
  const noChange = live.filter((row) => row.falsePositive);
  const wanted = live.filter((row) => row.suggestionHit !== null);
  return [
    `## V3.2 审查（审查${live[0]!.review === "on" ? "开" : "关"}，真实模型）`,
    "",
    `空闲合计 ${sum((row) => row.idleMinutes)} 分钟；没排上 ${sum((row) => row.unplaced.length)} 个；太满 ${sum((row) => row.overloadedDays)} 天；` +
      `雨天户外 ${sum((row) => row.wetOutdoor)} 站；违例 ${sum((row) => row.violations.length)}；误报 ${noChange.length} 次；` +
      `建议命中 ${wanted.filter((row) => row.suggestionHit).length}/${wanted.length}；每趟耗时中位 ${median(live.map((row) => row.elapsedMs))} ms。`,
    "",
    "| 用例 | 空闲（分） | 没排上 | 太满 | 雨天户外 | 违例 | 直接改 | 建议 | 模型 | 地图 | 耗时 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...live.map((row) =>
      `| ${row.caseId}${row.heldOut ? "（留出）" : ""} | ${row.idleMinutes} | ${row.unplaced.join("、") || "—"} | ${row.overloadedDays} | ${row.wetOutdoor} | ` +
      `${row.violations.join("、") || "—"} | ${row.applied.join("、") || "—"} | ${row.suggestions.join("、") || "—"} | ${row.modelRequests} | ${row.mapRequests} | ${row.elapsedMs} |`),
    "",
  ];
}
