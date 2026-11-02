import { Annotation, END, START, StateGraph, GraphRecursionError } from "@langchain/langgraph";
import { selectedRouteToTravelLeg } from "@tripquest/providers";
import type { BaselinePlanningInput } from "@tripquest/domain";
import {
  DecisionModelError,
  LIMITS,
  type AgentResult,
  type ActionFeedback,
  type DecisionPolicy,
  type DecisionContext,
  type DecisionModel,
  type LookupRoute,
  type ModelReply,
  type Plan,
} from "./contracts";
import { accessibleEdges, edgeKey, usefulEdges } from "./policy";
import { decisionSchema, type Decision } from "./schema";
import { serializeContext, FEEDBACK_PROMPT_VERSION } from "./prompt";
import { assertLocalTracingOnly } from "./tracing";

export const GRAPH_VERSION = "bounded-route-graph-v1";
interface Runtime extends AgentResult {
  readonly pending: unknown;
  readonly action: Decision | null;
  readonly stopped: boolean;
  readonly feedback?: ActionFeedback;
}
const GraphState = Annotation.Root({ runtime: Annotation<Runtime>() });
export interface AgentDependencies {
  readonly model: DecisionModel;
  readonly decisionPolicy?: DecisionPolicy;
  readonly lookupRoute: LookupRoute;
  readonly plan: Plan;
  readonly signal?: AbortSignal;
  /** 调用方只能收紧生产耗时与递归上限，测试不能借配置扩大调查能力。 */
  readonly requestMs?: number;
  readonly totalMs?: number;
  readonly recursionLimit?: number;
}

