import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";

// Expectations are hand derived from the S3.2 design contract for the four
// tables. They assert what PostgreSQL itself must refuse, independently of the
// Repository and the application layer above it.
config({
  path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
  quiet: true,
});

const JOURNEY = "20000000-0000-4000-8000-000000000001";
const OTHER_JOURNEY = "20000000-0000-4000-8000-000000000002";
const RESERVATION = "20000000-0000-4000-8000-000000000003";
const OTHER_RESERVATION = "20000000-0000-4000-8000-000000000004";
const ACTIVITY = "20000000-0000-4000-8000-000000000005";
const PLACE = "20000000-0000-4000-8000-000000000006";
const SECOND_ACTIVITY = "20000000-0000-4000-8000-000000000007";

describe("S3.2 database level constraints", () => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  );
  let client: JourneyDatabaseClient;

  beforeAll(async () => {
    client = createJourneyDatabase(testDatabaseUrl, {
      applicationName: "tripquest-db-constraint-test",
      maxConnections: 2,
    });
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(client.database, { migrationsFolder });
    // Running the same migration set twice must be a no-op, not an error.
    await migrate(client.database, { migrationsFolder });
  });

  afterAll(async () => {
    if (client === undefined) return;
    await truncate(client);
    await client.close();
  });

  beforeEach(async () => {
    await truncate(client);
    await seedValidBaseline(client);
  });

  it("records exactly one migration run and keeps the partial current index", async () => {
    const tables = await client.pool.query<{ name: string }>(`
      SELECT unnest(ARRAY['journeys','plan_versions','reservations','plan_activities']) AS name
    `);
    expect(tables.rows).toHaveLength(4);
    for (const { name } of tables.rows) {
      const found = await client.pool.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`public.${name}`],
      );
      expect(found.rows[0]?.present, `${name} exists`).toBe(true);
    }

    const applied = await client.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    expect(applied.rows[0]?.count, "eighteen migrations applied exactly once").toBe("18");

    const currentIndex = await client.pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'plan_versions_one_current_per_journey'",
    );
    const definition = currentIndex.rows[0]?.indexdef ?? "";
    expect(definition, "index exists").not.toBe("");
    expect(definition, "index is unique").toContain("UNIQUE");
    expect(definition.replace(/\s+/g, " "), "index is partial on is_current").toContain(
      "WHERE (is_current = true)",
    );
  });

  it("refuses journey rows that break the title, time zone or timestamp rules", async () => {
    await expectRejected(
      "UPDATE journeys SET title = $1 WHERE id = $2",
      ["   ", JOURNEY],
      "journeys_title_length_check",
    );
    await expectRejected(
      "UPDATE journeys SET title = $1 WHERE id = $2",
      ["x".repeat(81), JOURNEY],
      "journeys_title_length_check",
    );
    await expectRejected(
      "UPDATE journeys SET time_zone = $1 WHERE id = $2",
      ["UTC", JOURNEY],
      "journeys_time_zone_check",
    );
    await expectRejected(
      "UPDATE journeys SET updated_at = created_at - interval '1 second' WHERE id = $1",
      [JOURNEY],
      "journeys_updated_at_check",
    );
  });

  it("allows at most one current version per journey but any number of non-current ones", async () => {
    await expectRejected(
      "INSERT INTO plan_versions (journey_id, version, is_current, created_at) VALUES ($1, 2, true, $2)",
      [JOURNEY, "2026-10-15T00:00:00+08:00"],
      "plan_versions_one_current_per_journey",
    );

    // The reverse direction matters: the index must be partial, not unique over
    // the whole column, so historical non-current versions stay insertable.
    await client.pool.query(
      "INSERT INTO plan_versions (journey_id, version, parent_version, is_current, created_at) VALUES ($1, 2, 1, false, $2), ($1, 3, 2, false, $2)",
      [JOURNEY, "2026-10-15T00:00:00+08:00"],
    );
    const versions = await client.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM plan_versions WHERE journey_id = $1 AND is_current = false",
      [JOURNEY],
    );
    expect(versions.rows[0]?.count, "two non-current versions stored").toBe("2");
  });

  it("refuses plan version rows that break the version and reason rules", async () => {
    await expectRejected(
      "UPDATE plan_versions SET version = 0 WHERE journey_id = $1 AND version = 1",
      [JOURNEY],
      "plan_versions_version_check",
    );
    await expectRejected(
      "INSERT INTO plan_versions (journey_id, version, parent_version, is_current, created_at) VALUES ($1, 2, 2, false, $2)",
      [JOURNEY, "2026-10-15T00:00:00+08:00"],
      "plan_versions_parent_version_check",
    );
    await expectRejected(
      "UPDATE plan_versions SET change_reason = $1 WHERE journey_id = $2 AND version = 1",
      ["  ", JOURNEY],
      "plan_versions_change_reason_check",
    );
  });

  it("refuses reservation rows that break the window, enum or name rules", async () => {
    await expectRejected(
      "UPDATE reservations SET ends_at = starts_at WHERE id = $1",
      [RESERVATION],
      "reservations_time_window_check",
    );
    await expectRejected(
      "UPDATE reservations SET confirmation_status = $1 WHERE id = $2",
      ["maybe", RESERVATION],
      "reservations_confirmation_status_check",
    );
    await expectRejected(
      "UPDATE reservations SET source_kind = $1 WHERE id = $2",
      ["partner_api", RESERVATION],
      "reservations_source_kind_check",
    );
    await expectRejected(
      "UPDATE reservations SET place_name = $1 WHERE id = $2",
      ["   ", RESERVATION],
      "reservations_place_name_length_check",
    );
  });

  it("refuses activity rows that break position, priority, window or the lock rule", async () => {
    await expectRejected(
      "UPDATE plan_activities SET position = -1 WHERE activity_id = $1",
      [ACTIVITY],
      "plan_activities_position_check",
    );
    await expectRejected(
      "INSERT INTO plan_activities (journey_id, plan_version, activity_id, position, place_id, place_name, starts_at, ends_at, priority, locked) VALUES ($1, 1, $2, 0, $3, 'd', $4, $5, 'normal', false)",
      [JOURNEY, SECOND_ACTIVITY, PLACE, "2026-10-15T20:00:00+08:00", "2026-10-15T21:00:00+08:00"],
      "plan_activities_position_unique",
    );
    await expectRejected(
      "UPDATE plan_activities SET priority = $1 WHERE activity_id = $2",
      ["urgent", ACTIVITY],
      "plan_activities_priority_check",
    );
    await expectRejected(
      "UPDATE plan_activities SET ends_at = starts_at WHERE activity_id = $1",
      [ACTIVITY],
      "plan_activities_time_window_check",
    );
    await expectRejected(
      "UPDATE plan_activities SET reservation_id = $1, locked = false WHERE activity_id = $2",
      [RESERVATION, ACTIVITY],
      "plan_activities_reservation_lock_check",
    );
    await expectRejected(
      "UPDATE plan_activities SET reservation_id = $1, locked = true, priority = 'normal' WHERE activity_id = $2",
      [RESERVATION, ACTIVITY],
      "plan_activities_reservation_lock_check",
    );
  });

  it("refuses a reservation that belongs to another journey", async () => {
    await expectRejected(
      "UPDATE plan_activities SET reservation_id = $1, locked = true, priority = 'high' WHERE activity_id = $2",
      [OTHER_RESERVATION, ACTIVITY],
      "plan_activities_reservation_fkey",
    );
  });

  async function expectRejected(
    sql: string,
    parameters: readonly unknown[],
    constraint: string,
  ): Promise<void> {
    let caught: unknown;
    try {
      await client.pool.query(sql, [...parameters]);
    } catch (error) {
      caught = error;
    }
    expect(caught, `${constraint} must reject the statement`).toBeDefined();
    expect(
      (caught as { constraint?: string }).constraint,
      `rejected by ${constraint}`,
    ).toBe(constraint);
  }
});

