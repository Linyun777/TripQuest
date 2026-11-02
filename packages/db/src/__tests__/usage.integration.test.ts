import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { setUserDailyLimit, UsageLedger, UsageLimitError } from "../usage";
import { testUserId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const NOW = Date.parse("2026-10-27T02:00:00Z");

/** V2.12 两层用量上限（stages/V2.12.md §3.5、§5）：一个人用完不影响别人，全站上限仍然有效。 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.12 daily usage per user and for the site", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let alice: string;
  let bob: string;
  const ledger = (userId: string, environment: Record<string, string> = {}) => new UsageLedger(client.pool, userId, environment, () => NOW);

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v212-usage-test", maxConnections: 6 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM users WHERE username IN ('test_usage_a', 'test_usage_b')");
    await client.pool.query("DELETE FROM usage_events");
    alice = await testUserId(client.pool, "test_usage_a");
    bob = await testUserId(client.pool, "test_usage_b");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM users WHERE username IN ('test_usage_a', 'test_usage_b')");
    await client?.close();
  });

  it("one user running out does not stop another; an owner override and the site limit both apply", async () => {
    const env = { USER_DAILY_LIMIT_WEB: "2", WEB_SEARCH_DAILY_LIMIT: "3" };
    await ledger(alice, env).reserve("web", "web-search", "chat");
    await ledger(alice, env).reserve("web", "web-search", "chat");
    await expect(ledger(alice, env).reserve("web", "web-search", "chat")).rejects.toMatchObject({ category: "web", scope: "user" });
    await ledger(bob, env).reserve("web", "web-search", "chat");
    // 全站 3 次已满：调高了个人上限的人也不行。
    await setUserDailyLimit(client.pool, bob, "web", 10);
    await expect(ledger(bob, env).reserve("web", "web-search", "chat")).rejects.toMatchObject({ scope: "site" });
    expect(await ledger(alice, env).today()).toEqual(expect.arrayContaining([{ category: "web", used: 2, limit: 2 }]));
    expect(await ledger(bob, env).today()).toEqual(expect.arrayContaining([{ category: "web", used: 1, limit: 10 }]));
    // 模型：每人有上限（缺省 300），全站不限；Jev 缺省关闭。
    await expect(ledger(alice).reserve("jev", "pick-jev", "plan")).rejects.toBeInstanceOf(UsageLimitError);
  });

  it("concurrent reservations never go past the limit", async () => {
    const env = { USER_DAILY_LIMIT_AMAP: "5" };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ledger(alice, env).reserve("amap", "route", "plan")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [alice])).rows[0].n).toBe(5);
  });
});
