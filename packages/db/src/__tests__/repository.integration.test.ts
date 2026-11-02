import {
  createJourney,
  confirmJourneyAdjustment,
  getJourney,
  previewJourneyAdjustment,
  type CreateJourneyCommand,
  type InitialJourneyDraft,
  type JourneyIdGenerator,
  type JourneyRepository,
} from "@tripquest/application";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  getSharedJourneyDatabase,
  type JourneyDatabaseClient,
} from "../connection";
import {
  DrizzleJourneyRepository,
  JourneyPersistenceError,
} from "../repository";
import { journeyObservations, planActivities, planConfirmations, planVersions } from "../schema";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

config({
  path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
  quiet: true,
});

const IDS = {
  journey: "10000000-0000-4000-8000-000000000001",
  activityOne: "f0000000-0000-4000-8000-000000000002",
  placeOne: "10000000-0000-4000-8000-000000000003",
  activityTwo: "80000000-0000-4000-8000-000000000004",
  placeTwo: "10000000-0000-4000-8000-000000000005",
  activityThree: "20000000-0000-4000-8000-000000000006",
  placeThree: "10000000-0000-4000-8000-000000000007",
  reservation: "10000000-0000-4000-8000-000000000008",
} as const;

const command: CreateJourneyCommand = {
  title: "  虚构市一日行程  ",
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  activities: [
    {
      placeName: "  上午地点  ",
      startsAt: "09:00",
      endsAt: "10:00",
      priority: "normal",
      kind: "activity",
    },
    {
      placeName: "午间地点",
      startsAt: "12:00",
      endsAt: "13:00",
      priority: "low",
      kind: "activity",
    },
    {
      placeName: "固定晚餐",
      startsAt: "18:00",
      endsAt: "19:00",
      priority: "low",
      kind: "reservation",
    },
  ],
};

class SequenceIdGenerator implements JourneyIdGenerator {
  private position = 0;

  constructor(private readonly ids: readonly string[]) {}

  next(): string {
    const id = this.ids[this.position];
    this.position += 1;
    if (id === undefined) throw new Error("test ID sequence exhausted");
    return id;
  }
}

describe("test database safety", () => {
  it("rejects a cleanup target that is not an isolated _test database", () => {
    expect(() =>
      requireSafeTestDatabaseUrl(
        "postgresql://tripquest:secret@127.0.0.1:55432/tripquest",
        undefined,
      ),
    ).toThrow("ending in _test");
  });

  it("rejects the development target even when credentials differ", () => {
    expect(() =>
      requireSafeTestDatabaseUrl(
        "postgresql://test_user:test@127.0.0.1:55432/tripquest_test",
        "postgres://dev_user:dev@127.0.0.1:55432/tripquest_test",
      ),
    ).toThrow("must not equal");
  });
});

describe("shared database lifecycle", () => {
  afterEach(async () => {
    await closeSharedJourneyDatabase();
  });

  it("reuses one lazy pool and refuses silent connection changes", () => {
    const url = "postgresql://tripquest:secret@127.0.0.1:55432/lifecycle_test";
    const first = getSharedJourneyDatabase(url);
    const second = getSharedJourneyDatabase(url);

    expect(second).toBe(first);
    expect(first.pool.listenerCount("error")).toBe(1);
    expect(() =>
      getSharedJourneyDatabase(
        "postgresql://tripquest:secret@127.0.0.1:55432/another_test",
      ),
    ).toThrow("already configured for another connection");
  });
});

