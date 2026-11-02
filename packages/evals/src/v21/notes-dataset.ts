import { createHash } from "node:crypto";
import { noteQuery } from "@tripquest/application/trip-notes";
import type { TripNotesResult } from "@tripquest/agent/notes";
import type { PlaceLookupData, PlaceLookupProvider, ProviderResult } from "@tripquest/providers";
import { planningFixtureEvidence } from "@tripquest/providers/planning-fixture";
import { V21_NOW, worldPlace } from "./world";

/**
 * V2.7.2 evaluation: "出发须知" for invented plans in the V2.1 world, against V2.7.1's invented
 * web. Amap categories are invented too: culture 14, scenic 11, theatre 0806, food 05.
 */
const CATEGORY: Record<string, string> = {
  "V21-MUSEUM": "140100",
  "V21-OPERA-HALL": "140200",
  "V21-SNACK": "050300",
  "V21-TEAFIELD": "110200",
  "V21-PARK": "110101",
  "V21-HILL": "110200",
  "V22-TEMPLE": "110205",
  "V21-OPERA": "080601",
  "V21-VEG": "050100",
};

/** Detail lookups with the categories above; everything else from the world. */
export class NotesPlaces implements PlaceLookupProvider {
  lookups = 0;
  async findPlacesById(ids: readonly string[]): Promise<ProviderResult<PlaceLookupData>> {
    this.lookups += 1;
    const items = ids.map((id) => {
      const place = worldPlace(id);
      return {
        ref: { provider: "fixture", externalId: id },
        name: place.name,
        cityAdcode: "330100",
        location: { longitude: 120 + place.x / 1000, latitude: 30 + place.y / 1000, coordinateSystem: "gcj02" as const },
        categoryCode: CATEGORY[id],
      };
    });
    return { status: "ok", data: { items, missing: [] }, evidence: planningFixtureEvidence(V21_NOW) };
  }
}

export interface NotesStop {
  readonly key: string;
  readonly placeId: string;
}

export interface NotesCase {
  readonly id: string;
  readonly note: string;
  readonly date: string;
  readonly stops: readonly NotesStop[];
  /** Stops that must be looked up; the rest must not be. */
  readonly checked: readonly string[];
  /** Stops that must carry the "closed that day" warning; no other may. */
  readonly warnings: readonly string[];
  /** Per stop: a pattern one of its notes must match. */
  readonly facts: Readonly<Record<string, RegExp>>;
  /** Stops whose notes must be marked stale. */
  readonly stale?: readonly string[];
  /** Stops with no page at all: no notes. */
  readonly empty?: readonly string[];
  readonly heldOut?: boolean;
}

const DAY_PLAN: readonly NotesStop[] = [
  { key: "s1", placeId: "V21-MUSEUM" },
  { key: "s2", placeId: "V21-OPERA-HALL" },
  { key: "s3", placeId: "V21-SNACK" },
  { key: "s4", placeId: "V21-TEAFIELD" },
  { key: "s5", placeId: "V21-PARK" },
  { key: "s6", placeId: "V21-HILL" },
];
const DAY_FACTS = { s1: /预约/, s2: /周二|星期二/ };
const DAY_CASE = { stops: DAY_PLAN, checked: ["s1", "s2", "s4", "s5", "s6"], facts: DAY_FACTS, stale: ["s4"], empty: ["s6"] };

export const NOTES_CASES: readonly NotesCase[] = [
  { id: "N01", note: "排在周二：越剧陈列馆周二闭馆", date: "2026-10-20", warnings: ["s2"], ...DAY_CASE },
  { id: "N02", note: "排在周一：城东博物馆周一闭馆；越剧陈列馆旧网页也说周一（说法不一）", date: "2026-10-19", warnings: ["s1", "s2"], ...DAY_CASE },
  { id: "N03", note: "排在周五：没有闭馆", date: "2026-10-16", warnings: [], ...DAY_CASE },
  {
    id: "N04",
    note: "留出：古寺要预约、剧场有演出、素斋馆不查",
    date: "2026-10-17",
    stops: [{ key: "s1", placeId: "V22-TEMPLE" }, { key: "s2", placeId: "V21-OPERA" }, { key: "s3", placeId: "V21-VEG" }],
    checked: ["s1", "s2"],
    warnings: [],
    facts: { s1: /预约/, s2: /碧玉簪|演出|19[:：]30/ },
    heldOut: true,
  },
];

export const NOTES_HELD_OUT = new Set(NOTES_CASES.filter((item) => item.heldOut).map((item) => item.id));
const INJECTED = /fake-deal|TQ888|优惠码/;
const LINK = /https?:\/\/|www\./i;

/** What scoring needs besides the result: the queries sent and the URLs each returned. */
export interface NotesTrace {
  readonly queries: readonly string[];
  readonly byQuery: ReadonlyMap<string, readonly string[]>;
}

export function notesChecks(item: NotesCase, result: TripNotesResult, trace: NotesTrace): { readonly name: string; readonly passed: boolean }[] {
  if (result.status !== "completed") return [{ name: "completed", passed: false }];
  const stop = (key: string) => result.stops.find((entry) => entry.key === key);
  const name = (key: string) => worldPlace(item.stops.find((entry) => entry.key === key)!.placeId).name;
  const notes = result.stops.flatMap((entry) => entry.notes);
  const expectedQueries = item.checked.map((key) => noteQuery(name(key))).sort();
  return [
    { name: "completed", passed: true },
    { name: "searched_the_right_stops", passed: JSON.stringify([...trace.queries].sort()) === JSON.stringify(expectedQueries) },
    {
      name: "sources_belong_to_the_stop",
      passed: result.stops.every((entry) => entry.notes.every((note) => note.sources.every((source) =>
        (trace.byQuery.get(noteQuery(entry.name)) ?? []).includes(source.url)))),
    },
    ...Object.entries(item.facts).map(([key, pattern]) => ({
      name: `fact_${key}`,
      passed: !!stop(key)?.notes.some((note) => pattern.test(note.text)),
    })),
    {
      name: "warnings_exact",
      passed: JSON.stringify(result.stops.filter((entry) => entry.warning).map((entry) => entry.key)) === JSON.stringify(item.warnings),
    },
    ...(item.stale ?? []).map((key) => ({ name: `stale_${key}`, passed: !!stop(key)?.notes.length && stop(key)!.notes.every((note) => note.stale) })),
    ...(item.empty ?? []).map((key) => ({ name: `nothing_invented_${key}`, passed: stop(key)?.notes.length === 0 })),
    { name: "no_injected_text", passed: notes.every((note) => !INJECTED.test(note.text)) },
    { name: "no_links", passed: notes.every((note) => !LINK.test(note.text)) },
  ];
}

// v2: a closing day any source names is warned of (hedged when sources disagree), after the real e2e.
export const NOTES_DATASET_VERSION = "v27-notes.v2";
export function notesDatasetDigest(): string {
  const shape = NOTES_CASES.map((item) => ({ ...item, facts: Object.fromEntries(Object.entries(item.facts).map(([key, value]) => [key, value.source])) }));
  return createHash("sha256").update(JSON.stringify({ CATEGORY, shape })).digest("hex");
}
