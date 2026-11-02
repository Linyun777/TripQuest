import { Annotation, END, GraphRecursionError, START, StateGraph } from "@langchain/langgraph";
import {
  dayPlanningResultSchema,
  explainDayOutcome,
  type DayCounts,
  type DayPlanningProblem,
  type DayPlanningResult,
  type DayPlanningRunner,
} from "@tripquest/application/day-planning";
import { z } from "zod";
import { createDayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { DecisionModelError } from "./contracts";
import {
  dayActionSchema,
  DayRunError,
  type DayAction,
  type DayDecisionContext,
  type DayRunnerDependencies,
} from "./day-contracts";
import { serializeDayContext } from "./day-prompt";
import { dayLimits, dayOperation } from "./day-runtime";
import { DayToolExecutor, type DayToolSnapshot } from "./day-tools";
import { assertLocalTracingOnly } from "./tracing";
import { inAgent } from "./agents/run-agent";
import { currentRun } from "./runs";

const replySchema = z.object({
  decision: z.unknown(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe(), cacheHitTokens: z.number().int().nonnegative().nullable(),
    cacheMissTokens: z.number().int().nonnegative().nullable(),
  }).nullable(),
  returnedModel: z.string().max(160).optional(), fingerprint: z.string().max(160).optional(), requestId: z.string().max(160).optional(),
}).strict();

/**
 * 一日规划的编排入口：模型决定搜什么、试什么顺序，工具层取得事实，领域层排时间并复核。
 * finish 只能引用通过校验的试算；图交付的是候选草稿，保存仍需单独确认。
 */
export function createDayPlanningRunner(dependencies: DayRunnerDependencies): DayPlanningRunner {
  const limits = dayLimits(dependencies.limits);
  // V3.0：入口建一日规划的子运行，交接内容是这一天的需求；不合格不排（stages/V3.0.md §3.5）。
  return {
    run: (problem, options) => inAgent(
      "day-planner",
      {
        input: problem.requirements,
        rejected: (): DayPlanningResult => ({
          runId: problem.runId, counts: { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 },
          elapsedMs: 0, usage: null, status: "failed", code: "internal_error",
        }),
        attributes: { date: problem.requirements.date },
      },
      async (run) => {
        const result = await runDay(problem, options, dependencies, limits);
        run?.step("check", "result", {
          ...result.counts,
          ...(result.status === "failed" && result.hints?.length ? { hints: result.hints } : {}),
          ...(result.status === "completed" && result.outcome === "no_plan" ? { issues: result.issues.map((issue) => issue.code).slice(0, 10) } : {}),
        });
        return result;
      },
      (result) => result.status === "completed"
        ? result.outcome === "draft" ? { status: "ok" } : { status: "none", outcome: result.reason }
        : result.status === "failed" ? { status: "failed", outcome: result.code } : { status: "cancelled" },
    ),
  };
}

/** 每次运行的可序列化状态；检查点只保存数据，模型客户端、信号和回调由新进程重新注入。 */
interface DayRunState {
  readonly tools?: DayToolSnapshot;
  readonly counts: DayCounts;
  readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  readonly pending?: unknown;
  readonly action?: DayAction;
  readonly feedback: DayDecisionContext["feedback"];
  readonly result?: DayPlanningResult;
  readonly startedAtMs: number;
  readonly hints?: readonly string[];
}

