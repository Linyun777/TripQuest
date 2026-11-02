import type { JourneyFormActivity, JourneyFormValues } from "./form-state";

const ACTIVITY_FIELD = /^activities\.(0|[1-9]\d*)\.(placeName|startsAt|endsAt|priority|kind)$/;
const MAX_FORM_FIELDS = 50;
const MAX_FIELD_LENGTH = 500;

export type ParsedJourneyForm =
  | { readonly ok: true; readonly values: JourneyFormValues }
  | {
      readonly ok: false;
      readonly values: JourneyFormValues;
      readonly formError: string;
    };

export function parseJourneyFormData(formData: FormData): ParsedJourneyForm {
  const fields = new Map<string, string>();
  let malformed = false;
  let count = 0;

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION_")) continue;
    count += 1;
    if (
      count > MAX_FORM_FIELDS ||
      fields.has(key) ||
      typeof value !== "string" ||
      value.length > MAX_FIELD_LENGTH ||
      (key !== "title" && key !== "date" && ACTIVITY_FIELD.exec(key) === null)
    ) {
      malformed = true;
      continue;
    }
    fields.set(key, value);
  }

  const indices = new Set<number>();
  for (const key of fields.keys()) {
    const match = ACTIVITY_FIELD.exec(key);
    if (match === null) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index > 8) {
      malformed = true;
      continue;
    }
    indices.add(index);
  }

  const orderedIndices = [...indices].sort((a, b) => a - b);
  if (orderedIndices.some((index, position) => index !== position)) {
    malformed = true;
  }

  const activities: JourneyFormActivity[] = orderedIndices.map((index) => ({
    placeName: fields.get(`activities.${index}.placeName`) ?? "",
    startsAt: fields.get(`activities.${index}.startsAt`) ?? "",
    endsAt: fields.get(`activities.${index}.endsAt`) ?? "",
    priority: fields.get(`activities.${index}.priority`) ?? "",
    kind: fields.get(`activities.${index}.kind`) ?? "",
  }));
  const values: JourneyFormValues = {
    title: fields.get("title") ?? "",
    date: fields.get("date") ?? "",
    activities,
  };

  return malformed
    ? { ok: false, values, formError: "表单包含重复或不支持的字段，请检查后重试。" }
    : { ok: true, values };
}
