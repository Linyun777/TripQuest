import { Annotation, END, GraphRecursionError, START, StateGraph } from "@langchain/langgraph";
import {
  REPLAN_LIMITS,
  keyIssues,
  replanResultSchema,
  type DayReplanProblem,
  type DayReplanRunner,
  type ReplanResult,
} from "@tripquest/application/day-replan";
import type { ReplanCounts } from "@tripquest/application/day-state";
import { z } from "zod";
import { DecisionModelError } from "./contracts";
import { DayRunError } from "./day-contracts";
import { dayOperation } from "./day-runtime";
import {
  replanActionSchema,
  type ReplanAction,
  type ReplanDecisionContext,
  type ReplanLimits,
  type ReplanRunnerDependencies,
} from "./replan-contracts";
import { serializeReplanContext } from "./replan-prompt";
import { ReplanToolExecutor, type ReplanToolSnapshot } from "./replan-tools";
import { assertLocalTracingOnly } from "./tracing";
import { inAgent } from "./agents/run-agent";

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  totalTokens: z.number().int().nonnegative().safe(),
  cacheHitTokens: z.number().int().nonnegative().nullable(),
  cacheMissTokens: z.number().int().nonnegative().nullable(),
}).nullable();
const replySchema = z.object({
  decision: z.unknown(),
  usage: usageSchema,
  returnedModel: z.string().max(160).optional(),
  fingerprint: z.string().max(160).optional(),
  requestId: z.string().max(160).optional(),
}).strict();

export function replanLimits(overrides: Partial<ReplanLimits> = {}): ReplanLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !(key in REPLAN_LIMITS) || !Number.isSafeInteger(value) || value < 1 ||
      value > REPLAN_LIMITS[key as keyof ReplanLimits]
    ) {
      throw new TypeError("Replan limits may only tighten the production bounds");
    }
  }
  return { ...REPLAN_LIMITS, ...overrides };
}

/**
 * 演示行程的局部重规划图（真实行程的对话调整见 application/real-adjust）。
 * 先试保留原顺序的确定性基线，再允许模型探索；两者共用事实与校验，便于比较是否值得改。
 */
export function createReplanRunner(dependencies: ReplanRunnerDependencies): DayReplanRunner {
  const limits = replanLimits(dependencies.limits);
  return {
    run: (problem, options) => inAgent(
      "replan",
      {},
      () => runReplan(problem, options, dependencies, limits),
      (result) => result.status === "completed"
        ? result.outcome === "candidate" ? { status: "ok" } : { status: "none", outcome: result.outcome }
        : result.status === "failed" ? { status: "failed", outcome: result.code } : { status: "cancelled" },
    ),
  };
}

/** 运行状态只保存 JSON 数据；恢复时重新注入工具依赖，并重建计数与事实缓存。 */
interface ReplanRunState {
  readonly tools?: ReplanToolSnapshot;
  readonly counts: ReplanCounts;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  readonly pending?: unknown;
  readonly action?: ReplanAction;
  readonly feedback: ReplanDecisionContext["feedback"];
  readonly result?: ReplanResult;
  readonly startedAtMs: number;
}

