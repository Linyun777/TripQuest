import { AGENTS, type AgentId } from "./registry";
import { currentRun, runIn, type AgentRun, type RunResult } from "../runs";

export interface AgentEntry<T> {
  /** 上游交过来的内容：按这个 Agent 契约的 input 校验，记一步 handoff（只记是否合格和出错的字段路径）。 */
  readonly input?: unknown;
  /** 交接不合格时这个 Agent 返回什么（各 Agent 自己的失败结果）；不合格的内容不往下传。 */
  readonly rejected?: () => T;
  readonly attributes?: Record<string, unknown>;
}

/**
 * V3.0 各 Agent 的入口（stages/V3.0.md §3.3、§3.5）：在当前运行下建这个 Agent 的子运行，核对调用方、
 * 校验交接内容，再执行；结束时按 classify 记状态。没有当前运行时直接执行，和原来一样。
 */
export function inAgent<T>(
  agent: AgentId,
  entry: AgentEntry<T>,
  operation: (run: AgentRun | null) => Promise<T>,
  classify: (value: T) => RunResult,
): Promise<T> {
  const parent = currentRun();
  if (!parent) return operation(null);
  const contract = AGENTS[agent];
  const run = parent.child(agent, { version: contract.version, ...(entry.attributes ? { attributes: entry.attributes } : {}) });
  run.allow(contract.tools);
  if (parent.trigger !== "eval" && !contract.callers.includes(parent.agent)) {
    run.step("check", "caller", { allowed: false, caller: parent.agent });
  }
  if ("input" in entry) {
    const name = `${parent.agent}→${agent}`;
    if (!contract.input) {
      run.step("handoff", name, { checked: false });
    } else {
      const parsed = contract.input.safeParse(entry.input);
      const issues = parsed.success ? [] : parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".").slice(0, 80));
      run.step("handoff", name, { checked: true, valid: parsed.success, ...(issues.length ? { issues } : {}) });
      if (!parsed.success && entry.rejected) {
        const rejected = entry.rejected;
        return runIn(run, async () => rejected(), () => ({ status: "failed", outcome: "invalid_handoff" }));
      }
    }
  }
  return runIn(run, operation, classify);
}
