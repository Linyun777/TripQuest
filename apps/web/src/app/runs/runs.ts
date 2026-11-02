import "server-only";
import { AgentRun, currentRun, runIn, type RunBudget, type RunLinks, type RunResult, type RunSink } from "@tripquest/agent/runs";
import { TRIGGER_BUDGETS } from "@tripquest/agent/agents";
import { getSharedJourneyDatabase, PgAgentRunStore } from "@tripquest/db";

/**
 * V3.0 网页入口的根运行（stages/V3.0.md §3.3）：一次请求一棵树，结束时写进这个用户的 agent_runs。
 * 已经在某个运行里（一个入口调用了另一个入口）就沿用它，不另起一棵树。
 */
export interface RootOptions {
  readonly trigger: string;
  /** 没有用户（注入了仓库的单元测试）就只在内存里记，不写库。 */
  readonly userId: string | null;
  readonly links?: RunLinks;
  readonly attributes?: Record<string, unknown>;
  /** 不写用这个入口的缺省预算（TRIGGER_BUDGETS）。 */
  readonly budget?: RunBudget;
}

/** 不是 Agent 的入口：只在发了请求时才留记录（打开页面不必每次都记一棵空树）。 */
const SUPPORT_TRIGGERS = new Set(["page_view", "edit_card", "switch_mode", "locate", "save", "progress", "other"]);

function databaseSink(userId: string | null): RunSink | null {
  // 没配数据库或没有用户（部分单元测试）就不写。
  if (!process.env.DATABASE_URL || !userId) return null;
  return { write: (runs, steps) => new PgAgentRunStore(getSharedJourneyDatabase().pool, userId).write(runs, steps) };
}

export function rootRun(options: RootOptions): AgentRun {
  return AgentRun.root({
    trigger: options.trigger,
    userId: options.userId,
    ...(options.links ? { links: options.links } : {}),
    ...(options.attributes ? { attributes: options.attributes } : {}),
    budget: options.budget ?? TRIGGER_BUDGETS[options.trigger] ?? {},
    sink: databaseSink(options.userId),
    skipEmpty: SUPPORT_TRIGGERS.has(options.trigger),
  });
}

const finished = (): RunResult => ({ status: "ok" });

export function traced<T>(
  options: RootOptions,
  operation: (run: AgentRun) => Promise<T>,
  classify: (value: T) => RunResult = finished,
): Promise<T> {
  const existing = currentRun();
  if (existing) return operation(existing);
  return runIn(rootRun(options), operation, classify);
}

/**
 * 计量请求时用的运行：没有当前运行（漏接的入口）就补一个只含这一次请求的 other 根运行，保证每条用量都能
 * 对到运行；开发时提示是哪个用途漏了。
 */
export async function runForUsage<T>(userId: string, purpose: string, operation: (run: AgentRun) => Promise<T>): Promise<T> {
  const run = currentRun();
  if (run) return operation(run);
  if (process.env.NODE_ENV === "development") console.warn(`[runs] request outside a run: ${purpose}`);
  return runIn(rootRun({ trigger: "other", userId, attributes: { purpose } }), operation, finished);
}
