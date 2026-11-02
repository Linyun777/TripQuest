import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createDayPlanningRunner, createDayScriptedModel } from "@tripquest/agent/day-planning";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  DrizzleConversationRepository,
  DrizzleJourneyRepository,
  getSharedJourneyDatabase,
  PgAgentRunStore,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { verifyDraftReceipt } from "../../planning/new/draft-receipt";
import { createConversationService } from "../conversation-service";
import { createOutingSave } from "../outing-service";
import { createPlanService } from "../plan-service";
import { amap, ENV, NOW, outingCard, SECRET } from "./outing-fixtures";

/**
 * V3.1 第 1 步：出游四个接口（分到各天、逐天生成、跨天改动、保存）现在的输入输出和失败语义，作为换编排时不变的
 * 标准（stages/V3.1.md §4 第 1 步、§5）。原来的编排已在 V3.2 删除，现在只跑总控图。
 * 全部用演示地点和脚本模型（不发真实请求）；保存要真的出游表，用自己的临时测试库。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V3.1 outing endpoints", () => {
  const database = "tripquest_v31_outing_graph_test";
  const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = Object.assign(new URL(safe), { pathname: `/${database}` }).toString();
  const admin = () => createJourneyDatabase(safe, { maxConnections: 1 });
  let owner: string;
  const conversations = (user = owner) => new DrizzleConversationRepository(getSharedJourneyDatabase().database, user);
  const services = (user = owner) => {
    const shared = { userId: user, environment: ENV, now: () => NOW, repository: () => conversations(user) };
    return {
      chat: createConversationService({ ...shared, places: () => amap as never, runner: async () => { throw new Error("no chat in these tests"); } }),
      plan: createPlanService({
        ...shared,
        amap: () => amap as never,
        runner: async () => createDayPlanningRunner({ provider: amap as never, model: createDayScriptedModel(), now: () => NOW }),
      }),
      save: createOutingSave({
        now: () => NOW,
        repository: () => conversations(user),
        trips: () => new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user),
        routes: () => amap as never,
        verify: (receipt, at) => verifyDraftReceipt(receipt, SECRET, at),
        enabled: () => true,
        cities: () => amap as never,
      }),
    };
  };
  async function conversation(draft: RequirementsDraft, user = owner) {
    const store = conversations(user);
    const created = await store.createConversation({ id: randomUUID(), title: "演示出游", now: new Date(NOW) });
    await store.updateDraft({ conversationId: created.id, expectedFingerprint: fingerprint(created.draft), draft, now: new Date(NOW) });
    return created.id;
  }
  /** 一个流式入口的全部事件。 */
  async function events<E>(run: (emit: (event: E) => void, signal: AbortSignal) => Promise<void>): Promise<E[]> {
    const seen: E[] = [];
    await run((event) => seen.push(event), new AbortController().signal);
    return seen;
  }
  type Event = { type: string; [key: string]: unknown };

  beforeAll(async () => {
    const setup = admin();
    await setup.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await setup.pool.query(`CREATE DATABASE ${database}`);
    await setup.close();
    vi.stubEnv("DATABASE_URL", requireSafeTestDatabaseUrl(url, process.env.DATABASE_URL));
    const { pool, database: client } = getSharedJourneyDatabase();
    await migrateJourneyDatabase(client, { migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle") });
    owner = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'")).rows[0]!.id;
  });
  afterAll(async () => {
    await closeSharedJourneyDatabase();
    vi.unstubAllEnvs();
    const cleanup = admin();
    await cleanup.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cleanup.close();
  });

  it("allocate: the split goes onto the card; a stale, incomplete, unknown or daily card is refused", async () => {
    const { chat } = services();
    const card = outingCard();
    const id = await conversation(card);
    expect(await chat.allocate(id, "0".repeat(64))).toEqual({ status: "conflict" });
    expect(await chat.allocate(randomUUID(), fingerprint(card))).toEqual({ status: "not_found" });
    const split = await chat.allocate(id, fingerprint(card));
    expect(split).toMatchObject({ status: "ok", card: { outing: { allocation: { source: "rules", problems: [] } } } });
    const allocation = (split as unknown as { card: { outing: { allocation: { days: { day: number; items: { name: string }[] }[] } } } }).card.outing.allocation;
    expect(allocation.days.map((day) => day.items.map((item) => item.name))).toEqual([["演示公园步行街", "演示博物馆"], ["演示博物馆"]]);

    const unfinished = await conversation({ ...card, start: null });
    // 卡片还缺东西：分配接口照现在的说法回 invalid / incomplete。
    expect(await chat.allocate(unfinished, fingerprint({ ...card, start: null }))).toEqual({ status: "invalid", code: "incomplete" });
  });

  it("generate: progress steps, one day event per day with its receipts, then done; re-planning a day keeps the generation", async () => {
    const { chat, plan } = services();
    const card = outingCard();
    const id = await conversation(card);
    const notSplit = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: fingerprint(card) }, emit as never, signal));
    expect(notSplit).toEqual([{ type: "refused", status: "incomplete", message: "先把地点分到各天。" }]);
    const split = await chat.allocate(id, fingerprint(card)) as { card: { fingerprint: string } };
    const stale = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: fingerprint(card) }, emit as never, signal));
    expect(stale).toMatchObject([{ type: "refused", status: "conflict" }]);
    const missing = await events<Event>((emit, signal) => plan.outing(randomUUID(), { fingerprint: split.card.fingerprint }, emit as never, signal));
    expect(missing).toMatchObject([{ type: "refused", status: "not_found" }]);

    const all = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: split.card.fingerprint }, emit as never, signal));
    const kinds = all.map((event) => event.type);
    expect(kinds[0]).toBe("step");
    expect(kinds.filter((kind) => kind !== "step")).toEqual(["day", "day", "outing_done"]);
    const days = all.filter((event) => event.type === "day") as unknown as { message: { day: number; status: string; generationId: string; parts: { kind: string }[] }; receipts: unknown[] }[];
    expect(days.map((event) => [event.message.day, event.message.status])).toEqual([[1, "draft"], [2, "draft"]]);
    expect(days.every((event) => event.receipts.length === event.message.parts.filter((part) => part.kind === "plan").length)).toBe(true);
    expect(all.at(-1)).toEqual({ type: "outing_done", messageCount: expect.any(Number) });

    const again = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: split.card.fingerprint, days: [2] }, emit as never, signal));
    const redone = again.filter((event) => event.type === "day") as unknown as typeof days;
    expect(redone.map((event) => event.message.day)).toEqual([2]);
    expect(redone[0]!.message.generationId).toBe(days[0]!.message.generationId);
    // 是总控图在排：运行记录里有它自己的步骤。
    const steps = await getSharedJourneyDatabase().pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id WHERE r.conversation_id = $1 AND s.name LIKE 'outing:%'",
      [id],
    );
    expect(steps.rows[0]!.n).toBeGreaterThan(0);
  });

  it("save, then move a place to another day: refusals, the change card, and a confirm that saves once", async () => {
    const { chat, plan, save } = services();
    const card = outingCard();
    const id = await conversation(card);
    const split = await chat.allocate(id, fingerprint(card)) as { card: { fingerprint: string } };
    const generated = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: split.card.fingerprint }, emit as never, signal));
    const days = generated.filter((event) => event.type === "day") as unknown as { message: { generationId: string }; receipts: { receipt: string }[] }[];
    const generationId = days[0]!.message.generationId;
    const receipts = days.flatMap((event) => event.receipts.map((item) => item.receipt));

    expect(await save(id, { generationId: randomUUID(), receipts, acknowledgeUnknowns: true })).toEqual({ status: "not_found" });
    expect(await save(id, { generationId, receipts: ["bad.receipt"], acknowledgeUnknowns: true })).toEqual({ status: "invalid_receipt" });
    expect(await save(id, { generationId, receipts: receipts.slice(1), acknowledgeUnknowns: true })).toMatchObject({ status: "invalid_receipt", day: 1 });
    const saved = await save(id, { generationId, receipts, acknowledgeUnknowns: true });
    expect(saved).toMatchObject({ status: "saved", tripId: expect.any(String) });
    expect(await save(id, { generationId, receipts, acknowledgeUnknowns: true })).toMatchObject({ status: "already_saved" });

    const count = async () => (await conversations().findConversation(id))!.conversation.messageCount;
    const before = await count();
    const stale = await events<Event>((emit, signal) => plan.outingChange(id, { expectedCount: before - 1, request: { move: { visit: "v1", toDay: 2 } } }, emit as never, signal));
    expect(stale).toMatchObject([{ type: "refused", status: "conflict" }]);
    const same = await events<Event>((emit, signal) => plan.outingChange(id, { expectedCount: before, request: { move: { visit: "v1", toDay: 1 } } }, emit as never, signal));
    expect(same.at(-1)).toMatchObject({ type: "change", messages: [{ kind: "notice", text: "演示公园步行街本来就在第 1 天。" }], receipts: [] });

    const moved = await events<Event>((emit, signal) => plan.outingChange(id, { expectedCount: before + 1, request: { move: { visit: "v1", toDay: 2 } } }, emit as never, signal));
    expect(moved.filter((event) => event.type !== "step").map((event) => event.type)).toEqual(["change"]);
    const change = moved.at(-1) as unknown as { messages: { id: string; kind: string; note: string; days: { day: number }[] }[]; receipts: { receipt: string }[] };
    expect(change.messages.map((message) => message.kind)).toEqual(["outing_change"]);
    expect(change.messages[0]).toMatchObject({ note: "演示公园步行街挪到第 2 天" });
    expect(change.messages[0]!.days.map((day) => day.day)).toEqual([1, 2]);
    const confirm = { messageId: change.messages[0]!.id, receipts: change.receipts.map((item) => item.receipt) };
    expect(await plan.confirmOutingChange(id, { ...confirm, receipts: [] })).toMatchObject({ status: "invalid_receipt" });
    expect(await plan.confirmOutingChange(id, confirm)).toMatchObject({ status: "saved" });
    expect(await plan.confirmOutingChange(id, confirm)).toMatchObject({ status: "already_saved" });
  });

  it("two accounts generating at the same time do not see each other's runs or messages", async () => {
    const other = (await getSharedJourneyDatabase().pool.query<{ id: string }>(
      `INSERT INTO users (name, email, username, display_username, role)
       VALUES ('test_outing_b', gen_random_uuid()::text || '@users.invalid', 'test_outing_b', 'test_outing_b', 'user')
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username RETURNING id`,
    )).rows[0]!.id;
    const generate = async (user: string) => {
      const { chat, plan } = services(user);
      const card = outingCard();
      const id = await conversation(card, user);
      const split = await chat.allocate(id, fingerprint(card)) as { card: { fingerprint: string } };
      const seen = await events<Event>((emit, signal) => plan.outing(id, { fingerprint: split.card.fingerprint }, emit as never, signal));
      return { id, days: seen.filter((event) => event.type === "day").length };
    };
    const [mine, theirs] = await Promise.all([generate(owner), generate(other)]);
    expect([mine.days, theirs.days]).toEqual([2, 2]);
    expect(await conversations(other).findConversation(mine.id)).toBeNull();
    expect(await conversations(owner).findConversation(theirs.id)).toBeNull();
    const runs = (user: string) => new PgAgentRunStore(getSharedJourneyDatabase().pool, user);
    expect((await runs(owner).listForConversation(mine.id)).length).toBeGreaterThan(0);
    expect(await runs(other).listForConversation(mine.id)).toEqual([]);
    expect(await runs(owner).listForConversation(theirs.id)).toEqual([]);
  });
});
