import type { PreviewJourneyCommand } from "@tripquest/application";

export type PreviewValues = {
  readonly observedAt: string;
  readonly earliestResumeAt: string;
  readonly completedActivityIds: readonly string[];
  readonly noCurrentActivity: boolean;
  readonly location: string;
  readonly travelMinutes: string;
};

export type PreviewFormParse =
  | { readonly ok: true; readonly command: PreviewJourneyCommand; readonly values: PreviewValues }
  | { readonly ok: false; readonly values: PreviewValues; readonly error: string };

export const emptyPreviewValues: PreviewValues = {
  observedAt: "", earliestResumeAt: "", completedActivityIds: [],
  noCurrentActivity: false, location: "unknown", travelMinutes: "",
};

const allowed = new Set(["basePlanVersion", "observedAt", "earliestResumeAt", "completedActivityId", "noCurrentActivity", "location", "travelMinutes"]);
const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePreviewFormData(journeyId: string, formData: FormData): PreviewFormParse {
  const single = new Map<string, string>();
  const completed: string[] = [];
  let malformed = false;
  let count = 0;
  for (const [key, value] of formData.entries()) {
    count += 1;
    if (count > 20) malformed = true;
    if (key.startsWith("$ACTION_")) continue;
    if (key.length > 40 || !allowed.has(key) || typeof value !== "string" || value.length > 80) {
      malformed = true;
      continue;
    }
    if (key === "completedActivityId") {
      completed.push(value);
    } else if (single.has(key)) {
      malformed = true;
    } else {
      single.set(key, value);
    }
  }
  const values: PreviewValues = {
    observedAt: single.get("observedAt") ?? "",
    earliestResumeAt: single.get("earliestResumeAt") ?? "",
    completedActivityIds: completed,
    noCurrentActivity: single.get("noCurrentActivity") === "yes",
    location: single.get("location") ?? "unknown",
    travelMinutes: single.get("travelMinutes") ?? "",
  };
  const version = single.get("basePlanVersion") ?? "";
  const travel = values.travelMinutes;
  if (
    malformed || !uuid.test(journeyId) || !/^[1-9]\d{0,8}$/.test(version) ||
    !hhmm.test(values.observedAt) || !hhmm.test(values.earliestResumeAt) ||
    values.earliestResumeAt < values.observedAt ||
    (single.has("noCurrentActivity") && single.get("noCurrentActivity") !== "yes") ||
    !["unknown", "at_target"].includes(values.location) ||
    completed.length > 8 || new Set(completed).size !== completed.length || completed.some((id) => !uuid.test(id)) ||
    (travel !== "" && (!/^(?:[1-9]|[1-9]\d|1\d\d|2[0-3]\d|240)$/.test(travel)))
  ) return { ok: false, values, error: "输入包含无效、重复或不支持的字段，请检查后重试。" };

  return { ok: true, values, command: {
    journeyId,
    basePlanVersion: Number(version),
    observedAt: values.observedAt,
    earliestResumeAt: values.earliestResumeAt,
    completedActivityIds: completed,
    noCurrentActivity: values.noCurrentActivity,
    locationAtTarget: values.location === "at_target",
    travelMinutes: travel === "" ? null : Number(travel),
  } };
}