async function runReplan(
  problem: DayReplanProblem,
  options: Parameters<DayReplanRunner["run"]>[1],
  dependencies: ReplanRunnerDependencies,
  limits: ReplanLimits,
): Promise<ReplanResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(cancel, limits.runMs);
  let run: ReplanRunState = {
    counts: { model: 0, searches: 0, baseline: 0, tries: 0, routes: 0, semanticRepairs: 0 },
    usage: null,
    feedback: null,
    startedAtMs: Date.now(),
  };
  const counts: ReplanCounts = { ...run.counts };
  const toolOptions = { signal: controller.signal, onProgress: options.onProgress, counts };
  let tools = new ReplanToolExecutor(problem, dependencies, limits, toolOptions);
  // 图节点恢复的必须是整轮状态，不能只恢复待执行动作，却丢失基线结果、已查路线或已耗预算。
  const load = (state: ReplanRunState) => {
    run = state;
    Object.assign(counts, state.counts);
    tools = new ReplanToolExecutor(problem, dependencies, limits, toolOptions, state.tools);
  };
  const save = (changes: Partial<ReplanRunState>): { run: ReplanRunState } => {
    run = { ...run, ...changes, counts: { ...counts }, tools: tools.snapshot() };
    return { run };
  };
  const base = () => ({
    runId: problem.runId,
    counts: { ...counts },
    elapsedMs: Math.max(0, Date.now() - run.startedAtMs),
    usage: run.usage,
  });
  const active = () => {
    if (controller.signal.aborted) throw new DayRunError("timeout");
  };
  const progress = (phase: "preparing" | "baseline" | "deciding" | "observing") => {
    active();
    options.onProgress({ phase, counts: { ...counts } });
  };
  const addUsage = (reported: z.infer<typeof usageSchema>) => {
    if (!reported) return run.usage;
    const usage = run.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      inputTokens: usage.inputTokens + reported.inputTokens,
      outputTokens: usage.outputTokens + reported.outputTokens,
      totalTokens: usage.totalTokens + reported.totalTokens,
    };
  };
  const step = (body: () => Promise<Partial<ReplanRunState>> | Partial<ReplanRunState>) =>
    async (state: { run: ReplanRunState }) => {
      load(state.run);
      return save(await body());
    };
  const Runtime = Annotation.Root({ run: Annotation<ReplanRunState>() });
  const builder = new StateGraph(Runtime)
    .addNode("prepare", step(() => {
      assertLocalTracingOnly();
      progress("preparing");
      return {};
    }))
    .addNode("baseline", step(async () => {
      // 确定性基线先试保留原未处理顺序；与模型候选共用相同事实、缓存、排程和校验。
      progress("baseline");
      counts.baseline = 1;
      await tools.attempt("baseline", problem.adjustable);
      return {};
    }))
    .addNode("decide", step(async () => {
      active();
      if (counts.model >= limits.model) throw new DayRunError("budget_exhausted");
      const context = tools.context(run.feedback);
      serializeReplanContext(context, limits.contextBytes);
      counts.model += 1;
      progress("deciding");
      let raw: unknown;
      try {
        raw = await dayOperation({
          signal: controller.signal,
          timeoutMs: limits.modelMs,
          operation: (signal) => dependencies.model.decide(context, { signal }),
        });
      } catch (error) {
        if (error instanceof DecisionModelError && error.metadata?.usage) {
          const reported = usageSchema.safeParse(error.metadata.usage);
          if (reported.success) run = { ...run, usage: addUsage(reported.data) };
        }
        throw error;
      }
      active();
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) throw new DayRunError("invalid_output");
      return { usage: addUsage(parsed.data.usage), pending: parsed.data.decision };
    }))
    // 结构错误直接失败；语义错误只在有限修复预算内回到决策，且不执行对应工具。
    .addNode("guard", step(() => {
      active();
      const parsed = replanActionSchema.safeParse(run.pending);
      if (!parsed.success) throw new DayRunError("invalid_output");
      const invalid = tools.guard(parsed.data);
      if (invalid) {
        if (counts.semanticRepairs >= limits.semanticRepairs) throw new DayRunError("semantic_invalid");
        counts.semanticRepairs += 1;
        return { pending: undefined, action: undefined, feedback: { code: invalid } };
      }
      return { pending: undefined, action: parsed.data, feedback: null };
    }))
    .addNode("execute", step(async () => {
      active();
      const action = run.action;
      if (!action) throw new DayRunError("internal_error");
      let result: ReplanResult | undefined;
      switch (action.action) {
        case "search_places":
          await tools.search(action);
          break;
        case "try_replan":
          if (counts.tries >= limits.tries) throw new DayRunError("budget_exhausted");
          counts.tries += 1;
          await tools.attempt(`attempt-${counts.tries}`, action.orderedActivityIds);
          break;
        case "finish": {
          // 一次成功试算也可能与当前计划相同；这种情况只解释结果，不制造没有业务变化的新版本。
          const built = tools.finish(action.attemptId);
          // 单列最终采用基线还是模型组合，便于解释 Agent 是否实际改变了方案，而非只统计它调用了几次。
          const chosen = action.attemptId === "baseline" ? "baseline" as const : "agent" as const;
          result = built.unchanged
            ? {
                ...base(), status: "completed", outcome: "unchanged",
                explanation: "按当前事实检查后，接下来的安排与当前版本相同，无需保存新版本。",
              }
            : {
                ...base(), status: "completed", outcome: "candidate",
                candidate: built.candidate,
                comparison: built.comparison,
                selection: built.selection,
                candidateFingerprint: built.fingerprint,
                chosen,
                explanation: explain(counts, chosen),
              };
          break;
        }
        // 有限次尝试未找到候选只说明本轮没有找到；保存报告与旧计划仍保持，不宣称全局无解。
        case "stop": {
          const baseline = tools.baselineEvaluation();
          result = {
            ...base(), status: "completed", outcome: "bounded_no_candidate",
            reason: action.reason,
            issues: keyIssues(tools.lastIssues(), tools.places, tools.activities),
            baselineIssues: baseline?.status === "not_scheduled"
              ? keyIssues(baseline.issues, tools.places, tools.activities) : [],
            explanation: `保留当前顺序和本轮 ${counts.tries} 次调整试算都未得到可行安排；` +
              "这只说明有限尝试未找到方案，不代表全局无解。已保存的报告保持不变。",
          };
          break;
        }
      }
      active();
      return { action: undefined, ...(result ? { result: replanResultSchema.parse(result) } : {}) };
    }))
    .addNode("observe", step(() => {
      progress("observing");
      return {};
    }))
    .addEdge(START, "prepare")
    .addEdge("prepare", "baseline")
    .addEdge("baseline", "decide")
    .addEdge("decide", "guard")
    // guard 清空非法动作后回 decide；执行到 result 才结束，普通搜索/试排只补充观察。
    .addConditionalEdges("guard", (state) => state.run.action ? "execute" : "decide")
    .addConditionalEdges("execute", (state) => state.run.result ? END : "observe")
    .addEdge("observe", "decide");
  const thread = dependencies.thread;
  const graph = builder.compile(thread ? { checkpointer: thread.checkpointer } : {});
  let result: ReplanResult | undefined;
  try {
    const config = {
      recursionLimit: limits.recursion,
      callbacks: [],
      signal: controller.signal,
      // 每步同步写检查点后再推进；未落盘的中断节点可能重做，不能由此宣称工具调用恰好一次。
      ...(thread ? { configurable: { thread_id: thread.threadId }, durability: "sync" as const } : {}),
    };
    // 已有检查点用 null 输入续接，避免把同一任务重新初始化。
    const resume = thread ? await thread.checkpointer.getTuple({ configurable: { thread_id: thread.threadId } }) : undefined;
    const final = await graph.invoke(resume ? null : { run }, config) as { run: ReplanRunState };
    load(final.run);
    active();
    result = replanResultSchema.parse(final.run.result);
  } catch (error) {
    result = options.signal.aborted
      ? { ...base(), status: "cancelled" }
      : {
          ...base(), status: "failed",
          code: controller.signal.aborted ? "timeout"
            : error instanceof DayRunError ? error.code
            : error instanceof GraphRecursionError ? "engine_limit"
            : error instanceof DecisionModelError
              ? error.code === "invalid_output" ? "invalid_output"
                : error.code === "timeout" ? "timeout" : "model_error"
            : "internal_error",
        };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
  return replanResultSchema.parse(result ?? { ...base(), status: "failed", code: "internal_error" });
}

function explain(counts: ReplanCounts, chosen: "baseline" | "agent"): string {
  return `本轮先按当前顺序试排，再进行了 ${counts.searches} 次地点调查、${counts.tries} 次调整试算；` +
    (chosen === "baseline" ? "最终沿用当前顺序。" : "最终采用调整后的组合。") +
    "必去与固定事项保持，时间由程序按路线、停留与缓冲排定并独立检查。";
}
