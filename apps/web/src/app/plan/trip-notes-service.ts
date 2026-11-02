import "server-only";
import { traced } from "../runs/runs";
import { requireOwner } from "../auth/owner";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createTripNotesRunner, type NotesDecisionModel, type TripNotesStopInput } from "@tripquest/agent/notes";
import { createNotesLiveModel } from "@tripquest/agent/notes-live";
import type { ConversationRepository } from "@tripquest/application/conversation";
import type { RealDayAdjustRepository } from "@tripquest/application/real-adjust";
import { DrizzleConversationRepository, DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { PlaceLookupProvider, WebSearchProvider } from "@tripquest/providers";
import { readChatAvailability } from "./conversation-service";
import { readRealPlaceMode } from "../real-places/real-mode";
import { createUserUsage, meteredAmap, meteredWebSearch } from "../usage/usage";
import type { TripNotesView } from "./view-models";

/**
 * V2.7.2 "出发须知" for a plan card (before saving) or a saved trip's stops still to do. Nothing
 * is stored: like the weather, it is looked up when asked for.
 */
export interface TripNotesOptions {
  /** V2.12：当前用户（接口从会话取得）；仓库只读写这个用户的数据。 */
  userId?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  workspaceRoot?: string;
  conversations?: () => Pick<ConversationRepository, "findConversation">;
  journeys?: () => Pick<RealDayAdjustRepository, "findCurrentJourney">;
  dependencies?: () => Promise<{ model: NotesDecisionModel; places: PlaceLookupProvider; web: WebSearchProvider }>;
}

export type TripNotesReply = { status: "ok"; notes: TripNotesView } | { status: "not_found" | "unavailable" | "failed" };

const chinaDay = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

export function createTripNotesService(options: TripNotesOptions = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const root = options.workspaceRoot ?? resolve(process.cwd(), "../..");
  const conversations = () => options.conversations?.() ?? new DrizzleConversationRepository(getSharedJourneyDatabase().database, owner());
  const journeys = () => options.journeys?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner());

  async function dependencies() {
    if (options.dependencies) return options.dependencies();
    const env = environment();
    const key = env.WEB_SEARCH_ENABLED === "false" ? "" : env.DEEPSEEK_API_KEY?.trim() ?? "";
    const mode = readRealPlaceMode(env);
    if (!readChatAvailability(env).enabled || !key || !mode.enabled) return null;
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) return null;
    const config: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    const usage = createUserUsage(owner(), now);
    return {
      model: createNotesLiveModel({
        config,
        profileId: env.AGENT_MODEL_PROFILE ?? "",
        environment: env,
        beforeRequest: () => usage.reserve("model", "model", "trip-notes"),
      }),
      places: meteredAmap({ key: mode.key, usage, purpose: "trip-notes", now }),
      web: meteredWebSearch({ key, usage, purpose: "trip-notes", now }),
    };
  }

  /** The runner's keys are s1, s2…; the page knows the stops by their own ids. */
  async function run(date: string, stops: readonly { id: string; externalId: string; name: string }[]): Promise<TripNotesReply> {
    if (!stops.length) return { status: "ok", notes: { date, stops: [] } };
    const found = await dependencies().catch(() => null);
    if (!found) return { status: "unavailable" };
    const input: TripNotesStopInput[] = stops.map((stop, index) => ({ key: `s${index + 1}`, externalId: stop.externalId, name: stop.name }));
    const result = await createTripNotesRunner(found).run({ date, today: chinaDay(now()), stops: input }, { signal: AbortSignal.timeout(90_000) });
    if (result.status !== "completed") {
      if (environment().NODE_ENV === "development") console.warn(`[trip-notes] failed: ${result.code}`);
      return { status: result.code === "live_budget" ? "unavailable" : "failed" };
    }
    return {
      status: "ok",
      notes: {
        date,
        stops: result.stops.map((stop, index) => ({
          id: stops[index].id,
          name: stop.name,
          checked: stop.checked,
          notes: stop.notes.map((note) => ({ kind: note.kind, text: note.text, stale: note.stale, sources: note.sources })),
          warning: stop.warning,
        })),
      },
    };
  }

  return {
    /** A plan card of this conversation, by its run. */
    forPlan: (conversationId: string, runId: string) => traced({ trigger: "trip_notes", userId: options.userId ?? null }, async (root): Promise<TripNotesReply> => {
      const found = await conversations().findConversation(conversationId);
      const card = found?.messages.find((message) => message.kind === "plan_card" && message.body.runId === runId);
      if (!card || card.kind !== "plan_card") return { status: "not_found" };
      root.link({ conversationId });
      const stops = card.body.stops.map((stop) => ({ id: stop.externalId, externalId: stop.externalId, name: stop.name }));
      return run(card.body.date, stops);
    }),
    /** A saved trip: the stops still to do in its current version. */
    forJourney: (journeyId: string) => traced({ trigger: "trip_notes", userId: options.userId ?? null }, async (root): Promise<TripNotesReply> => {
      const journey = await journeys().findCurrentJourney(journeyId);
      const details = journey?.realDay;
      if (!journey || !details) return { status: "not_found" };
      root.link({ journeyId });
      const done = new Set([...(journey.dayProgress?.completedActivityIds ?? []), ...(journey.dayProgress?.skippedActivityIds ?? [])]);
      const stops = details.activities
        .filter((item) => !done.has(item.record.activity.activityId))
        .map((item) => {
          const place = details.places.find((entry) => entry.placeId === item.record.activity.placeId)!;
          return { id: item.record.activity.activityId, externalId: place.externalId, name: place.name };
        });
      return run(details.context.date, stops);
    }),
  };
}
