import {
  createJourney,
  type CreateJourneyCommand,
  type InitialJourneyDraft,
  type JourneyIdGenerator,
  type JourneyRepository,
} from "@tripquest/application";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleJourneyRepository, JourneyPersistenceError } from "../repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

// Expectations are hand derived from the S3.2 design contract: the Repository
// must refuse an invalid initial draft before writing any row, and must refuse
// to translate an inconsistent stored state into a read model.
config({
  path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
  quiet: true,
});

const IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "30000000-0000-4000-8000-000000000004",
  "30000000-0000-4000-8000-000000000005",
  "30000000-0000-4000-8000-000000000006",
  "30000000-0000-4000-8000-000000000007",
  "30000000-0000-4000-8000-000000000008",
] as const;

const JOURNEY_ID = IDS[0];

const command: CreateJourneyCommand = {
  title: "边界行程",
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  activities: [
    { placeName: "上午地点", startsAt: "09:00", endsAt: "10:00", priority: "normal", kind: "activity" },
    { placeName: "午间地点", startsAt: "12:00", endsAt: "13:00", priority: "low", kind: "activity" },
    { placeName: "固定晚餐", startsAt: "18:00", endsAt: "19:00", priority: "low", kind: "reservation" },
  ],
};

/** Shifts an ISO timestamp to the following day, keeping the +08:00 offset. */
function toNextDay(value: string): `${string}+08:00` {
  return value.replace("2026-10-15T", "2026-10-16T") as `${string}+08:00`;
}

