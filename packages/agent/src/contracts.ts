import type {
  BaselinePlanningInput,
  BaselinePlanningResult,
  TravelLegInput,
} from "@tripquest/domain";
import type { RouteResult } from "@tripquest/providers";
import type { Decision } from "./schema";

export const LIMITS = {
  routes: 3,
  models: 4,
  plans: 4,
  requestMs: 15_000,
  totalMs: 90_000,
  contextChars: 12_000,
  recursion: 32,
} as const;

export type Edge = readonly [from: string, to: string];
export type RouteReply = RouteResult | { readonly status: "budget_exhausted" };
export type LookupRoute = (from: string, to: string) => Promise<RouteReply>;
export type Plan = (input: BaselinePlanningInput) => BaselinePlanningResult;
export type ExecutionStatus =
  | "completed"
  | "model_stopped"
  | "model_error"
  | "invalid_decision"
  | "budget_exhausted"
  | "cancelled"
  | "engine_limit";
export type ErrorCode =
  | "timeout"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transport"
  | "invalid_output"
  | "context_limit"
  | "invalid_action"
  | "route_failure"
  | "engine_limit";

export interface Observation {
  readonly edge: Edge;
  readonly status: RouteReply["status"];
  readonly failureCode?: string;
}
export type DecisionPolicy = "fail_fast" | "feedback_once";
export interface ActionFeedback {
  readonly version: "action-feedback-v1";
  readonly code: "known_edge" | "already_requested" | "edge_not_allowed";
  readonly sequence: number;
  readonly allowedEdges: readonly Edge[];
  readonly remaining: { readonly models: number; readonly routes: number };
}
export interface DecisionContext {
  readonly protocolVersion?: "route-investigation-feedback-v1";
  readonly feedback?: ActionFeedback;
  readonly initial: BaselinePlanningInput;
  readonly travelLegs: readonly TravelLegInput[];
  readonly currentResult: BaselinePlanningResult;
  readonly observations: readonly Observation[];
  readonly allowedEdges: readonly Edge[];
  readonly remaining: { readonly routes: number; readonly models: number };
}
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
}
export interface ModelReply {
  readonly decision: unknown;
  readonly usage: Usage | null;
  readonly returnedModel?: string;
  readonly fingerprint?: string;
  readonly requestId?: string;
}
export interface DecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  getRequestCount?(): number;
  decide(context: DecisionContext, options: { signal: AbortSignal }): Promise<ModelReply>;
}
export class DecisionModelError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly metadata?: Omit<ModelReply, "decision">,
  ) {
    super(code);
    this.name = "DecisionModelError";
  }
}
export interface DecisionEvent {
  readonly sequence: number;
  readonly action: Decision | null;
  readonly accepted: boolean;
  readonly error: ErrorCode | null;
  readonly usage: Usage | null;
  readonly returnedModel: string | null;
  readonly fingerprint: string | null;
  readonly requestId: string | null;
}
export interface AgentResult {
  readonly result: BaselinePlanningResult;
  readonly travelLegs: readonly TravelLegInput[];
  readonly executionStatus: ExecutionStatus;
  readonly error: ErrorCode | null;
  readonly modelRequests: number;
  readonly routeRequests: number;
  readonly planningCalls: number;
  readonly rejectedActions: number;
  readonly decisions: readonly DecisionEvent[];
  readonly observations: readonly Observation[];
  readonly repairAttempts?: number;
  readonly feedbackEvents?: readonly ActionFeedback[];
}
