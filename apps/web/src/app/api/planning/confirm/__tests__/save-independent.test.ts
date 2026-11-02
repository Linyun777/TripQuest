// TQ-008.3.1 independent test (Claude Code). Uses its own *_test databases so it never
// races the developer's save.test.ts, which truncates the shared test database.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../draft/draft-handler";
import { createConfirmDayHandler } from "../confirm-handler";
import { createGenerationService } from "../../../../planning/new/generation-service";
import { createDraftSaveOffer } from "../../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../../planning/new/place-token";
import { asTestUser, ownerId } from "../../../../../test-support/users";

const envFile = resolve(process.cwd(), "../../.env");
// Only the test database address: the developer's own feature switches must not leak in.
if (existsSync(envFile)) {
  process.env.TEST_DATABASE_URL ??= parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL;
}
const migrations = resolve(process.cwd(), "../../packages/db/drizzle");
const t0 = Date.parse("2026-10-09T06:00:00Z");
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_PLACE_TOKEN_SECRET: "independent-s531-place-secret-0123456789abcdef",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_DRAFT_RECEIPT_SECRET: "independent-s531-receipt-secret-0123456789abcd",
};
const places = planningFixturePlaces();

function post(path: string, body: unknown) {
  return new Request(`http://localhost:3360/api/planning/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3360",
      host: "localhost:3360",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// Start → required museum → fixed 12:00–13:00 at the food place, which is also the end.
function requirements() {
  const token = (index: number) =>
    issuePlaceToken(
      { place: places[index], evidence: planningFixtureEvidence(t0) },
      env.PLANNING_PLACE_TOKEN_SECRET!,
      "fixture",
      t0,
    );
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-16",
    window: { startsAt: "09:00", endsAt: "18:00" },
    startPlace: token(0),
    endPlace: token(4),
    interests: [],
    pace: "standard",
    visits: [
      { token: token(1), role: "required", stayMinutes: 45 },
      { token: token(4), role: "fixed", startsAt: "12:00", endsAt: "13:00" },
    ],
  };
}

async function receipt(options: NodeJS.ProcessEnv = env): Promise<string> {
  const handler = createDraftHandler(
    () => createGenerationService({ environment: options, now: () => t0 }),
    (snapshot, result) => createDraftSaveOffer(snapshot, result, { environment: options, now: t0 }),
    undefined,
    asTestUser,
  );
  const lines = (await (await handler(post("draft", requirements()))).text()).trim().split("\n");
  const last = dayStreamEventSchema.parse(JSON.parse(lines.at(-1)!));
  if (last.type !== "result" || last.saveOffer?.status !== "available") {
    throw new Error("expected an available save offer");
  }
  return last.saveOffer.receipt;
}

function databaseUrl(name: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.1 independent persistence boundaries", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;

  async function freshDatabase(name: string): Promise<JourneyDatabaseClient> {
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${name}`);
    return createJourneyDatabase(databaseUrl(name), {
      applicationName: "tripquest-s531-independent",
      // Same pool size as the shared server database, so concurrency matches the real route.
      maxConnections: 10,
    });
  }
  const confirm = (body: unknown, options: NodeJS.ProcessEnv = env) =>
    createConfirmDayHandler({ user: asTestUser,
      environment: options,
      now: () => t0 + 60_000,
      repository: () => repository,
    })(post("confirm", body));
  const roots = async () =>
    (await client.pool.query("SELECT count(*)::int AS n FROM journeys")).rows[0].n as number;

  beforeAll(async () => {
    admin = createJourneyDatabase(
      requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL),
      { applicationName: "tripquest-s531-independent-admin", maxConnections: 1 },
    );
    client = await freshDatabase("tripquest_s531_it_test");
    await migrateJourneyDatabase(client.database, { migrationsFolder: migrations });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s531_it_test WITH (FORCE)");
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s531_migration_test WITH (FORCE)");
    await admin?.close();
  });

  it("treats surrounding title whitespace as the same intent and does not dedupe separate runs", async () => {
    const first = await receipt();
    const saved = await confirm({ receipt: first, title: "  独立测试行程 ", acknowledgeUnknowns: true });
    expect(saved.status).toBe(201);
    const { journeyId } = await saved.json();
    for (const title of ["独立测试行程", "独立测试行程   "]) {
      const again = await confirm({ receipt: first, title, acknowledgeUnknowns: true });
      expect(again.status, title).toBe(200);
      expect((await again.json()).journeyId).toBe(journeyId);
    }
    // A new generation with identical content is a new run, so it creates a second journey.
    const second = await confirm({ receipt: await receipt(), title: "独立测试行程", acknowledgeUnknowns: true });
    expect(second.status).toBe(201);
    expect((await second.json()).journeyId).not.toBe(journeyId);
    expect(await roots()).toBe(2);
  });

  it("refuses unsaved receipts while saving is disabled and saved ones after secret rotation", async () => {
    const unsaved = await receipt();
    const disabled = await confirm(
      { receipt: unsaved, title: "关闭保存", acknowledgeUnknowns: true },
      { ...env, PLANNING_SAVE_ENABLED: "false" },
    );
    expect(disabled.status).toBe(503);
    const before = await roots();
    const saved = await confirm({ receipt: unsaved, title: "轮换前", acknowledgeUnknowns: true });
    expect(saved.status).toBe(201);
    const rotated = await confirm(
      { receipt: unsaved, title: "轮换前", acknowledgeUnknowns: true },
      { ...env, PLANNING_DRAFT_RECEIPT_SECRET: "rotated-s531-receipt-secret-0123456789abcdefgh" },
    );
    expect(rotated.status).toBe(403);
    expect(await rotated.json()).toEqual({ status: "invalid_receipt" });
    expect(await roots()).toBe(before + 1);
  });

  it("answers every concurrent identical confirmation with the one saved journey", async () => {
    // Several tabs/retries racing one run: exactly one creation, and every same-intent
    // request must learn that journey (200/201), never a "temporarily unavailable" 503.
    const handler = createConfirmDayHandler({ user: asTestUser,
      environment: env,
      now: () => t0 + 60_000,
      repository: () => repository,
    });
    for (let round = 0; round < 3; round += 1) {
      const body = { receipt: await receipt(), title: "并发同意图", acknowledgeUnknowns: true };
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => handler(post("confirm", body))),
      );
      const statuses = replies.map((reply) => reply.status).sort();
      const ids = new Set((await Promise.all(replies.map((reply) => reply.json())))
        .map((item) => item.journeyId));
      expect({ round, statuses, ids: ids.size }).toEqual({
        round, statuses: [200, 200, 200, 200, 200, 200, 200, 200, 200, 201], ids: 1,
      });
    }
  });

  it("fails closed when standard rows drift from the saved planning details", async () => {
    const reply = await confirm({ receipt: await receipt(), title: "漂移检查", acknowledgeUnknowns: true });
    const { journeyId } = await reply.json();
    const found = await getJourney(journeyId, repository);
    expect(found.status).toBe("found");
    if (found.status !== "found") return;
    const fixed = found.journey.activities.find((item) => item.locked)!;
    expect(fixed.reservation).toMatchObject({ confirmationStatus: "unknown", sourceKind: "user_reported" });

    const drifts = [
      [
        "UPDATE reservations SET confirmation_status = 'confirmed' WHERE journey_id = $1",
        "UPDATE reservations SET confirmation_status = 'unknown' WHERE journey_id = $1",
      ],
      [
        "UPDATE plan_activities SET starts_at = starts_at + interval '1 minute' WHERE journey_id = $1 AND locked",
        "UPDATE plan_activities SET starts_at = starts_at - interval '1 minute' WHERE journey_id = $1 AND locked",
      ],
      [
        "UPDATE plan_activities SET priority = 'normal' WHERE journey_id = $1 AND position = 0",
        "UPDATE plan_activities SET priority = 'high' WHERE journey_id = $1 AND position = 0",
      ],
    ];
    for (const [drift, restore] of drifts) {
      await client.pool.query(drift, [journeyId]);
      await expect(getJourney(journeyId, repository), drift).rejects.toThrow();
      await client.pool.query(restore, [journeyId]);
    }
    expect((await getJourney(journeyId, repository)).status).toBe("found");
  });

  it("enforces creation identity and plan-detail ownership in the database itself", async () => {
    const id = () => randomUUID();
    const insert = (kind: string, run: string | null, intent: string | null) =>
      client.pool.query(
        `INSERT INTO journeys (id, user_id, title, date, time_zone, created_at, updated_at,
           creation_kind, creation_run_id, creation_intent_fingerprint)
         VALUES ($1, (SELECT id FROM users WHERE username = 'owner'), '约束', '2026-10-16', 'Asia/Shanghai', now(), now(), $2, $3, $4)`,
        [id(), kind, run, intent],
      );
    const hex = "a".repeat(64);
    const run = id();
    await expect(insert("generated_day", null, hex)).rejects.toThrow();
    await expect(insert("generated_day", id(), null)).rejects.toThrow();
    await expect(insert("generated_day", id(), "NOT-HEX")).rejects.toThrow();
    await expect(insert("manual", id(), hex)).rejects.toThrow();
    await expect(insert("imported", null, null)).rejects.toThrow();
    await insert("generated_day", run, hex);
    await expect(insert("generated_day", run, hex)).rejects.toThrow(/unique|duplicate/i);
    await expect(
      client.pool.query(
        "INSERT INTO day_plan_details (journey_id, plan_version, details) VALUES ($1, 1, '{}')",
        [id()],
      ),
    ).rejects.toThrow();
  });

  it("upgrades a database holding an old manual journey without changing it", async () => {
    const legacy = await freshDatabase("tripquest_s531_migration_test");
    try {
      // Apply only the first two migrations, as an existing S4-era database would have.
      const oldFolder = mkdtempSync(join(tmpdir(), "s531-migrations-"));
      cpSync(migrations, oldFolder, { recursive: true });
      const journalPath = join(oldFolder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.slice(0, 2);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrateJourneyDatabase(legacy.database, { migrationsFolder: oldFolder });

      const journeyId = randomUUID();
      await legacy.pool.query(
        `INSERT INTO journeys (id, title, date, time_zone, created_at, updated_at)
         VALUES ($1, '旧手动行程', '2026-10-01', 'Asia/Shanghai',
                 '2026-10-01T08:00:00+08:00', '2026-10-01T08:00:00+08:00')`,
        [journeyId],
      );
      await legacy.pool.query(
        `INSERT INTO plan_versions (journey_id, version, parent_version, change_reason, is_current, created_at)
         VALUES ($1, 1, NULL, NULL, true, '2026-10-01T08:00:00+08:00')`,
        [journeyId],
      );
      await legacy.pool.query(
        `INSERT INTO plan_activities (journey_id, plan_version, activity_id, position, place_id,
           place_name, starts_at, ends_at, priority, locked, reservation_id)
         VALUES ($1, 1, $2, 0, $3, '旧地点', '2026-10-01T10:00:00+08:00',
                 '2026-10-01T11:00:00+08:00', 'normal', false, NULL)`,
        [journeyId, randomUUID(), randomUUID()],
      );
      const snapshot = async () =>
        (await legacy.pool.query(
          `SELECT j.title, j.date::text, j.created_at::text, a.place_name, a.starts_at::text
           FROM journeys j JOIN plan_activities a ON a.journey_id = j.id`,
        )).rows;
      const before = await snapshot();

      await migrateJourneyDatabase(legacy.database, { migrationsFolder: migrations });
      expect(await snapshot()).toEqual(before);
      const row = (await legacy.pool.query(
        "SELECT creation_kind, creation_run_id, creation_intent_fingerprint FROM journeys",
      )).rows[0];
      expect(row).toEqual({ creation_kind: "manual", creation_run_id: null, creation_intent_fingerprint: null });
      const reopened = await getJourney(journeyId, new DrizzleJourneyRepository(legacy.database, await ownerId(legacy.pool)));
      expect(reopened.status === "found" && reopened.journey.creationKind).toBe("manual");
      expect(reopened.status === "found" && reopened.journey.activities).toHaveLength(1);
    } finally {
      await legacy.close();
    }
  });
});
