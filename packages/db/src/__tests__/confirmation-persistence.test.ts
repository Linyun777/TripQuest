import { confirmJourneyAdjustment, type ConfirmedAdjustmentDraft } from "@tripquest/application";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "dotenv";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleJourneyRepository } from "../repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

// Expectations are hand derived from the S3.4 design contract: the migration must
// be reproducible from an existing v1 database, one confirmation must leave v1
// historical and create exactly one v2 plus one observation and one confirmation,
// an idempotent retry must add nothing, and a losing concurrent confirmation must
// not write. Concurrency is driven by real overlapping promises, not by sleeping.
config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const JOURNEY = "70000000-0000-4000-8000-000000000001";
const MUSEUM = "70000000-0000-4000-8000-000000000002";
const MUSEUM_PLACE = "70000000-0000-4000-8000-000000000003";
const CAFE = "70000000-0000-4000-8000-000000000009";
const CAFE_PLACE = "70000000-0000-4000-8000-00000000000a";
const AFTERNOON = "70000000-0000-4000-8000-000000000004";
const AFTERNOON_PLACE = "70000000-0000-4000-8000-000000000005";
const DINNER = "70000000-0000-4000-8000-000000000006";
const DINNER_PLACE = "70000000-0000-4000-8000-000000000007";
const RESERVATION = "70000000-0000-4000-8000-000000000008";
const KEY_A = "70000000-0000-4000-8000-0000000000a1";
const KEY_B = "70000000-0000-4000-8000-0000000000a2";
const DATE = "2026-10-15";

const testDatabaseUrl = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

