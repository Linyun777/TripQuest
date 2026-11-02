import { z } from "zod";
import { dayIssueSchema } from "./day-planning";
import { PLANNING_INTERESTS, planningPlaceSchema } from "./planning-requirements";

/**
 * Client-safe S5.3.3 page contract: schemas, types and limits only (no Node or provider code),
 * so browser components can validate streamed results without pulling server modules.
 */
export const DAY_REPLAN_PROTOCOL = "day-replanning.v1" as const;
export const DAY_REPLAN_PURPOSE = "generated-day-replan.v1" as const;
export const REPLAN_LIMITS = {
  model: 8, searches: 2, tries: 3, routes: 28, semanticRepairs: 1, pool: 12,
  runMs: 120_000, modelMs: 15_000, providerMs: 5_000, contextBytes: 24 * 1024, recursion: 64,
} as const;

export const replanScopeSchema = z.enum(["rest_of_day", "until_next_fixed"]);
export const replanGoalSchema = z.enum(["keep_as_much", "less_walking", "relaxed"]);
export type ReplanScope = z.infer<typeof replanScopeSchema>;
export type ReplanGoal = z.infer<typeof replanGoalSchema>;
export const replanCountsSchema = z.strictObject({
  model: z.number().int().min(0).max(8),
  searches: z.number().int().min(0).max(2),
  baseline: z.number().int().min(0).max(1),
  tries: z.number().int().min(0).max(3),
  routes: z.number().int().min(0).max(28),
  semanticRepairs: z.number().int().min(0).max(1),
});
export type ReplanCounts = z.infer<typeof replanCountsSchema>;

export const replanConflictSchema = z.strictObject({
  code: z.enum(["hard_skipped", "fixed_passed", "resume_after_end"]),
  activityId: z.uuid().optional(),
});

const key = z.string().min(1).max(160);
const minute = z.number().int().min(0).max(1439);
const keyedIssueSchema = dayIssueSchema;
const metricsSchema = z.strictObject({
  activities: z.number().int().min(0).max(6),
  walking: z.number().int().nonnegative(),
  distance: z.number().int().nonnegative(),
  longest: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  endArrival: minute,
});
export const replanCandidateSchema = z.strictObject({
  archived: z.array(z.strictObject({
    key,
    name: z.string().min(1).max(200),
    role: z.enum(["optional", "required", "fixed", "discovered"]),
    status: z.enum(["completed", "skipped"]),
    planned: z.strictObject({ startsAt: minute, endsAt: minute }),
  })).max(6),
  resume: z.strictObject({ key, name: z.string().min(1).max(200), startsAt: minute }),
  end: z.strictObject({ key, name: z.string().min(1).max(200), endsAt: minute }),
  activities: z.array(z.strictObject({
    key,
    placeKey: key,
    name: z.string().min(1).max(200),
    role: z.enum(["optional", "required", "fixed", "discovered"]),
    origin: z.enum(["planned", "discovered"]),
    frozen: z.boolean(),
    stayMinutes: z.number().int().positive().max(1439),
    staySource: z.enum(["user", "system_estimate"]),
    interest: z.enum(PLANNING_INTERESTS).optional(),
    arrivesAt: minute,
    startsAt: minute,
    endsAt: minute,
    waitMinutes: z.number().int().min(0).max(1439),
  })).max(6),
  legs: z.array(z.strictObject({
    fromKey: key,
    toKey: key,
    departsAt: minute,
    arrivesAt: minute,
    travelMinutes: z.number().int().min(0).max(1439),
    bufferMinutes: z.union([z.literal(0), z.literal(5), z.literal(10)]),
    distanceMeters: z.number().int().nonnegative(),
    source: z.enum(["route_estimate", "same_place_assumption"]),
  })).min(1).max(7),
  places: z.array(z.strictObject({ placeId: key, selection: planningPlaceSchema })).min(1).max(12),
  metrics: metricsSchema,
  verification: z.enum(["checked", "pending"]),
  checks: z.array(keyedIssueSchema).max(30),
});
export type ReplanCandidate = z.infer<typeof replanCandidateSchema>;

export const replanSelectionSchema = z.array(z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("planned"), activityId: z.uuid() }),
  z.strictObject({
    kind: z.literal("discovered"),
    externalId: z.string().min(1).max(128),
    interest: z.enum(PLANNING_INTERESTS),
  }),
])).max(6);
export type ReplanSelection = z.infer<typeof replanSelectionSchema>;

export const replanComparisonSchema = z.strictObject({
  changes: z.array(z.strictObject({
    key,
    name: z.string().min(1).max(200),
    change: z.enum(["kept", "moved", "removed", "added"]),
    before: z.strictObject({ startsAt: minute, endsAt: minute }).optional(),
    after: z.strictObject({ startsAt: minute, endsAt: minute }).optional(),
  })).max(18),
  baseline: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("scheduled"), metrics: metricsSchema, sameAsCandidate: z.boolean() }),
    z.strictObject({ status: z.literal("not_scheduled"), issues: z.array(keyedIssueSchema).max(30) }),
  ]).nullable(),
});
export type ReplanComparison = z.infer<typeof replanComparisonSchema>;

