// TQ-008.3.2 independent test (Claude Code). Own *_test database, so it can run beside
// the developer's edits.test.ts. Expected times come from a hand-written oracle over the
// fixture route formula and the design's buffer/fixed rules, never from scheduleDay.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import type { DayEditChange } from "@tripquest/application/saved-day";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createDraftSaveOffer } from "../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { createDayEditHandlers } from "../edit-handlers";
import { asTestUser, ownerId } from "../../../../test-support/users";

const envFile = resolve(process.cwd(), "../../.env");
// Only the test database address: the developer's own feature switches must not leak in.
if (existsSync(envFile)) {
  process.env.TEST_DATABASE_URL ??= parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL;
}
const t0 = Date.parse("2026-10-09T07:00:00Z");
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "independent-s532-place-secret-0123456789abcdef",
  PLANNING_DRAFT_RECEIPT_SECRET: "independent-s532-receipt-secret-0123456789abc",
};
const directory = planningFixturePlaces();
const index = (externalId: string) =>
  directory.findIndex((place) => place.ref.externalId === externalId);
const DB = "tripquest_s532_it_test";
const WINDOW = { start: 9 * 60, end: 16 * 60 };
const BUFFER = 5; // pace "standard"

/** Fixture walking minutes, read off the handwritten provider rule, rounded up. */
function legMinutes(from: number, to: number): number {
  const seconds = 240 + Math.abs(to - from) * 120 + (from > to ? 61 : 1);
  return Math.ceil(seconds / 60);
}
type Stop = { place: number; role: string; stay: number; fixed?: [number, number] };
type Oracle =
  | { ok: true; times: [number, number, number][]; endArrival: number }
  | { ok: false; code: "day_fixed_late" | "day_window_exceeded" };