describe("S3.4 confirmation persistence", () => {
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(testDatabaseUrl, { applicationName: "tripquest-s34-confirm", maxConnections: 4 });
    await migrate(client.database, { migrationsFolder: DRIZZLE_DIR });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.pool.query("TRUNCATE TABLE journeys CASCADE");
    await client.close();
  });

  async function seedVersionOne(): Promise<void> {
    await client.pool.query("TRUNCATE TABLE journeys CASCADE");
    await client.pool.query(
      `INSERT INTO journeys (id, user_id, title, date, time_zone, created_at, updated_at) VALUES ($1,(SELECT id FROM users WHERE username = 'owner'),'虚构市一日行程',$2,'Asia/Shanghai',$3,$3)`,
      [JOURNEY, DATE, `${DATE}T00:05:00+08:00`],
    );
    await client.pool.query(
      `INSERT INTO plan_versions (journey_id, version, change_reason, is_current, created_at) VALUES ($1,1,'initial_creation',true,$2)`,
      [JOURNEY, `${DATE}T00:05:00+08:00`],
    );
    await client.pool.query(
      `INSERT INTO reservations (id, journey_id, place_id, place_name, starts_at, ends_at, confirmation_status, source_kind, recorded_at) VALUES ($1,$2,$3,'固定晚餐',$4,$5,'confirmed','user_reported',$6)`,
      [RESERVATION, JOURNEY, DINNER_PLACE, `${DATE}T18:00:00+08:00`, `${DATE}T19:00:00+08:00`, `${DATE}T00:05:00+08:00`],
    );
    await client.pool.query(
      `INSERT INTO plan_activities (journey_id, plan_version, activity_id, position, place_id, place_name, starts_at, ends_at, priority, locked, reservation_id) VALUES
       ($1,1,$2,0,$3,'博物馆',$4,$5,'normal',false,NULL),
       ($1,1,$6,1,$7,'咖啡店',$8,$9,'normal',false,NULL),
       ($1,1,$10,2,$11,'下午馆',$12,$13,'normal',false,NULL),
       ($1,1,$14,3,$15,'固定晚餐',$16,$17,'high',true,$18)`,
      [JOURNEY, MUSEUM, MUSEUM_PLACE, `${DATE}T09:00:00+08:00`, `${DATE}T10:00:00+08:00`,
       CAFE, CAFE_PLACE, `${DATE}T11:00:00+08:00`, `${DATE}T12:00:00+08:00`,
       AFTERNOON, AFTERNOON_PLACE, `${DATE}T15:00:00+08:00`, `${DATE}T16:00:00+08:00`,
       DINNER, DINNER_PLACE, `${DATE}T18:00:00+08:00`, `${DATE}T19:00:00+08:00`, RESERVATION],
    );
  }

  /** Builds the confirmation the user would submit after seeing a fresh preview. */
  async function buildConfirmation(idempotencyKey: string, earliestResumeAt: string) {
    const { previewJourneyAdjustment } = await import("@tripquest/application");
    const preview = await previewJourneyAdjustment(
      { journeyId: JOURNEY, basePlanVersion: 1, observedAt: "14:30", earliestResumeAt, completedActivityIds: [MUSEUM, CAFE], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 40 },
      repository,
      () => "preview-request",
    );
    if (preview.status !== "candidate_found") throw new Error(`fixture is not confirmable: ${preview.status}`);
    return {
      journeyId: JOURNEY, basePlanVersion: 1, baseObservationVersion: 0, observedAt: "14:30", earliestResumeAt,
      completedActivityIds: [MUSEUM, CAFE], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 40,
      strategy: preview.strategy, semanticFingerprint: preview.semanticFingerprint, idempotencyKey,
    };
  }

  /** Submits a confirmation. A retry reuses the very same command, as a user would. */
  async function submit(command: unknown) {
    return confirmJourneyAdjustment(
      command,
      repository,
      { now: () => new Date("2026-10-15T02:00:00.000Z") },
      () => "confirm-request",
    );
  }

  async function previewThenConfirm(idempotencyKey: string, earliestResumeAt: string) {
    return submit(await buildConfirmation(idempotencyKey, earliestResumeAt));
  }

  async function counts() {
    const result = await client.pool.query<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM plan_versions)::text AS versions,
        (SELECT count(*) FROM plan_activities)::text AS activities,
        (SELECT count(*) FROM journey_observations)::text AS observations,
        (SELECT count(*) FROM plan_confirmations)::text AS confirmations,
        (SELECT count(*) FROM plan_versions WHERE is_current)::text AS current_versions,
        (SELECT count(*) FROM reservations)::text AS reservations,
        (SELECT coalesce(max(version),0) FROM plan_versions)::text AS max_version,
        (SELECT current_observation_version FROM journeys WHERE id = '${JOURNEY}')::text AS observation_version
    `);
    const row = result.rows[0] ?? {};
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }

  it("migrates an existing version 1 database and defaults the observation version to zero", async () => {
    const name = `${databaseName(testDatabaseUrl)}_v1upgrade`;
    const admin = createJourneyDatabase(withDatabase(testDatabaseUrl, "postgres"), { maxConnections: 1 });
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${name}`);

    // Apply only the first migration so the database looks like an S3.2 install.
    const staged = join(tmpdir(), `tripquest-migrate-${process.pid}`);
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(join(staged, "meta"), { recursive: true });
    copyFileSync(join(DRIZZLE_DIR, "0000_faithful_lady_ursula.sql"), join(staged, "0000_faithful_lady_ursula.sql"));
    const journal = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")),
    );
    writeFileSync(join(staged, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));

    const v1 = createJourneyDatabase(withDatabase(testDatabaseUrl, name), { maxConnections: 1 });
    try {
      await migrate(v1.database, { migrationsFolder: staged });
      const before = await v1.pool.query<{ present: boolean }>(
        "SELECT to_regclass('public.journey_observations') IS NOT NULL AS present",
      );
      expect(before.rows[0]?.present, "the new tables are absent before the upgrade").toBe(false);
      await v1.pool.query(
        `INSERT INTO journeys (id, title, date, time_zone, created_at, updated_at) VALUES ($1,'旧行程',$2,'Asia/Shanghai',$3,$3)`,
        [JOURNEY, DATE, `${DATE}T00:05:00+08:00`],
      );

      await migrate(v1.database, { migrationsFolder: DRIZZLE_DIR });

      const after = await v1.pool.query<{ version: number; title: string }>(
        "SELECT current_observation_version AS version, title FROM journeys WHERE id = $1",
        [JOURNEY],
      );
      expect(after.rows[0]?.version, "existing row defaults to no persisted observation").toBe(0);
      expect(after.rows[0]?.title, "existing row survives the upgrade").toBe("旧行程");
      const applied = await v1.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      expect(applied.rows[0]?.count, "eighteen migrations are recorded once").toBe("18");
    } finally {
      await v1.close();
      await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
      rmSync(staged, { recursive: true, force: true });
    }
  });

  it("turns v1 historical and writes exactly one v2, observation and confirmation", async () => {
    await seedVersionOne();
    const outcome = await previewThenConfirm(KEY_A, "15:30");

    expect(outcome, "committed").toEqual({ status: "committed", journeyId: JOURNEY, planVersion: 2, observationVersion: 1 });
    expect(await counts(), "one of each, v1 kept").toEqual({
      versions: 2, activities: 8, observations: 1, confirmations: 1,
      current_versions: 1, reservations: 1, max_version: 2, observation_version: 1,
    });

    const versions = await client.pool.query<{ version: number; parent_version: number | null; change_reason: string; is_current: boolean }>(
      "SELECT version, parent_version, change_reason, is_current FROM plan_versions ORDER BY version",
    );
    expect(versions.rows[0], "v1 is kept as history").toMatchObject({ version: 1, is_current: false });
    expect(versions.rows[1], "v2 points at v1 and says why").toMatchObject({
      version: 2, parent_version: 1, change_reason: "user_confirmed_adjustment", is_current: true,
    });

    const current = await repository.findCurrentJourney(JOURNEY);
    expect(current?.currentPlan.version, "reader follows current").toBe(2);
    expect(current?.currentObservationVersion, "reader exposes the observation version").toBe(1);
    expect(current?.currentPlan.activities.map((item) => item.id), "order and ids preserved").toEqual([MUSEUM, CAFE, AFTERNOON, DINNER]);
    expect(current?.currentPlan.activities[2], "afternoon shifted").toMatchObject({ startsAt: `${DATE}T15:30:00+08:00`, endsAt: `${DATE}T16:30:00+08:00` });
    expect(current?.currentPlan.activities[3], "the fixed reservation never moves").toMatchObject({
      startsAt: `${DATE}T18:00:00+08:00`, endsAt: `${DATE}T19:00:00+08:00`, locked: true, priority: "high", reservationId: RESERVATION,
    });

    const observation = await client.pool.query<{ source: string; completed_activity_ids: string[]; location_place_id: string; current_activity_id: string | null }>(
      "SELECT source, completed_activity_ids, location_place_id, current_activity_id FROM journey_observations",
    );
    expect(observation.rows[0]?.source, "recorded as a user report").toBe("user_reported");
    expect(observation.rows[0]?.completed_activity_ids, "the reported facts are stored").toEqual([MUSEUM, CAFE]);
    expect(observation.rows[0]?.location_place_id, "location is the target activity place").toBe(AFTERNOON_PLACE);
    expect(observation.rows[0]?.current_activity_id, "no running activity is stored as null").toBeNull();

    const confirmation = await client.pool.query<{ strategy: string; travel_source: string; transfer_buffer_minutes: number; result_plan_version: number; result_observation_version: number }>(
      "SELECT strategy, travel_source, transfer_buffer_minutes, result_plan_version, result_observation_version FROM plan_confirmations",
    );
    expect(confirmation.rows[0], "the confirmation records its basis").toMatchObject({
      strategy: "shift", travel_source: "user_estimate", transfer_buffer_minutes: 10,
      result_plan_version: 2, result_observation_version: 1,
    });
  });

  it("adds nothing when the same key retries the same intent", async () => {
    await seedVersionOne();
    const command = await buildConfirmation(KEY_A, "15:30");
    expect((await submit(command)).status, "first attempt commits").toBe("committed");
    const afterFirst = await counts();

    const retry = await submit(command);
    expect(retry, "retry reports the same saved version").toEqual({
      status: "already_committed", journeyId: JOURNEY, planVersion: 2, observationVersion: 1,
    });
    expect(await counts(), "a retry writes nothing at all").toEqual(afterFirst);
  });

  it("refuses the same key with different facts and writes nothing", async () => {
    await seedVersionOne();
    const command = await buildConfirmation(KEY_A, "15:30");
    await submit(command);
    const afterFirst = await counts();

    const conflict = await submit({ ...command, earliestResumeAt: "16:00" });
    expect(conflict.status, "same key, different intent").toBe("idempotency_conflict");
    expect(await counts(), "a conflict writes nothing").toEqual(afterFirst);
  });

  it("refuses a confirmation whose base observation version already moved", async () => {
    await seedVersionOne();
    await client.pool.query("UPDATE journeys SET current_observation_version = 5 WHERE id = $1", [JOURNEY]);
    const before = await counts();

    const stale = await previewThenConfirm(KEY_A, "15:30");
    expect(stale.status, "stale observation base").toBe("stale");
    expect(await counts(), "a stale confirmation writes nothing").toEqual(before);
  });

  it("lets only one of two concurrent confirmations on the same base version win", async () => {
    await seedVersionOne();

    // Two real overlapping confirmations, each with its own idempotency key.
    const [first, second] = await Promise.all([
      previewThenConfirm(KEY_A, "15:30"),
      previewThenConfirm(KEY_B, "15:30"),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses.filter((status) => status === "committed"), "exactly one writer wins").toHaveLength(1);
    expect(
      statuses.filter((status) => status === "stale" || status === "preview_changed" || status === "idempotency_conflict"),
      "the loser is told to re-preview, never silently dropped",
    ).toHaveLength(1);

    expect(await counts(), "still exactly one v2 and one observation").toMatchObject({
      versions: 2, observations: 1, confirmations: 1, current_versions: 1, max_version: 2, observation_version: 1,
    });
  });

  it("rolls the whole confirmation back when a later write fails", async () => {
    await seedVersionOne();
    const before = await counts();

    // Force a failure after the observation and the v2 plan row are inserted by
    // rejecting the confirmation row itself: a null strategy violates the check.
    const { previewJourneyAdjustment } = await import("@tripquest/application");
    const preview = await previewJourneyAdjustment(
      { journeyId: JOURNEY, basePlanVersion: 1, observedAt: "14:30", earliestResumeAt: "15:30", completedActivityIds: [MUSEUM, CAFE], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 40 },
      repository, () => "preview-request",
    );
    if (preview.status !== "candidate_found") throw new Error("fixture is not confirmable");
    const stored = await repository.findCurrentJourney(JOURNEY);
    if (stored === null) throw new Error("fixture journey missing");

    const draft = {
      journeyId: JOURNEY, idempotencyKey: KEY_A, intentFingerprint: "f".repeat(64),
      basePlanVersion: 1, baseObservationVersion: 0, expectedJourney: stored,
      previewFingerprint: preview.semanticFingerprint,
      command: { observedAt: "14:30", earliestResumeAt: "15:30", completedActivityIds: [MUSEUM, CAFE], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 40 },
      candidateActivities: stored.currentPlan.activities.map((item, index) =>
        index === 2 ? { ...item, startsAt: `${DATE}T15:30:00+08:00`, endsAt: `${DATE}T16:30:00+08:00` } : item,
      ),
      confirmedAt: `${DATE}T10:00:00+08:00`,
      // A value the database rejects, so the failure lands on the last insert.
      strategy: "invalid" as never,
    } satisfies ConfirmedAdjustmentDraft;

    await expect(repository.commitConfirmedAdjustment(draft), "the bad row is rejected").rejects.toThrow();
    expect(await counts(), "nothing from the failed attempt survives").toEqual(before);
  });
});
