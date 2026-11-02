import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgAgentRunStore, type StoredRun, type StoredStep } from "../agent-runs";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleConversationRepository } from "../conversation-repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { UsageLedger } from "../usage";
import { testUserId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const NOW = new Date("2026-10-27T08:00:00.123Z");
const counts = { model: 2, amap: 5, web: 0, embed: 0, jev: 0, inputTokens: 900, outputTokens: 80, cacheHitTokens: 700 };

function tree(conversationId: string): { runs: StoredRun[]; steps: StoredStep[] } {
  const root = randomUUID();
  const child = randomUUID();
  const base = { version: null, trigger: null, links: {}, outcome: null, attributes: {}, startedAt: NOW, finishedAt: NOW, counts };
  return {
    runs: [
      // 子运行写在前面也要能写进去（写入时根运行排到前面）。
      { ...base, id: child, rootId: root, parentId: root, agent: "day-planner", version: "day-planning.v1", status: "ok" },
      { ...base, id: root, rootId: root, parentId: null, agent: "plan", trigger: "plan", links: { conversationId }, status: "ok" },
    ],
    steps: [
      { runId: child, seq: 1, kind: "model_call", name: "search_places", latencyMs: 812, summary: { code: "ok" }, at: NOW },
      { runId: child, seq: 2, kind: "check", name: "result", latencyMs: null, summary: { tries: 1 }, at: NOW },
    ],
  };
}

/**
 * V3.0 运行记录（stages/V3.0.md §5）：按用户隔离——B 拿着 A 的运行或对话编号查不到；删除对话或账号时运行
 * 记录一起删；用量记上根运行。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V3.0 run records", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let alice: string;
  let bob: string;
  const count = async (sql: string, ...params: unknown[]) => (await client.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v30-test", maxConnections: 3 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM users WHERE username IN ('test_run_a', 'test_run_b')");
    alice = await testUserId(client.pool, "test_run_a");
    bob = await testUserId(client.pool, "test_run_b");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM users WHERE username IN ('test_run_a', 'test_run_b')");
    await client?.close();
  });

  it("someone else's runs are not found, and deleting the conversation or the account removes them", async () => {
    const conversation = randomUUID();
    await new DrizzleConversationRepository(client.database, alice).createConversation({ id: conversation, title: "规划", now: NOW });
    const { runs, steps } = tree(conversation);
    const mine = new PgAgentRunStore(client.pool, alice);
    await mine.write(runs, steps);
    const rootId = runs[1]!.id;

    const found = await mine.findTree(runs[0]!.id);
    expect(found?.runs.map((run) => run.agent)).toEqual(["plan", "day-planner"]);
    expect(found?.steps.map((step) => step.name)).toEqual(["search_places", "result"]);
    expect(found?.runs[0]).toMatchObject({ model_requests: 2, map_requests: 5, cache_hit_tokens: 700 });
    expect((found?.runs[0]!.started_at as Date).getMilliseconds()).toBe(123);
    expect(await mine.listForConversation(conversation)).toHaveLength(1);

    const theirs = new PgAgentRunStore(client.pool, bob);
    expect(await theirs.findTree(rootId)).toBeNull();
    expect(await theirs.listForConversation(conversation)).toEqual([]);

    // 产品里还没有删除对话；直接删行，核对外键连带删除。
    await client.pool.query("DELETE FROM conversations WHERE id = $1", [conversation]);
    expect(await count("SELECT count(*)::int AS n FROM agent_runs WHERE root_id = $1", rootId)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM agent_steps WHERE run_id = $1", runs[0]!.id)).toBe(0);

    // 不挂对话的运行（如打开页面）随账号删除。
    const other = tree(conversation);
    const loose = other.runs.map((run) => ({ ...run, links: {} }));
    await mine.write(loose, other.steps);
    await client.pool.query("DELETE FROM users WHERE id = $1", [alice]);
    expect(await count("SELECT count(*)::int AS n FROM agent_runs WHERE root_id = $1", loose[1]!.id)).toBe(0);
  });

  it("each usage reservation carries the root run it was made for", async () => {
    const run = randomUUID();
    await new UsageLedger(client.pool, alice, {}, () => NOW.getTime(), () => run).reserve("amap", "search", "plan");
    await new UsageLedger(client.pool, alice, {}, () => NOW.getTime()).reserve("amap", "search", "plan");
    const { rows } = await client.pool.query<{ run_id: string | null }>(
      "SELECT run_id FROM usage_events WHERE user_id = $1 ORDER BY run_id NULLS LAST",
      [alice],
    );
    expect(rows.map((row) => row.run_id)).toEqual([run, null]);
  });
});
