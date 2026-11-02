import { createTripNotesRunner, type NotesDecisionModel, type TripNotesResult } from "@tripquest/agent/notes";
import { FakeWeb } from "./info-dataset";
import { NotesPlaces, notesChecks, type NotesCase } from "./notes-dataset";
import { V21_TODAY, worldPlace } from "./world";

export interface NotesRow {
  readonly suite: "notes";
  readonly caseId: string;
  readonly calls: "batch" | "per_stop";
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly modelRequests: number;
  readonly webSearches: number;
  readonly dropped: number;
  readonly notes: readonly { readonly key: string; readonly texts: readonly string[]; readonly warning: string | null }[];
  readonly failureCode?: string;
}

/** One plan's "出发须知", through the product's own runner, the invented web and categories. */
export async function runNotesCase(item: NotesCase, model: () => NotesDecisionModel, calls: "batch" | "per_stop"): Promise<NotesRow> {
  const web = new FakeWeb();
  const stops = item.stops.map((stop) => ({ key: stop.key, externalId: stop.placeId, name: worldPlace(stop.placeId).name }));
  const result: TripNotesResult = await createTripNotesRunner({ model: model(), places: new NotesPlaces(), web, calls, searchGapMs: 0 })
    .run({ date: item.date, today: V21_TODAY, stops }, { signal: new AbortController().signal });
  const checks = notesChecks(item, result, web);
  return {
    suite: "notes",
    caseId: item.id,
    calls,
    checks,
    passed: checks.every((check) => check.passed),
    modelRequests: result.counts.model,
    webSearches: result.counts.webSearches,
    dropped: result.counts.dropped,
    notes: result.status === "completed"
      ? result.stops.map((stop) => ({ key: stop.key, texts: stop.notes.map((note) => note.text), warning: stop.warning }))
      : [],
    ...(result.status === "failed" ? { failureCode: result.code } : {}),
  };
}
