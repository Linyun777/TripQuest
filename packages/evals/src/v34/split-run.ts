import type { DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import type { Policy } from "../v21/run";
import { runLodgingCase, type LodgingRow } from "../v33/lodging-run";
import type { SplitOutingCase } from "./split-dataset";

/**
 * V3.4 搜索兜底题（stages/V3.4.md §4.1）：照住处题跑（规则分配、产品逐天生成），判分沿用住处题，另加“排到了
 * 那个地点”（`reach`）。§4.2 的标准按这一条算：3 次里至少 2 次排到。
 */
export interface SplitOutingRow extends Omit<LodgingRow, "suite"> {
  readonly suite: "splitOuting";
  readonly reached: boolean;
}

export async function runSplitOutingCase(
  item: SplitOutingCase,
  policy: Policy,
  models?: { readonly day: () => DayPlanningDecisionModel },
): Promise<SplitOutingRow> {
  const row = await runLodgingCase(item, policy, models);
  const reached = row.days.some((day) => day.stops.includes(item.reach));
  const checks = [...row.checks, { name: "reaches_place", passed: reached }];
  return { ...row, suite: "splitOuting", reached, checks, passed: checks.every((check) => check.passed) };
}

/** 报告里的一节：每题排到没有、没过的检查、每晚住处。 */
export function renderSplitOutings(rows: readonly SplitOutingRow[] | undefined): string[] {
  const live = (rows ?? []).filter((row) => row.policy === "live");
  const shown = live.length ? live : rows ?? [];
  if (!shown.length) return [];
  return [
    `## V3.4 搜索兜底（${live.length ? "真实模型" : "脚本模型"}）`,
    "",
    `排到 ${shown.filter((row) => row.reached).length}/${shown.length}；整题通过 ${shown.filter((row) => row.passed).length}/${shown.length}。`,
    "",
    "| 用例 | 排到 | 通过 | 没过的检查 | 每天的站 | 每晚住处 | 一日规划的搜索:kind |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...shown.map((row) =>
      `| ${row.caseId}${row.heldOut ? "（留出）" : ""} | ${row.reached ? "✓" : "✗"} | ${row.passed ? "✓" : "✗"} | ` +
      `${row.checks.filter((item) => !item.passed).map((item) => item.name).join("、") || "—"} | ` +
      `${row.days.map((day) => `${day.day}:${day.outcome === "draft" ? day.stops.join("→") || "空" : day.outcome}`).join("；")} | ` +
      `${row.nights.map((night) => night ?? "—").join("、") || "—"} | ${(row.daySearches ?? []).map((item) => `${item.query}:${item.kind ?? "—"}`).join("、") || "—"} |`),
    "",
  ];
}
