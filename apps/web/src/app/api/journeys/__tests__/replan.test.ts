import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import { replanStreamEventSchema, type ReplanOffer, type ReplanResult } from "@tripquest/application/day-replan";
import type { DayProgressCommand } from "@tripquest/application/day-progress";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createDraftSaveOffer } from "../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { createDayEditHandlers } from "../edit-handlers";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplanScriptedModel } from "@tripquest/agent/replanning";
import { PlanningFixtureProvider } from "@tripquest/providers/planning-fixture";
import { createReplanHandlers } from "../replan-handlers";
import { asTestUser, ownerId } from "../../../../test-support/users";

const t0 = Date.parse("2026-10-16T01:00:00Z"); // 09:00 in Hangzhou
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "s533-development-place-secret-0123456789abcdef",
  PLANNING_DRAFT_RECEIPT_SECRET: "s533-development-receipt-secret-0123456789abcdef",
};
const directory = planningFixturePlaces();
const post = (path: string, body: unknown) =>
  new Request(`http://localhost:3355/api/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3355",
      host: "localhost:3355",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.3 report → replan → confirm on PostgreSQL", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;
  let journeyId: string;

  const handlers = (now = t0, options = environment) =>
    createReplanHandlers({ environment: options, now: () => now, repository: () => repository });
  const current = async () => (await repository.findCurrentJourney(journeyId))!;
  const counts = async () => (await client.pool.query(`SELECT
    (SELECT count(*)::int FROM plan_versions) AS versions,
    (SELECT count(*)::int FROM generated_day_progress) AS reports,
    (SELECT count(*)::int FROM generated_day_replan_confirmations) AS replans,
    (SELECT count(*)::int FROM reservations) AS reservations,
    (SELECT current_observation_version FROM journeys LIMIT 1) AS observation,
    (SELECT creation_run_id::text || creation_intent_fingerprint FROM journeys LIMIT 1) AS identity
  `)).rows[0];
  async function report(overrides: Partial<DayProgressCommand> = {}, now = t0) {
    const stored = await current();
    const command: DayProgressCommand = {
      reportId: randomUUID(),
      basePlanVersion: stored.currentPlan.version,
      baseObservationVersion: stored.currentObservationVersion,
      completedActivityIds: [],
      skippedActivityIds: [],
      observedAt: "2026-10-16T09:00+08:00",
      earliestResumeAt: "2026-10-16T09:00+08:00",
      location: { kind: "unknown" },
      noCurrentActivity: true,
      ...overrides,
    };
    const response = await handlers(now).progress(post(`journeys/${journeyId}/progress`, command), journeyId);
    return { status: response.status, body: await response.json(), command };
  }
  async function replan(
    scope: "rest_of_day" | "until_next_fixed" = "rest_of_day",
    goal: "keep_as_much" | "less_walking" | "relaxed" = "keep_as_much",
    now = t0,
  ) {
    const stored = await current();
    const response = await handlers(now).replan(post(`journeys/${journeyId}/replan`, {
      basePlanVersion: stored.currentPlan.version,
      baseObservationVersion: stored.currentObservationVersion,
      scope,
      goal,
    }), journeyId);
    if (!response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      return { status: response.status, body: await response.json() };
    }
    const events = (await response.text()).trim().split("\n")
      .map((line) => replanStreamEventSchema.parse(JSON.parse(line)));
    const terminal = events.at(-1);
    if (terminal?.type !== "result") throw new Error("missing terminal result");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    return { status: response.status, result: terminal.result as ReplanResult, offer: terminal.offer as ReplanOffer | undefined };
  }
  const confirm = async (receipt: string, acknowledgeUnknowns = true, now = t0) => {
    const response = await handlers(now).confirm(
      post(`journeys/${journeyId}/replan/confirm`, { receipt, acknowledgeUnknowns }),
      journeyId,
    );
    return { status: response.status, body: await response.json() };
  };
  const placeOf = (stored: Awaited<ReturnType<typeof current>>, activityId: string) =>
    stored.currentPlan.activities.find((item) => item.id === activityId)!.placeId;

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s533_dev_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s533_dev_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s533_dev_test";
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s533_dev_test WITH (FORCE)");
    await admin?.close();
  });
  beforeEach(async () => {
    await client.pool.query("TRUNCATE journeys CASCADE");
    const token = (index: number) => issuePlaceToken(
      { place: directory[index], evidence: planningFixtureEvidence(t0) },
      environment.PLANNING_PLACE_TOKEN_SECRET!,
      "fixture",
      t0,
    );
    // Real S5.2 generation and S5.3.1 save produce the v1 this stage starts from.
    const generate = createDraftHandler(
      () => createGenerationService({ environment, now: () => t0 }),
      (snapshot, result) => createDraftSaveOffer(snapshot, result, { environment, now: t0 }),
      undefined,
      asTestUser,
    );
    const response = await generate(post("planning/draft", {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: "2026-10-16",
      window: { startsAt: "09:00", endsAt: "17:00" },
      startPlace: token(0),
      endPlace: token(4),
      interests: ["nature"],
      pace: "relaxed",
      visits: [
        { token: token(1), role: "required", stayMinutes: 60 },
        { token: token(5), role: "fixed", startsAt: "13:00", endsAt: "14:00" },
        { token: token(2), role: "optional", stayMinutes: 60 },
      ],
    }));
    const terminal = dayStreamEventSchema.parse(JSON.parse((await response.text()).trim().split("\n").at(-1)!));
    if (terminal.type !== "result" || terminal.saveOffer?.status !== "available") {
      throw new Error("Actual generation failed");
    }
    const saved = await createConfirmDayHandler({ user: asTestUser,
      environment, now: () => t0, repository: () => repository,
    })(post("planning/confirm", {
      receipt: terminal.saveOffer.receipt, title: "途中调整开发自检", acknowledgeUnknowns: true,
    }));
    expect(saved.status).toBe(201);
    journeyId = (await saved.json()).journeyId;
  });

  /** v1 order: museum A (required), garden 13:00–14:00 (fixed), museum B (optional). */
  async function ids() {
    const stored = await current();
    const [museumA, garden, museumB] = stored.currentPlan.activities.map((item) => item.id);
    return { stored, museumA, garden, museumB };
  }

  it("saves reports as state only: replay, conflicts, cumulative rules, no_change, obs0 edit closed", async () => {
    const { stored, museumA, garden } = await ids();
    const before = await counts();
    // Non-prefix progress and an unknown location are legal facts.
    const first = await report({
      completedActivityIds: [garden],
      observedAt: "2026-10-16T09:40+08:00",
      earliestResumeAt: "2026-10-16T09:45+08:00",
    });
    expect(first).toMatchObject({ status: 201, body: { status: "saved", observationVersion: 1 } });
    const replay = await handlers().progress(post(`journeys/${journeyId}/progress`, first.command), journeyId);
    expect(await replay.json(), "same report replays").toEqual({ status: "already_saved", observationVersion: 1 });
    const conflict = await handlers().progress(post(`journeys/${journeyId}/progress`, {
      ...first.command, earliestResumeAt: "2026-10-16T09:50+08:00",
    }), journeyId);
    expect(conflict.status, "same reportId, other facts").toBe(409);
    expect((await report({ baseObservationVersion: 0 })).status, "stale base").toBe(409);
    for (const bad of [
      { completedActivityIds: [] },                                   // undoing a completion
      { completedActivityIds: [garden], skippedActivityIds: [garden] }, // complete and skip
      { completedActivityIds: [garden, randomUUID()] },               // not a member
      { completedActivityIds: [garden], observedAt: "2026-10-16T09:30+08:00" }, // backwards
      { completedActivityIds: [garden], observedAt: "2026-10-17T10:00+08:00",
        earliestResumeAt: "2026-10-17T10:00+08:00" },                // another day
      { completedActivityIds: [garden], location: { kind: "known" as const, placeId: randomUUID() } },
    ]) {
      expect((await report({ observedAt: "2026-10-16T09:40+08:00", earliestResumeAt: "2026-10-16T09:45+08:00", ...bad })).status)
        .toBe(422);
    }
    const same = await report({
      completedActivityIds: [garden],
      observedAt: "2026-10-16T09:40+08:00",
      earliestResumeAt: "2026-10-16T09:45+08:00",
    });
    expect(same.body, "identical facts add nothing").toEqual({ status: "no_change", observationVersion: 1 });
    // Unknown location blocks replanning without any model or route request.
    expect(await replan()).toMatchObject({ status: 422, body: { status: "needs_information", reason: "location_unknown" } });
    const after = await counts();
    expect(after).toEqual({ ...before, reports: 1, observation: 1 });
    // Reports never change the plan, reservations or creation identity; obs0 editing closes.
    expect((await current()).currentPlan).toEqual(stored.currentPlan);
    const edit = await createDayEditHandlers({ environment, now: () => t0, repository: () => repository })
      .preview(post(`journeys/${journeyId}/edits/preview`, {
        basePlanVersion: 1, baseObservationVersion: 1,
        change: { kind: "change_stay", activityId: museumA, stayMinutes: 30 },
      }), journeyId);
    expect(edit.status).toBe(409);
    // Skipping a hard item is saved, but stops automatic replanning.
    const skipped = await report({
      completedActivityIds: [garden],
      skippedActivityIds: [museumA],
      observedAt: "2026-10-16T10:00+08:00",
      earliestResumeAt: "2026-10-16T10:00+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    expect(skipped.body).toEqual({ status: "saved", observationVersion: 2 });
    expect(await replan()).toMatchObject({
      status: 422,
      body: { status: "constraints_conflict", conflicts: [{ code: "hard_skipped", activityId: museumA }] },
    });
    const journey = await getJourney(journeyId, repository);
    expect(journey.status === "found" && journey.journey.dayProgress).toMatchObject({
      status: "reported", version: 2, skippedActivityIds: [museumA],
    });
  });

  it("previews without writing, confirms v2 as stored-day-plan.v3, replays, and keeps v1 and reservations", async () => {
    const { stored, museumA } = await ids();
    await report({
      completedActivityIds: [museumA],
      observedAt: "2026-10-16T10:30+08:00",
      earliestResumeAt: "2026-10-16T10:40+08:00",
      location: { kind: "known", placeId: placeOf(stored, museumA) },
    });
    const before = await counts();
    const run = await replan("rest_of_day");
    if (run.result?.status !== "completed" || run.result.outcome !== "candidate" || run.offer?.status !== "available") {
      throw new Error(JSON.stringify(run));
    }
    expect(await counts(), "a candidate writes nothing").toEqual(before);
    expect(run.result.candidate.archived).toEqual([expect.objectContaining({ key: museumA, status: "completed" })]);
    expect(run.result.candidate.resume).toMatchObject({ startsAt: 640 });
    expect(run.result.candidate.legs[0].fromKey).toBe(placeOf(stored, museumA));
    expect(run.result.candidate.activities.find((item) => item.role === "fixed"))
      .toMatchObject({ startsAt: 780, endsAt: 840 });
    expect(run.result.counts.model).toBeGreaterThan(0);
    expect((await confirm(run.offer.receipt, false)).body, "pending needs acknowledgment")
      .toEqual({ status: "acknowledgment_required" });
    const saved = await confirm(run.offer.receipt);
    expect(saved).toMatchObject({ status: 201, body: { status: "saved", planVersion: 2 } });
    expect(await confirm(run.offer.receipt), "replay").toMatchObject({ status: 200, body: { status: "already_saved", planVersion: 2 } });
    const after = await counts();
    expect(after).toEqual({ ...before, versions: before.versions + 1, replans: 1 });
    const read = await getJourney(journeyId, repository);
    if (read.status !== "found") throw new Error("missing");
    expect(read.journey.dayDetails?.schemaVersion).toBe("stored-day-plan.v3");
    expect(read.journey.activities.map((item) => item.id)).toEqual(
      run.result.candidate.activities.map((item) => item.key),
    );
    const v1 = await getJourney(journeyId, repository, 1);
    expect(v1.status === "found" && v1.journey.activities.map((a) => a.id)).toEqual(stored.currentPlan.activities.map((a) => a.id));
    expect(v1.status === "found" && v1.journey.dayProgress, "history has no live overlay").toBeUndefined();
  });

  it("replans a v3 again: empty target segment before the anchor, a discovered stop, then zero future activities", async () => {
    const { stored, museumA, garden, museumB } = await ids();
    await report({
      completedActivityIds: [museumA],
      observedAt: "2026-10-16T10:20+08:00",
      earliestResumeAt: "2026-10-16T10:30+08:00",
      location: { kind: "known", placeId: placeOf(stored, museumA) },
    });
    // until_next_fixed: nothing adjustable before the garden; the Agent may add a nearby stop.
    const segment = await replan("until_next_fixed");
    if (segment.result?.status !== "completed" || segment.result.outcome !== "candidate" || segment.offer?.status !== "available") {
      throw new Error(JSON.stringify(segment));
    }
    const planned = segment.result.candidate.activities;
    expect(planned.at(-2), "anchor frozen").toMatchObject({ key: garden, frozen: true, startsAt: 780, endsAt: 840 });
    expect(planned.at(-1), "tail frozen").toMatchObject({ key: museumB, frozen: true });
    const added = planned.filter((item) => item.origin === "discovered");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ role: "discovered", staySource: "system_estimate", frozen: false });
    expect(segment.result.counts).toMatchObject({ baseline: 1, searches: 1 });
    expect((await confirm(segment.offer.receipt)).body).toMatchObject({ status: "saved", planVersion: 2 });

    // Report on the v3: the discovered stop and the fixed garden are done.
    const v2 = await current();
    const discoveredId = v2.currentPlan.activities[0].id;
    expect(discoveredId).not.toBe(museumA);
    await report({
      completedActivityIds: [museumA, discoveredId, garden],
      observedAt: "2026-10-16T14:00+08:00",
      earliestResumeAt: "2026-10-16T15:50+08:00",
      location: { kind: "known", placeId: placeOf(v2, garden) },
    });
    // Keeping museum B misses 17:00; the policy drops it and the direct leg to the end fits.
    const tail = await replan("rest_of_day");
    if (tail.result?.status !== "completed" || tail.result.outcome !== "candidate" || tail.offer?.status !== "available") {
      throw new Error(JSON.stringify(tail));
    }
    expect(tail.result.comparison.baseline).toMatchObject({
      status: "not_scheduled", issues: [{ code: "day_window_exceeded" }],
    });
    expect(tail.result.chosen).toBe("agent");
    expect(tail.result.candidate.activities).toEqual([]);
    expect(tail.result.candidate.legs).toHaveLength(1);
    expect(tail.result.comparison.changes).toEqual([expect.objectContaining({ key: museumB, change: "removed" })]);
    expect((await confirm(tail.offer.receipt)).body).toMatchObject({ status: "saved", planVersion: 3 });
    const v3 = await getJourney(journeyId, repository);
    if (v3.status !== "found" || v3.journey.dayDetails?.schemaVersion !== "stored-day-plan.v3") throw new Error("v3");
    expect(v3.journey.activities, "zero future rows read back").toEqual([]);
    expect(v3.journey.dayDetails.archived.map((item) => [item.record.activity.activityId, item.status]))
      .toEqual([[museumA, "completed"], [discoveredId, "completed"], [garden, "completed"]]);
    // A removed activity is not a reported skip, and the fixed booking stays unknown.
    expect(v3.journey.dayDetails.progressBasis.skippedActivityIds).toEqual([]);
    const reservation = (await client.pool.query("SELECT confirmation_status FROM reservations")).rows;
    expect(reservation).toEqual([{ confirmation_status: "unknown" }]);

    // Damaged v3 facts or a pointer without its report fail closed instead of reading through.
    await client.pool.query(`UPDATE day_plan_details
      SET details = jsonb_set(details, '{future,resumesAt}', to_jsonb((details->'future'->>'resumesAt')::int - 5))
      WHERE plan_version = 3`);
    await expect(getJourney(journeyId, repository)).rejects.toThrow();
    await client.pool.query(`UPDATE day_plan_details
      SET details = jsonb_set(details, '{future,resumesAt}', to_jsonb((details->'future'->>'resumesAt')::int + 5))
      WHERE plan_version = 3`);
    expect((await getJourney(journeyId, repository)).status).toBe("found");
    await client.pool.query("UPDATE journeys SET current_observation_version = 9");
    await expect(getJourney(journeyId, repository)).rejects.toThrow();
  });

  it("stops correctly after bounded attempts and refuses impossible facts before any model call", async () => {
    const { stored, museumA, garden } = await ids();
    await report({
      completedActivityIds: [museumA, garden],
      observedAt: "2026-10-16T14:00+08:00",
      earliestResumeAt: "2026-10-16T16:58+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    const stopped = await replan();
    expect(stopped.result).toMatchObject({
      status: "completed", outcome: "bounded_no_candidate", reason: "constraints_not_met",
      counts: { baseline: 1, tries: 1 },
    });
    expect(stopped.offer).toBeUndefined();
    expect((await current()).dayProgress?.version, "the report survives").toBe(1);
    await report({
      completedActivityIds: [museumA, garden],
      observedAt: "2026-10-16T17:00+08:00",
      earliestResumeAt: "2026-10-16T17:00+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    expect((await replan()).body).toMatchObject({ status: "constraints_conflict", conflicts: [{ code: "resume_after_end" }] });
  });

  it("fixed booking already passed, invalid scope and receipts bound to stale versions", async () => {
    const { stored, museumA } = await ids();
    await report({
      observedAt: "2026-10-16T13:30+08:00",
      earliestResumeAt: "2026-10-16T13:30+08:00",
      location: { kind: "known", placeId: placeOf(stored, museumA) },
    });
    expect((await replan()).body).toMatchObject({ status: "constraints_conflict", conflicts: [{ code: "fixed_passed" }] });

    const garden = stored.currentPlan.activities[1].id;
    await report({
      completedActivityIds: [museumA, garden],
      observedAt: "2026-10-16T14:00+08:00",
      earliestResumeAt: "2026-10-16T14:05+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    expect((await replan("until_next_fixed")).body, "no fixed left").toEqual({ status: "invalid_scope" });
    const offered = await replan("rest_of_day", "relaxed");
    if (offered.offer?.status !== "available") throw new Error(JSON.stringify(offered));
    const [encoded, signature] = offered.offer.receipt.split(".");
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(encoded, "base64url").toString()), goal: "keep_as_much",
    })).toString("base64url");
    expect((await confirm(`${forged}.${signature}`)).status, "tampered").toBe(403);
    expect((await confirm(offered.offer.receipt, true, t0 + 15 * 60 * 1000)).status, "expired").toBe(410);
    // A newer report makes the candidate stale; nothing is written.
    await report({
      completedActivityIds: [museumA, garden],
      observedAt: "2026-10-16T14:10+08:00",
      earliestResumeAt: "2026-10-16T14:15+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    const before = await counts();
    expect((await confirm(offered.offer.receipt)).body).toEqual({ status: "stale" });
    expect(await counts()).toEqual(before);
  });

  it("lets only one writer win across replans and reports, and rolls back a failing late step", async () => {
    const { stored, museumA } = await ids();
    await report({
      completedActivityIds: [museumA],
      observedAt: "2026-10-16T10:30+08:00",
      earliestResumeAt: "2026-10-16T10:40+08:00",
      location: { kind: "known", placeId: placeOf(stored, museumA) },
    });
    const a = await replan();
    const b = await replan("rest_of_day", "relaxed");
    if (a.offer?.status !== "available" || b.offer?.status !== "available") throw new Error("offers");
    // Late step fails: nothing from this confirmation remains.
    await client.pool.query(`CREATE FUNCTION s533_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 's533 late failure'; END $$ LANGUAGE plpgsql`);
    await client.pool.query(`CREATE TRIGGER s533_fail BEFORE INSERT ON generated_day_replan_confirmations
      FOR EACH ROW EXECUTE FUNCTION s533_fail()`);
    const before = await counts();
    try {
      expect(await confirm(a.offer.receipt)).toMatchObject({ status: 503, body: { status: "temporarily_unavailable" } });
      expect(await counts(), "full rollback").toEqual(before);
    } finally {
      await client.pool.query("DROP TRIGGER s533_fail ON generated_day_replan_confirmations");
      await client.pool.query("DROP FUNCTION s533_fail()");
    }
    const [first, second] = await Promise.all([confirm(a.offer.receipt), confirm(b.offer.receipt)]);
    expect([first.body.status, second.body.status].sort()).toEqual(["saved", "stale"]);
    // An identical replan of the new version is "unchanged" and gets no receipt.
    const again = await replan();
    expect(again.result).toMatchObject({ status: "completed", outcome: "unchanged" });
    expect(again.offer).toBeUndefined();
    // State and plan writers race on the same root lock: at most one new write.
    const v2 = await current();
    const at = { kind: "known" as const, placeId: placeOf(v2, v2.currentPlan.activities[0].id) };
    // Whichever won, pick a goal that must change the remaining day.
    const relaxedWon = v2.currentPlan.activities.length === 1;
    if (relaxedWon) {
      await report({
        completedActivityIds: [museumA, v2.currentPlan.activities[0].id],
        observedAt: "2026-10-16T14:00+08:00",
        earliestResumeAt: "2026-10-16T14:00+08:00",
        location: at,
      });
    }
    const c = await replan("rest_of_day", relaxedWon ? "keep_as_much" : "relaxed");
    if (c.offer?.status !== "available") throw new Error(JSON.stringify(c));
    const [plan, state] = await Promise.all([
      confirm(c.offer.receipt),
      report({
        completedActivityIds: relaxedWon ? [museumA, v2.currentPlan.activities[0].id] : [museumA],
        observedAt: "2026-10-16T14:10+08:00",
        earliestResumeAt: "2026-10-16T14:20+08:00",
        location: at,
      }),
    ]);
    const wins = [plan.status === 201, state.status === 201].filter(Boolean);
    expect(wins).toHaveLength(1);
    expect([plan.status, state.status]).toContain(409);
  });

  it("guards Agent actions before any route, stops on a second violation, honours cancel and the s533 budget", async () => {
    const { stored, museumA, garden } = await ids();
    await report({
      completedActivityIds: [museumA],
      observedAt: "2026-10-16T10:30+08:00",
      earliestResumeAt: "2026-10-16T10:40+08:00",
      location: { kind: "known", placeId: placeOf(stored, museumA) },
    });
    const provider = new PlanningFixtureProvider(() => t0);
    const routes = vi.spyOn(provider, "findRoutes");
    const contexts: unknown[] = [];
    // The garden is the frozen anchor of until_next_fixed; listing it is out of scope.
    const model = createReplanScriptedModel((context) => {
      contexts.push(context);
      return { action: "try_replan", orderedActivityIds: [context.frozenOrder[0]] };
    });
    const run = (options: Parameters<typeof createReplanHandlers>[0], signal?: AbortSignal) =>
      createReplanHandlers({ repository: () => repository, now: () => t0, ...options })
        .replan(new Request(`http://localhost:3355/api/journeys/${journeyId}/replan`, {
          method: "POST",
          headers: { origin: "http://localhost:3355", host: "localhost:3355", "content-type": "application/json" },
          body: JSON.stringify({ basePlanVersion: 1, baseObservationVersion: 1, scope: "until_next_fixed", goal: "keep_as_much" }),
          signal,
        }), journeyId);
    const terminal = async (response: Response) =>
      replanStreamEventSchema.parse(JSON.parse((await response.text()).trim().split("\n").at(-1)!));
    const guarded = await terminal(await run({ environment, model, provider }));
    expect(guarded.type === "result" && guarded.result).toMatchObject({
      status: "failed", code: "semantic_invalid", counts: { model: 2, semanticRepairs: 1, tries: 0 },
    });
    expect((contexts[1] as { feedback: { code: string } }).feedback.code).toBe("day_frozen_changed");
    const baselineRoutes = routes.mock.calls.length;
    expect(baselineRoutes, "only the baseline queried routes").toBeGreaterThan(0);
    expect(JSON.stringify(contexts[0]), "no UUIDs or receipts reach the model").not.toContain(garden);

    const abort = new AbortController();
    const slow = createReplanScriptedModel(() => {
      abort.abort();
      return { action: "finish", attemptId: "baseline" };
    });
    const cancelled = await terminal(await run({ environment, model: slow, provider }, abort.signal));
    expect(cancelled.type === "result" && cancelled.result.status).toBe("cancelled");
    expect(cancelled.type === "result" && cancelled.offer, "no receipt after cancel").toBeUndefined();

    // fixture+live wiring with a stand-in model: one run per round in the s533 ledger.
    const workspace = mkdtempSync(join(tmpdir(), "s533-budget-"));
    try {
      const live: NodeJS.ProcessEnv = {
        ...environment, NODE_ENV: "development", PLANNING_MODEL_MODE: "live",
        AGENT_LIVE_ENABLED: "true", AGENT_MODEL_PROFILE: "stand-in", REPLANNING_LIVE_ROUND: "developer",
      };
      const standIn = { ...createReplanScriptedModel(), mode: "live" as const };
      await import("node:fs").then((fs) => fs.writeFileSync(join(workspace, "agent-models.local.json"), "{}"));
      const first = await terminal(await run({ environment: live, model: standIn, provider, workspaceRoot: workspace }));
      expect(first.type === "result" && first.result.status).toBe("completed");
      const ledger = readFileSync(join(workspace, "eval-results/s533-live-budget.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(ledger.map((entry) => entry.kind)).toEqual(["run", "result"]);
      expect(ledger[0]).toMatchObject({ round: "developer", purpose: "replan-fixture-live" });
      const second = await run({ environment: live, model: standIn, provider, workspaceRoot: workspace });
      expect(second.status, "one fixture+live run per round").toBe(503);
      const production = await run({ environment: { ...live, NODE_ENV: "production" }, model: standIn, provider, workspaceRoot: workspace });
      expect(await production.json()).toMatchObject({ status: "disabled" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
