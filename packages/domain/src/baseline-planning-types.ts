import type { CandidatePlan } from "./model";
import type {
  CandidateValidationInput,
  CandidateValidationResult,
  ValidationIssue,
} from "./candidate-validation-types";

/** The current snapshot and estimates; the baseline constructs its own candidate. */
export type BaselinePlanningInput = Omit<CandidateValidationInput, "candidate">;

export type BaselineStatus =
  | "candidate_found"
  | "needs_information"
  | "no_feasible_candidate"
  | "invalid_input"
  | "request_not_current"
  | "unsupported_scenario"
  | "planner_error";

export type BaselineStrategy = "keep" | "shift" | "omit";

export type BaselineNotConstructedReason =
  | "outside_scope"
  | "would_reorder"
  | "duplicate"
  | "omit_not_allowed"
  | "multiple_editable_activities";

export type BaselineAttempt =
  | {
      readonly strategy: BaselineStrategy;
      readonly outcome: "checked";
      readonly candidate: CandidatePlan;
      readonly validation: CandidateValidationResult;
    }
  | {
      readonly strategy: BaselineStrategy;
      readonly outcome: "not_constructed";
      readonly reasonCode: BaselineNotConstructedReason;
    };

export interface BaselineSelection {
  readonly strategy: BaselineStrategy;
  readonly candidate: CandidatePlan;
  /** A selected candidate is always backed by a feasible validator verdict. */
  readonly validation: CandidateValidationResult;
}

export type BaselinePlanningResult =
  | {
      readonly status: "candidate_found";
      readonly selected: BaselineSelection;
      readonly attempts: readonly BaselineAttempt[];
      readonly issues: readonly ValidationIssue[];
    }
  | {
      readonly status: Exclude<BaselineStatus, "candidate_found">;
      readonly selected?: never;
      readonly attempts: readonly BaselineAttempt[];
      readonly issues: readonly ValidationIssue[];
    };
