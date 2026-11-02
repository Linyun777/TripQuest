import { z } from "zod";
import { dayDraftSchema, type DayDraft } from "./day-planning";
import { planningPlaceSchema } from "./planning-requirements";
import type { StoredDayPlanDetails } from "./generated-day";

const id = z.string().min(1).max(100);
const minute = z.number().int().min(0).max(1439);
const window = z.strictObject({ startsAt: minute, endsAt: minute });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const dayEditChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("remove"), activityId: z.uuid() }),
  z.strictObject({
    kind: z.literal("change_stay"),
    activityId: z.uuid(),
    stayMinutes: z.number().int().min(15).max(240),
  }),
  z.strictObject({
    kind: z.literal("replace"),
    activityId: z.uuid(),
    externalId: z.string().min(1).max(128),
    stayMinutes: z.number().int().min(15).max(240),
  }),
]);
export type DayEditChange = z.infer<typeof dayEditChangeSchema>;

export const savedDayFactsSchema = z.strictObject({
  context: z.strictObject({
    runId: z.uuid(),
    requirementsFingerprint: hash,
    date: z.iso.date(),
    timeZone: z.literal("Asia/Shanghai"),
    window,
    startPlaceId: id,
    endPlaceId: id,
    bufferMinutes: z.union([z.literal(5), z.literal(10)]),
  }),
  places: z
    .array(z.strictObject({ placeId: id, selection: planningPlaceSchema }))
    .min(1)
    .max(8),
  activities: z
    .array(
      z.strictObject({
        activity: z.strictObject({
          activityId: id,
          placeId: id,
          role: z.enum(["optional", "required", "fixed", "discovered"]),
          stayMinutes: z.number().int().min(1).max(1439),
          staySource: z.enum(["user", "system_estimate"]),
          fixed: window.optional(),
          opening: z.strictObject({ status: z.literal("unknown") }),
          tickets: z.literal("unknown"),
        }),
        interest: z.enum(["culture", "nature", "city_walk", "food"]).optional(),
      }),
    )
    .min(1)
    .max(6),
  routes: z
    .array(
      z.discriminatedUnion("status", [
        z.strictObject({
          fromPlaceId: id,
          toPlaceId: id,
          status: z.literal("same_place_assumption"),
        }),
        z.strictObject({
          fromPlaceId: id,
          toPlaceId: id,
          status: z.literal("known"),
          durationSeconds: z.number().int().nonnegative(),
          distanceMeters: z.number().int().nonnegative(),
          provider: z.string().min(1).max(80),
          sourceKind: z.literal("fixture"),
          retrievedAt: z.iso.datetime({ offset: true }),
        }),
      ]),
    )
    .min(1)
    .max(7),
  draft: dayDraftSchema,
});
export type SavedDayFacts = z.infer<typeof savedDayFactsSchema>;

const placeBindings = z
  .array(z.strictObject({ draftPlaceId: id, placeId: z.uuid() }))
  .min(1)
  .max(8);
const activityBindings = z
  .array(z.strictObject({ draftActivityId: id, activityId: z.uuid() }))
  .min(1)
  .max(6);
export const editedDayDetailsSchema = z
  .strictObject({
    schemaVersion: z.literal("stored-day-plan.v2"),
    planVersion: z.number().int().min(2),
    parentVersion: z.number().int().positive(),
    facts: savedDayFactsSchema,
    placeBindings,
    activityBindings,
    edit: z.strictObject({
      editId: z.uuid(),
      change: dayEditChangeSchema,
      baseFingerprint: hash,
      candidateFingerprint: hash,
      replacedActivityId: z.uuid().optional(),
    }),
    recheckedAt: z.iso.datetime({ offset: true }),
    acknowledgeUnknowns: z.boolean(),
  })
  .refine((details) => details.planVersion === details.parentVersion + 1);
export type EditedDayDetails = z.infer<typeof editedDayDetailsSchema>;
export type SavedDayDetails = StoredDayPlanDetails | EditedDayDetails;
export interface SavedDayView {
  facts: SavedDayFacts;
  placeBindings: z.infer<typeof placeBindings>;
  activityBindings: z.infer<typeof activityBindings>;
}

/** v1 retains its original snapshot; later versions carry only current facts. */
export function toSavedDayView(details: SavedDayDetails): SavedDayView {
  if (details.schemaVersion === "stored-day-plan.v2") {
    return structuredClone({
      facts: details.facts,
      placeBindings: details.placeBindings,
      activityBindings: details.activityBindings,
    });
  }
  const { problem, draft, places, activities, routes } = details.planning;
  const used = new Set([
    draft.startPlace.placeId,
    draft.endPlace.placeId,
    ...draft.activities.map((item) => item.placeId),
  ]);
  return {
    facts: savedDayFactsSchema.parse({
      context: {
        runId: problem.runId,
        requirementsFingerprint: problem.requirementsFingerprint,
        date: draft.date,
        timeZone: draft.timeZone,
        window: draft.window,
        startPlaceId: draft.startPlace.placeId,
        endPlaceId: draft.endPlace.placeId,
        bufferMinutes: problem.input.bufferMinutes,
      },
      places: places.filter((place) => used.has(place.placeId)),
      activities: draft.activities.map((item) =>
        activities.find(
          (record) => record.activity.activityId === item.activityId,
        ),
      ),
      routes,
      draft,
    }),
    placeBindings: details.placeBindings.filter((place) =>
      used.has(place.draftPlaceId),
    ),
    activityBindings: structuredClone(details.activityBindings),
  };
}

export const previewDayEditCommandSchema = z.strictObject({
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().nonnegative(),
  change: dayEditChangeSchema,
});
export const confirmDayEditCommandSchema = z.strictObject({
  receipt: z
    .string()
    .min(1)
    .max(8 * 1024),
  acknowledgeUnknowns: z.boolean(),
});
export interface DayEditDifference {
  activityId: string;
  before: DayDraft["activities"][number];
  after: DayDraft["activities"][number] | null;
  beforeName: string;
  afterName: string | null;
}
export interface DayEditComparison {
  activities: DayEditDifference[];
  before: {
    walking: number;
    distance: number;
    longest: number;
    waiting: number;
    endArrival: number;
  };
  after: {
    walking: number;
    distance: number;
    longest: number;
    waiting: number;
    endArrival: number;
  };
}
export type DayEditError =
  | "invalid_request"
  | "invalid_receipt"
  | "not_found"
  | "source_not_allowed"
  | "invalid_change"
  | "stale"
  | "candidate_changed"
  | "expired"
  | "disabled"
  | "acknowledgment_required"
  | "intent_conflict"
  | "temporarily_unavailable";
export type DayEditPreviewReply =
  | {
      status: "ready";
      draft: DayDraft;
      places: SavedDayFacts["places"];
      comparison: DayEditComparison;
      receipt: string;
    }
  | { status: "not_feasible"; issues: DayDraft["checks"] }
  | { status: DayEditError };
export type DayEditConfirmReply =
  | {
      status: "saved" | "already_saved";
      journeyId: string;
      planVersion: number;
    }
  | { status: DayEditError };
