import type { LodgingRow } from "./lodging-run";

const median = (values: readonly number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** 报告里的一节：这一次运行的通过数和每题的明细；和基线的对比由回归脚本做。 */
export function renderLodging(rows: readonly LodgingRow[] | undefined): string[] {
  const live = (rows ?? []).filter((row) => row.policy === "live");
  const shown = live.length ? live : rows ?? [];
  if (!shown.length) return [];
  return [
    `## V3.3 住处（${live.length ? "真实模型" : "脚本模型"}）`,
    "",
    `通过 ${shown.filter((row) => row.passed).length}/${shown.length}；每趟地图请求中位 ${median(shown.map((row) => row.mapRequests))}、` +
      `耗时中位 ${median(shown.map((row) => row.elapsedMs))} ms。`,
    "",
    "| 用例 | 通过 | 没过的检查 | 每晚住处 | 候选 | 车程（实际 / 应有） | 地图 | 耗时 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...shown.map((row) =>
      `| ${row.caseId}${row.heldOut ? "（留出）" : ""} | ${row.passed ? "✓" : "✗"} | ${row.checks.filter((item) => !item.passed).map((item) => item.name).join("、") || "—"} | ` +
      `${row.nights.map((night) => night ?? "—").join("、") || "—"} | ${row.candidates.map((item) => item.place).join("、") || "—"} | ` +
      `${row.estimates.map((item) => `${item.minutes}/${item.expected}`).join("、") || "—"} | ${row.mapRequests} | ${row.elapsedMs} |`),
    "",
  ];
}