describe("DrizzleJourneyRepository with PostgreSQL", () => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  );
  let client: JourneyDatabaseClient;
  let databaseReady = false;
  let repository: DrizzleJourneyRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(testDatabaseUrl, {
      applicationName: "tripquest-db-test",
      maxConnections: 2,
    });
    await migrate(client.database, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    databaseReady = true;
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });

  beforeEach(async () => {
    await truncateBusinessTables(client);
  });

  afterAll(async () => {
    if (client !== undefined) {
      if (databaseReady) await truncateBusinessTables(client);
      await client.close();
    }
  });

  async function confirmationInput(idempotencyKey: string) {
    const input = { journeyId: IDS.journey, basePlanVersion: 1, observedAt: "11:30", earliestResumeAt: "12:30", completedActivityIds: [IDS.activityOne], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 20 };
    const preview = await previewJourneyAdjustment(input, repository, () => crypto.randomUUID());
    if (preview.status !== "candidate_found" || preview.strategy === "keep") throw new Error("Expected a confirmable preview");
    return { ...input, baseObservationVersion: preview.baseObservationVersion, strategy: preview.strategy, semanticFingerprint: preview.semanticFingerprint, idempotencyKey };
  }

  it("atomically saves v2, observation and confirmation, then replays the same key", async () => {
    await createJourney(command, createDependencies(repository));
    const input = await confirmationInput(crypto.randomUUID());
    const clock = { now: () => new Date("2026-10-14T16:06:00Z") };
    const first = await confirmJourneyAdjustment(input, repository, clock, () => crypto.randomUUID());
    expect(first).toEqual({ status: "committed", journeyId: IDS.journey, planVersion: 2, observationVersion: 1 });
    expect(await confirmJourneyAdjustment(input, repository, clock, () => crypto.randomUUID())).toEqual({ ...first, status: "already_committed" });
    expect((await getJourney(IDS.journey, repository)).status).toBe("found");
    const versions = await client.database.select().from(planVersions).where(eq(planVersions.journeyId, IDS.journey));
    expect(versions.map((item) => [item.version, item.parentVersion, item.isCurrent])).toEqual([[1, null, false], [2, 1, true]]);
    expect(await client.database.select().from(journeyObservations).where(eq(journeyObservations.journeyId, IDS.journey))).toHaveLength(1);
    expect(await client.database.select().from(planConfirmations).where(eq(planConfirmations.journeyId, IDS.journey))).toHaveLength(1);
    const oldActivities = await client.database.select().from(planActivities).where(eq(planActivities.planVersion, 1));
    const newActivities = await client.database.select().from(planActivities).where(eq(planActivities.planVersion, 2));
    expect(oldActivities).toHaveLength(3);
    expect(newActivities).toHaveLength(3);
    expect(newActivities.find((item) => item.activityId === IDS.activityTwo)?.startsAt.toISOString()).toBe("2026-10-15T04:30:00.000Z");
    expect(newActivities.find((item) => item.activityId === IDS.activityThree)?.startsAt.toISOString()).toBe("2026-10-15T10:00:00.000Z");
  });

  it("allows at most one different-key confirmation from the same base", async () => {
    await createJourney(command, createDependencies(repository));
    const base = await confirmationInput(crypto.randomUUID());
    const clock = { now: () => new Date("2026-10-14T16:06:00Z") };
    const results = await Promise.all([base, { ...base, idempotencyKey: crypto.randomUUID() }].map((item) => confirmJourneyAdjustment(item, repository, clock, () => crypto.randomUUID())));
    expect(results.filter((item) => item.status === "committed")).toHaveLength(1);
    expect(results.filter((item) => item.status === "stale")).toHaveLength(1);
    expect(await client.database.select().from(planConfirmations)).toHaveLength(1);
  });

  it("rejects a changed intent under the same key and a tampered preview fingerprint", async () => {
    await createJourney(command, createDependencies(repository));
    const input = await confirmationInput(crypto.randomUUID());
    const clock = { now: () => new Date("2026-10-14T16:06:00Z") };
    expect((await confirmJourneyAdjustment({ ...input, semanticFingerprint: "f".repeat(64) }, repository, clock, () => crypto.randomUUID())).status).toBe("preview_changed");
    expect(await client.database.select().from(planConfirmations)).toHaveLength(0);
    expect((await confirmJourneyAdjustment(input, repository, clock, () => crypto.randomUUID())).status).toBe("committed");
    expect((await confirmJourneyAdjustment({ ...input, travelMinutes: 21 }, repository, clock, () => crypto.randomUUID())).status).toBe("idempotency_conflict");
    expect(await client.database.select().from(planConfirmations)).toHaveLength(1);
  });

  it("rejects a changed observation version or reservation snapshot before writing", async () => {
    await createJourney(command, createDependencies(repository));
    const input = await confirmationInput(crypto.randomUUID());
    const clock = { now: () => new Date("2026-10-14T16:06:00Z") };
    await client.pool.query("UPDATE journeys SET current_observation_version = 1 WHERE id = $1", [IDS.journey]);
    expect((await confirmJourneyAdjustment(input, repository, clock, () => crypto.randomUUID())).status).toBe("stale");
    await client.pool.query("UPDATE journeys SET current_observation_version = 0 WHERE id = $1", [IDS.journey]);
    await client.pool.query("UPDATE reservations SET confirmation_status = 'pending' WHERE id = $1", [IDS.reservation]);
    expect((await confirmJourneyAdjustment(input, repository, clock, () => crypto.randomUUID())).status).not.toBe("committed");
    expect(await client.database.select().from(planConfirmations)).toHaveLength(0);
  });

  it("rolls back every write when the confirmation insert fails", async () => {
    await createJourney(command, createDependencies(repository));
    const input = await confirmationInput(crypto.randomUUID());
    await client.pool.query("CREATE FUNCTION tripquest_fail_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$");
    await client.pool.query("CREATE TRIGGER tripquest_fail_confirmation BEFORE INSERT ON plan_confirmations FOR EACH ROW EXECUTE FUNCTION tripquest_fail_confirmation()");
    try {
      const result = await confirmJourneyAdjustment(input, repository, { now: () => new Date("2026-10-14T16:06:00Z") }, () => crypto.randomUUID());
      expect(result.status).toBe("temporarily_unavailable");
      expect((await client.database.select().from(planVersions)).map((item) => [item.version, item.isCurrent])).toEqual([[1, true]]);
      expect(await client.database.select().from(journeyObservations)).toHaveLength(0);
      expect(await client.database.select().from(planConfirmations)).toHaveLength(0);
    } finally {
      await client.pool.query("DROP TRIGGER tripquest_fail_confirmation ON plan_confirmations");
      await client.pool.query("DROP FUNCTION tripquest_fail_confirmation()");
    }
  });

  it("round trips v1, snapshots and a fixed reservation through PostgreSQL", async () => {
    const result = await createJourney(command, createDependencies(repository));

    expect(result).toEqual({ status: "created", journeyId: IDS.journey });
    const found = await getJourney(IDS.journey, repository);
    expect(found).toEqual({
      status: "found",
      journey: {
        creationKind: "manual",
        journeyId: IDS.journey,
        title: "虚构市一日行程",
        date: "2026-10-15",
        timeZone: "Asia/Shanghai",
        version: 1,
        createdAt: "2026-10-15T00:05:06+08:00",
        updatedAt: "2026-10-15T00:05:06+08:00",
        activities: [
          {
            id: IDS.activityOne,
            position: 0,
            placeId: IDS.placeOne,
            placeName: "上午地点",
            startsAt: "2026-10-15T09:00:00+08:00",
            endsAt: "2026-10-15T10:00:00+08:00",
            priority: "normal",
            locked: false,
            kind: "activity",
          },
          {
            id: IDS.activityTwo,
            position: 1,
            placeId: IDS.placeTwo,
            placeName: "午间地点",
            startsAt: "2026-10-15T12:00:00+08:00",
            endsAt: "2026-10-15T13:00:00+08:00",
            priority: "low",
            locked: false,
            kind: "activity",
          },
          {
            id: IDS.activityThree,
            position: 2,
            placeId: IDS.placeThree,
            placeName: "固定晚餐",
            startsAt: "2026-10-15T18:00:00+08:00",
            endsAt: "2026-10-15T19:00:00+08:00",
            priority: "high",
            locked: true,
            reservationId: IDS.reservation,
            kind: "reservation",
            reservation: {
              id: IDS.reservation,
              confirmationStatus: "confirmed",
              sourceKind: "user_reported",
              recordedAt: "2026-10-15T00:05:06+08:00",
            },
          },
        ],
      },
    });
  });

  it("reads activities by position even when rows were inserted in reverse", async () => {
    const draft = await createDraft();
    await repository.createInitialJourney(draft);
    const rows = await client.database.select().from(planActivities);

    await client.database.delete(planActivities);
    await client.database.insert(planActivities).values([...rows].reverse());

    const stored = await repository.findCurrentJourney(IDS.journey);
    expect(stored?.currentPlan.activities.map(({ id }) => id)).toEqual([
      IDS.activityOne,
      IDS.activityTwo,
      IDS.activityThree,
    ]);
    expect(stored?.activitySnapshots.map(({ position }) => position)).toEqual([
      0, 1, 2,
    ]);
  });

  it("uses the current marker instead of falling back to the highest version", async () => {
    await repository.createInitialJourney(await createDraft());
    await client.database
      .update(planVersions)
      .set({ isCurrent: false })
      .where(eq(planVersions.journeyId, IDS.journey));

    await expect(repository.findCurrentJourney(IDS.journey)).resolves.toBeNull();
    await expect(
      repository.findCurrentJourney("90000000-0000-4000-8000-000000000099"),
    ).resolves.toBeNull();
  });

  it("handles an idle connection loss and reconnects on the next query", async () => {
    expect(client.pool.listenerCount("error")).toBe(1);
    const idleClient = await client.pool.connect();
    const backendResult = await idleClient.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const backendPid = backendResult.rows[0]?.pid;
    idleClient.release();
    if (backendPid === undefined) throw new Error("test backend PID missing");

    const poolError = new Promise<Error>((resolve) => {
      client.pool.once("error", (error) => resolve(error));
    });
    const killer = createJourneyDatabase(testDatabaseUrl, {
      applicationName: "tripquest-db-test-killer",
      maxConnections: 1,
    });

    try {
      const terminated = await killer.pool.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [backendPid],
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      await expect(withTimeout(poolError, 2_000)).resolves.toBeInstanceOf(Error);
      await expect(
        repository.findCurrentJourney("90000000-0000-4000-8000-000000000099"),
      ).resolves.toBeNull();
    } finally {
      await killer.close();
    }
  });

  it("rolls back all four tables when a later reservation insert fails", async () => {
    const draft = await createDraft();
    const reservationSnapshot = draft.reservations[0];
    if (reservationSnapshot === undefined) throw new Error("test reservation missing");
    const invalidPlaceName = " 固定晚餐 ";
    const invalidDraft: InitialJourneyDraft = {
      ...draft,
      activitySnapshots: draft.activitySnapshots.map((snapshot) =>
        snapshot.activityId === IDS.activityThree
          ? { ...snapshot, placeName: invalidPlaceName }
          : snapshot,
      ),
      reservations: [
        {
          ...reservationSnapshot,
          placeName: invalidPlaceName,
        },
      ],
    };

    await expect(repository.createInitialJourney(invalidDraft)).rejects.toThrow();
    await expect(readBusinessTableCounts(client)).resolves.toEqual({
      journeys: 0,
      planVersions: 0,
      reservations: 0,
      planActivities: 0,
    });
  });

  it("rejects overlapping direct drafts before writing any rows", async () => {
    const draft = await createDraft();
    const second = draft.currentPlan.activities[1];
    if (second === undefined) throw new Error("test activity missing");
    const invalidDraft: InitialJourneyDraft = {
      ...draft,
      currentPlan: {
        ...draft.currentPlan,
        activities: [
          draft.currentPlan.activities[0],
          { ...second, startsAt: "2026-10-15T09:30:00+08:00" },
          draft.currentPlan.activities[2],
        ],
      },
    } as InitialJourneyDraft;

    await expect(repository.createInitialJourney(invalidDraft)).rejects.toBeInstanceOf(
      JourneyPersistenceError,
    );
    await expect(readBusinessTableCounts(client)).resolves.toEqual({
      journeys: 0,
      planVersions: 0,
      reservations: 0,
      planActivities: 0,
    });
  });

  it("rejects an initial reservation that is not confirmed and user-reported", async () => {
    const draft = await createDraft();
    const reservationSnapshot = draft.reservations[0];
    if (reservationSnapshot === undefined) throw new Error("test reservation missing");
    const invalidDraft: InitialJourneyDraft = {
      ...draft,
      reservations: [
        {
          ...reservationSnapshot,
          reservation: {
            ...reservationSnapshot.reservation,
            confirmation: {
              ...reservationSnapshot.reservation.confirmation,
              status: "pending",
              source: { kind: "fixture" },
            },
          },
        },
      ],
    };

    await expect(repository.createInitialJourney(invalidDraft)).rejects.toBeInstanceOf(
      JourneyPersistenceError,
    );
    await expect(readBusinessTableCounts(client)).resolves.toEqual({
      journeys: 0,
      planVersions: 0,
      reservations: 0,
      planActivities: 0,
    });
  });
});

