import { z } from "zod";
import type { PlaceLookupProvider, WebSearchProvider } from "@tripquest/providers";
import type { WebSource } from "./chat-contracts";
import type { ModelReply } from "./contracts";

/**
 * V2.7.2 "出发须知": for the scenic, culture and theatre stops of a plan, one web search each and
 * one model call that turns the results into short notes. Code decides which stops, what is
 * searched, which sources a note may cite, and whether the plan's day is a closing day.
 */
export const NOTE_KINDS = ["reserve", "ticket", "hours", "other"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

const stopKey = z.string().regex(/^s\d{1,2}$/);
const resultId = z.string().regex(/^w\d{1,2}$/);
export const notesOutputSchema = z.strictObject({
  stops: z.array(z.strictObject({
    key: stopKey,
    notes: z.array(z.strictObject({
      kind: z.enum(NOTE_KINDS),
      text: z.string().trim().min(2).max(60),
      sources: z.array(resultId).min(1).max(3),
    })).max(2),
  })).max(5),
});

export interface TripNotesStopInput {
  readonly key: string;
  readonly externalId: string;
  readonly name: string;
}

export interface TripNotesInput {
  /** The plan's day, "YYYY-MM-DD". */
  readonly date: string;
  /** Today (Beijing time), for "信息较旧". */
  readonly today: string;
  readonly stops: readonly TripNotesStopInput[];
}

export interface TripNote {
  readonly kind: NoteKind;
  readonly text: string;
  readonly sources: readonly WebSource[];
  /** Every source is over a year old. */
  readonly stale: boolean;
}

export interface TripNotesStop {
  readonly key: string;
  readonly name: string;
  /** Looked up (a scenic, culture or theatre stop within the first five). */
  readonly checked: boolean;
  readonly notes: readonly TripNote[];
  /** "你排的 10 月 20 日是周二，这里周二闭馆", from code. */
  readonly warning: string | null;
  /** The search for this stop failed (code only). */
  readonly failure?: string;
}

export type TripNotesCounts = { model: number; webSearches: number; details: number; dropped: number };

export type TripNotesResult =
  | {
      readonly status: "completed";
      readonly stops: readonly TripNotesStop[];
      readonly counts: TripNotesCounts;
      readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
    }
  | {
      readonly status: "failed";
      readonly code: "lookup_failed" | "model_error" | "invalid_output" | "timeout" | "live_budget";
      readonly counts: TripNotesCounts;
      readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
    };

/** What the model sees: each stop's results by id, untrusted. */
export interface NotesDecisionContext {
  readonly protocolVersion: "trip-notes.v1";
  readonly date: string;
  readonly weekday: string;
  readonly stops: readonly {
    readonly key: string;
    readonly name: string;
    readonly results: readonly {
      readonly id: string;
      readonly title: string;
      readonly site: string | null;
      readonly date: string | null;
      readonly authority: number | null;
      readonly summary: string;
    }[];
  }[];
  readonly feedback: null | { readonly code: string };
}

export interface NotesDecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  decide(context: NotesDecisionContext, options: { signal: AbortSignal }): Promise<ModelReply>;
}

export interface TripNotesDependencies {
  readonly model: NotesDecisionModel;
  readonly places: PlaceLookupProvider;
  readonly web: WebSearchProvider;
  /** "batch" (one model call for all stops) or "per_stop" (the V2.7.2 comparison). */
  readonly calls?: "batch" | "per_stop";
  /** Gap between starting searches (DeepSeek allows 5 per second); tests use 0. */
  readonly searchGapMs?: number;
}

export const NOTES_LIMITS = { turnMs: 60_000, modelMs: 30_000, providerMs: 8_000, contextBytes: 32 * 1024 } as const;
