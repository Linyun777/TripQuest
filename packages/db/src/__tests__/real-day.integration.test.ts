import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getJourney, type InitialJourneyDraft } from "@tripquest/application";
import { checkDayProgress } from "@tripquest/application/day-progress";
import type { InitialRealDayDraft } from "@tripquest/application/real-day";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleJourneyRepository } from "../repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

// Synthetic IDs and names only; no real Amap data.
const ID = {
  journey: "50000000-0000-4000-8000-000000000001",
  run: "50000000-0000-4000-8000-000000000002",
  start: "50000000-0000-4000-8000-000000000003",
  museum: "50000000-0000-4000-8000-000000000004",
  end: "50000000-0000-4000-8000-000000000005",
  activity: "50000000-0000-4000-8000-000000000006",
  manual: "50000000-0000-4000-8000-000000000007",
  manualActivity: "50000000-0000-4000-8000-000000000008",
  manualPlace: "50000000-0000-4000-8000-000000000009",
} as const;
const at = "2026-10-15T09:00:00+08:00" as const;

function realDraft(intent = "a".repeat(64)): InitialRealDayDraft {
  return {
    journeyId: ID.journey,
    title: "合成真实行程",
    createdAt: at,
    updatedAt: at,
    creationRunId: ID.run,
    creationIntentFingerprint: intent,
    currentPlan: {
      journeyId: ID.journey,
      date: "2026-10-16",
      timeZone: "Asia/Shanghai",
      version: 1,
      changeReason: "initial_creation",
      activities: [{
        id: ID.activity,
        placeId: ID.museum,
        startsAt: "2026-10-16T09:20:00+08:00",
        endsAt: "2026-10-16T10:50:00+08:00",
        priority: "high",
        locked: false,
      }],
    },
    activitySnapshots: [{ activityId: ID.activity, position: 0, placeName: "合成博物馆" }],
    reservations: [],
    realDay: {
      schemaVersion: "stored-real-day.v1",
      planVersion: 1,
      context: {
        creationRunId: ID.run,
        requirementsFingerprint: "b".repeat(64),
        date: "2026-10-16",
        timeZone: "Asia/Shanghai",
        window: { startsAt: 540, endsAt: 1080 },
        startPlaceId: ID.start,
        endPlaceId: ID.end,
        bufferMinutes: 5,
        pace: "standard",
        interests: [],
      },
      places: [
        { placeId: ID.start, provider: "amap", externalId: "SYN0", name: "合成起点" },
        { placeId: ID.museum, provider: "amap", externalId: "SYN1", name: "合成博物馆" },
        { placeId: ID.end, provider: "amap", externalId: "SYN3", name: "合成餐厅" },
      ],
      activities: [{
        record: {
          activity: {
            activityId: ID.activity,
            placeId: ID.museum,
            role: "required",
            stayMinutes: 90,
            staySource: "user",
            opening: { status: "unknown" },
            tickets: "unknown",
          },
        },
        startsAt: 560,
        endsAt: 650,
      }],
      acknowledgeUnknowns: true,
    },
  };
}