/** 同时取消底层传输并隔离不配合取消的迟到响应，结束后的运行不再接受结果。 */
async function abortable<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DecisionModelError("timeout");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DecisionModelError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new DecisionModelError("timeout");
      return operation(signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * 早期的有界路线调查：模型只选择查询哪条有向边或停止，不生成行程时刻。
 * 每次补充事实后重新调用确定性基线；当前一日规划使用 day-graph，这里保留为评测与学习入口。
 */
export async function runAgent(
  source: BaselinePlanningInput,
  dependencies: AgentDependencies,
): Promise<AgentResult> {
  assertLocalTracingOnly();
  const initial = structuredClone(source);
  const feedbackEnabled = dependencies.decisionPolicy === "feedback_once";
  const runController = new AbortController();
  const cancel = () => runController.abort();
  dependencies.signal?.addEventListener("abort", cancel, { once: true });
  if (dependencies.signal?.aborted) cancel();
  const totalMs = Math.max(1, Math.min(dependencies.totalMs ?? LIMITS.totalMs, LIMITS.totalMs));
  const timer = setTimeout(cancel, totalMs);
  let first;
  try {
    first = dependencies.plan(structuredClone(initial));
  } catch (error) {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", cancel);
    throw error;
  }
  let latest: Runtime = {
    ...(feedbackEnabled ? { repairAttempts: 0, feedbackEvents: [] } : {}),
    result: first,
    travelLegs: structuredClone(initial.travelLegs),
    executionStatus: "completed",
    error: null,
    modelRequests: 0,
    routeRequests: 0,
    planningCalls: 1,
    rejectedActions: 0,
    decisions: [],
    observations: [],
    pending: null,
    action: null,
    stopped: false,
  };
  const update = (runtime: Runtime) => {
    latest = runtime;
    return { runtime };
  };
  const stop = (
    state: Runtime,
    executionStatus: AgentResult["executionStatus"],
    error: AgentResult["error"] = null,
  ): Runtime => ({ ...state, executionStatus, error, stopped: true, pending: null, action: null });
  const guard = (state: Runtime): Runtime => {
    if (runController.signal.aborted) {
      return stop(state, dependencies.signal?.aborted ? "cancelled" : "model_error", "timeout");
    }
    return state;
  };
  // 白名单由初始业务拓扑确定，模型只能调查未知有向边；模型不能扩大地点集合或覆盖已知事实。
  const allowed = accessibleEdges(initial);
  const contextFor = (state: Runtime): DecisionContext => {
    const requested = new Set(state.observations.map((o) => edgeKey(o.edge)));
    return structuredClone({
      ...(feedbackEnabled ? { protocolVersion: FEEDBACK_PROMPT_VERSION } : {}),
      ...(state.feedback ? { feedback: state.feedback } : {}),
      initial,
      travelLegs: state.travelLegs,
      currentResult: state.result,
      observations: state.observations,
      allowedEdges: allowed.filter((edge) => !requested.has(edgeKey(edge)))
        .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
      remaining: {
        routes: LIMITS.routes - state.routeRequests,
        models: LIMITS.models - state.modelRequests,
      },
    });
  };
  // 是否还值得调查由当前业务结果与未查边共同判断；无改善空间或额度耗尽时由代码停止。
  const terminal = (state: Runtime): Runtime => {
    const guarded = guard(state);
    if (guarded.stopped) return guarded;
    if (!usefulEdges(state.result, allowed, state.observations).length) {
      return stop(state, "completed");
    }
    if (state.routeRequests >= LIMITS.routes || state.modelRequests >= LIMITS.models) {
      return stop(state, "budget_exhausted");
    }
    return state;
  };

  const graph = new StateGraph(GraphState)
    .addNode("prepare", ({ runtime }) => update(terminal(runtime)))
    .addNode("decide", async ({ runtime }) => {
      let state = guard(runtime);
      if (state.stopped) return update(state);
      const context = contextFor(state);
      try {
        serializeContext(context);
      } catch {
        return update(stop(state, "model_error", "context_limit"));
      }
      state = { ...state, modelRequests: state.modelRequests + 1 };
      update(state); // 请求发出前更新 latest，图意外中止时仍保留已经尝试的请求计数。
      const request = new AbortController();
      const signal = AbortSignal.any([request.signal, runController.signal]);
      const timeout = setTimeout(
        () => request.abort(),
        Math.max(1, Math.min(dependencies.requestMs ?? LIMITS.requestMs, LIMITS.requestMs)),
      );
      let reply: ModelReply;
      try {
        reply = await abortable((signal) => dependencies.model.decide(context, { signal }), signal);
      } catch (error) {
        const code = error instanceof DecisionModelError ? error.code : "transport";
        const metadata = error instanceof DecisionModelError ? error.metadata : undefined;
        const event = {
          sequence: state.modelRequests,
          action: null,
          accepted: false,
          error: code,
          usage: metadata?.usage ?? null,
          returnedModel: metadata?.returnedModel ?? null,
          fingerprint: metadata?.fingerprint ?? null,
          requestId: metadata?.requestId ?? null,
        };
        state = { ...state, decisions: [...state.decisions, event] };
        return update(stop(state, dependencies.signal?.aborted ? "cancelled" : "model_error", code));
      } finally {
        clearTimeout(timeout);
      }
      state = guard(state);
      if (state.stopped) return update(state);
      return update({
        ...state,
        pending: reply.decision,
        decisions: [...state.decisions, {
          sequence: state.modelRequests,
          action: null,
          accepted: false,
          error: null,
          usage: reply.usage,
          returnedModel: reply.returnedModel ?? null,
          fingerprint: reply.fingerprint ?? null,
          requestId: reply.requestId ?? null,
        }],
      });
    })
    .addNode("validate_action", ({ runtime }) => {
      const state = guard(runtime);
      if (state.stopped) return update(state);
      const parsed = decisionSchema.safeParse(state.pending);
      const action = parsed.success ? parsed.data : null;
      const valid = action && (action.action === "finish" || contextFor(state).allowedEdges.some(
        (edge) => edge[0] === action.fromPlaceId && edge[1] === action.toPlaceId,
      ));
      const decisions = state.decisions.map((event, index) =>
        index === state.decisions.length - 1
          ? { ...event, action, accepted: !!valid, error: valid ? null : "invalid_action" as const }
          : event,
      );
      if (!valid) {
        const rejected = {
          ...state,
          decisions,
          rejectedActions: state.rejectedActions + 1,
        };
        // 只修复“结构合法但选错边”的语义错误，且仍消耗原有模型预算。
        // JSON 解析失败、传输错误不进入这个分支，避免把各种故障都包装成可无限重试的纠错。
        if (feedbackEnabled && action?.action === "lookup_route" && !state.repairAttempts) {
          const known = state.travelLegs.some((leg) =>
            leg.fromPlaceId === action.fromPlaceId &&
            leg.toPlaceId === action.toPlaceId && leg.duration.kind === "known",
          );
          const requested = state.observations.some((observation) =>
            observation.edge[0] === action.fromPlaceId &&
            observation.edge[1] === action.toPlaceId,
          );
          const context = contextFor(state);
          const feedback: ActionFeedback = {
            version: "action-feedback-v1",
            code: known ? "known_edge" : requested ? "already_requested" : "edge_not_allowed",
            sequence: state.modelRequests,
            allowedEdges: context.allowedEdges,
            remaining: context.remaining,
          };
          if (state.modelRequests >= LIMITS.models) {
            return update(stop(rejected, "budget_exhausted"));
          }
          return update({
            ...rejected,
            repairAttempts: 1,
            feedbackEvents: [feedback],
            feedback,
            pending: null,
            action: null,
          });
        }
        return update(stop(rejected, "invalid_decision", "invalid_action"));
      }
      // finish 只表示模型停止调查，不证明已经找到可行计划；业务结论仍来自最近一次确定性试算。
      if (action.action === "finish") {
        return update(stop({ ...state, decisions }, "model_stopped"));
      }
      return update({ ...state, decisions, action, pending: null, feedback: undefined });
    })
    .addNode("execute_route", async ({ runtime }) => {
      let state = guard(runtime);
      if (state.stopped) return update(state);
      if (state.routeRequests >= LIMITS.routes) return update(stop(state, "budget_exhausted"));
      const action = state.action;
      if (action?.action !== "lookup_route") return update(stop(state, "invalid_decision", "invalid_action"));
      state = { ...state, routeRequests: state.routeRequests + 1 };
      update(state);
      try {
        const reply = await abortable(
          () => dependencies.lookupRoute(action.fromPlaceId, action.toPlaceId),
          runController.signal,
        );
        state = guard(state);
        if (state.stopped) return update(state);
        const observation = {
          edge: [action.fromPlaceId, action.toPlaceId] as const,
          status: reply.status,
          ...(reply.status === "failure" ? { failureCode: reply.failure.code } : {}),
        };
        state = { ...state, observations: [...state.observations, observation] };
        if (reply.status === "budget_exhausted") return update(stop(state, "budget_exhausted"));
        // 只有明确成功且唯一的步行路线能扩充领域事实；无路线、故障或错误方向都不能补成 known。
        if (reply.status === "ok") {
          if (reply.routes.length !== 1 || reply.routes[0].mode !== "walking") {
            return update(stop(state, "model_error", "route_failure"));
          }
          const leg = selectedRouteToTravelLeg(action.fromPlaceId, action.toPlaceId, reply.routes[0]);
          state = {
            ...state,
            travelLegs: [...state.travelLegs.filter((l) =>
              l.fromPlaceId !== action.fromPlaceId || l.toPlaceId !== action.toPlaceId,
            ), leg],
          };
        }
        if (reply.status === "failure" && ["authorization_failed", "quota_exceeded"].includes(reply.failure.code)) {
          state = stop(state, "model_error", reply.failure.code === "authorization_failed" ? "auth" : "quota");
        }
        return update(state);
      } catch {
        return update(stop(state, dependencies.signal?.aborted ? "cancelled" : "model_error", "route_failure"));
      }
    })
    // 工具观察与业务结论分开：成功查询只增加事实，能否保留活动仍由重新试算决定。
    // executionStatus 另记模型失败或取消，不能因为碰巧留有可行候选就把执行过程算作成功。
    .addNode("recompute", ({ runtime }) => {
      const state = guard(runtime);
      if (runController.signal.aborted) return update(state);
      if (state.planningCalls >= LIMITS.plans) return update(stop(state, "budget_exhausted"));
      const result = dependencies.plan({ ...structuredClone(initial), travelLegs: structuredClone(state.travelLegs) });
      const next = { ...state, result, planningCalls: state.planningCalls + 1 };
      return update(next.stopped ? next : terminal(next));
    })
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", ({ runtime }) => runtime.stopped ? END : "decide")
    .addConditionalEdges("decide", ({ runtime }) => runtime.stopped ? END : "validate_action")
    .addConditionalEdges("validate_action", ({ runtime }) =>
      runtime.stopped ? END : runtime.action ? "execute_route" : "decide")
    .addEdge("execute_route", "recompute")
    .addConditionalEdges("recompute", ({ runtime }) => runtime.stopped ? END : "decide")
    .compile();
  try {
    await graph.invoke({ runtime: latest }, {
      recursionLimit: Math.min(
        dependencies.recursionLimit ?? (feedbackEnabled ? 40 : LIMITS.recursion),
        feedbackEnabled ? 40 : LIMITS.recursion,
      ),
      callbacks: [],
    });
  } catch (error) {
    latest = runController.signal.aborted
      ? guard(latest)
      : error instanceof GraphRecursionError
        ? stop(latest, "engine_limit", "engine_limit")
        : stop(latest, "model_error", "transport");
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", cancel);
    runController.abort();
  }
  const { pending, action, stopped, feedback, ...result } = latest;
  void feedback;
  void pending;
  void action;
  void stopped;
  return structuredClone(result);
}