/** start/end/wait per activity: same place = 0 walk and no buffer; fixed never moves. */
function oracle(stops: Stop[], start: number, end: number): Oracle {
  let cursor = WINDOW.start;
  let at = start;
  const times: [number, number, number][] = [];
  const hop = (to: number) => (to === at ? 0 : legMinutes(at, to) + BUFFER);
  for (const stop of stops) {
    const arrive = cursor + hop(stop.place);
    if (stop.fixed) {
      if (arrive > stop.fixed[0]) return { ok: false, code: "day_fixed_late" };
      times.push([stop.fixed[0], stop.fixed[1], stop.fixed[0] - arrive]);
      cursor = stop.fixed[1];
    } else {
      times.push([arrive, arrive + stop.stay, 0]);
      cursor = arrive + stop.stay;
    }
    at = stop.place;
  }
  const endArrival = cursor + hop(end);
  if (endArrival > WINDOW.end) return { ok: false, code: "day_window_exceeded" };
  return { ok: true, times, endArrival };
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost:3361/api/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3361",
      host: "localhost:3361",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.2 independent edit boundaries", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;
  const handlers = () =>
    createDayEditHandlers({ environment: env, now: () => t0 + 60_000, repository: () => repository });
  const preview = async (journeyId: string, change: unknown, base = 1, observation = 0) => {
    const response = await handlers().preview(
      post(`journeys/${journeyId}/edits/preview`, {
        basePlanVersion: base,
        baseObservationVersion: observation,
        change,
      }),
      journeyId,
    );
    return { status: response.status, body: await response.json() };
  };
  const confirm = async (journeyId: string, receipt: string) => {
    const response = await handlers().confirm(
      post(`journeys/${journeyId}/edits/confirm`, { receipt, acknowledgeUnknowns: true }),
      journeyId,
    );
    return { status: response.status, body: await response.json() };
  };
  const versions = async (journeyId: string) =>
    (await client.pool.query(
      "SELECT count(*)::int AS n FROM plan_versions WHERE journey_id = $1",
      [journeyId],
    )).rows[0].n as number;

  async function saveJourney(visits: object[]) {
    const token = (i: number) =>
      issuePlaceToken(
        { place: directory[i], evidence: planningFixtureEvidence(t0) },
        env.PLANNING_PLACE_TOKEN_SECRET!,
        "fixture",
        t0,
      );
    const generate = createDraftHandler(
      () => createGenerationService({ environment: env, now: () => t0 }),
      (snapshot, result) => createDraftSaveOffer(snapshot, result, { environment: env, now: t0 }),
      undefined,
      asTestUser,
    );
    const response = await generate(post("planning/draft", {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: "2026-10-16",
      window: { startsAt: "09:00", endsAt: "16:00" },
      startPlace: token(0),
      endPlace: token(7),
      interests: [],
      pace: "standard",
      visits: visits.map((visit) => {
        const { place, ...rest } = visit as { place: number };
        return { token: token(place), ...rest };
      }),
    }));
    const last = dayStreamEventSchema.parse(
      JSON.parse((await response.text()).trim().split("\n").at(-1)!),
    );
    if (last.type !== "result" || last.saveOffer?.status !== "available") {
      throw new Error("expected a saveable fixture draft");
    }
    const saved = await createConfirmDayHandler({ user: asTestUser,
      environment: env,
      now: () => t0,
      repository: () => repository,
    })(post("planning/confirm", {
      receipt: last.saveOffer.receipt,
      title: "独立测试修改",
      acknowledgeUnknowns: true,
    }));
    expect(saved.status).toBe(201);
    return (await saved.json()).journeyId as string;
  }

  /** Current saved order as oracle stops plus the persistent activity IDs. */
  async function facts(journeyId: string) {
    const stored = (await repository.findCurrentJourney(journeyId))!;
    const details = stored.dayDetails!;
    if (details.schemaVersion === "stored-day-plan.v3") throw new Error("This oracle reads v1/v2 only");
    const draft = details.schemaVersion === "stored-day-plan.v1"
      ? details.planning.draft
      : details.facts.draft;
    const placesOf = details.schemaVersion === "stored-day-plan.v1"
      ? details.planning.places
      : details.facts.places;
    const placeIndex = (placeId: string) =>
      index(placesOf.find((place) => place.placeId === placeId)!.selection.place.ref.externalId);
    const stops: Stop[] = draft.activities.map((activity) => ({
      place: placeIndex(activity.placeId),
      role: activity.role,
      stay: activity.stayMinutes,
      ...(activity.role === "fixed"
        ? { fixed: [activity.startsAt, activity.endsAt] as [number, number] }
        : {}),
    }));
    const ids = draft.activities.map((activity) =>
      details.activityBindings.find((item) => item.draftActivityId === activity.activityId)!.activityId);
    return {
      stored,
      draft,
      stops,
      ids,
      start: placeIndex(draft.startPlace.placeId),
      end: placeIndex(draft.endPlace.placeId),
    };
  }
  const timesOf = (draft: { activities: { startsAt: number; endsAt: number; waitMinutes: number }[] }) =>
    draft.activities.map((item) => [item.startsAt, item.endsAt, item.waitMinutes]);

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${DB}`);
    const url = new URL(safe);
    url.pathname = `/${DB}`;
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.close();
  });

  const fourStops = [
    { place: 1, role: "required", stayMinutes: 60 },
    { place: 3, role: "optional", stayMinutes: 30 },
    { place: 5, role: "optional", stayMinutes: 45 },
    { place: 6, role: "fixed", startsAt: "13:00", endsAt: "14:00" },
  ];

  it("matches hand-derived times at the exact feasibility boundary and rejects one minute more", async () => {
    const journeyId = await saveJourney(fourStops);
    const v1 = await facts(journeyId);
    const base = oracle(v1.stops, v1.start, v1.end);
    expect(base.ok && [base.times, base.endArrival]).toEqual([timesOf(v1.draft), v1.draft.endArrival]);

    const target = v1.stops.findIndex((stop) => stop.role === "optional" || stop.role === "discovered");
    const withStay = (stay: number) =>
      oracle(v1.stops.map((stop, i) => (i === target ? { ...stop, stay } : stop)), v1.start, v1.end);
    let limit = 15;
    while (limit < 240 && withStay(limit + 1).ok) limit += 1;
    expect(limit, "scenario must bind inside 15–240").toBeLessThan(240);
    // An unchanged stay is refused as "no change", so step one minute below a tight plan.
    const feasible = limit === v1.stops[target].stay ? limit - 1 : limit;

    const edge = await preview(journeyId, { kind: "change_stay", activityId: v1.ids[target], stayMinutes: feasible });
    expect(edge.body.status).toBe("ready");
    const expected = withStay(feasible);
    expect(expected.ok && [expected.times, expected.endArrival])
      .toEqual([timesOf(edge.body.draft), edge.body.draft.endArrival]);
    // Prefix before the target and every fixed slot are untouched.
    expect(edge.body.draft.activities.slice(0, target)).toEqual(v1.draft.activities.slice(0, target));
    v1.draft.activities.forEach((activity, i) => {
      if (activity.role === "fixed") {
        expect(edge.body.draft.activities[i]).toMatchObject({ startsAt: activity.startsAt, endsAt: activity.endsAt });
      }
    });

    const over = await preview(journeyId, { kind: "change_stay", activityId: v1.ids[target], stayMinutes: limit + 1 });
    const failure = withStay(limit + 1);
    expect(over.body.status).toBe("not_feasible");
    expect(over.body.issues.map((issue: { code: string }) => issue.code))
      .toContain(!failure.ok && failure.code);
    expect(await versions(journeyId)).toBe(1);
  });

  it("replaces with the end place as a same-place stop, but never with the start or an unknown place", async () => {
    const journeyId = await saveJourney(fourStops);
    const v1 = await facts(journeyId);
    // The last soft stop, so the end place (also the replacement) becomes a same-place leg.
    const soft = v1.stops.map((stop, i) => (stop.role === "optional" || stop.role === "discovered" ? i : -1));
    const target = Math.max(...soft);
    expect(target).toBe(v1.stops.length - 1);
    const cafe = directory[7].ref.externalId;
    const reply = await preview(journeyId, {
      kind: "replace", activityId: v1.ids[target], externalId: cafe, stayMinutes: 20,
    });
    const expected = oracle(
      v1.stops.map((stop, i) => (i === target ? { ...stop, place: 7, stay: 20, role: "optional" } : stop)),
      v1.start,
      v1.end,
    );
    if (expected.ok) {
      expect(reply.body.status).toBe("ready");
      expect([timesOf(reply.body.draft), reply.body.draft.endArrival]).toEqual([expected.times, expected.endArrival]);
      expect(reply.body.draft.activities[target]).toMatchObject({ role: "optional", stayMinutes: 20 });
      expect(reply.body.draft.endArrival).toBe(reply.body.draft.activities[target].endsAt);
    } else {
      expect(reply.body.status).toBe("not_feasible");
    }
    for (const externalId of [directory[0].ref.externalId, "DEMO-NOT-IN-CATALOG"]) {
      const refused = await preview(journeyId, {
        kind: "replace", activityId: v1.ids[target], externalId, stayMinutes: 20,
      });
      expect([400, 422], externalId).toContain(refused.status);
    }
    expect(await versions(journeyId)).toBe(1);
  });

  it("refuses previews and receipts built on an older version or after an observation exists", async () => {
    const journeyId = await saveJourney(fourStops);
    const v1 = await facts(journeyId);
    const optional = v1.ids.filter((_, i) => v1.stops[i].role === "optional" || v1.stops[i].role === "discovered");
    const a = await preview(journeyId, { kind: "change_stay", activityId: optional[0], stayMinutes: 20 });
    const b = await preview(journeyId, { kind: "remove", activityId: optional.at(-1) });
    expect([a.body.status, b.body.status]).toEqual(["ready", "ready"]);
    expect((await confirm(journeyId, a.body.receipt)).status).toBe(201);
    expect((await preview(journeyId, { kind: "change_stay", activityId: optional[0], stayMinutes: 25 }, 1)).status).toBe(409);
    expect((await confirm(journeyId, b.body.receipt)).status).toBe(409);

    // A later travel observation must invalidate pre-departure edits on the current version.
    const c = await preview(journeyId, { kind: "change_stay", activityId: optional[0], stayMinutes: 25 }, 2);
    expect(c.body.status).toBe("ready");
    // S5.3.3: a pointer > 0 needs its saved report (a missing one fails closed), so add a real one.
    await client.pool.query(`INSERT INTO generated_day_progress
      (journey_id, version, previous_version, base_plan_version, report_id, intent_fingerprint,
       observed_at, earliest_resume_at, completed_activity_ids, skipped_activity_ids,
       location_place_id, source, recorded_at)
      SELECT id, 1, 0, 2, gen_random_uuid(), repeat('a', 64),
        (date + time '09:00') AT TIME ZONE 'Asia/Shanghai', (date + time '09:00') AT TIME ZONE 'Asia/Shanghai',
        '{}', '{}', NULL, 'user_reported', updated_at
      FROM journeys WHERE id = $1`, [journeyId]);
    await client.pool.query("UPDATE journeys SET current_observation_version = 1 WHERE id = $1", [journeyId]);
    try {
      expect((await preview(journeyId, { kind: "change_stay", activityId: optional[0], stayMinutes: 30 }, 2, 1)).status).toBe(409);
      expect((await confirm(journeyId, c.body.receipt)).status).toBe(409);
      expect(await versions(journeyId)).toBe(2);
    } finally {
      await client.pool.query("UPDATE journeys SET current_observation_version = 0 WHERE id = $1", [journeyId]);
      await client.pool.query("DELETE FROM generated_day_progress WHERE journey_id = $1", [journeyId]);
    }
  });

  it("keeps the last activity and refuses to edit a manual journey", async () => {
    const single = await saveJourney([{ place: 3, role: "optional", stayMinutes: 30 }]);
    const only = await facts(single);
    expect(only.ids).toHaveLength(1);
    const removal = await preview(single, { kind: "remove", activityId: only.ids[0] } satisfies DayEditChange);
    expect(removal.status).toBe(422);

    const manual = await createJourney({
      title: "独立手动行程",
      date: "2026-10-16",
      timeZone: "Asia/Shanghai",
      activities: [{ placeName: "手动地点", startsAt: "10:00", endsAt: "11:00", priority: "normal", kind: "activity" }],
    }, { repository, idGenerator: { next: () => randomUUID() }, clock: { now: () => new Date(t0) } });
    if (manual.status !== "created") throw new Error("manual creation failed");
    const stored = (await repository.findCurrentJourney(manual.journeyId))!;
    const refused = await preview(manual.journeyId, {
      kind: "change_stay", activityId: stored.currentPlan.activities[0].id, stayMinutes: 45,
    });
    expect(refused.status).toBe(403);
    expect(await versions(manual.journeyId)).toBe(1);
  });
});
