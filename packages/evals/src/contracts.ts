import type {
  BaselinePlanningInput, BaselinePlanningResult, BaselineStatus, BaselineStrategy,
  CandidateValidationResult, ChinaDateTime, PlannedActivity, TravelLegInput, ValidationIssueCode,
} from "@tripquest/domain";
import type { RouteResult } from "@tripquest/providers";

export const PLANNER_IDS = ["rules_only", "fixed_workflow"] as const;
export type PlannerId = typeof PLANNER_IDS[number];
export const TOOL_BUDGET = 3;
export type ToolReply = RouteResult | { readonly status: "budget_exhausted" };
export interface ToolCall {
  readonly sequence: number;
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly result: ToolReply;
}
export type LookupRoute = (fromPlaceId: string, toPlaceId: string) => Promise<ToolReply>;
export interface RouteWorldEntry {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly result: RouteResult;
}
export interface HumanExpectation {
  readonly status: BaselineStatus;
  readonly strategy?: BaselineStrategy;
  readonly requiredIssues: readonly ValidationIssueCode[];
  readonly activities?: readonly PlannedActivity[];
  readonly arrival?: { readonly activityId: string; readonly at: ChinaDateTime };
  readonly calls: number;
  readonly reasoning: string;
}
export interface EvaluationCase {
  readonly id: string;
  readonly title: string;
  readonly source: "hand_authored_fiction";
  readonly input: BaselinePlanningInput;
  readonly world: readonly RouteWorldEntry[];
  readonly expected: Readonly<Record<PlannerId, HumanExpectation>>;
}
export interface Dataset {
  readonly version: string;
  readonly cases: readonly EvaluationCase[];
}
/** Deliberately excludes case ID, title, answers and tool world. */
export interface PlannerContext {
  readonly input: BaselinePlanningInput;
  readonly lookupRoute: LookupRoute;
  readonly budget: number;
  readonly plan: (input: BaselinePlanningInput) => BaselinePlanningResult;
}
export interface PlannerOutput {
  readonly result: BaselinePlanningResult;
  readonly travelLegs: readonly TravelLegInput[];
}
export interface Planner {
  readonly id: PlannerId;
  readonly version: string;
  readonly run: (context: PlannerContext) => Promise<PlannerOutput>;
}
export interface PlanningCall {
  readonly toolCallsAtPlanning: number;
  readonly input: BaselinePlanningInput;
  readonly result: BaselinePlanningResult;
}
export interface Score {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly revalidation: CandidateValidationResult | null;
  readonly unsupportedFactChanges: number;
  readonly selectedNonFeasible: boolean;
}
export interface EvaluationRow {
  readonly caseId: string;
  readonly title: string;
  readonly plannerId: PlannerId;
  readonly plannerVersion: string;
  readonly initialStatus: BaselineStatus;
  readonly initialIssueCodes: readonly ValidationIssueCode[];
  readonly finalStatus: BaselineStatus | "exception";
  readonly selectedStrategy: BaselineStrategy | null;
  readonly issueCodes: readonly ValidationIssueCode[];
  readonly activityDiff: readonly { id: string; before: PlannedActivity | null; after: PlannedActivity | null }[];
  readonly travelLegs: readonly TravelLegInput[];
  readonly legEvidence: readonly { readonly fromPlaceId: string; readonly toPlaceId: string; readonly source: "initial_input" | "tool" | "unsupported"; readonly toolSequence?: number; readonly durationSeconds?: number; readonly convertedMinutes?: number }[];
  readonly toolRequests: number;
  readonly toolFailures: number;
  readonly budgetRejections: number;
  readonly trace: readonly ToolCall[];
  readonly planningCalls: readonly PlanningCall[];
  readonly validationCount: number;
  readonly elapsedMs: number;
  readonly expected: HumanExpectation;
  readonly score: Score;
  readonly exception: string | null;
}
