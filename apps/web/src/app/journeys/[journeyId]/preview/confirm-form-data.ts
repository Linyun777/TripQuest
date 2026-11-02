import type { ConfirmJourneyCommand } from "@tripquest/application";
import { parsePreviewFormData } from "./form-data";

const previewKeys = new Set(["basePlanVersion", "observedAt", "earliestResumeAt", "completedActivityId", "noCurrentActivity", "location", "travelMinutes"]);
const confirmationKeys = new Set(["baseObservationVersion", "strategy", "semanticFingerprint", "idempotencyKey"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseConfirmFormData(journeyId: string, formData: FormData): { readonly ok: true; readonly command: ConfirmJourneyCommand } | { readonly ok: false } {
  const preview = new FormData();
  const extras = new Map<string, string>();
  let count = 0;
  for (const [key, value] of formData.entries()) {
    count += 1;
    if (count > 20) return { ok: false };
    if (key.startsWith("$ACTION_")) continue;
    if (typeof value !== "string" || value.length > 80 || key.length > 40) return { ok: false };
    if (previewKeys.has(key)) preview.append(key, value);
    else if (confirmationKeys.has(key) && !extras.has(key)) extras.set(key, value);
    else return { ok: false };
  }
  const parsed = parsePreviewFormData(journeyId, preview);
  if (!parsed.ok || !["basePlanVersion", "observedAt", "earliestResumeAt", "noCurrentActivity", "location", "travelMinutes"].every((key) => preview.has(key))) return { ok: false };
  const observation = extras.get("baseObservationVersion") ?? "";
  const strategy = extras.get("strategy");
  const semanticFingerprint = extras.get("semanticFingerprint") ?? "";
  const idempotencyKey = extras.get("idempotencyKey") ?? "";
  if (!/^(?:0|[1-9]\d{0,8})$/.test(observation) || (strategy !== "shift" && strategy !== "omit") || !/^[a-f0-9]{64}$/.test(semanticFingerprint) || !uuid.test(idempotencyKey)) return { ok: false };
  return { ok: true, command: { ...parsed.command, baseObservationVersion: Number(observation), strategy, semanticFingerprint, idempotencyKey } };
}
