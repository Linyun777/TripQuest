import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  getSharedJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { createUserUsage, meteredAmap, RUN_BUDGET_MESSAGE } from "../../usage/usage";
import { traced } from "../runs";

/**
 * V3.0 网页入口的运行记录（stages/V3.0.md §5 覆盖完整）：每次计量请求都对到一个根运行（用量带 run_id），
 * 漏接的入口也会补一个 other 根运行；共用预算用完时请求不发，说法和“今天的次数用完”分开。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V3.0 every metered request belongs to a run", () => {
  // 自己的库：web 的其他数据库测试会清表（PITFALLS §2）。
  const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = Object.assign(new URL(safe), { pathname: "/tripquest_v30_runs_test" }).toString();
  const admin = () => createJourneyDatabase(safe, { maxConnections: 1 });
  let user: string;
  const rows = async <T extends object>(sql: string, ...values: unknown[]) =>
    (await getSharedJourneyDatabase().pool.query<T>(sql, values)).rows;

  beforeAll(async () => {
    const setup = admin();
    await setup.pool.query("DROP DATABASE IF EXISTS tripquest_v30_runs_test WITH (FORCE)");
    await setup.pool.query("CREATE DATABASE tripquest_v30_runs_test");
    await setup.close();
    vi.stubEnv("DATABASE_URL", requireSafeTestDatabaseUrl(url, process.env.DATABASE_URL));
    const { pool, database } = getSharedJourneyDatabase();
    await migrateJourneyDatabase(database, { migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle") });
    user = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'")).rows[0]!.id;
  });
  afterAll(async () => {
    await closeSharedJourneyDatabase();
    vi.unstubAllEnvs();
    const cleanup = admin();
    await cleanup.pool.query("DROP DATABASE IF EXISTS tripquest_v30_runs_test WITH (FORCE)");
    await cleanup.close();
  });

  it("requests inside an entry carry its root run; a request outside any run still gets one", async () => {
    const usage = createUserUsage(user);
    const root = await traced({ trigger: "plan", userId: user }, async (run) => {
      await usage.reserve("amap", "search", "plan");
      await usage.reserve("model", "model", "plan");
      return run.rootId;
    });
    await usage.reserve("amap", "detail", "open");

    const events = await rows<{ run_id: string | null; kind: string }>("SELECT run_id, kind FROM usage_events ORDER BY created_at, kind");
    expect(events.filter((event) => event.run_id === null)).toEqual([]);
    expect(events.filter((event) => event.run_id === root).map((event) => event.kind).sort()).toEqual(["model", "search"]);
    const runs = await rows<{ id: string; trigger: string; map_requests: number; attributes: Record<string, unknown> }>(
      "SELECT id, trigger, map_requests, attributes FROM agent_runs ORDER BY started_at",
    );
    expect(runs).toEqual([
      // 模型次数在传输层记（这里没有真的发模型请求），地图在计量依赖里记。
      expect.objectContaining({ id: root, trigger: "plan", map_requests: 1 }),
      expect.objectContaining({ trigger: "other", map_requests: 1, attributes: { purpose: "open" } }),
    ]);
  });

  it("once the shared budget is spent the request is not sent and the message says why", async () => {
    // 不发真实请求：高德的 HTTP 换成空结果；要在建提供方之前换（它在构造时拿 fetch）。
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ status: "1", count: "0", pois: [] }));
    const amap = meteredAmap({ key: "synthetic", usage: createUserUsage(user), purpose: "plan" });
    const request = { query: "咖啡", scope: { kind: "city", cityAdcode: "330100" }, limit: 5 } as const;
    const second = await traced({ trigger: "plan", userId: user, budget: { amap: 1 } }, async () => {
      await amap.searchPlaces(request as never);
      const sent = fetch.mock.calls.length;
      const reply = await amap.searchPlaces(request as never);
      expect(fetch.mock.calls.length).toBe(sent);
      return reply;
    });
    expect(second).toMatchObject({ status: "failure", failure: { code: "quota_exceeded", safeMessage: RUN_BUDGET_MESSAGE } });
    const [run] = await rows<{ status: string }>("SELECT status FROM agent_runs WHERE trigger = 'plan' ORDER BY started_at DESC LIMIT 1");
    expect(run).toEqual({ status: "budget_exhausted" });
    fetch.mockRestore();
  });
});
