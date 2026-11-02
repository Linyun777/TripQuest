import type { EvaluationReport } from "./runner";
const jsonBlock = (value: unknown) => `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
export function renderMarkdown(report: EvaluationReport): string {
  const lines = ["# S4.1 离线固定流程基线评估", "", `运行：${report.runId}；开始：${report.startedAt}`, "", `数据集：${report.datasetVersion}；SHA-256：${report.datasetHash}`, "", `Git：${report.git.sha}；dirty：${report.git.dirty}；工具预算：每例每策略 ${report.toolBudget} 次。`, "", "全部地点、路线和预约为人工虚构。模型调用、token、模型费用、真实 API 调用均为 0；耗时只反映本地离线运行。候选率不是正确率，受限策略无解不等于所有排程无解。", "", "## 汇总", "", "|策略|符合预期/总数|候选/总数|需信息|无候选|无效/过期/不支持|工具调用/失败/超额|不可行候选/无依据事实修改|", "|---|---|---|---|---|---|---|---|"];
  for (const s of report.summary) lines.push(`|${s.plannerId}|${s.passed}/${s.total}|${s.candidates}/${s.total}|${s.statuses.needs_information}|${s.statuses.no_feasible_candidate}|${s.statuses.invalid_input}/${s.statuses.request_not_current}/${s.statuses.unsupported_scenario}|${s.toolCalls}/${s.toolFailures}/${s.budgetRejections}|${s.selectedNonFeasible}/${s.unsupportedFactChanges}|`);
  lines.push("", "## 逐例结论", "", "|案例|策略|初始 → 最终|选择|工具请求|通过|", "|---|---|---|---|---|---|");
  for (const r of report.rows) lines.push(`|${r.caseId} ${r.title}|${r.plannerId}|${r.initialStatus} → ${r.finalStatus}|${r.selectedStrategy ?? "—"}|${r.trace.length}|${r.score.passed ? "是" : "否"}|`);
  lines.push("", "## 逐例证据", "", "校验次数包含策略内实际检查及候选独立复验，不包含仅供展示的初始状态探针。JSON 保存每次规则输入与结果，便于复核。", "");
  for (const r of report.rows) {
    lines.push(`### ${r.caseId} · ${r.plannerId}`, "", `手算依据：${r.expected.reasoning}`, "", `预期：${r.expected.status} / ${r.expected.strategy ?? "—"}；实际：${r.finalStatus} / ${r.selectedStrategy ?? "—"}。`, "", `初始问题：${r.initialIssueCodes.join(", ") || "无"}；最终问题：${r.issueCodes.join(", ") || "无"}。工具请求/失败/超额：${r.toolRequests}/${r.toolFailures}/${r.budgetRejections}；规则调用 ${r.planningCalls.length}；校验 ${r.validationCount}；耗时 ${r.elapsedMs.toFixed(3)} ms。`, "", `评分：${r.score.passed ? "通过" : r.score.failures.join("；")}；异常：${r.exception ?? "无"}。`, "", "活动差异：", jsonBlock(r.activityDiff), "实际领域交通：", jsonBlock({ travelLegs: r.travelLegs, evidence: r.legEvidence }), "工具轨迹（ok 时显式选唯一 walking 路线，分钟 = ceil(durationSeconds / 60)；未改动的边来自初始输入）：", jsonBlock(r.trace), "独立复验与到达证明：", jsonBlock(r.score.revalidation));
  }
  return lines.join("\n") + "\n";
}