async function seedValidBaseline(client: JourneyDatabaseClient): Promise<void> {
  const timestamp = "2026-10-15T00:05:06+08:00";
  await client.pool.query(
    `INSERT INTO journeys (id, user_id, title, date, time_zone, created_at, updated_at)
     VALUES ($1, (SELECT id FROM users WHERE username = 'owner'), 'Valid journey', '2026-10-15', 'Asia/Shanghai', $2, $2)`,
    [JOURNEY, timestamp],
  );
  await client.pool.query(
    `INSERT INTO journeys (id, user_id, title, date, time_zone, created_at, updated_at)
     VALUES ($1, (SELECT id FROM users WHERE username = 'owner'), 'Other journey', '2026-10-15', 'Asia/Shanghai', $2, $2)`,
    [OTHER_JOURNEY, timestamp],
  );
  await client.pool.query(
    `INSERT INTO plan_versions (journey_id, version, change_reason, is_current, created_at)
     VALUES ($1, 1, 'initial_creation', true, $2)`,
    [JOURNEY, timestamp],
  );
  await client.pool.query(
    `INSERT INTO plan_versions (journey_id, version, change_reason, is_current, created_at)
     VALUES ($1, 1, 'initial_creation', true, $2)`,
    [OTHER_JOURNEY, timestamp],
  );
  await client.pool.query(
    `INSERT INTO reservations (id, journey_id, place_id, place_name, starts_at, ends_at, confirmation_status, source_kind, recorded_at)
     VALUES ($1, $2, $3, '固定晚餐', '2026-10-15T18:00:00+08:00', '2026-10-15T19:00:00+08:00', 'confirmed', 'user_reported', $4),
            ($5, $6, $3, '别的晚餐', '2026-10-15T20:00:00+08:00', '2026-10-15T21:00:00+08:00', 'confirmed', 'user_reported', $4)`,
    [RESERVATION, JOURNEY, PLACE, timestamp, OTHER_RESERVATION, OTHER_JOURNEY],
  );
  await client.pool.query(
    `INSERT INTO plan_activities (journey_id, plan_version, activity_id, position, place_id, place_name, starts_at, ends_at, priority, locked)
     VALUES ($1, 1, $2, 0, $3, '上午地点', '2026-10-15T09:00:00+08:00', '2026-10-15T10:00:00+08:00', 'normal', false)`,
    [JOURNEY, ACTIVITY, PLACE],
  );
}

async function truncate(client: JourneyDatabaseClient): Promise<void> {
  await client.pool.query("TRUNCATE TABLE journeys CASCADE");
}
