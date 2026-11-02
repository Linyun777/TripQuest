import type {
  CandidatePlan,
  ChinaDateTime,
  JourneyState,
  PlanVersion,
  ReplanRequest,
  Reservation,
} from "./model";

/** Directed travel estimate. Provider provenance is deliberately a later contract. */
export interface TravelLegInput {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly duration:
    | { readonly kind: "known"; readonly minutes: number }
    | { readonly kind: "unknown"; readonly reason?: string };
}

export interface CandidateValidationInput {
  readonly plan: PlanVersion;
  readonly state: JourneyState;
  readonly request: ReplanRequest;
  readonly candidate: CandidatePlan;
  readonly reservations: readonly Reservation[];
  readonly travelLegs: readonly TravelLegInput[];
  readonly transferBufferMinutes: number;
}

export type ValidationVerdict =
  | "feasible"
  | "known_violation"
  | "insufficient_information"
  | "invalid_input";

export type ValidationIssueCode =
  | "invalid_shape"
  | "invalid_datetime"
  | "invalid_interval"
  | "invalid_number"
  | "duplicate_id"
  | "inconsistent_baseline"
  | "ambiguous_travel_leg"
  | "stale_base"
  | "journey_mismatch"
  | "protected_activity_changed"
  | "outside_scope_change"
  | "unauthorized_metadata_change"
  | "reservation_conflict"
  | "activity_overlap"
  | "delay_conflict"
  | "travel_conflict"
  | "unknown_location"
  | "unknown_travel_duration"
  | "reservation_unverified"
  | "current_activity_end_unknown"
  | "activity_progress_unknown";

export interface ValidationIssue {
  readonly category: "invalid_input" | "known_violation" | "insufficient_information";
  readonly code: ValidationIssueCode;
  readonly fieldPath?: string;
  readonly activityId?: string;
  readonly relatedActivityId?: string;
  readonly fromPlaceId?: string;
  readonly toPlaceId?: string;
}

/** An evaluated, known transition; absent or unknown travel has no arrival proof. */
export interface CheckedTransition {
  /** Omitted when departing from the observed location. */
  readonly fromActivityId?: string;
  readonly toActivityId: string;
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly departsAt: ChinaDateTime;
  readonly earliestArrivalAt: ChinaDateTime;
  readonly nextStartsAt: ChinaDateTime;
  readonly travelMinutes: number;
  readonly bufferMinutes: number;
}

export interface CandidateValidationResult {
  readonly verdict: ValidationVerdict;
  readonly issues: readonly ValidationIssue[];
  readonly checkedTransitions: readonly CheckedTransition[];
}