async function runDay(
  problem: DayPlanningProblem,
  options: Parameters<DayPlanningRunner["run"]>[1],
  dependencies: DayRunnerDependencies,
  limits: ReturnType<typeof dayLimits>,
): Promise<DayPlanningResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(cancel, limits.runMs);
  // 当前节点使用的工作副本；进入节点时从图状态恢复，完成节点后再保存回去。
  let run: DayRunState = {
    counts: { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 },
    usage: null,
    feedback: null,
    startedAtMs: Date.now(),
  };
  const counts: DayCounts = { ...run.counts };
  let tools = new DayToolExecutor(problem, dependencies, limits, {
    signal: controller.signal, onProgress: options.onProgress, counts, onRoutePath: options.onRoutePath,
  });
  // 工具里的 Map/Set 由 JSON 快照重建，计数对象则原地同步；执行器与回调共享同一份计数引用。
  const load = (state: DayRunState) => {
    run = state;
    Object.assign(counts, state.counts);
    tools = new DayToolExecutor(problem, dependencies, limits, {
      signal: controller.signal, onProgress: options.onProgress, counts, onRoutePath: options.onRoutePath,
    }, state.tools);
  };
  // 复制计数并导出工具快照，避免后续节点继续修改对象时反向污染已交给检查点的状态。
  const save = (changes: Partial<DayRunState>): { run: DayRunState } => {
    run = { ...run, ...changes, counts: { ...counts }, tools: tools.snapshot() };
    return { run };
  };
  const base = () => ({
    runId: problem.runId, counts: { ...counts },
    elapsedMs: Math.max(0, Date.now() - run.startedAtMs), usage: run.usage,
  });
  const active = () => {
    if (controller.signal.aborted) throw new DayRunError("timeout");
  };
  const progress = (phase: "preparing" | "deciding" | "observing") => {
    active();
    options.onProgress({ phase, counts: { ...counts } });
  };
  const addUsage = (reported: { inputTokens: number; outputTokens: number; totalTokens: number } | null) => {
    if (!reported) return run.usage;
    const usage = run.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      inputTokens: usage.inputTokens + reported.inputTokens,
      outputTokens: usage.outputTokens + reported.outputTokens,
      totalTokens: usage.totalTokens + reported.totalTokens,
    };
  };
  // 节点内的对象只是工作副本；每步结束都把计数、工具事实和待执行动作写回图状态。
  // 已完成节点的计数与事实一起恢复；中断在检查点落盘前的节点仍可能重做，外部调用并非恰好一次。
  const step = (body: () => Promise<Partial<DayRunState>> | Partial<DayRunState>) =>
    async (state: { run: DayRunState }) => {
      load(state.run);
      return save(await body());
    };
  const Runtime = Annotation.Root({ run: Annotation<DayRunState>() });
  const builder = new StateGraph(Runtime)
    .addNode("prepare", step(() => {
      assertLocalTracingOnly();
      progress("preparing");
      return {};
    }))
    // 决策节点只接收并解析模型信封，把业务动作暂存为 unknown；下一节点才授予执行资格。
    .addNode("decide", step(async () => {
      active();
      if (counts.model >= limits.model) throw new DayRunError("budget_exhausted");
      const context = tools.context(run.feedback);
      serializeDayContext(context, limits.contextBytes); // 超出上下文上限直接拒绝，不能截掉受保护的需求。
      // 在发出请求之前记一次尝试；模型超时、返回坏 JSON 也消耗预算，防止失败被当作免费重试。
      counts.model += 1;
      progress("deciding");
      let raw: unknown;
      try {
        raw = await dayOperation({
          signal: controller.signal, timeoutMs: limits.modelMs,
          operation: (signal) => dependencies.model.decide(context, { signal }),
        });
      } catch (error) {
        if (error instanceof DecisionModelError && error.metadata?.usage) {
          const reported = replySchema.shape.usage.safeParse(error.metadata.usage);
          if (reported.success) run = { ...run, usage: addUsage(reported.data) };
        }
        throw error;
      }
      active();
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) throw new DayRunError("invalid_output");
      return { usage: addUsage(parsed.data.usage), pending: parsed.data.decision };
    }))
    .addNode("guard", step(() => {
      active();
      const parsed = dayActionSchema.safeParse(run.pending);
      if (!parsed.success) throw new DayRunError("invalid_output");
      // 形状非法直接失败；形状合法但语义不成立才给有次数上限的反馈修复。
      // 例如遗漏必去、重复组合、引用未验证试算，都在实际调用工具前拒绝。
      const invalid = tools.guard(parsed.data);
      // 搜索额度用尽且活动池为空时，唯一有证据的终态就是“没有合适地点”。
      // 直接由代码选择合法停止动作；P05 曾因模型反复搜索而有 1/3 运行失败。
      const forced = { action: "stop", reason: "no_suitable_places" } as const;
      if (invalid?.startsWith("no_searches_left: stop") && !tools.guard(forced)) {
        run = { ...run, hints: [...(run.hints ?? []), `${parsed.data.action}:${invalid}`.slice(0, 80)].slice(-10) };
        currentRun()?.step("fallback", "stop", { code: "no_searches_left" });
        return { pending: undefined, action: forced, feedback: null, hints: run.hints };
      }
      if (invalid) {
        // 模型接收完整修正建议；诊断记录只保留最近的短提示码，控制体积并避免保存上下文正文。
        run = { ...run, hints: [...(run.hints ?? []), `${parsed.data.action}:${invalid}`.slice(0, 80)].slice(-10) };
        currentRun()?.step("repair", parsed.data.action, { hint: invalid.slice(0, 80) });
        if (counts.semanticRepairs >= limits.semanticRepairs) throw new DayRunError("semantic_invalid");
        counts.semanticRepairs += 1;
        return { pending: undefined, action: undefined, feedback: { code: invalid }, hints: run.hints };
      }
      return { pending: undefined, action: parsed.data, feedback: null };
    }))
    // execute 只处理 guard 放行的动作；搜索和试算回到观察循环，finish/stop 才设置最终结果。
    .addNode("execute", step(async () => {
      active();
      const action = run.action;
      if (!action) throw new DayRunError("internal_error");
      let result: DayPlanningResult | undefined;
      switch (action.action) {
        case "search_places": await tools.search(action); break;
        case "try_itinerary": await tools.tryItinerary(action); break;
        case "finish": {
          const draft = tools.finish(action.attemptId, action.reasons);
          result = {
            ...base(), status: "completed", outcome: "draft", draft,
            explanation: `本轮进行了 ${counts.searches} 次地点调查、${counts.tries} 次组合试算。保留全部必去与固定事项，按路线估计、停留和缓冲排程并独立校验。`,
          };
          break;
        }
        case "stop": {
          const issues = tools.attempts.at(-1)?.issues ?? [];
          result = {
            ...base(), status: "completed", outcome: "no_plan", reason: action.reason, issues: [...issues],
            explanation: explainDayOutcome(counts, issues),
          };
          break;
        }
      }
      active();
      return { action: undefined, ...(result ? { result: dayPlanningResultSchema.parse(result) } : {}) };
    }))
    .addNode("observe", step(() => {
      progress("observing");
      return {};
    }))
    .addEdge(START, "prepare")
    .addEdge("prepare", "decide")
    .addEdge("decide", "guard")
    // 校验失败回 decide 时携带 feedback；成功才执行。observe 只报告阶段，不再额外调用模型。
    .addConditionalEdges("guard", (state) => state.run.action ? "execute" : "decide")
    .addConditionalEdges("execute", (state) => state.run.result ? END : "observe")
    .addEdge("observe", "decide");
  /** 只把最终通过独立校验的草稿交给可选保存出口，工具中间结果不能直接成为保存凭据。 */
  const handoff = (final: DayPlanningResult) => {
    if (final.status !== "completed" || final.outcome !== "draft" || !options.onDraftReady) return;
    // 快照构造或消费者失败只撤掉保存入口，已经校验过的只读草稿仍可交付。
    try {
      options.onDraftReady(createDayDraftConfirmationSnapshot({
        problem, places: tools.places, activities: tools.activities,
        routes: tools.routeFacts(), draft: final.draft,
      }));
    } catch {
      // 页面根据缺少快照判断暂不可保存，不把可读草稿一起丢弃。
    }
    active();
  };
  const thread = dependencies.thread;
  const graph = builder.compile(thread ? { checkpointer: thread.checkpointer } : {});
  let result: DayPlanningResult | undefined;
  try {
    const config = {
      recursionLimit: limits.recursion,
      callbacks: [],
      signal: controller.signal,
      // sync 要求本步检查点写完后再进下一步，减少进程退出时丢失已完成决策的窗口。
      // 它不保证外部调用恰好一次：请求已发出、检查点未落盘时仍可能在恢复后重做。
      ...(thread ? { configurable: { thread_id: thread.threadId }, durability: "sync" as const } : {}),
    };
    // 存在持久检查点时用 null 输入续接；重新传初始状态会把恢复任务误当成新运行。
    const resume = thread ? await thread.checkpointer.getTuple({ configurable: { thread_id: thread.threadId } }) : undefined;
    const final = await graph.invoke(resume ? null : { run }, config) as { run: DayRunState };
    load(final.run);
    active();
    result = dayPlanningResultSchema.parse(final.run.result);
    handoff(result);
  } catch (error) {
    // 第一层降级：模型后续输出失败，但之前已有通过校验的试算时，可以交付该试算。
    // 限于模型输出、语义修复或预算类错误；主动取消和整体超时不能被降级伪装成成功。
    const recoverable = !options.signal.aborted && !controller.signal.aborted && (
      (error instanceof DayRunError && ["semantic_invalid", "budget_exhausted", "invalid_output"].includes(error.code)) ||
      error instanceof GraphRecursionError ||
      (error instanceof DecisionModelError && error.code === "invalid_output"));
    const latestVerified = () =>
      [...tools.attempts].reverse().find((attempt) => attempt.schedule && attempt.validation?.verdict !== "rejected");
    let verified = recoverable ? latestVerified() : undefined;
    // 没有可复用试算时，只有语义反复错误或预算耗尽才允许代码补试；格式坏掉不触发额外探索。
    const ruleBreaking = error instanceof DayRunError && ["semantic_invalid", "budget_exhausted"].includes(error.code);
    if (ruleBreaking && !verified) {
      // 第二层降级：只保留固定与必去站，按确定性顺序补试一次，避免模型为可选站反复纠结。
      // 不重复已经试过的顺序，也不放宽受保护事项；能否交付仍由排程和独立校验决定。
      // V2.11：没有必去时补试卡片上的“想去”地点（模型一次都没试就放弃，只有想去的一天也能排出来）。
      const protectedOrder = tools.firstOrder();
      const tried = tools.attempts.some((attempt) => JSON.stringify(attempt.order) === JSON.stringify(protectedOrder));
      if (protectedOrder.length > 0 && !tried && !tools.guard({ action: "try_itinerary", orderedActivityIds: protectedOrder })) {
        try {
          await tools.tryItinerary({ action: "try_itinerary", orderedActivityIds: protectedOrder }, true);
          verified = latestVerified();
        } catch {
          // 确定性补试也受路线和时间预算限制；失败时保留原故障，不无限追加兜底。
        }
      }
    }
    if (verified) {
      try {
        result = dayPlanningResultSchema.parse({
          ...base(), status: "completed", outcome: "draft", draft: tools.finish(verified.attemptId),
          explanation: "规划助手没能给出最终确认，已采用其中一个通过独立校验的方案。",
        });
        handoff(result);
        return result;
      } catch {
        // 旧试算若在 finish 复核时失效，继续返回原失败，不直接输出过期草稿。
      }
    }
    // 第三层归类：所有试算都因明确约束失败，且必去/固定的最小组合也试过，才可解释为排不开。
    // 只要还存在未知路线，就不能把信息不足说成确定无解；这里也不承诺穷举了全部组合。
    const protectedOrder = tools.protectedOrder();
    const aloneTried = !protectedOrder.length ||
      tools.attempts.some((attempt) => JSON.stringify(attempt.order) === JSON.stringify(protectedOrder));
    const definite = tools.attempts.length > 0 && tools.attempts.every((attempt) =>
      !attempt.schedule && attempt.issues.length > 0 && attempt.issues.every((issue) => issue.kind === "violation"));
    if (ruleBreaking && !verified && !options.signal.aborted && aloneTried && definite) {
      const issues = tools.attempts.at(-1)!.issues;
      result = dayPlanningResultSchema.parse({
        ...base(), status: "completed", outcome: "no_plan", reason: "constraints_not_met", issues: [...issues],
        explanation: explainDayOutcome(counts, issues),
      });
      handoff(result);
      return result;
    }
    // 用户取消与系统超时分开呈现；业务上的 no_plan 已在前面正常返回，不能与执行故障混为一谈。
    result = options.signal.aborted
      ? { ...base(), status: "cancelled" }
      : {
          ...base(), status: "failed",
          ...(run.hints?.length ? { hints: [...run.hints] } : {}),
          code: controller.signal.aborted ? "timeout"
            : error instanceof DayRunError ? error.code
            : error instanceof GraphRecursionError ? "engine_limit"
            : error instanceof DecisionModelError ? error.code === "invalid_output" ? "invalid_output"
              : error.code === "timeout" ? "timeout" : "model_error"
            : "internal_error",
        };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
  return dayPlanningResultSchema.parse(result ?? { ...base(), status: "failed", code: "internal_error" });
}
