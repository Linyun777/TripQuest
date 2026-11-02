import { ASKS, KNOWLEDGE_ASKS } from "@tripquest/agent/chat";
import type { IntentRouter } from "@tripquest/agent/intent";
import {
  harmfulErrors,
  ROUTE_FLAGS,
  truthFlags,
  type RouteCase,
  type RouteFlag,
  type RouteFlags,
  type RouteInput,
} from "./route-dataset";

/** 一种分流实现在评测里的样子：输入一条消息，给出 7 个判断。 */
export interface EvalRouter {
  readonly name: string;
  route(input: RouteInput): Promise<RouteFlags>;
}

/**
 * 基线：现在的产品（V2.8）。需求理解规则始终在（planning 恒为真）；有保存的行程就带调整规则；
 * 命中 ASKS 或 KNOWLEDGE_ASKS 时同时提供联网和资料库；没有建议、闲聊、偏好这些概念。
 */
export const currentProductRouter: EvalRouter = {
  name: "current-product",
  async route(input) {
    const asking = ASKS.test(input.text) || KNOWLEDGE_ASKS.test(input.text);
    return {
      planning: true,
      adjust: input.hasTrip,
      ask_timely: asking,
      ask_knowledge: asking,
      advice: false,
      chitchat: false,
      preference: false,
    };
  },
};

/** 产品的分流实现接到评测上（输入就是题目本身）。 */
export function fromIntentRouter(router: IntentRouter, name = router.name): EvalRouter & {
  lastFallback: () => readonly string[];
  lastFailure: () => string | null;
  lastRouter: () => string;
  lastModel: () => string | null;
  lastTokens: () => number;
  lastConfidence: () => Readonly<Record<string, number>> | null;
} {
  let fallback: readonly string[] = [];
  let failure: string | null = null;
  let actual = router.name;
  let model: string | null = null;
  let tokens = 0;
  let confidence: Readonly<Record<string, number>> | null = null;
  return {
    name,
    lastFallback: () => fallback,
    lastFailure: () => failure,
    lastRouter: () => actual,
    lastModel: () => model,
    lastTokens: () => tokens,
    lastConfidence: () => confidence,
    async route(input) {
      const result = await router.route(
        { text: input.text, hasTrip: input.hasTrip, cardEmpty: input.cardEmpty, ...(input.previous ? { previous: input.previous } : {}) },
        { signal: new AbortController().signal },
      );
      fallback = result.fallback;
      failure = result.failure ?? null;
      actual = result.router;
      model = result.model ?? null;
      tokens = result.inputTokens ?? 0;
      confidence = result.confidence;
      return result.flags;
    },
  };
}

export interface RouteRow {
  readonly suite: "route";
  readonly caseId: string;
  readonly router: string;
  readonly heldOut: boolean;
  readonly predicted: readonly RouteFlag[];
  readonly truth: readonly RouteFlag[];
  readonly exact: boolean;
  readonly harmful: readonly string[];
  readonly latencyMs: number;
  /** 用正则补的判断（拿不准或整条失败）。 */
  readonly fallback: readonly string[];
  /** 整条退回正则的原因。 */
  readonly failure: string | null;
  /** 级联里这条改问了 DeepSeek。 */
  readonly escalated: boolean;
  /** V2.9.2：实际回答的模型版本与输入 tokens（Jev）。 */
  readonly model?: string | null;
  readonly inputTokens?: number;
  /** 每个判断的原始分数（选阈值时离线重算用）。 */
  readonly confidence?: Readonly<Record<string, number>> | null;
}

export async function runRouteCase(item: RouteCase, router: EvalRouter): Promise<RouteRow> {
  const started = performance.now();
  const flags = await router.route(item);
  const latencyMs = Math.round(performance.now() - started);
  const failure = "lastFailure" in router && typeof router.lastFailure === "function" ? (router.lastFailure() as string | null) : null;
  const fallback = "lastFallback" in router && typeof router.lastFallback === "function" ? (router.lastFallback() as readonly string[]) : [];
  const predicted = ROUTE_FLAGS.filter((flag) => flags[flag]);
  const truth = truthFlags(item);
  return {
    suite: "route",
    caseId: item.id,
    router: router.name,
    heldOut: !!item.heldOut,
    predicted,
    truth: [...item.truth],
    exact: ROUTE_FLAGS.every((flag) => flags[flag] === truth[flag]),
    harmful: harmfulErrors(item, flags),
    latencyMs,
    fallback,
    failure,
    escalated: "lastRouter" in router && typeof router.lastRouter === "function" && String(router.lastRouter()).includes("+"),
    model: "lastModel" in router && typeof router.lastModel === "function" ? (router.lastModel() as string | null) : null,
    inputTokens: "lastTokens" in router && typeof router.lastTokens === "function" ? (router.lastTokens() as number) : 0,
    confidence: "lastConfidence" in router && typeof router.lastConfidence === "function" ? (router.lastConfidence() as Readonly<Record<string, number>> | null) : null,
  };
}

export interface RouteSummary {
  readonly rows: number;
  readonly exact: number;
  readonly harmful: Readonly<Record<string, number>>;
  /** 每个判断的精确率与召回率（分母为 0 时为 null）。 */
  readonly perFlag: Readonly<Record<RouteFlag, { readonly precision: number | null; readonly recall: number | null }>>;
  readonly latency: { readonly p50: number; readonly p90: number };
  /** 有判断用正则补过的条数，以及整条退回正则的条数。 */
  readonly fallback: { readonly partial: number; readonly whole: number };
}

export function summarizeRoute(rows: readonly RouteRow[]): RouteSummary {
  const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
  const perFlag = Object.fromEntries(ROUTE_FLAGS.map((flag) => {
    const predicted = rows.filter((row) => row.predicted.includes(flag));
    const actual = rows.filter((row) => row.truth.includes(flag));
    const hit = rows.filter((row) => row.predicted.includes(flag) && row.truth.includes(flag)).length;
    return [flag, { precision: ratio(hit, predicted.length), recall: ratio(hit, actual.length) }];
  })) as RouteSummary["perFlag"];
  const harmful: Record<string, number> = {};
  for (const kind of rows.flatMap((row) => row.harmful)) harmful[kind] = (harmful[kind] ?? 0) + 1;
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  return {
    rows: rows.length,
    exact: rows.filter((row) => row.exact).length,
    harmful,
    perFlag,
    latency: { p50: at(0.5), p90: at(0.9) },
    fallback: {
      partial: rows.filter((row) => row.fallback.length > 0 && row.fallback.length < 7).length,
      whole: rows.filter((row) => row.fallback.length === 7).length,
    },
  };
}
