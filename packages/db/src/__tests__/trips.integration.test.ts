import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleJourneyRepository } from "../repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { id, segment, trip } from "./outing-fixtures";
import { ownerId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.11 an outing is saved with its days in one transaction", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v211-test", maxConnections: 2 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM trips");
    await client.pool.query("DELETE FROM journeys");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM trips");
    await client?.pool.query("DELETE FROM journeys");
    await client?.close();
  });

  it("saves the outing and its days together, replays a retry, and lists the days under the outing", async () => {
    const days = [{ day: 1, part: 0, journey: segment(1, "2026-10-17") }, { day: 2, part: 0, journey: segment(2, "2026-10-18") }];
    expect(await repository.createTrip(trip(days))).toEqual({ status: "saved", tripId: id(9, 1) });
    expect(await repository.createTrip({ ...trip(days), tripId: id(9, 3) })).toEqual({ status: "already_saved", tripId: id(9, 1) });
    expect(await repository.findTrip(id(9, 1))).toMatchObject({
      title: "云岭出游",
      days: [{ day: 1, part: 0, journeyId: id(1, 1) }, { day: 2, part: 0, journeyId: id(2, 1) }],
    });
    const listed = await repository.listJourneys(10);
    expect(listed.map((item) => item.trip)).toEqual(expect.arrayContaining([
      { id: id(9, 1), title: "云岭出游", day: 1, part: 0, firstDate: "2026-10-17", lastDate: "2026-10-18" },
      { id: id(9, 1), title: "云岭出游", day: 2, part: 0, firstDate: "2026-10-17", lastDate: "2026-10-18" },
    ]));
    // 一趟出游算一项：只要 1 项也带全它的各天（按行截取时后面的天被截掉，页面把它们显示成“只有交通”）。
    await repository.createRealDay(segment(4, "2026-10-20"));
    expect((await repository.listJourneys(1)).map((item) => item.trip?.day).sort()).toEqual([1, 2]);
    expect(await repository.listJourneys(2)).toHaveLength(3);
    const { rows } = await client.pool.query("SELECT details::text AS text FROM trips");
    expect(rows[0].text).not.toMatch(/location|longitude|address|duration|distance/);
  });

  it("keeps nothing when one day cannot be written, and deleting the outing deletes its days", async () => {
    // 第二天和第一天用同一个规划编号：违反唯一约束，整趟回滚。
    const clash = { ...segment(2, "2026-10-18"), creationRunId: id(1, 2) };
    const broken = [{ day: 1, part: 0, journey: segment(1, "2026-10-17") }, { day: 2, part: 0, journey: { ...clash, realDay: { ...clash.realDay, context: { ...clash.realDay.context, creationRunId: id(1, 2) } } } }];
    await expect(repository.createTrip(trip(broken))).rejects.toThrow();
    expect((await client.pool.query("SELECT count(*)::int AS n FROM trips")).rows[0].n).toBe(0);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM journeys")).rows[0].n).toBe(0);

    await repository.createTrip(trip([{ day: 1, part: 0, journey: segment(1, "2026-10-17") }, { day: 2, part: 0, journey: segment(2, "2026-10-18") }]));
    expect(await repository.deleteTrip(id(9, 1))).toBe("deleted");
    expect((await client.pool.query("SELECT count(*)::int AS n FROM journeys")).rows[0].n).toBe(0);
  });

  it("replaces a day that has not started and skips today's stop in one change; a stale base changes nothing", async () => {
    await repository.createTrip(trip([{ day: 1, part: 0, journey: segment(1, "2026-10-17") }, { day: 2, part: 0, journey: segment(2, "2026-10-18") }]));
    const base = (await repository.readTripBase(id(9, 1)))!;
    expect(base.tripVersion).toBe(1);
    const change = {
      tripId: id(9, 1),
      changeId: id(9, 5),
      base: { tripVersion: base.tripVersion, journeys: base.journeys },
      replace: [{ day: 2, journeys: [{ day: 2, part: 0, journey: segment(3, "2026-10-18") }] }],
      skip: { journeyId: id(1, 1), activityId: id(1, 6) },
      details: trip([]).details,
      confirmedAt: "2026-10-17T17:30:00+08:00" as const,
    };
    // 别的天变了（版本对不上）：整体拒绝，什么都不改。
    expect(await repository.commitOutingChange({ ...change, base: { ...change.base, tripVersion: 0 } })).toEqual({ status: "stale" });
    expect((await repository.findTrip(id(9, 1)))!.days.map((day) => day.journeyId)).toEqual([id(1, 1), id(2, 1)]);

    const saved = await repository.commitOutingChange(change);
    expect(saved.status).toBe("saved");
    expect((await repository.findTrip(id(9, 1)))!.days.map((day) => day.journeyId)).toEqual([id(1, 1), id(3, 1)]);
    expect((await repository.readTripBase(id(9, 1)))!.tripVersion).toBe(2);
    expect((await repository.findCurrentJourney(id(1, 1)))!.dayProgress?.skippedActivityIds).toEqual([id(1, 6)]);
    // 重试同一个改动：照旧返回已保存，不再写。
    expect((await repository.commitOutingChange(change)).status).toBe("already_saved");
  });
});
