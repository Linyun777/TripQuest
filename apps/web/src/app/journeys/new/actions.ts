"use server";

import {
  createJourney,
  validateCreateJourneyCommand,
} from "@tripquest/application";
import {
  DrizzleJourneyRepository,
  getSharedJourneyDatabase,
} from "@tripquest/db";
import { redirect } from "next/navigation";

import { parseJourneyFormData } from "./form-data";
import type { JourneyFormState } from "./form-state";
import { pageUser } from "../../auth/session";

export async function createJourneyAction(
  previous: JourneyFormState,
  formData: FormData,
): Promise<JourneyFormState> {
  const parsed = parseJourneyFormData(formData);
  const revision = previous.revision + 1;
  if (!parsed.ok) {
    return {
      revision,
      values: parsed.values,
      fieldErrors: {},
      formError: parsed.formError,
    };
  }

  const validation = validateCreateJourneyCommand({
    ...parsed.values,
    timeZone: "Asia/Shanghai",
  });
  if (!validation.success) {
    return {
      revision,
      values: parsed.values,
      fieldErrors: validation.fieldErrors,
      ...(validation.formError === undefined
        ? {}
        : { formError: validation.formError }),
    };
  }

  const user = await pageUser("/journeys/new");
  let outcome;
  try {
    const client = getSharedJourneyDatabase();
    outcome = await createJourney(
      validation.command,
      {
        repository: new DrizzleJourneyRepository(client.database, user.id),
        idGenerator: { next: () => crypto.randomUUID() },
        clock: { now: () => new Date() },
      },
    );
  } catch {
    return {
      revision,
      values: parsed.values,
      fieldErrors: {},
      formError: "暂时无法保存行程，请稍后重试。",
    };
  }

  if (outcome.status === "invalid") {
    return {
      revision,
      values: parsed.values,
      fieldErrors: outcome.fieldErrors,
      ...(outcome.formError === undefined ? {} : { formError: outcome.formError }),
    };
  }

  redirect(`/journeys/${outcome.journeyId}`);
}
