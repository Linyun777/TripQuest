import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emptyDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleConversationRepository } from "../conversation-repository";
import { DrizzlePreferenceRepository } from "../preference-repository";
import { DrizzleJourneyRepository } from "../repository";
import { PgPlanningTaskRepository } from "../task-repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { id, segment, trip } from "./outing-fixtures";
import { testUserId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const NOW = new Date("2026-10-26T12:00:00Z");
const CONVERSATION = "62000000-0000-4000-8000-000000000001";

/**
 * V2.12 数据按用户隔离（stages/V2.12.md §3.4、§5）：仓库绑定一个用户，B 拿着 A 的编号读、改、删，结果都和
 * “不存在”一样，A 的数据不变；列表只列自己的。删除用户时它的数据一起删掉，别人的不动。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.12 each user only sees their own data", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let alice: string;
  let bob: string;
  const repos = (userId: string) => ({
    conversations: new DrizzleConversationRepository(client.database, userId),
    preferences: new DrizzlePreferenceRepository(client.database, userId),
    journeys: new DrizzleJourneyRepository(client.database, userId),
    tasks: new PgPlanningTaskRepository(client.pool, { userId }),
  });
  const count = async (sql: string, ...params: unknown[]) => (await client.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v212-test", maxConnections: 3 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM users WHERE username IN ('test_alice', 'test_bob')");
    alice = await testUserId(client.pool, "test_alice");
    bob = await testUserId(client.pool, "test_bob");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM users WHERE username IN ('test_alice', 'test_bob')");
    await client?.close();
  });

  it("conversations, messages and decision records", async () => {
    const a = repos(alice);
    const b = repos(bob);
    await a.conversations.createConversation({ id: CONVERSATION, title: "爱丽丝的规划", now: NOW });
    await a.conversations.appendTurn({
      conversationId: CONVERSATION, expectedCount: 0, now: NOW, newId: randomUUID,
      messages: [
        { role: "user", kind: "text", body: { text: "明天去哪" } },
        { role: "assistant", kind: "choices", body: { tripId: randomUUID(), step: 1, interestId: "i1", anchor: null, round: 1, options: [{ externalId: "SYN-CAFE", name: "合成咖啡", reason: "近", stayMinutes: 30 }], chosen: null } },
      ],
    });
    await a.conversations.recordTrace({ conversationId: CONVERSATION, seq: 1, record: { outcome: "completed" }, now: NOW });
    const choice = (await a.conversations.findConversation(CONVERSATION))!.messages[1]!.id;

    expect(await b.conversations.findConversation(CONVERSATION)).toBeNull();
    expect(await b.conversations.appendTurn({ conversationId: CONVERSATION, expectedCount: 2, now: NOW, newId: randomUUID, messages: [{ role: "user", kind: "text", body: { text: "偷看" } }] }))
      .toEqual({ status: "not_found" });
    expect(await b.conversations.updateDraft({ conversationId: CONVERSATION, expectedFingerprint: fingerprint(emptyDraft()), draft: emptyDraft(), now: NOW }))
      .toEqual({ status: "not_found" });
    expect(await b.conversations.updateSummary({ conversationId: CONVERSATION, summary: { text: "偷改", throughSeq: 1 } })).toEqual({ status: "not_found" });
    expect(await b.conversations.chooseOption({ conversationId: CONVERSATION, messageId: choice, externalId: "SYN-CAFE", now: NOW })).toEqual({ status: "not_found" });
    expect(await b.conversations.markPlanSaved({ conversationId: CONVERSATION, runId: randomUUID(), journeyId: randomUUID(), now: NOW })).toEqual({ status: "not_found" });
    await b.conversations.recordTrace({ conversationId: CONVERSATION, seq: 2, record: { outcome: "intruder" }, now: NOW });
    expect(await b.conversations.listTraces(CONVERSATION)).toEqual([]);

    const mine = await a.conversations.findConversation(CONVERSATION);
    expect(mine?.conversation.messageCount).toBe(2);
    expect(mine?.messages[1]?.body).toMatchObject({ chosen: null });
    expect((await a.conversations.listTraces(CONVERSATION)).map((item) => item.record)).toEqual([{ outcome: "completed" }]);
  });

  it("preferences", async () => {
    const a = repos(alice);
    const b = repos(bob);
    await a.conversations.createConversation({ id: CONVERSATION, title: "爱丽丝的规划", now: NOW });
    await a.conversations.appendTurn({
      conversationId: CONVERSATION, expectedCount: 0, now: NOW, newId: randomUUID,
      messages: [
        { role: "assistant", kind: "preference_proposal", body: { text: "不吃辣", category: "food", status: "pending" } },
        { role: "assistant", kind: "preference_proposal", body: { text: "少走路", category: "pace", status: "pending" } },
      ],
    });
    const [first, second] = (await a.conversations.findConversation(CONVERSATION))!.messages.map((message) => message.id);
    // B 拿 A 对话里的提议卡片：和没有一样。
    expect(await b.preferences.saveProposal({ conversationId: CONVERSATION, messageId: second!, newId: randomUUID(), now: NOW })).toEqual({ status: "not_found" });
    expect(await b.preferences.dismissProposal({ conversationId: CONVERSATION, messageId: second!, now: NOW })).toEqual({ status: "not_found" });
    const saved = await a.preferences.saveProposal({ conversationId: CONVERSATION, messageId: first!, newId: randomUUID(), now: NOW });
    if (saved.status !== "saved") throw new Error("save");

    expect(await b.preferences.list()).toEqual([]);
    expect(await b.preferences.update({ id: saved.preference.id, text: "偷改", category: "other", now: NOW })).toEqual({ status: "not_found" });
    expect(await b.preferences.remove(saved.preference.id)).toEqual({ status: "not_found" });
    expect(await b.preferences.removeAll()).toBe(0);
    expect((await a.preferences.list()).map((item) => item.text)).toEqual(["不吃辣"]);
  });

  it("journeys, outings and planning tasks", async () => {
    const a = repos(alice);
    const b = repos(bob);
    const outing = trip([{ day: 1, part: 0, journey: segment(1, "2026-10-17") }, { day: 2, part: 0, journey: segment(2, "2026-10-18") }]);
    expect(await a.journeys.createTrip(outing)).toEqual({ status: "saved", tripId: id(9, 1) });
    const task = await a.tasks.createTask({
      id: randomUUID(), kind: "day_draft", journeyId: null, requestKey: randomUUID(), intentFingerprint: "c".repeat(64), input: {}, createdAt: NOW,
    });
    if (task.status !== "created") throw new Error("task");

    expect(await b.journeys.listJourneys(10)).toEqual([]);
    expect(await b.journeys.findTrip(id(9, 1))).toBeNull();
    expect(await b.journeys.readTripBase(id(9, 1))).toBeNull();
    expect(await b.journeys.findTripCreation(outing.generationId)).toBeNull();
    expect(await b.journeys.findCurrentJourney(id(1, 1))).toBeNull();
    expect(await b.journeys.deleteTrip(id(9, 1))).toBe("not_found");
    expect(await b.tasks.findTask(task.task.id)).toBeNull();
    expect(await b.tasks.requestCancel(task.task.id, NOW)).toBeNull();
    // 同一个请求编号：B 拿到的是“意图冲突”，不是 A 的任务。
    expect(await b.tasks.createTask({ ...task.task, id: randomUUID(), createdAt: NOW })).toEqual({ status: "intent_conflict" });

    expect(await a.journeys.findTrip(id(9, 1))).toMatchObject({ title: "云岭出游" });
    expect(await a.journeys.findCurrentJourney(id(1, 1))).not.toBeNull();
    expect(await a.journeys.listJourneys(10)).toHaveLength(2);
    expect((await a.tasks.findTask(task.task.id))?.status).toBe("queued");
  });

  it("deleting a user deletes all of their data and nothing of anyone else's", async () => {
    for (const [userId, conversationId, group] of [[alice, CONVERSATION, 1], [bob, "62000000-0000-4000-8000-000000000002", 3]] as const) {
      const r = repos(userId);
      await r.conversations.createConversation({ id: conversationId, title: "规划", now: NOW });
      await r.conversations.recordTrace({ conversationId, seq: 1, record: {}, now: NOW });
      await r.journeys.createTrip({
        ...trip([{ day: 1, part: 0, journey: segment(group, "2026-10-17") }, { day: 2, part: 0, journey: segment(group + 1, "2026-10-18") }]),
        tripId: id(9, group), generationId: id(8, group),
      });
    }
    await client.pool.query("DELETE FROM users WHERE id = $1", [alice]);
    for (const table of ["conversations", "journeys", "trips", "preferences", "planning_tasks"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, alice), table).toBe(0);
    }
    expect(await count("SELECT count(*)::int AS n FROM chat_traces WHERE conversation_id = $1", CONVERSATION)).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM journeys WHERE user_id = $1", bob)).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM chat_traces t JOIN conversations c ON c.id = t.conversation_id WHERE c.user_id = $1", bob)).toBe(1);
  });
});
