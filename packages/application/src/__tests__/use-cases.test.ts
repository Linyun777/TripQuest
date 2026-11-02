import { describe, expect, it } from "vitest";

import {
  JourneyReadModelError,
  createJourney,
  getJourney,
  type CreateJourneyCommand,
  type InitialJourneyDraft,
  type JourneyIdGenerator,
  type JourneyIdKind,
  type JourneyRepository,
  type StoredJourney,
} from "../index";

const IDS = {
  journey: "00000000-0000-4000-8000-000000000001",
  activityOne: "00000000-0000-4000-8000-000000000002",
  placeOne: "00000000-0000-4000-8000-000000000003",
  activityTwo: "00000000-0000-4000-8000-000000000004",
  placeTwo: "00000000-0000-4000-8000-000000000005",
  reservation: "00000000-0000-4000-8000-000000000006",
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
      placeName: "固定晚餐",
      startsAt: "18:00",
      endsAt: "19:00",
      priority: "low",
      kind: "reservation",
    },
  ],
};

class FakeJourneyRepository implements JourneyRepository {
  readonly created: InitialJourneyDraft[] = [];
  readonly stored = new Map<string, StoredJourney>();

  async createInitialJourney(draft: InitialJourneyDraft): Promise<void> {
    this.created.push(draft);
    this.stored.set(draft.journeyId, { ...draft, creationKind: "manual", currentObservationVersion: 0 });
  }

  async findCurrentJourney(journeyId: string): Promise<StoredJourney | null> {
    return this.stored.get(journeyId) ?? null;
  }
}

class SequenceIdGenerator implements JourneyIdGenerator {
  readonly calls: JourneyIdKind[] = [];

  constructor(private readonly ids: readonly string[]) {}

  next(kind: JourneyIdKind): string {
    this.calls.push(kind);
    const id = this.ids[this.calls.length - 1];
    if (id === undefined) throw new Error("test ID sequence exhausted");
    return id;
  }
}

function createDependencies() {
  const repository = new FakeJourneyRepository();
  const idGenerator = new SequenceIdGenerator([
    IDS.journey,
    IDS.activityOne,
    IDS.placeOne,
    IDS.activityTwo,
    IDS.placeTwo,
    IDS.reservation,
  ]);
  return {
    repository,
    idGenerator,
    clock: { now: () => new Date("2026-10-14T16:05:06.789Z") },
  };
}

describe("createJourney", () => {
  it("builds one current v1 aggregate and a separate fixed reservation fact", async () => {
    const dependencies = createDependencies();

    const outcome = await createJourney(command, dependencies);

    expect(outcome).toEqual({ status: "created", journeyId: IDS.journey });
    expect(dependencies.idGenerator.calls).toEqual([
      "journey",
      "activity",
      "place",
      "activity",
      "place",
      "reservation",
    ]);
    expect(dependencies.repository.created).toHaveLength(1);

    const draft = dependencies.repository.created[0];
    expect(draft).toMatchObject({
      journeyId: IDS.journey,
      title: "虚构市一日行程",
      createdAt: "2026-10-15T00:05:06+08:00",
      updatedAt: "2026-10-15T00:05:06+08:00",
      currentPlan: {
        journeyId: IDS.journey,
        date: "2026-10-15",
        timeZone: "Asia/Shanghai",
        version: 1,
        changeReason: "initial_creation",
      },
      activitySnapshots: [
        { activityId: IDS.activityOne, position: 0, placeName: "上午地点" },
        { activityId: IDS.activityTwo, position: 1, placeName: "固定晚餐" },
      ],
    });
    expect(draft.currentPlan).not.toHaveProperty("parentVersion");
    expect(draft.currentPlan.activities).toEqual([
      {
        id: IDS.activityOne,
        placeId: IDS.placeOne,
        startsAt: "2026-10-15T09:00:00+08:00",
        endsAt: "2026-10-15T10:00:00+08:00",
        priority: "normal",
        locked: false,
      },
      {
        id: IDS.activityTwo,
        placeId: IDS.placeTwo,
        startsAt: "2026-10-15T18:00:00+08:00",
        endsAt: "2026-10-15T19:00:00+08:00",
        priority: "high",
        locked: true,
        reservationId: IDS.reservation,
      },
    ]);
    expect(draft.reservations).toEqual([
      {
        placeName: "固定晚餐",
        reservation: {
          id: IDS.reservation,
          placeId: IDS.placeTwo,
          startsAt: "2026-10-15T18:00:00+08:00",
          endsAt: "2026-10-15T19:00:00+08:00",
          confirmation: {
            status: "confirmed",
            source: { kind: "user_reported" },
            recordedAt: "2026-10-15T00:05:06+08:00",
          },
        },
      },
    ]);
  });

  it("returns precise validation errors without generating IDs or writing", async () => {
    const dependencies = createDependencies();

    const outcome = await createJourney(
      {
        ...command,
        activities: [{ ...command.activities[0], endsAt: "08:00" }],
      },
      dependencies,
    );

    expect(outcome).toMatchObject({
      status: "invalid",
      fieldErrors: {
        "activities.0.endsAt": ["结束时间必须晚于开始时间"],
      },
    });
    expect(dependencies.idGenerator.calls).toEqual([]);
    expect(dependencies.repository.created).toEqual([]);
  });

  it("rejects invalid and duplicate injected UUIDs before persistence", async () => {
    const invalidDependencies = createDependencies();
    invalidDependencies.idGenerator = new SequenceIdGenerator(["not-a-uuid"]);

    await expect(createJourney(command, invalidDependencies)).rejects.toThrow(
      "invalid journey UUID",
    );
    expect(invalidDependencies.repository.created).toEqual([]);

    const duplicateDependencies = createDependencies();
    duplicateDependencies.idGenerator = new SequenceIdGenerator([
      IDS.journey,
      IDS.journey,
    ]);
    await expect(createJourney(command, duplicateDependencies)).rejects.toThrow(
      "duplicate activity UUID",
    );
    expect(duplicateDependencies.repository.created).toEqual([]);
  });

  it("does not convert repository failures into a successful outcome", async () => {
    const repository: JourneyRepository = {
      async createInitialJourney() {
        throw new Error("database unavailable");
      },
      async findCurrentJourney() {
        return null;
      },
    };

    await expect(
      createJourney(command, { ...createDependencies(), repository }),
    ).rejects.toThrow("database unavailable");
  });
});

