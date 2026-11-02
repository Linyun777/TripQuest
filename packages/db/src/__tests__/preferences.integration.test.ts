import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleConversationRepository } from "../conversation-repository";
import { DrizzlePreferenceRepository } from "../preference-repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const CONVERSATION = "70000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-21T12:00:00Z");
let counter = 0;
const newId = () => `71000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.9 preferences on PostgreSQL", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let conversations: DrizzleConversationRepository;
  let preferences: DrizzlePreferenceRepository;

  /** 一轮对话：用户一句话，加一张偏好提议卡片；返回卡片的消息 id。 */
  async function propose(text: string, expectedCount: number): Promise<string> {
    await conversations.appendTurn({
      conversationId: CONVERSATION,
      expectedCount,
      messages: [
        { role: "user", kind: "text", body: { text: "我从来不吃辣" } },
        { role: "assistant", kind: "preference_proposal", body: { text, category: "food", status: "pending" } },
      ],
      now: NOW,
      newId,
    });
    const found = await conversations.findConversation(CONVERSATION);
    return found!.messages.at(-1)!.id;
  }

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v29-test", maxConnections: 3 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    conversations = new DrizzleConversationRepository(client.database, await ownerId(client.pool));
    preferences = new DrizzlePreferenceRepository(client.database, await ownerId(client.pool));
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM preferences");
    await client.pool.query("DELETE FROM conversations");
    await conversations.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM preferences");
    await client?.pool.query("DELETE FROM conversations");
    await client?.close();
  });

  it("saves only on the user's click, once, and marks the card", async () => {
    const card = await propose("不吃辣", 0);
    const saved = await preferences.saveProposal({ conversationId: CONVERSATION, messageId: card, newId: newId(), now: NOW });
    expect(saved).toMatchObject({ status: "saved", preference: { text: "不吃辣", category: "food", sourceConversationId: CONVERSATION } });
    expect(await preferences.saveProposal({ conversationId: CONVERSATION, messageId: card, newId: newId(), now: NOW })).toEqual({ status: "already_decided" });
    const found = await conversations.findConversation(CONVERSATION);
    expect(found!.messages.at(-1)!.body).toMatchObject({ status: "saved" });
    expect(await preferences.list()).toHaveLength(1);
  });

  it("dismisses without saving, refuses a private text, and stops at thirty", async () => {
    const card = await propose("不吃辣", 0);
    expect(await preferences.dismissProposal({ conversationId: CONVERSATION, messageId: card, now: NOW })).toEqual({ status: "dismissed" });
    expect(await preferences.list()).toEqual([]);
    const home = await propose("住在东门小区附近", 2);
    expect(await preferences.saveProposal({ conversationId: CONVERSATION, messageId: home, newId: newId(), now: NOW })).toEqual({ status: "invalid" });
    for (let index = 0; index < 30; index += 1) {
      await client.pool.query("INSERT INTO preferences (id, user_id, text, category, created_at, updated_at) VALUES ($1, (SELECT id FROM users WHERE username = 'owner'), $2, 'other', $3, $3)", [newId(), `偏好${index}`, NOW]);
    }
    const one = await propose("喜欢安静", 4);
    expect(await preferences.saveProposal({ conversationId: CONVERSATION, messageId: one, newId: newId(), now: NOW })).toEqual({ status: "limit" });
  });

  it("keeps the rolling summary moving forward only", async () => {
    expect(await conversations.updateSummary({ conversationId: CONVERSATION, summary: { text: "朋友推荐过老街茶馆", throughSeq: 4 } })).toEqual({ status: "updated" });
    expect(await conversations.updateSummary({ conversationId: CONVERSATION, summary: { text: "更旧的摘要", throughSeq: 2 } })).toEqual({ status: "stale" });
    expect((await conversations.findConversation(CONVERSATION))!.conversation.summary).toEqual({ text: "朋友推荐过老街茶馆", throughSeq: 4 });
  });

  it("appends decision records once per turn and deletes them with the conversation", async () => {
    await conversations.recordTrace({ conversationId: CONVERSATION, seq: 1, record: { route: { router: "regex" } }, now: NOW });
    await conversations.recordTrace({ conversationId: CONVERSATION, seq: 1, record: { route: { router: "other" } }, now: NOW });
    await conversations.recordTrace({ conversationId: CONVERSATION, seq: 3, record: { route: { router: "regex" } }, now: NOW });
    const traces = await conversations.listTraces(CONVERSATION);
    expect(traces.map((item) => [item.seq, (item.record as { route: { router: string } }).route.router])).toEqual([[1, "regex"], [3, "regex"]]);
    await client.pool.query("DELETE FROM conversations");
    expect((await client.pool.query("SELECT count(*)::int AS n FROM chat_traces")).rows[0].n).toBe(0);
  });

  it("edits, removes one or all, and keeps a preference when its conversation is deleted", async () => {
    const card = await propose("不吃辣", 0);
    const saved = await preferences.saveProposal({ conversationId: CONVERSATION, messageId: card, newId: newId(), now: NOW });
    const id = saved.status === "saved" ? saved.preference.id : "";
    expect(await preferences.update({ id, text: "不吃辣，也不吃香菜", category: "food", now: NOW })).toEqual({ status: "updated" });
    expect(await preferences.update({ id, text: "电话13800138000", category: "other", now: NOW })).toEqual({ status: "invalid" });
    await client.pool.query("DELETE FROM conversations");
    expect((await preferences.list())[0]).toMatchObject({ text: "不吃辣，也不吃香菜", sourceConversationId: null });
    expect(await preferences.remove(id)).toEqual({ status: "removed" });
    expect(await preferences.remove(id)).toEqual({ status: "not_found" });
    await client.pool.query("INSERT INTO preferences (id, user_id, text, category, created_at, updated_at) VALUES ($1, (SELECT id FROM users WHERE username = 'owner'), '少走路', 'pace', $2, $2)", [newId(), NOW]);
    expect(await preferences.removeAll()).toBe(1);
    expect(await preferences.list()).toEqual([]);
  });
});
