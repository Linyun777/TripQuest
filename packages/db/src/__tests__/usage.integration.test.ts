import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import {
  chinaDay,
  resetSiteDailyLimit,
  resetUserDailyLimit,
  setSiteDailyLimit,
  setUserDailyLimit,
  siteUsageOverview,
  UsageLedger,
  UsageLimitError,
  UsageUnavailableError,
} from "../usage";
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
    await client.pool.query("DELETE FROM site_usage_limits");
    alice = await testUserId(client.pool, "test_usage_a");
    bob = await testUserId(client.pool, "test_usage_b");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM users WHERE username IN ('test_usage_a', 'test_usage_b')");
    await client?.pool.query("DELETE FROM site_usage_limits");
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

  it("a ledger that cannot be reached is not reported as a used-up limit", async () => {
    // 连不上的库（本机没有监听的端口）：没记上、请求不发，但不能说成“今天用完了”。
    const down = createJourneyDatabase("postgresql://nobody:nothing@127.0.0.1:1/unreachable_test", { connectionTimeoutMillis: 500 });
    const failed = await new UsageLedger(down.pool, alice, {}, () => NOW).reserve("model", "model", "chat").catch((error: unknown) => error);
    await down.close();
    expect(failed).toBeInstanceOf(UsageUnavailableError);
    expect(failed).not.toBeInstanceOf(UsageLimitError);
  });

  it("concurrent reservations never go past the limit", async () => {
    const env = { USER_DAILY_LIMIT_AMAP: "5" };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ledger(alice, env).reserve("amap", "route", "plan")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE user_id = $1", [alice])).rows[0].n).toBe(5);
  });

  it("concurrent model calls by different users share the production site ceiling", async () => {
    const environment = { NODE_ENV: "production", MODEL_DAILY_LIMIT: "3", USER_DAILY_LIMIT_MODEL: "10" };
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      ledger(index % 2 === 0 ? alice : bob, environment).reserve("model", "model", "deployment"),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected").every((result) =>
      result.status === "rejected" && result.reason instanceof UsageLimitError && result.reason.scope === "site",
    )).toBe(true);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM usage_events WHERE category = 'model'")).rows[0].n).toBe(3);
  });

  it("zero production model budget rejects before recording or invoking an external request", async () => {
    let requests = 0;
    const call = async () => {
      await ledger(alice, { NODE_ENV: "production", MODEL_DAILY_LIMIT: "0" }).reserve("model", "model", "deployment");
      requests += 1;
    };
    await expect(call()).rejects.toMatchObject({ scope: "site" });
    expect(requests).toBe(0);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM usage_events")).rows[0].n).toBe(0);
  });

  it("dynamic site and user limit overrides take effect immediately and fall back on reset", async () => {
    const env = { NODE_ENV: "production", MODEL_DAILY_LIMIT: "2", USER_DAILY_LIMIT_MODEL: "1" };
    await ledger(alice, env).reserve("model", "model", "chat");
    await expect(ledger(alice, env).reserve("model", "model", "chat")).rejects.toMatchObject({ scope: "user" });

    // Raise personal limit for alice above site limit: now site limit (2) caps alice after 1 more call.
    await setUserDailyLimit(client.pool, alice, "model", 5);
    await ledger(alice, env).reserve("model", "model", "chat");
    await expect(ledger(alice, env).reserve("model", "model", "chat")).rejects.toMatchObject({ scope: "site" });

    // Raise site limit dynamically in DB without restarting or changing env: alice can proceed immediately.
    await setSiteDailyLimit(client.pool, "model", 4);
    await ledger(alice, env).reserve("model", "model", "chat");

    const overview = await siteUsageOverview(client.pool, chinaDay(NOW), env);
    expect(overview.find((item) => item.category === "model")).toMatchObject({
      used: 3,
      limit: 4,
      defaultLimit: 2,
      customLimit: 4,
      remaining: 1,
    });

    // Setting site limit to 0 immediately blocks bob too.
    await setSiteDailyLimit(client.pool, "model", 0);
    await expect(ledger(bob, env).reserve("model", "model", "chat")).rejects.toMatchObject({ scope: "site" });

    // Resetting overrides falls back to environment defaults cleanly.
    await resetSiteDailyLimit(client.pool, "model");
    await resetUserDailyLimit(client.pool, alice, "model");
    expect(await ledger(alice, env).today()).toEqual(expect.arrayContaining([{ category: "model", used: 3, limit: 1 }]));
    const restored = await siteUsageOverview(client.pool, chinaDay(NOW), env);
    expect(restored.find((item) => item.category === "model")).toMatchObject({
      used: 3,
      limit: 2,
      defaultLimit: 2,
      customLimit: null,
      remaining: 0,
    });
  });
});
