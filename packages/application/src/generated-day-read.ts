import { z } from "zod";
import type { StoredJourney } from "./contracts";
import {
  assertSavedDayMatchesJourney,
  assertSavedDayPreservesInitial,
  savedDayDetailsSchema,
} from "./day-edit";
import {
  assertReplanPreservesInitial,
  assertReplannedDayMatchesJourney,
  replannedDayDetailsSchema,
  type GeneratedDayDetails,
} from "./day-state";
import type { StoredDayPlanDetails } from "./generated-day";

/** v1/v2 keep their own formats; v3 is the only version that may have no future activity. */
export const generatedDayDetailsSchema = z.union([
  ...savedDayDetailsSchema.options,
  replannedDayDetailsSchema,
]);

export function assertGeneratedDayMatchesJourney(
  details: GeneratedDayDetails,
  stored: StoredJourney,
): void {
  if (details.schemaVersion === "stored-day-plan.v3") {
    assertReplannedDayMatchesJourney(details, stored);
    return;
  }
  assertSavedDayMatchesJourney(details, stored);
}

export function assertGeneratedDayPreservesInitial(
  details: GeneratedDayDetails,
  initial: StoredDayPlanDetails,
): void {
  if (details.schemaVersion === "stored-day-plan.v3") {
    assertReplanPreservesInitial(details, initial);
    return;
  }
  assertSavedDayPreservesInitial(details, initial);
}
