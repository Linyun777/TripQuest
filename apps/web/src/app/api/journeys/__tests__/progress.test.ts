import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import type { DayProgressCommand } from "@tripquest/application/day-progress";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createDraftSaveOffer } from "../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { createDayEditHandlers } from "../edit-handlers";
import { createProgressHandlers } from "../progress-handlers";
import { asTestUser, ownerId } from "../../../../test-support/users";

// S5.3.3 的进度报告（原来和途中重排在一个测试文件里；V3.6 删了重排，报告的用例原样留下）。
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

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.3 progress reports on PostgreSQL", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;
  let journeyId: string;

  const handlers = (overrides: Parameters<typeof createProgressHandlers>[0] = {}) =>
    createProgressHandlers({ environment, now: () => t0, repository: () => repository, ...overrides });
  const current = async () => (await repository.findCurrentJourney(journeyId))!;
  const counts = async () => (await client.pool.query(`SELECT
    (SELECT count(*)::int FROM plan_versions) AS versions,
    (SELECT count(*)::int FROM generated_day_progress) AS reports,
    (SELECT count(*)::int FROM reservations) AS reservations,
    (SELECT current_observation_version FROM journeys LIMIT 1) AS observation,
    (SELECT creation_run_id::text || creation_intent_fingerprint FROM journeys LIMIT 1) AS identity
  `)).rows[0];
  async function report(overrides: Partial<DayProgressCommand> = {}) {
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
    const response = await handlers().progress(post(`journeys/${journeyId}/progress`, command), journeyId);
    return { status: response.status, body: await response.json(), command };
  }
  const placeOf = (stored: Awaited<ReturnType<typeof current>>, activityId: string) =>
    stored.currentPlan.activities.find((item) => item.id === activityId)!.placeId;

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_progress_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_progress_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_progress_test";
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_progress_test WITH (FORCE)");
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
    // Real S5.2 generation and S5.3.1 save produce the v1 the reports start from.
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
      receipt: terminal.saveOffer.receipt, title: "进度报告自检", acknowledgeUnknowns: true,
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
    // Skipping a hard item is saved as a fact.
    const skipped = await report({
      completedActivityIds: [garden],
      skippedActivityIds: [museumA],
      observedAt: "2026-10-16T10:00+08:00",
      earliestResumeAt: "2026-10-16T10:00+08:00",
      location: { kind: "known", placeId: placeOf(stored, garden) },
    });
    expect(skipped.body).toEqual({ status: "saved", observationVersion: 2 });
    const journey = await getJourney(journeyId, repository);
    expect(journey.status === "found" && journey.journey.dayProgress).toMatchObject({
      status: "reported", version: 2, skippedActivityIds: [museumA],
    });
  });

  it("writes simultaneous identical reports once and replays after later facts and a disabled switch", async () => {
    const stored = await current();
    const command: DayProgressCommand = {
      reportId: randomUUID(), basePlanVersion: 1, baseObservationVersion: 0,
      completedActivityIds: [stored.currentPlan.activities[0].id, stored.currentPlan.activities[2].id],
      skippedActivityIds: [], observedAt: "2026-10-16T11:00+08:00",
      earliestResumeAt: "2026-10-16T11:20+08:00",
      location: { kind: "known", placeId: stored.currentPlan.activities[2].placeId }, noCurrentActivity: true,
    };
    const send = async (service: ReturnType<typeof handlers>, body = command) => {
      const response = await service.progress(post(`journeys/${journeyId}/progress`, body), journeyId);
      return response.json();
    };
    const results = await Promise.all([send(handlers()), send(handlers())]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_saved", "saved"]);
    expect((await counts()).reports).toBe(1);
    expect((await report({
      completedActivityIds: command.completedActivityIds,
      observedAt: "2026-10-16T11:30+08:00", earliestResumeAt: "2026-10-16T11:30+08:00",
      location: command.location,
    })).status).toBe(201);
    const replay = await send(handlers({ environment: { ...environment, PLANNING_SAVE_ENABLED: "false" } }), {
      ...command, completedActivityIds: [...command.completedActivityIds].reverse(),
    });
    expect(replay).toEqual({ status: "already_saved", observationVersion: 1 });
    expect((await current()).currentObservationVersion).toBe(2);
  });

  it("rolls back an inserted report when the root update fails, then accepts the same intent", async () => {
    await client.pool.query(`CREATE FUNCTION s533_it_fail_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.current_observation_version > OLD.current_observation_version THEN
      RAISE EXCEPTION 'independent report failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER s533_it_report_failure BEFORE UPDATE ON journeys
      FOR EACH ROW EXECUTE FUNCTION s533_it_fail_report()`);
    let command: DayProgressCommand;
    try {
      const attempted = await report();
      command = attempted.command;
      expect(attempted).toMatchObject({ status: 503, body: { status: "temporarily_unavailable" } });
      expect(await counts()).toMatchObject({ versions: 1, reports: 0, observation: 0 });
    } finally {
      await client.pool.query("DROP TRIGGER s533_it_report_failure ON journeys; DROP FUNCTION s533_it_fail_report()");
    }
    const retry = await handlers().progress(post(`journeys/${journeyId}/progress`, command!), journeyId);
    expect(retry.status).toBe(201);
    expect(await counts()).toMatchObject({ versions: 1, reports: 1, observation: 1 });
  });
});
