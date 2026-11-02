"use server";

import { previewJourneyAdjustment } from "@tripquest/application";
import { confirmJourneyAdjustment } from "@tripquest/application";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseConfirmFormData } from "./confirm-form-data";
import { parsePreviewFormData } from "./form-data";
import type { PreviewFormState } from "./form-state";
import { pageUser } from "../../../auth/session";

export async function previewJourneyAction(journeyId: string, previous: PreviewFormState, formData: FormData): Promise<PreviewFormState> {
  const parsed = parsePreviewFormData(journeyId, formData);
  const revision = previous.revision + 1;
  if (!parsed.ok) return { revision, values: parsed.values, formError: parsed.error };
  const user = await pageUser(`/journeys/${journeyId}/preview`);
  try {
    const database = getSharedJourneyDatabase();
    const result = await previewJourneyAdjustment(
      parsed.command,
      new DrizzleJourneyRepository(database.database, user.id),
      () => crypto.randomUUID(),
      () => console.error("TripQuest preview integrity check failed"),
    );
    return { revision, values: parsed.values, result, ...(result.status === "candidate_found" && result.strategy !== "keep" ? { confirmationKey: crypto.randomUUID() } : {}) };
  } catch {
    return { revision, values: parsed.values, result: { status: "unavailable" } };
  }
}

export interface ConfirmFormState { readonly status?: "invalid_input" | "stale" | "preview_changed" | "not_confirmable" | "not_found" | "idempotency_conflict" | "temporarily_unavailable" }

export async function confirmJourneyAction(journeyId: string, _previous: ConfirmFormState, formData: FormData): Promise<ConfirmFormState> {
  const parsed = parseConfirmFormData(journeyId, formData);
  if (!parsed.ok) return { status: "invalid_input" };
  const user = await pageUser(`/journeys/${journeyId}/preview`);
  let result;
  try {
    const database = getSharedJourneyDatabase();
    result = await confirmJourneyAdjustment(parsed.command, new DrizzleJourneyRepository(database.database, user.id), { now: () => new Date() }, () => crypto.randomUUID());
  } catch {
    return { status: "temporarily_unavailable" };
  }
  if (result.status === "committed" || result.status === "already_committed") {
    revalidatePath(`/journeys/${journeyId}`);
    redirect(`/journeys/${journeyId}?saved=${result.status === "committed" ? "new" : "again"}`);
  }
  return { status: result.status };
}
