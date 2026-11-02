/** Engineering-only export for checking workspace package resolution in S1. */
export const projectName = "TripQuest" as const;

export type {
  ActivityPriority,
  CalendarDate,
  CandidatePlan,
  ChinaDateTime,
  JourneyState,
  JourneyTimeZone,
  ObservedLocation,
  PlanVersion,
  PlannedActivity,
  ReplanRequest,
  ReplanScope,
  Reservation,
  ReservationConfirmationStatus,
  TimeWindow,
} from "./model";

export { referenceCases } from "./reference-cases";
export type {
  FixtureTravelDuration,
  FixtureTravelLeg,
  ReferenceCase,
  ReferenceCaseId,
  ReferenceExpectation,
} from "./reference-cases";

export { validateCandidatePlan } from "./candidate-validation";
export type {
  CandidateValidationInput,
  CandidateValidationResult,
  CheckedTransition,
  TravelLegInput,
  ValidationIssue,
  ValidationIssueCode,
  ValidationVerdict,
} from "./candidate-validation-types";

export { generateBaselineCandidate } from "./baseline-planning";
export type {
  BaselineAttempt,
  BaselineNotConstructedReason,
  BaselinePlanningInput,
  BaselinePlanningResult,
  BaselineSelection,
  BaselineStatus,
  BaselineStrategy,
} from "./baseline-planning-types";

export { dayMinutes, dayTime, inspectDayOrder, sameDayPlace, scheduleDay } from "./day-planning";
export { validateDayDraft } from "./day-validation";
export {
  futureDayInput,
  inspectReplanOrder,
  scheduleReplan,
  validateReplan,
} from "./day-adjustment";
export type { DayFrozenActivity, DayReplanInput } from "./day-adjustment";
export type {
  DayActivity,
  DayIssue,
  DayIssueCode,
  DayOpening,
  DayPlace,
  DayPlanningInput,
  DayRoute,
  DayTravelMode,
  DaySchedule,
  DayScheduledActivity,
  DayScheduledLeg,
  DaySchedulingResult,
  DayValidation,
  DayWindow,
} from "./day-planning-types";