describe("S3.2 repository draft and read boundaries", () => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  );
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(testDatabaseUrl, {
      applicationName: "tripquest-db-boundary-test",
      maxConnections: 2,
    });
    await migrate(client.database, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });

  afterAll(async () => {
    if (client === undefined) return;
    await truncate(client);
    await client.close();
  });

  beforeEach(async () => {
    await truncate(client);
  });

  it("refuses a draft that is not a first version without a parent", async () => {
    const base = await createDraft();
    const variants: ReadonlyArray<readonly [string, InitialJourneyDraft]> = [
      ["version 2", { ...base, currentPlan: { ...base.currentPlan, version: 2 } }],
      ["with a parent", { ...base, currentPlan: { ...base.currentPlan, parentVersion: 1 } }],
      [
        "wrong change reason",
        { ...base, currentPlan: { ...base.currentPlan, changeReason: "replanned" } },
      ],
      ["plan of another journey", { ...base, currentPlan: { ...base.currentPlan, journeyId: IDS[7] } }],
    ];

    for (const [label, draft] of variants) {
      await expect(
        repository.createInitialJourney(draft),
        `${label} is refused`,
      ).rejects.toBeInstanceOf(JourneyPersistenceError);
    }
    await expect(counts(client)).resolves.toEqual(EMPTY_COUNTS);
  });

  it("refuses a draft whose activity and snapshot collections do not line up", async () => {
    const base = await createDraft();
    const variants: ReadonlyArray<readonly [string, InitialJourneyDraft]> = [
      [
        "zero activities",
        {
          ...base,
          currentPlan: { ...base.currentPlan, activities: [] },
          activitySnapshots: [],
          reservations: [],
        },
      ],
      [
        "snapshot count mismatch",
        { ...base, activitySnapshots: base.activitySnapshots.slice(0, 2) },
      ],
      [
        "duplicate snapshot ids",
        {
          ...base,
          activitySnapshots: [
            base.activitySnapshots[0]!,
            { ...base.activitySnapshots[1]!, activityId: base.activitySnapshots[0]!.activityId },
            base.activitySnapshots[2]!,
          ],
        },
      ],
      [
        "snapshot order mismatch",
        {
          ...base,
          activitySnapshots: [
            { ...base.activitySnapshots[0]!, position: 1 },
            { ...base.activitySnapshots[1]!, position: 0 },
            base.activitySnapshots[2]!,
          ],
        },
      ],
      [
        "activities outside the plan date",
        {
          ...base,
          // The whole plan shifts one day while the plan date stays put, so the
          // ordering and reservation rules still hold and only the date rule can
          // reject this draft.
          currentPlan: {
            ...base.currentPlan,
            activities: base.currentPlan.activities.map((item) => ({
              ...item,
              startsAt: toNextDay(item.startsAt),
              endsAt: toNextDay(item.endsAt),
            })),
          },
          reservations: base.reservations.map((snapshot) => ({
            ...snapshot,
            reservation: {
              ...snapshot.reservation,
              startsAt: toNextDay(snapshot.reservation.startsAt),
              endsAt: toNextDay(snapshot.reservation.endsAt),
            },
          })),
        },
      ],
      [
        "duplicate reservation ids",
        { ...base, reservations: [base.reservations[0]!, base.reservations[0]!] },
      ],
    ];

    for (const [label, draft] of variants) {
      await expect(
        repository.createInitialJourney(draft),
        `${label} is refused`,
      ).rejects.toBeInstanceOf(JourneyPersistenceError);
    }
    await expect(counts(client)).resolves.toEqual(EMPTY_COUNTS);
  });

  it("refuses a draft that mixes offsets or leaves a reservation unlinked", async () => {
    const base = await createDraft();
    const [first, second, third] = base.currentPlan.activities;

    const utcDraft: InitialJourneyDraft = {
      ...base,
      currentPlan: {
        ...base.currentPlan,
        activities: [
          // A UTC offset is rejected by the ChinaDateTime type at compile time,
          // so it is forced in here to prove the runtime guard also refuses it.
          {
            ...first!,
            startsAt: "2026-10-15T01:00:00+00:00" as never,
            endsAt: "2026-10-15T02:00:00+00:00" as never,
          },
          second!,
          third!,
        ],
      },
    };
    await expect(
      repository.createInitialJourney(utcDraft),
      "a non +08:00 offset is refused",
    ).rejects.toBeInstanceOf(JourneyPersistenceError);

    // Removing the reservation link leaves the reservation unlinked, which must
    // be refused even though every remaining activity is individually valid.
    const unlinkedDraft: InitialJourneyDraft = {
      ...base,
      currentPlan: {
        ...base.currentPlan,
        activities: [
          first!,
          second!,
          {
            id: third!.id,
            placeId: third!.placeId,
            startsAt: third!.startsAt,
            endsAt: third!.endsAt,
            priority: "normal",
            locked: false,
          },
        ],
      },
    };
    await expect(
      repository.createInitialJourney(unlinkedDraft),
      "an unlinked reservation is refused",
    ).rejects.toBeInstanceOf(JourneyPersistenceError);

    await expect(counts(client)).resolves.toEqual(EMPTY_COUNTS);
  });

  it("refuses to read a stored plan whose positions are not contiguous", async () => {
    await repository.createInitialJourney(await createDraft());
    // Move only the last row, so the unique position index is not transiently
    // violated while the update runs; 0, 1, 9 leaves a gap at index 2.
    await client.pool.query(
      "UPDATE plan_activities SET position = 9 WHERE journey_id = $1 AND position = 2",
      [JOURNEY_ID],
    );

    await expect(repository.findCurrentJourney(JOURNEY_ID)).rejects.toBeInstanceOf(
      JourneyPersistenceError,
    );
  });

  it("refuses to read a stored plan that has no activities at all", async () => {
    await repository.createInitialJourney(await createDraft());
    await client.pool.query("DELETE FROM plan_activities WHERE journey_id = $1", [JOURNEY_ID]);

    await expect(repository.findCurrentJourney(JOURNEY_ID)).rejects.toBeInstanceOf(
      JourneyPersistenceError,
    );
  });

  it("refuses to read stored activities whose time windows overlap", async () => {
    await repository.createInitialJourney(await createDraft());
    const rows = await client.pool.query<{ activity_id: string }>(
      "SELECT activity_id FROM plan_activities WHERE journey_id = $1 ORDER BY position",
      [JOURNEY_ID],
    );
    const secondActivity = rows.rows[1]?.activity_id;
    expect(secondActivity, "second stored activity").toBeDefined();

    // Move the second activity into the first one's window; the database accepts
    // it because overlap is an application-level rule, so the reader must catch it.
    await client.pool.query(
      "UPDATE plan_activities SET starts_at = '2026-10-15T09:30:00+08:00', ends_at = '2026-10-15T09:45:00+08:00' WHERE activity_id = $1",
      [secondActivity],
    );

    await expect(repository.findCurrentJourney(JOURNEY_ID)).rejects.toBeInstanceOf(
      JourneyPersistenceError,
    );
  });

  async function createDraft(): Promise<InitialJourneyDraft> {
    let captured: InitialJourneyDraft | undefined;
    const capture: JourneyRepository = {
      async createInitialJourney(draft) {
        captured = draft;
      },
      async findCurrentJourney() {
        return null;
      },
    };
    await createJourney(command, {
      repository: capture,
      idGenerator: new SequenceIdGenerator(IDS),
      clock: { now: () => new Date("2026-10-14T16:05:06.789Z") },
    });
    if (captured === undefined) throw new Error("draft was not captured");
    return captured;
  }
});

const EMPTY_COUNTS = {
  journeys: 0,
  planVersions: 0,
  reservations: 0,
  planActivities: 0,
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

async function truncate(client: JourneyDatabaseClient): Promise<void> {
  await client.pool.query("TRUNCATE TABLE journeys CASCADE");
}

async function counts(client: JourneyDatabaseClient) {
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
  if (row === undefined) throw new Error("count query returned no row");
  return {
    journeys: Number(row.journeys),
    planVersions: Number(row.plan_versions),
    reservations: Number(row.reservations),
    planActivities: Number(row.plan_activities),
  };
}