function createDependencies(repository: JourneyRepository) {
  return {
    repository,
    idGenerator: new SequenceIdGenerator([
      IDS.journey,
      IDS.activityOne,
      IDS.placeOne,
      IDS.activityTwo,
      IDS.placeTwo,
      IDS.activityThree,
      IDS.placeThree,
      IDS.reservation,
    ]),
    clock: { now: () => new Date("2026-10-14T16:05:06.789Z") },
  };
}

async function createDraft(): Promise<InitialJourneyDraft> {
  let captured: InitialJourneyDraft | undefined;
  const captureRepository: JourneyRepository = {
    async createInitialJourney(draft) {
      captured = draft;
    },
    async findCurrentJourney() {
      return null;
    },
  };
  await createJourney(command, createDependencies(captureRepository));
  if (captured === undefined) throw new Error("test draft was not created");
  return captured;
}

async function truncateBusinessTables(client: JourneyDatabaseClient) {
  await client.pool.query("TRUNCATE TABLE journeys CASCADE");
}

async function readBusinessTableCounts(client: JourneyDatabaseClient) {
  const result = await client.pool.query<{
    journeys: string;
    plan_versions: string;
    reservations: string;
    plan_activities: string;
  }>(`
    SELECT
      (SELECT count(*) FROM journeys)::text AS journeys,
      (SELECT count(*) FROM plan_versions)::text AS plan_versions,
      (SELECT count(*) FROM reservations)::text AS reservations,
      (SELECT count(*) FROM plan_activities)::text AS plan_activities
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error("database count query returned no row");
  return {
    journeys: Number(row.journeys),
    planVersions: Number(row.plan_versions),
    reservations: Number(row.reservations),
    planActivities: Number(row.plan_activities),
  };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("timed out waiting for pool error")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