describe("getJourney", () => {
  it("does not query the repository for an invalid UUID", async () => {
    const repository = new FakeJourneyRepository();
    let reads = 0;
    repository.findCurrentJourney = async () => {
      reads += 1;
      return null;
    };

    await expect(getJourney("not-a-uuid", repository)).resolves.toEqual({
      status: "invalid_id",
    });
    expect(reads).toBe(0);
  });

  it("distinguishes a missing journey from a found current plan", async () => {
    const dependencies = createDependencies();
    await createJourney(command, dependencies);

    await expect(
      getJourney("00000000-0000-4000-8000-000000000099", dependencies.repository),
    ).resolves.toEqual({ status: "not_found" });

    const found = await getJourney(IDS.journey, dependencies.repository);
    expect(found).toMatchObject({
      status: "found",
      journey: {
        journeyId: IDS.journey,
        title: "虚构市一日行程",
        date: "2026-10-15",
        timeZone: "Asia/Shanghai",
        version: 1,
        activities: [
          {
            id: IDS.activityOne,
            position: 0,
            placeName: "上午地点",
            kind: "activity",
          },
          {
            id: IDS.activityTwo,
            position: 1,
            placeName: "固定晚餐",
            kind: "reservation",
            reservation: {
              id: IDS.reservation,
              confirmationStatus: "confirmed",
              sourceKind: "user_reported",
            },
          },
        ],
      },
    });
  });

  it("rejects a stored activity order that disagrees with position", async () => {
    const dependencies = createDependencies();
    await createJourney(command, dependencies);
    const stored = dependencies.repository.stored.get(IDS.journey);
    if (stored === undefined) throw new Error("test setup failed");
    dependencies.repository.stored.set(IDS.journey, {
      ...stored,
      activitySnapshots: stored.activitySnapshots.map((snapshot, index) => ({
        ...snapshot,
        position: index === 0 ? 1 : 0,
      })),
    });

    await expect(getJourney(IDS.journey, dependencies.repository)).rejects.toBeInstanceOf(
      JourneyReadModelError,
    );
  });

  it("rejects a repository result that belongs to another requested journey", async () => {
    const dependencies = createDependencies();
    await createJourney(command, dependencies);
    const stored = dependencies.repository.stored.get(IDS.journey);
    if (stored === undefined) throw new Error("test setup failed");
    const repository: JourneyRepository = {
      async createInitialJourney() {},
      async findCurrentJourney() {
        return stored;
      },
    };

    await expect(
      getJourney("00000000-0000-4000-8000-000000000099", repository),
    ).rejects.toThrow("Repository returned another journey");
  });
});
