import type { V2Report } from "./runner";
const block = (value: unknown) => `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
export function renderV2(report: V2Report): string {
  const lines = [
    "# S4.2 有界工具决策对照",
    "",
    `运行 ${report.runId} · ${report.startedAt}`,
    "",
    `数据 ${report.datasetVersion} · SHA-256 ${report.datasetHash}`,
    `Git ${report.git.sha} · dirty ${report.git.dirty}`,
    "",
    "全部路线为虚构工具。scripted 只证明工程；live 是真实模型 + 虚构路线。费用 unknown 不等于免费，少量公开案例不证明模型优势。",
    `提前中止：${report.stoppedEarly}；未执行运行：${report.skippedRuns}。`,
    "",
    "## 四条对照",
    "",
    "|策略|通过/总数|质量|安全|执行正常|候选|路线|模型 API|",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const s of report.summary) {
    lines.push(`|${s.plannerId}|${s.passed}/${s.total}|${s.quality}|${s.safety}|${s.execution}|${s.candidates}|${s.toolCalls}|${s.modelApiCalls}|`);
  }
  lines.push("", "## 逐例证据", "");
  for (const row of report.rows) {
    lines.push(
      `### ${row.caseId} · ${row.plannerId}`,
      "",
      `${row.title}；模式 ${row.modelMode}；provider/model ${row.provider ?? "—"}/${row.model ?? "—"}`,
      "",
      `人工参考：${row.expected.reasoning}`,
      "",
      `业务 ${row.output?.result.status ?? "exception"}；执行 ${row.output?.executionStatus ?? "exception"}；` +
        `错误 ${row.output?.error ?? row.exception ?? "无"}。`,
      `耗时 ${row.elapsedMs.toFixed(3)} ms；${row.cost.note}。`,
      "",
      "评分与独立复验：", block(row.score),
      "模型决策（不保存私有推理）：", block(row.output?.decisions),
      "工具轨迹（明确方向，成功路线秒数向上取整为分钟）：", block(row.trace),
      "最终程序结果与事实：", block({
        result: row.output?.result,
        travelLegs: row.output?.travelLegs,
        planningCalls: row.output?.planningCalls,
        modelRequests: row.output?.modelRequests,
        rejectedActions: row.output?.rejectedActions,
      }),
      "成本：", block(row.cost),
    );
  }
  return lines.join("\n") + "\n";
}