const manualDraft: InitialJourneyDraft = {
  journeyId: ID.manual,
  title: "手动行程",
  createdAt: at,
  updatedAt: at,
  currentPlan: {
    journeyId: ID.manual,
    date: "2026-10-16",
    timeZone: "Asia/Shanghai",
    version: 1,
    changeReason: "initial_creation",
    activities: [{
      id: ID.manualActivity,
      placeId: ID.manualPlace,
      startsAt: "2026-10-16T10:00:00+08:00",
      endsAt: "2026-10-16T11:00:00+08:00",
      priority: "normal",
      locked: false,
    }],
  },
  activitySnapshots: [{ activityId: ID.manualActivity, position: 0, placeName: "手动地点" }],
  reservations: [],
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.5 real days on PostgreSQL", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-s55-test", maxConnections: 2 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM journeys");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM journeys");
    await client?.close();
  });

  it("stores only the minimal record and reads it back as a real day", async () => {
    expect(await repository.createRealDay(realDraft())).toEqual({ status: "saved", journeyId: ID.journey, planVersion: 1 });
    const stored = await repository.findCurrentJourney(ID.journey);
    expect(stored).toMatchObject({ creationKind: "real_day", realDay: realDraft().realDay });
    expect(stored?.dayDetails).toBeUndefined();
    const read = await getJourney(ID.journey, repository);
    expect(read).toMatchObject({ status: "found", journey: { creationKind: "real_day", realDay: { places: expect.any(Array) } } });
    const { rows } = await client.pool.query("SELECT details::text AS text FROM day_plan_details");
    expect(rows[0].text).not.toMatch(/location|longitude|address|duration|distance|retrievedAt/);
    // Generated-day flows refuse a real day before any work.
    expect(checkDayProgress(stored!, {
      reportId: "50000000-0000-4000-8000-0000000000aa",
      basePlanVersion: 1,
      baseObservationVersion: 0,
      completedActivityIds: [],
      skippedActivityIds: [],
      observedAt: "2026-10-16T10:00+08:00",
      earliestResumeAt: "2026-10-16T10:00+08:00",
      location: { kind: "unknown" },
      noCurrentActivity: true,
    }, "c".repeat(64))).toEqual({ status: "source_not_allowed" });
  });

  it("keeps the trip's city; a trip saved without one reads back as Hangzhou (V2.10)", async () => {
    await repository.createRealDay({ ...realDraft(), city: { adcode: "510100", name: "成都市" } });
    expect((await repository.findCurrentJourney(ID.journey))?.city).toEqual({ adcode: "510100", name: "成都市" });
    await repository.createInitialJourney(manualDraft);
    expect((await repository.findCurrentJourney(ID.manual))?.city).toEqual({ adcode: "330100", name: "杭州市" });
  });

  it("records progress on a real day and confirms an adjustment as the next version, once (V2.5)", async () => {
    await repository.createRealDay(realDraft());
    const report = (reportId: string, extra: Record<string, unknown> = {}) => ({
      reportId, basePlanVersion: 1, baseObservationVersion: 0, completedActivityIds: [ID.activity], skippedActivityIds: [],
      observedAt: "2026-10-16T10:55+08:00", earliestResumeAt: "2026-10-16T11:00+08:00",
      location: { kind: "known" as const, placeId: ID.museum }, noCurrentActivity: true as const, ...extra,
    });
    // v2: the museum is done (history), a tea house is added after it.
    const tea = { activity: "50000000-0000-4000-8000-0000000000b1", place: "50000000-0000-4000-8000-0000000000b2" };
    const v1 = realDraft().realDay;
    const adjusted = {
      next: {
        currentPlan: {
          journeyId: ID.journey, date: "2026-10-16", timeZone: "Asia/Shanghai" as const, version: 2, changeReason: "user_confirmed_replan",
          activities: [{ id: tea.activity, placeId: tea.place, startsAt: "2026-10-16T11:30:00+08:00" as const, endsAt: "2026-10-16T12:30:00+08:00" as const, priority: "normal" as const, locked: false }],
        },
        activitySnapshots: [{ activityId: tea.activity, position: 0, placeName: "合成茶馆" }],
        reservations: [],
      },
      realDay: {
        ...v1,
        planVersion: 2,
        context: { ...v1.context, window: { startsAt: 660, endsAt: 1080 }, startPlaceId: ID.museum, freeInterests: [{ id: "i1", text: "喝茶" }] },
        places: [...v1.places, { placeId: tea.place, provider: "amap" as const, externalId: "SYN4", name: "合成茶馆" }],
        activities: [{
          record: { activity: { activityId: tea.activity, placeId: tea.place, role: "discovered" as const, stayMinutes: 60, staySource: "system_estimate" as const, opening: { status: "unknown" as const }, tickets: "unknown" as const }, interest: "i1" },
          startsAt: 690, endsAt: 750,
        }],
        archived: [{ activityId: ID.activity, placeId: ID.museum, status: "completed" as const, startsAt: 560, endsAt: 650 }],
        change: { parentVersion: 1, note: "加一个喝茶", origin: { placeId: ID.start, startsAt: 540 } },
      },
      diff: [],
    };
    const commit = (intent: string, base = { plan: 1, observation: 0 }) => repository.commitRealDayAdjustment({
      journeyId: ID.journey, runId: "50000000-0000-4000-8000-0000000000c1", intentFingerprint: intent,
      basePlanVersion: base.plan, baseObservationVersion: base.observation,
      progress: report("50000000-0000-4000-8000-0000000000a2"), adjusted, confirmedAt: "2026-10-16T11:00:00+08:00",
    });
    expect(await commit("d".repeat(64), { plan: 1, observation: 1 })).toEqual({ status: "stale" });
    expect(await commit("d".repeat(64))).toEqual({ status: "saved", planVersion: 2 });
    expect(await commit("d".repeat(64))).toEqual({ status: "already_saved", planVersion: 2 });
    expect(await commit("e".repeat(64))).toEqual({ status: "intent_conflict" });
    const stored = await repository.findCurrentJourney(ID.journey);
    expect(stored).toMatchObject({
      currentPlan: { version: 2 }, currentObservationVersion: 1,
      dayProgress: { completedActivityIds: [ID.activity], locationPlaceId: ID.museum },
      realDay: { planVersion: 2, archived: [{ status: "completed" }], change: { parentVersion: 1 } },
    });
    // The page reads it with its progress; the first version stays readable as it was.
    expect(await getJourney(ID.journey, repository)).toMatchObject({ status: "found", journey: { version: 2 } });
    expect((await repository.findJourneyVersion(ID.journey, 1))?.realDay?.planVersion).toBe(1);
    // A later report builds on the new versions; taking back the museum is refused.
    expect(await repository.commitRealDayProgress({
      journeyId: ID.journey, command: report("50000000-0000-4000-8000-0000000000a3", { basePlanVersion: 2, baseObservationVersion: 1, completedActivityIds: [] }), recordedAt: at,
    })).toEqual({ status: "invalid_report" });
    expect(await repository.commitRealDayProgress({
      journeyId: ID.journey, command: report("50000000-0000-4000-8000-0000000000a4", { basePlanVersion: 2, baseObservationVersion: 1, completedActivityIds: [ID.activity, tea.activity] }), recordedAt: at,
    })).toEqual({ status: "saved", observationVersion: 2 });
    const { rows } = await client.pool.query("SELECT details::text AS text FROM day_plan_details");
    expect(rows.map((row) => row.text).join()).not.toMatch(/location|longitude|address|duration|distance/);
  });

  it("replays the same intent and refuses another one for the same run", async () => {
    await repository.createRealDay(realDraft());
    expect(await repository.createRealDay(realDraft())).toMatchObject({ status: "already_saved" });
    expect(await repository.createRealDay(realDraft("d".repeat(64)))).toEqual({ status: "intent_conflict" });
  });

  it("refuses a record that does not match its plan rows", async () => {
    const draft = realDraft();
    const broken = { ...draft, activitySnapshots: [{ ...draft.activitySnapshots[0], placeName: "别的名字" }] };
    await expect(repository.createRealDay(broken)).rejects.toThrow();
    expect((await client.pool.query("SELECT count(*)::int AS n FROM journeys")).rows[0].n).toBe(0);
  });

  it("lists saved journeys newest change first (V2.1 我的行程)", async () => {
    await repository.createInitialJourney(manualDraft);
    await repository.createRealDay(realDraft());
    const listed = await repository.listJourneys(10);
    expect(listed.map((item) => item.creationKind).sort()).toEqual(["manual", "real_day"]);
    expect(listed[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), date: "2026-10-16" });
    expect(Date.parse(listed[0].updatedAt)).toBeGreaterThanOrEqual(Date.parse(listed[1].updatedAt));
    expect(await repository.listJourneys(1)).toHaveLength(1);
  });

  it("purge deletes only real days", async () => {
    await repository.createRealDay(realDraft());
    await repository.createInitialJourney(manualDraft);
    const output = execFileSync("node", [fileURLToPath(new URL("../../scripts/purge-real-days.mjs", import.meta.url)), "--user", "owner", "--yes"], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(output).toContain("owner: deleted 1 real-place day(s)");
    const { rows } = await client.pool.query("SELECT id, creation_kind FROM journeys");
    expect(rows).toEqual([{ id: ID.manual, creation_kind: "manual" }]);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM day_plan_details")).rows[0].n).toBe(0);
  });
});
