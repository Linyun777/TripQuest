import { describe, expect, it } from "vitest";

import {
  createJourney,
  getJourney,
  JourneyReadModelError,
  type CreateJourneyCommand,
  type InitialJourneyDraft,
  type JourneyIdGenerator,
  type JourneyRepository,
  type StoredJourney,
} from "../index";

// Expectations are hand derived from the S3.2 design contract and the accepted
// S2 domain rules. They never read an expected value produced by the code under
// test, and they never derive the answer from the use case output.
function idAt(sequence: number): string {
  return `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

const JOURNEY_ID = idAt(1);

/**
 * Mirrors the documented allocation order: the journey first, then for each
 * activity an activity id, a place id, and a reservation id when requested.
 */
function sequentialIds(): JourneyIdGenerator {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return idAt(counter);
    },
  };
}

function validCommand(): CreateJourneyCommand {
  return {
    title: "边界行程",
    date: "2026-10-15",
    timeZone: "Asia/Shanghai",
    activities: [
      { placeName: "上午地点", startsAt: "09:00", endsAt: "10:00", priority: "normal", kind: "activity" },
      { placeName: "固定晚餐", startsAt: "18:00", endsAt: "19:00", priority: "low", kind: "reservation" },
    ],
  };
}

function activity(overrides: Partial<CreateJourneyCommand["activities"][number]> = {}) {
  return { placeName: "地点", startsAt: "09:00", endsAt: "10:00", priority: "normal" as const, kind: "activity" as const, ...overrides };
}

function captureRepository(): { repository: JourneyRepository; drafts: InitialJourneyDraft[] } {
  const drafts: InitialJourneyDraft[] = [];
  return {
    drafts,
    repository: {
      async createInitialJourney(draft) {
        drafts.push(draft);
      },
      async findCurrentJourney() {
        return null;
      },
    },
  };
}

function dependencies(
  repository: JourneyRepository,
  idGenerator: JourneyIdGenerator = sequentialIds(),
) {
  return {
    repository,
    idGenerator,
    clock: { now: () => new Date("2026-10-14T16:05:06.789Z") },
  };
}

describe("S3.2 create journey command boundaries", () => {
  it("accepts the documented text, date, time and count boundaries", async () => {
    const cases: ReadonlyArray<readonly [string, CreateJourneyCommand]> = [
      ["single activity", { ...validCommand(), activities: [activity()] }],
      [
        "eight activities",
        {
          ...validCommand(),
          activities: [
            activity({ startsAt: "00:00", endsAt: "00:30" }),
            activity({ startsAt: "01:00", endsAt: "01:30" }),
            activity({ startsAt: "02:00", endsAt: "02:30" }),
            activity({ startsAt: "03:00", endsAt: "03:30" }),
            activity({ startsAt: "04:00", endsAt: "04:30" }),
            activity({ startsAt: "05:00", endsAt: "05:30" }),
            activity({ startsAt: "06:00", endsAt: "06:30" }),
            activity({ startsAt: "23:00", endsAt: "23:59" }),
          ],
        },
      ],
      ["eighty character title and place", {
        ...validCommand(),
        title: "题".repeat(80),
        activities: [activity({ placeName: "地".repeat(80) })],
      }],
      ["leap day", { ...validCommand(), date: "2024-02-29", activities: [activity()] }],
      // Touching intervals are allowed: the domain treats windows as half-open.
      [
        "touching intervals",
        {
          ...validCommand(),
          activities: [activity({ startsAt: "09:00", endsAt: "10:00" }), activity({ startsAt: "10:00", endsAt: "11:00" })],
        },
      ],
    ];

    for (const [label, command] of cases) {
      const { repository, drafts } = captureRepository();
      const outcome = await createJourney(command, dependencies(repository));
      expect(outcome, `${label} accepted`).toEqual({ status: "created", journeyId: JOURNEY_ID });
      expect(drafts, `${label} persisted`).toHaveLength(1);
    }
  });

  it("rejects malformed text, dates, times and counts with field errors", async () => {
    const cases: ReadonlyArray<readonly [string, string, unknown]> = [
      ["blank title", "title", { ...validCommand(), title: "   " }],
      ["eighty-one character title", "title", { ...validCommand(), title: "题".repeat(81) }],
      ["non string title", "title", { ...validCommand(), title: 42 }],
      ["blank place name", "activities.0.placeName", { ...validCommand(), activities: [activity({ placeName: "  " })] }],
      ["impossible date", "date", { ...validCommand(), date: "2026-02-29" }],
      ["april thirty-first", "date", { ...validCommand(), date: "2026-04-31" }],
      ["month thirteen", "date", { ...validCommand(), date: "2026-13-01" }],
      ["sloppy date format", "date", { ...validCommand(), date: "2026-1-5" }],
      ["hour twenty-four", "activities.0.startsAt", { ...validCommand(), activities: [activity({ startsAt: "24:00" })] }],
      ["single digit hour", "activities.0.startsAt", { ...validCommand(), activities: [activity({ startsAt: "9:00" })] }],
      ["minute sixty", "activities.0.endsAt", { ...validCommand(), activities: [activity({ endsAt: "09:60" })] }],
      ["no activities", "activities", { ...validCommand(), activities: [] }],
      ["nine activities", "activities", { ...validCommand(), activities: Array.from({ length: 9 }, (_, index) => activity({ startsAt: `0${index}:00`, endsAt: `0${index}:30` })) }],
      ["reversed window", "activities.0.endsAt", { ...validCommand(), activities: [activity({ startsAt: "10:00", endsAt: "09:00" })] }],
      ["overlapping window", "activities.1.startsAt", {
        ...validCommand(),
        activities: [activity({ startsAt: "09:00", endsAt: "10:00" }), activity({ startsAt: "09:30", endsAt: "11:00" })],
      }],
      ["out of order", "activities.1.startsAt", {
        ...validCommand(),
        activities: [activity({ startsAt: "12:00", endsAt: "13:00" }), activity({ startsAt: "09:00", endsAt: "10:00" })],
      }],
      ["unknown activity kind", "activities.0.kind", { ...validCommand(), activities: [activity({ kind: "meeting" as never })] }],
    ];

    for (const [label, path, input] of cases) {
      const { repository, drafts } = captureRepository();
      const outcome = await createJourney(input, dependencies(repository));
      expect(outcome.status, `${label} rejected`).toBe("invalid");
      if (outcome.status !== "invalid") continue;
      expect(Object.keys(outcome.fieldErrors), `${label} names ${path}`).toContain(path);
      expect(drafts, `${label} wrote nothing`).toHaveLength(0);
    }
  });

  it("rejects unknown fields instead of silently dropping them", async () => {
    const { repository, drafts } = captureRepository();
    const outcome = await createJourney(
      { ...validCommand(), sneaky: "value" },
      dependencies(repository),
    );

    expect(outcome.status).toBe("invalid");
    if (outcome.status !== "invalid") return;
    expect(outcome.formError, "form level error").toBeDefined();
    expect(drafts).toHaveLength(0);
  });

  it("forces a reservation activity to be a locked high priority independent fact", async () => {
    const { repository, drafts } = captureRepository();
    const command: CreateJourneyCommand = {
      ...validCommand(),
      activities: [
        activity({ placeName: "普通地点", startsAt: "09:00", endsAt: "10:00", priority: "low", kind: "activity" }),
        activity({ placeName: "固定晚餐", startsAt: "18:00", endsAt: "19:00", priority: "low", kind: "reservation" }),
      ],
    };

    const outcome = await createJourney(command, dependencies(repository));
    expect(outcome.status, "created").toBe("created");
    const draft = drafts[0];
    expect(draft, "draft captured").toBeDefined();
    if (draft === undefined) return;

    const [plain, fixed] = draft.currentPlan.activities;
    expect(plain, "ordinary activity keeps its input priority").toMatchObject({
      priority: "low",
      locked: false,
    });
    expect(plain?.reservationId, "ordinary activity has no reservation").toBeUndefined();

    expect(fixed, "reservation activity is forced to locked high").toMatchObject({
      priority: "high",
      locked: true,
    });
    expect(fixed?.reservationId, "reservation activity carries the link").toBe(idAt(6));

    expect(draft.reservations, "one independent reservation fact").toHaveLength(1);
    const snapshot = draft.reservations[0];
    expect(snapshot?.reservation.id, "reservation id").toBe(idAt(6));
    expect(snapshot?.reservation.confirmation, "confirmed and user reported").toMatchObject({
      status: "confirmed",
      source: { kind: "user_reported" },
    });
    expect(snapshot?.reservation, "reservation mirrors the activity window").toMatchObject({
      placeId: fixed?.placeId,
      startsAt: fixed?.startsAt,
      endsAt: fixed?.endsAt,
    });
    expect(snapshot?.placeName, "reservation keeps its own place name").toBe("固定晚餐");
  });

  it("builds every timestamp from the plan date with an explicit +08:00 offset", async () => {
    const { repository, drafts } = captureRepository();
    // A clock that is far away in absolute terms must not leak into the plan.
    const outcome = await createJourney(
      { ...validCommand(), date: "2026-03-01", activities: [activity({ startsAt: "00:00", endsAt: "23:59" })] },
      {
        repository,
        idGenerator: sequentialIds(),
        clock: { now: () => new Date("2026-02-28T16:00:00.000Z") },
      },
    );

    expect(outcome.status, "created").toBe("created");
    const draft = drafts[0];
    expect(draft?.currentPlan.activities[0], "activity window").toMatchObject({
      startsAt: "2026-03-01T00:00:00+08:00",
      endsAt: "2026-03-01T23:59:00+08:00",
    });
    expect(draft?.createdAt, "created stamp uses the injected clock in +08:00").toBe(
      "2026-03-01T00:00:00+08:00",
    );
    expect(draft?.currentPlan, "first version").toMatchObject({
      version: 1,
      date: "2026-03-01",
      timeZone: "Asia/Shanghai",
    });
  });

  it("rejects a generator that returns an invalid or duplicate UUID", async () => {
    const { repository } = captureRepository();
    const invalid: JourneyIdGenerator = { next: () => "not-a-uuid" };
    await expect(
      createJourney(validCommand(), dependencies(repository, invalid)),
      "invalid uuid",
    ).rejects.toThrow();

    const duplicate: JourneyIdGenerator = { next: () => JOURNEY_ID };
    await expect(
      createJourney(validCommand(), dependencies(repository, duplicate)),
      "duplicate uuid",
    ).rejects.toThrow();
  });

  it("rejects an invalid injected clock and never mutates the input", async () => {
    const { repository } = captureRepository();
    await expect(
      createJourney(validCommand(), {
        repository,
        idGenerator: sequentialIds(),
        clock: { now: () => new Date(Number.NaN) },
      }),
      "invalid clock",
    ).rejects.toThrow();

    const command = validCommand();
    const before = JSON.stringify(command);
    await createJourney(command, dependencies(captureRepository().repository));
    expect(JSON.stringify(command), "input untouched").toBe(before);
  });
});

describe("S3.2 get journey boundaries", () => {
  const storedJourney = (): StoredJourney => ({
    creationKind: "manual",
    currentObservationVersion: 0,
    journeyId: JOURNEY_ID,
    title: "边界行程",
    createdAt: "2026-10-15T00:05:06+08:00",
    updatedAt: "2026-10-15T00:05:06+08:00",
    currentPlan: {
      journeyId: JOURNEY_ID,
      date: "2026-10-15",
      timeZone: "Asia/Shanghai",
      version: 1,
      changeReason: "initial_creation",
      activities: [
        { id: idAt(2), placeId: idAt(3), startsAt: "2026-10-15T09:00:00+08:00", endsAt: "2026-10-15T10:00:00+08:00", priority: "normal", locked: false },
        { id: idAt(4), placeId: idAt(5), startsAt: "2026-10-15T18:00:00+08:00", endsAt: "2026-10-15T19:00:00+08:00", priority: "high", locked: true, reservationId: idAt(6) },
      ],
    },
    activitySnapshots: [
      { activityId: idAt(2), position: 0, placeName: "上午地点" },
      { activityId: idAt(4), position: 1, placeName: "固定晚餐" },
    ],
    reservations: [
      {
        placeName: "固定晚餐",
        reservation: {
          id: idAt(6),
          placeId: idAt(5),
          startsAt: "2026-10-15T18:00:00+08:00",
          endsAt: "2026-10-15T19:00:00+08:00",
          confirmation: { status: "confirmed", source: { kind: "user_reported" }, recordedAt: "2026-10-15T00:05:06+08:00" },
        },
      },
    ],
  });

  function repositoryReturning(stored: StoredJourney | null): JourneyRepository {
    return {
      async createInitialJourney() {},
      async findCurrentJourney() {
        return stored;
      },
    };
  }

  it("separates an invalid id from a missing journey and a found one", async () => {
    await expect(getJourney("not-a-uuid", repositoryReturning(null))).resolves.toEqual({
      status: "invalid_id",
    });
    await expect(
      getJourney("40000000-0000-4000-8000-0000000000ff", repositoryReturning(null)),
    ).resolves.toEqual({ status: "not_found" });

    const found = await getJourney(JOURNEY_ID, repositoryReturning(storedJourney()));
    expect(found.status, "found").toBe("found");
    if (found.status !== "found") return;
    expect(found.journey.activities.map((item) => item.kind), "reservation kind detected").toEqual([
      "activity",
      "reservation",
    ]);
    expect(found.journey.activities[1]?.reservation, "reservation detail projected").toMatchObject({
      id: idAt(6),
      confirmationStatus: "confirmed",
      sourceKind: "user_reported",
    });
    expect(found.journey.activities[0]?.reservation, "ordinary activity has no reservation detail").toBeUndefined();
  });

  it("refuses to project an inconsistent stored journey", async () => {
    const base = storedJourney();
    const variants: ReadonlyArray<readonly [string, StoredJourney]> = [
      ["plan of another journey", { ...base, currentPlan: { ...base.currentPlan, journeyId: idAt(6) } }],
      ["position gap", { ...base, activitySnapshots: [{ ...base.activitySnapshots[0]!, position: 1 }, base.activitySnapshots[1]!] }],
      ["snapshot count mismatch", { ...base, activitySnapshots: [base.activitySnapshots[0]!] }],
      [
        "missing linked reservation",
        { ...base, reservations: [] },
      ],
      [
        "reservation no longer matches the activity",
        {
          ...base,
          reservations: [
            {
              ...base.reservations[0]!,
              reservation: { ...base.reservations[0]!.reservation, endsAt: "2026-10-15T20:00:00+08:00" },
            },
          ],
        },
      ],
      [
        "reservation activity unlocked",
        {
          ...base,
          currentPlan: {
            ...base.currentPlan,
            activities: [base.currentPlan.activities[0]!, { ...base.currentPlan.activities[1]!, locked: false }],
          },
        },
      ],
    ];

    for (const [label, stored] of variants) {
      await expect(getJourney(JOURNEY_ID, repositoryReturning(stored)), `${label} refused`).rejects.toBeInstanceOf(
        JourneyReadModelError,
      );
    }
  });
});
