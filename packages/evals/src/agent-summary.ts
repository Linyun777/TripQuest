import { AgentRun, MemoryRunSink, runIn } from "@tripquest/agent/runs";

/**
 * V3.0 评测报告按 Agent 汇总（stages/V3.0.md §3.6）：每题在一个 eval 根运行里跑，记录器用内存版；跑完按 Agent
 * 数运行、模型请求、tokens、耗时和兜底。模型请求和 tokens 只算这个 Agent 自己发的（不含它调用的下级 Agent）。
 */
export interface AgentRow {
  readonly suite: string;
  readonly caseId: string;
  /** 不在任何 Agent 里发的模型请求记在 (none)。 */
  readonly agent: string;
  readonly runs: number;
  readonly failed: number;
  readonly fallbacks: number;
  readonly modelRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
}

const rows: AgentRow[] = [];

export function agentRows(): readonly AgentRow[] {
  return rows;
}

/** V4.0：审查-修复 Agent 每一步做了什么（动作、检查结果、试排前后的数字），查它为什么这样做用。 */
export interface RepairTrace {
  readonly suite: string;
  readonly caseId: string;
  readonly steps: readonly { readonly kind: string; readonly name: string; readonly summary: Readonly<Record<string, unknown>> }[];
}
const traces: RepairTrace[] = [];

export function repairTraces(): readonly RepairTrace[] {
  return traces;
}

export async function evalCase<T>(suite: string, caseId: string, operation: () => Promise<T>): Promise<T> {
  const sink = new MemoryRunSink();
  const root = AgentRun.root({ trigger: "eval", sink, attributes: { suite, caseId } });
  try {
    return await runIn(root, operation, () => ({ status: "ok" }));
  } finally {
    const byAgent = new Map<string, { runs: number; failed: number; fallbacks: number; model: number; input: number; output: number; ms: number }>();
    const agentOf = new Map(sink.runs.map((run) => [run.id, run.parentId === null ? "(none)" : run.agent]));
    const entry = (agent: string) => {
      const found = byAgent.get(agent) ?? { runs: 0, failed: 0, fallbacks: 0, model: 0, input: 0, output: 0, ms: 0 };
      byAgent.set(agent, found);
      return found;
    };
    for (const run of sink.runs) {
      if (run.parentId === null) continue;
      const item = entry(run.agent);
      item.runs += 1;
      if (run.status === "failed" || run.status === "budget_exhausted") item.failed += 1;
      if (run.status === "fallback") item.fallbacks += 1;
      item.ms += (run.finishedAt?.getTime() ?? run.startedAt.getTime()) - run.startedAt.getTime();
    }
    for (const step of sink.steps) {
      if (step.kind !== "model_call") continue;
      const item = entry(agentOf.get(step.runId) ?? "(none)");
      item.model += 1;
      item.input += Number(step.summary.inputTokens ?? 0);
      item.output += Number(step.summary.outputTokens ?? 0);
    }
    const repairRuns = new Set(sink.runs.filter((run) => run.agent === "outing-repair").map((run) => run.id));
    if (repairRuns.size) {
      traces.push({
        suite,
        caseId,
        steps: sink.steps.filter((step) => repairRuns.has(step.runId)).map((step) => ({ kind: step.kind, name: step.name, summary: step.summary })),
      });
    }
    for (const [agent, item] of byAgent) {
      rows.push({
        suite, caseId, agent, runs: item.runs, failed: item.failed, fallbacks: item.fallbacks,
        modelRequests: item.model, inputTokens: item.input, outputTokens: item.output, ms: item.ms,
      });
    }
  }
}

/** 报告里的一节：每个 Agent 的合计，加每题的明细。 */
export function renderAgentRows(agents: readonly AgentRow[] | undefined): string[] {
  if (!agents?.length) return [];
  const totals = new Map<string, { runs: number; failed: number; fallbacks: number; model: number; tokens: number; ms: number; cases: Set<string> }>();
  for (const row of agents) {
    const item = totals.get(row.agent) ?? { runs: 0, failed: 0, fallbacks: 0, model: 0, tokens: 0, ms: 0, cases: new Set<string>() };
    item.runs += row.runs;
    item.failed += row.failed;
    item.fallbacks += row.fallbacks;
    item.model += row.modelRequests;
    item.tokens += row.inputTokens + row.outputTokens;
    item.ms += row.ms;
    item.cases.add(`${row.suite}:${row.caseId}`);
    totals.set(row.agent, item);
  }
  return [
    "## 按 Agent 汇总（V3.0 运行记录）",
    "",
    "模型请求和 tokens 只算这个 Agent 自己发的；耗时是它各次运行的合计（含它调用的下级）。",
    "",
    "| Agent | 题数 | 运行 | 失败 | 兜底 | 模型请求 | tokens | 耗时 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...[...totals].map(([agent, item]) =>
      `| ${agent} | ${item.cases.size} | ${item.runs} | ${item.failed} | ${item.fallbacks} | ${item.model} | ${item.tokens} | ${(item.ms / 1000).toFixed(1)} s |`),
    "",
  ];
}
