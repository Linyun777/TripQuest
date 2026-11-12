import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyDraftPatch, emptyDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import { createJourneyDatabase, type JourneyDatabaseClient } from "../connection";
import { DrizzleConversationRepository } from "../conversation-repository";
import { requireSafeTestDatabaseUrl } from "../test-database-safety";
import { ownerId } from "./test-users";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), quiet: true });

const CONVERSATION = "60000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-13T12:00:00Z");
let counter = 0;
const newId = () => `61000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.1 conversations on PostgreSQL", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let repository: DrizzleConversationRepository;

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v21-test", maxConnections: 3 });
    await migrate(client.database, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    repository = new DrizzleConversationRepository(client.database, await ownerId(client.pool));
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM conversations");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM conversations");
    await client?.close();
  });

  it("appends a turn with its draft and reads it back in order", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const draft = applyDraftPatch(emptyDraft(), { date: "2026-10-14", addInterests: ["越剧相关"] });
    if (draft.status !== "ok") throw new Error("draft");
    const appended = await repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 0,
      messages: [
        { role: "user", kind: "text", body: { text: "明天想看越剧" } },
        { role: "assistant", kind: "text", body: { text: "好的", asking: false } },
        { role: "assistant", kind: "requirements_card", body: { draft: draft.draft } },
      ],
      draft: draft.draft,
      title: "越剧一日",
      now: NOW,
      newId,
    });
    expect(appended).toEqual({ status: "appended", messageCount: 3 });
    const found = await repository.findConversation(CONVERSATION);
    expect(found?.conversation).toMatchObject({ title: "越剧一日", messageCount: 3, draft: { date: "2026-10-14" } });
    expect(found?.messages.map((message) => [message.seq, message.kind])).toEqual([
      [1, "text"], [2, "text"], [3, "requirements_card"],
    ]);
  });

  it("lets only one of two turns based on the same count land", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const turn = (text: string) => repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 0,
      messages: [{ role: "user", kind: "text", body: { text } }],
      now: NOW,
      newId,
    });
    const results = await Promise.all([turn("第一句"), turn("第二句")]);
    expect(results.map((result) => result.status).sort()).toEqual(["appended", "conflict"]);
    expect((await repository.findConversation(CONVERSATION))?.messages).toHaveLength(1);
  });

  it("applies a card edit only on the draft the page saw", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const seen = fingerprint(emptyDraft());
    const edited = { ...emptyDraft(), pace: "relaxed" as const };
    expect(await repository.updateDraft({ conversationId: CONVERSATION, expectedFingerprint: seen, draft: edited, now: NOW }))
      .toEqual({ status: "updated" });
    expect(await repository.updateDraft({ conversationId: CONVERSATION, expectedFingerprint: seen, draft: emptyDraft(), now: NOW }))
      .toEqual({ status: "conflict" });
    expect((await repository.findConversation(CONVERSATION))?.conversation.draft.pace).toBe("relaxed");
  });

  it("refuses a body that carries provider details", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const leaked = { ...emptyDraft(), start: { status: "bound", externalId: "SYN", name: "合成", location: "120,30" } };
    await expect(repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 0,
      messages: [{ role: "assistant", kind: "requirements_card", body: { draft: leaked as never } }],
      now: NOW,
      newId,
    })).rejects.toThrow();
    expect((await repository.findConversation(CONVERSATION))?.messages).toHaveLength(0);
  });

  it("finds the conversation a saved journey came from", async () => {
    const journeyId = "62000000-0000-4000-8000-000000000001";
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const place = { externalId: "B000TEST01", name: "测试起点" };
    await repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 0,
      messages: [{
        role: "assistant",
        kind: "plan_card",
        body: {
          runId: "63000000-0000-4000-8000-000000000001", title: "越剧一日", date: "2026-10-14",
          departAt: "09:00", arriveAt: "17:00", start: place, end: place, stops: [], notes: [], journeyId,
        },
      }],
      now: NOW,
      newId,
    });
    expect(await repository.findConversationIdByJourney(journeyId)).toBe(CONVERSATION);
    expect(await repository.findConversationIdByJourney("62000000-0000-4000-8000-000000000002")).toBeNull();
    // 出游各天各段的行程编号在 outing_day 里：从“我的行程”点进某一天也要能回到对话。
    const outingJourney = "62000000-0000-4000-8000-000000000003";
    await repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 1,
      messages: [{
        role: "assistant",
        kind: "outing_day",
        body: {
          generationId: "63000000-0000-4000-8000-000000000002", day: 2, date: "2026-10-15", title: "合成出游 · 第 2 天",
          tripId: "63000000-0000-4000-8000-000000000003", status: "draft", notes: [],
          parts: [
            { kind: "connect", from: "合成酒店", to: "合成车站", departAt: "08:00", arriveAt: "08:30" },
            {
              kind: "plan",
              segment: 1,
              plan: {
                runId: "63000000-0000-4000-8000-000000000004", title: "合成出游 · 第 2 天", date: "2026-10-15",
                departAt: "09:00", arriveAt: "17:00", start: place, end: place, stops: [], notes: [], journeyId: outingJourney,
              },
            },
          ],
        },
      }],
      now: NOW,
      newId,
    });
    expect(await repository.findConversationIdByJourney(outingJourney)).toBe(CONVERSATION);
  });

  it("records a short-trip pick once, and only among the options offered (V2.4)", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const options = [{ externalId: "B000TESTA1", name: "合成川菜馆", reason: "偏辣", stayMinutes: 60 }];
    await repository.appendTurn({
      conversationId: CONVERSATION,
      expectedCount: 0,
      messages: [{
        role: "assistant",
        kind: "choices",
        body: { tripId: "70000000-0000-4000-8000-000000000001", step: 1, interestId: "i1", anchor: null, round: 1, options, chosen: null },
      }],
      now: NOW,
      newId,
    });
    const messageId = (await repository.findConversation(CONVERSATION))!.messages[0].id;
    const pick = (externalId: string) => repository.chooseOption({ conversationId: CONVERSATION, messageId, externalId, now: NOW });
    expect(await pick("B000OTHER1")).toEqual({ status: "not_found" });
    expect(await pick("B000TESTA1")).toEqual({ status: "updated" });
    expect(await pick("B000TESTA1")).toEqual({ status: "conflict" });
    const stored = (await repository.findConversation(CONVERSATION))!.messages[0];
    expect(stored.kind === "choices" && stored.body.chosen).toBe("B000TESTA1");
  });

  it("purge removes conversations together with real days", async () => {
    await repository.createConversation({ id: CONVERSATION, title: "新的规划", now: NOW });
    const output = execFileSync("node", [fileURLToPath(new URL("../../scripts/purge-real-days.mjs", import.meta.url)), "--user", "owner", "--yes"], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(output).toContain("1 conversation(s).");
    expect(await repository.findConversation(CONVERSATION)).toBeNull();
  });
});