export const replanProgressSchema = z.strictObject({
  phase: z.enum(["preparing", "baseline", "deciding", "searching", "routing", "checking", "observing"]),
  counts: replanCountsSchema,
});
export type ReplanProgress = z.infer<typeof replanProgressSchema>;
export const replanFailureSchema = z.enum([
  "model_error", "invalid_output", "semantic_invalid", "provider_error", "budget_exhausted",
  "timeout", "context_limit", "engine_limit", "internal_error", "live_budget",
]);
export type ReplanFailure = z.infer<typeof replanFailureSchema>;
const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).nullable();
const resultBase = {
  runId: z.uuid(),
  counts: replanCountsSchema,
  elapsedMs: z.number().int().nonnegative(),
  usage: usageSchema,
};
export const replanResultSchema = z.union([
  z.strictObject({
    ...resultBase,
    status: z.literal("completed"),
    outcome: z.literal("candidate"),
    candidate: replanCandidateSchema,
    comparison: replanComparisonSchema,
    selection: replanSelectionSchema,
    candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    chosen: z.enum(["baseline", "agent"]),
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal("completed"),
    outcome: z.literal("unchanged"),
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({
    ...resultBase,
    status: z.literal("completed"),
    outcome: z.literal("bounded_no_candidate"),
    reason: z.enum(["constraints_not_met", "insufficient_information"]),
    issues: z.array(keyedIssueSchema).max(30),
    baselineIssues: z.array(keyedIssueSchema).max(30),
    explanation: z.string().min(1).max(600),
  }),
  z.strictObject({ ...resultBase, status: z.literal("failed"), code: replanFailureSchema }),
  z.strictObject({ ...resultBase, status: z.literal("cancelled") }),
]);
export type ReplanResult = z.infer<typeof replanResultSchema>;

export const replanOfferSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    receipt: z.string().min(1).max(8 * 1024),
    expiresAt: z.iso.datetime({ offset: true }),
    acknowledgeUnknownsRequired: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["disabled", "stale", "receipt_unavailable"]),
  }),
]);
export type ReplanOffer = z.infer<typeof replanOfferSchema>;

export const replanStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), runId: z.uuid(), sequence: z.literal(0) }),
  z.strictObject({
    type: z.literal("progress"), runId: z.uuid(), sequence: z.number().int().positive(),
    progress: replanProgressSchema,
  }),
  z.strictObject({
    type: z.literal("result"), runId: z.uuid(), sequence: z.number().int().positive(),
    result: replanResultSchema, offer: replanOfferSchema.optional(),
  }),
]).superRefine((event, context) => {
  if (event.type !== "result") return;
  if (event.result.runId !== event.runId) {
    context.addIssue({ code: "custom", message: "Result belongs to another run" });
  }
  const result = event.result;
  if (event.offer?.status === "available" && (
    result.status !== "completed" || result.outcome !== "candidate" ||
    event.offer.acknowledgeUnknownsRequired !== (result.candidate.verification === "pending")
  )) {
    context.addIssue({ code: "custom", message: "Offer does not match the candidate" });
  }
});
export type ReplanStreamEvent = z.infer<typeof replanStreamEventSchema>;
export const REPLAN_STREAM_EVENT_BYTES = 128 * 1024;
export const REPLAN_STREAM_TOTAL_BYTES = 512 * 1024;

/* ---------- HTTP commands ---------- */

export const replanCommandSchema = z.strictObject({
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().positive(),
  scope: replanScopeSchema,
  goal: replanGoalSchema,
});
export type ReplanCommand = z.infer<typeof replanCommandSchema>;
export const confirmReplanCommandSchema = z.strictObject({
  receipt: z.string().min(1).max(8 * 1024),
  acknowledgeUnknowns: z.boolean(),
});
export type ReplanError =
  | "invalid_request"
  | "invalid_receipt"
  | "not_found"
  | "source_not_allowed"
  | "invalid_scope"
  | "stale"
  | "candidate_changed"
  | "expired"
  | "disabled"
  | "acknowledgment_required"
  | "intent_conflict"
  | "temporarily_unavailable";
export type ReplanPreflightReply =
  | { status: "needs_information"; reason: "unreported" | "location_unknown" }
  | { status: "constraints_conflict"; conflicts: z.infer<typeof replanConflictSchema>[] }
  | { status: ReplanError; message?: string };
export type ReplanConfirmReply =
  | { status: "saved" | "already_saved"; journeyId: string; planVersion: number }
  | { status: ReplanError };

export const replanReceiptPayloadSchema = z.strictObject({
  purpose: z.literal(DAY_REPLAN_PURPOSE),
  runId: z.uuid(),
  journeyId: z.uuid(),
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().positive(),
  baseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  scope: replanScopeSchema,
  goal: replanGoalSchema,
  datasetVersion: z.string().min(1).max(80),
  selection: replanSelectionSchema,
  execution: z.strictObject({
    mode: z.enum(["scripted", "live"]),
    provider: z.string().regex(/^[A-Za-z0-9_.:/-]{1,80}$/),
    model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
    counts: replanCountsSchema,
  }),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export type ReplanReceiptPayload = z.infer<typeof replanReceiptPayloadSchema>;
