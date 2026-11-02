import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createInvite, registerWithInvite } from "@tripquest/auth";
import { emptyDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  DrizzleConversationRepository,
  getSharedJourneyDatabase,
  migrateJourneyDatabase,
  PgPlanningTaskRepository,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { getAuth } from "../../auth/session";

const BASE = "http://localhost:3000";
const NOW = new Date("2026-10-27T10:00:00Z");

/**
 * V2.12 数据隔离走真实的接口和会话（stages/V2.12.md §3.4、§5）：两个用邀请码注册的账号，B 拿着 A 的编号去读、改、删
 * 对话、出游、任务、偏好和进度，全部 404，A 的数据不变；没登录一律 401。决策记录没有对外接口（pnpm trace 是
 * 拥有者的命令行），仓库层的隔离见 packages/db 的 isolation 测试。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.12 someone else's ids answer 404 through the real routes", () => {
  // 自己的库：web 的其他数据库测试会清空对话、出游这些表，和它们共用测试库时 A 的数据会在断言前被删掉。
  const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = Object.assign(new URL(safe), { pathname: "/tripquest_v212_api_test" }).toString();
  const admin = () => createJourneyDatabase(safe, { maxConnections: 1 });
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  const ids = { conversation: randomUUID(), trip: randomUUID(), task: randomUUID(), preference: randomUUID(), journey: randomUUID() };

  const request = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) => new Request(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { origin: BASE, host: "localhost:3000", "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const count = async (sql: string, ...values: unknown[]) => (await getSharedJourneyDatabase().pool.query<{ n: number }>(sql, values)).rows[0]!.n;

  beforeAll(async () => {
    const setup = admin();
    await setup.pool.query("DROP DATABASE IF EXISTS tripquest_v212_api_test WITH (FORCE)");
    await setup.pool.query("CREATE DATABASE tripquest_v212_api_test");
    await setup.close();
    vi.stubEnv("DATABASE_URL", requireSafeTestDatabaseUrl(url, process.env.DATABASE_URL));
    vi.stubEnv("BETTER_AUTH_SECRET", "t".repeat(40));
    vi.stubEnv("BETTER_AUTH_URL", BASE);
    const { pool, database } = getSharedJourneyDatabase();
    await migrateJourneyDatabase(database, { migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle") });
    await pool.query("DELETE FROM users WHERE username IN ('test_api_a', 'test_api_b')");
    const signUp = async (username: string) => {
      const { code } = await createInvite(pool, { createdBy: null, now: new Date() });
      const outcome = await registerWithInvite({ auth: getAuth(), pool, now: () => new Date() }, { inviteCode: code, username, password: "correct-horse-1" });
      if (outcome.status !== "registered") throw new Error(outcome.status);
      return { id: outcome.userId, cookie: outcome.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") };
    };
    alice = await signUp("test_api_a");
    bob = await signUp("test_api_b");

    // A 的数据：一段对话（带一张“要记住吗”卡片）、一条偏好、一趟出游（只有一个行程）、一个任务。
    const conversations = new DrizzleConversationRepository(database, alice.id);
    await conversations.createConversation({ id: ids.conversation, title: "爱丽丝的对话", now: NOW });
    await conversations.appendTurn({
      conversationId: ids.conversation, expectedCount: 0, now: NOW, newId: randomUUID,
      messages: [{ role: "assistant", kind: "preference_proposal", body: { text: "不吃辣", category: "food", status: "pending" } }],
    });
    await pool.query(
      "INSERT INTO preferences (id, user_id, text, category, created_at, updated_at) VALUES ($1, $2, '少走路', 'pace', $3, $3)",
      [ids.preference, alice.id, NOW],
    );
    await pool.query(
      `INSERT INTO trips (id, user_id, generation_id, title, first_date, last_date, details, created_at, updated_at)
       VALUES ($1, $2, $3, '爱丽丝的出游', '2026-11-07', '2026-11-08', '{}', $4, $4)`,
      [ids.trip, alice.id, randomUUID(), NOW],
    );
    await pool.query(
      `INSERT INTO journeys (id, user_id, title, date, time_zone, created_at, updated_at, trip_id, trip_day, trip_part)
       VALUES ($1, $2, '第 1 天', '2026-11-07', 'Asia/Shanghai', $3, $3, $4, 1, 0)`,
      [ids.journey, alice.id, NOW, ids.trip],
    );
    await new PgPlanningTaskRepository(pool, { userId: alice.id }).createTask({
      id: ids.task, kind: "day_draft", journeyId: null, requestKey: randomUUID(), intentFingerprint: "d".repeat(64), input: {}, createdAt: NOW,
    });
  });
  afterAll(async () => {
    await getSharedJourneyDatabase().pool.query("DELETE FROM users WHERE username IN ('test_api_a', 'test_api_b')");
    await closeSharedJourneyDatabase();
    vi.unstubAllEnvs();
    const cleanup = admin();
    await cleanup.pool.query("DROP DATABASE IF EXISTS tripquest_v212_api_test WITH (FORCE)");
    await cleanup.close();
  });

  it("conversations: B cannot send, edit, switch, allocate, decide or ask for notes on A's", async () => {
    // 对话要个人模式和真实模型才开：用占位值打开（B 的请求在查对话时就停了），网络一律不通。
    for (const [name, value] of Object.entries({
      NODE_ENV: "development", PLANNING_PLACE_SOURCE: "amap", REAL_PLACE_SAVE_ENABLED: "true",
      AMAP_WEB_SERVICE_KEY: "synthetic", AGENT_LIVE_ENABLED: "true", AGENT_MODEL_PROFILE: "synthetic",
    })) vi.stubEnv(name, value);
    const network = vi.fn(async () => {
      throw new Error("no network in this test");
    });
    vi.stubGlobal("fetch", network);
    const id = { conversationId: ids.conversation };
    const draft = fingerprint(emptyDraft());
    const calls: [string, Promise<Response>][] = [
      ["messages", (await import("../conversations/[conversationId]/messages/route")).POST(request(`/api/conversations/${ids.conversation}/messages`, { cookie: bob.cookie, body: { text: "偷看", expectedCount: 1 } }), params(id))],
      ["draft", (await import("../conversations/[conversationId]/draft/route")).PATCH(request(`/api/conversations/${ids.conversation}/draft`, { method: "PATCH", cookie: bob.cookie, body: { patch: { date: "2026-11-01" }, fingerprint: draft } }), params(id))],
      ["mode", (await import("../conversations/[conversationId]/mode/route")).POST(request(`/api/conversations/${ids.conversation}/mode`, { cookie: bob.cookie, body: { mode: "outing", fingerprint: draft } }), params(id))],
      ["allocate", (await import("../conversations/[conversationId]/allocate/route")).POST(request(`/api/conversations/${ids.conversation}/allocate`, { cookie: bob.cookie, body: { fingerprint: draft } }), params(id))],
      ["preference", (await import("../conversations/[conversationId]/preference/route")).POST(request(`/api/conversations/${ids.conversation}/preference`, { cookie: bob.cookie, body: { messageId: randomUUID(), decision: "save" } }), params(id))],
      ["trip-notes", (await import("../conversations/[conversationId]/trip-notes/route")).POST(request(`/api/conversations/${ids.conversation}/trip-notes`, { cookie: bob.cookie, body: { runId: randomUUID() } }), params(id))],
    ];
    for (const [name, call] of calls) expect((await call).status, name).toBe(404);
    const mine = await new DrizzleConversationRepository(getSharedJourneyDatabase().database, alice.id).findConversation(ids.conversation);
    expect(mine?.conversation.messageCount).toBe(1);
    expect(mine?.conversation.draft).toEqual(emptyDraft());
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("outings, progress and tasks: B cannot read or delete A's", async () => {
    const trips = await import("../trips/[tripId]/route");
    expect((await trips.GET(request(`/api/trips/${ids.trip}`, { cookie: bob.cookie }), params({ tripId: ids.trip }))).status).toBe(404);
    expect((await trips.DELETE(request(`/api/trips/${ids.trip}`, { method: "DELETE", cookie: bob.cookie }), params({ tripId: ids.trip }))).status).toBe(404);
    const progress = await import("../journeys/[journeyId]/trip-progress/route");
    expect((await progress.GET(request(`/api/journeys/${ids.journey}/trip-progress`, { cookie: bob.cookie }), params({ journeyId: ids.journey }))).status).toBe(404);
    const task = await import("../tasks/[taskId]/route");
    expect((await task.GET(request(`/api/tasks/${ids.task}`, { cookie: bob.cookie }), params({ taskId: ids.task }))).status).toBe(404);
    const cancel = await import("../tasks/[taskId]/cancel/route");
    expect((await cancel.POST(request(`/api/tasks/${ids.task}/cancel`, { cookie: bob.cookie, body: {} }), params({ taskId: ids.task }))).status).toBe(404);

    expect(await count("SELECT count(*)::int AS n FROM trips WHERE id = $1", ids.trip)).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM planning_tasks WHERE id = $1 AND status = 'queued'", ids.task)).toBe(1);
  });

  it("preferences: B cannot edit or delete A's, and B's delete-all leaves A's alone", async () => {
    const one = await import("../preferences/[preferenceId]/route");
    const all = await import("../preferences/route");
    const id = params({ preferenceId: ids.preference });
    expect((await one.PATCH(request(`/api/preferences/${ids.preference}`, { method: "PATCH", cookie: bob.cookie, body: { text: "偷改", category: "other" } }), id)).status).toBe(404);
    expect((await one.DELETE(request(`/api/preferences/${ids.preference}`, { method: "DELETE", cookie: bob.cookie }), id)).status).toBe(404);
    expect((await all.DELETE(request("/api/preferences", { method: "DELETE", cookie: bob.cookie }))).status).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM preferences WHERE id = $1 AND text = '少走路'", ids.preference)).toBe(1);
  });

  it("signed out (or with a forged id in the body) gets 401, never someone's data", async () => {
    const trips = await import("../trips/[tripId]/route");
    expect((await trips.GET(request(`/api/trips/${ids.trip}`), params({ tripId: ids.trip }))).status).toBe(401);
    const start = await import("../conversations/route");
    expect((await start.POST(request("/api/conversations", { body: { text: "你好", userId: alice.id } }))).status).toBe(401);
    expect((await trips.GET(request(`/api/trips/${ids.trip}`, { cookie: "tripquest.session_token=forged" }), params({ tripId: ids.trip }))).status).toBe(401);
  });

  it("deleting B's account needs B's password and leaves A untouched", async () => {
    const account = await import("../account/route");
    expect((await account.DELETE(request("/api/account", { method: "DELETE", cookie: bob.cookie, body: { password: "wrong-password" } }))).status).toBe(403);
    const deleted = await account.DELETE(request("/api/account", { method: "DELETE", cookie: bob.cookie, body: { password: "correct-horse-1" } }));
    expect(deleted.status).toBe(200);
    expect(deleted.headers.getSetCookie().join(";")).toMatch(/tripquest\.session_token=;/);
    expect(await count("SELECT count(*)::int AS n FROM users WHERE id = $1", bob.id)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM conversations WHERE user_id = $1", alice.id)).toBe(1);
  });
});
