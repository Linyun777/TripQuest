import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createDayPlanningRunner, createDayScriptedModel } from "@tripquest/agent/day-planning";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import type { SuggestionFix } from "@tripquest/application/outing-review-contract";
import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  DrizzleConversationRepository,
  DrizzleJourneyRepository,
  getSharedJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { verifyDraftReceipt } from "../../planning/new/draft-receipt";
import { createConversationService } from "../conversation-service";
import { adoptedDraft, createOutingSave } from "../outing-service";
import { createPlanService } from "../plan-service";
import { amap, ENV, NOW, outingCard, SECRET } from "./outing-fixtures";

/**
 * V3.2 审查的建议（stages/V3.2.md §3.6、§6）：生成后存一条建议消息；忽略只记一次；保存前采纳改卡片、页面接着重排
 * 受影响的天；保存后采纳走跨天改动（重排、显示前后、确认才保存）。审查 Agent 用脚本代替，地点用演示数据。
 */
const reason = "这天下午空着";
const split = (draft: RequirementsDraft) => draft.outing!.allocation!.days.map((day) => [...day.visits, ...day.interests]);

describe("V3.2 a review suggestion becomes the right card change", () => {
  const card = (): RequirementsDraft => {
    const draft = outingCard();
    return { ...draft, outing: { ...draft.outing!, allocation: { days: [{ day: 1, visits: ["v1"], interests: [] }, { day: 2, visits: [], interests: ["i1"] }], source: "rules", problems: [] } } };
  };
  const adopt = (fix: SuggestionFix) => adoptedDraft(card(), fix)!;

  it("moves, swaps, adds an interest, stops driving and drops a place, keeping the split for everything else", () => {
    expect(split(adopt({ action: "move_visit", visit: "v1", toDay: 2, reason }).draft)).toEqual([[], ["v1", "i1"]]);
    const swapped = adopt({ action: "swap_days_content", days: [1, 2], reason });
    expect(split(swapped.draft)).toEqual([["i1"], ["v1"]]);
    expect(swapped.affected).toEqual([1, 2]);
    const added = adopt({ action: "add_interest", day: 1, text: "喝下午茶", when: "afternoon", reason });
    expect(added.draft.interests.map((item) => [item.text, item.when, item.day])).toEqual([["演示博物馆", undefined, undefined], ["喝下午茶", "afternoon", 1]]);
    expect(split(added.draft)).toEqual([["v1", "i2"], ["i1"]]);
    const noCar = adopt({ action: "set_day_travel", day: 2, remove: ["driving"], reason });
    expect([noCar.draft.outing!.noDriving, noCar.affected]).toEqual([[2], [2]]);
    const dropped = adopt({ action: "drop_visit", visit: "v1", reason });
    expect([dropped.draft.visits, split(dropped.draft), dropped.affected]).toEqual([[], [[], ["i1"]], [1]]);
  });

  it("V3.3: choosing another lodging changes that stay's nights to the user's pick, keeps the split, and re-plans both days", () => {
    const chosen = adopt({ action: "choose_lodging", nights: [1], place: { externalId: "DEMO-CAFE", name: "演示餐饮小馆", city: "330100" }, reason: "离第 1 天最后一站 300 米" });
    expect(chosen.draft.outing!.lodging).toEqual([{ night: 1, place: { status: "bound", externalId: "DEMO-CAFE", name: "演示餐饮小馆", city: "330100" } }]);
    expect(split(chosen.draft)).toEqual([["v1"], ["i1"]]);
    expect(chosen.affected).toEqual([1, 2]);
  });

  it("V3.3: adopting an added interest keeps the system's lodging pick", () => {
    const base = card();
    const picked: RequirementsDraft = {
      ...base,
      outing: { ...base.outing!, lodging: [{ night: 1, place: { status: "bound", externalId: "DEMO-CAFE", name: "演示餐饮小馆" }, source: "suggested" }] },
    };
    const added = adoptedDraft(picked, { action: "add_interest", day: 1, text: "喝下午茶", when: "afternoon", reason })!;
    expect(added.draft.outing!.lodging).toEqual(picked.outing!.lodging);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("V3.2 review suggestions through the services", () => {
  const database = "tripquest_v32_review_test";
  const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = Object.assign(new URL(safe), { pathname: `/${database}` }).toString();
  const admin = () => createJourneyDatabase(safe, { maxConnections: 1 });
  let owner: string;
  const conversations = () => new DrizzleConversationRepository(getSharedJourneyDatabase().database, owner);
  /** 审查 Agent 的脚本：第一次给三条建议，之后说没有可改的。 */
  function services(answers: unknown[]) {
    const reviewer: ReviewRequest = async () => ({ decision: answers.shift() ?? { fixes: [] }, usage: null });
    const shared = { userId: owner, environment: ENV, now: () => NOW, repository: conversations };
    return {
      chat: createConversationService({ ...shared, places: () => amap as never, runner: async () => { throw new Error("no chat"); } }),
      plan: createPlanService({
        ...shared,
        amap: () => amap as never,
        runner: async () => createDayPlanningRunner({ provider: amap as never, model: createDayScriptedModel(), now: () => NOW }),
        reviewer: async () => reviewer,
      }),
      save: createOutingSave({
        now: () => NOW,
        repository: conversations,
        trips: () => new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner),
        routes: () => amap as never,
        verify: (receipt, at) => verifyDraftReceipt(receipt, SECRET, at),
        enabled: () => true,
      }),
    };
  }
  type Event = { type: string; [key: string]: unknown };
  async function events(run: (emit: (event: Event) => void, signal: AbortSignal) => Promise<void>) {
    const seen: Event[] = [];
    await run((event) => seen.push(event), new AbortController().signal);
    return seen;
  }

  beforeAll(async () => {
    vi.stubEnv("OUTING_REVIEW", "on");
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

  it("V3.3: picks a lodging for a night with none and writes it on the card as the system's pick", async () => {
    const { chat, plan } = services([]);
    const store = conversations();
    const created = await store.createConversation({ id: randomUUID(), title: "没定住处", now: new Date(NOW) });
    const base = outingCard();
    const draft: RequirementsDraft = { ...base, outing: { ...base.outing!, lodging: [] } };
    await store.updateDraft({ conversationId: created.id, expectedFingerprint: fingerprint(created.draft), draft, now: new Date(NOW) });
    const split = await chat.allocate(created.id, fingerprint(draft)) as { card: { fingerprint: string } };
    const generated = await events((emit, signal) => plan.outing(created.id, { fingerprint: split.card.fingerprint }, emit as never, signal));
    const card = generated.find((event) => event.type === "card") as unknown as { card: { fingerprint: string; outing: { lodging: unknown[] } } };
    expect(card.card.outing.lodging).toEqual([{ night: 1, place: { status: "bound", placeId: "DEMO-CAFE", name: "演示餐饮小馆" }, suggested: true }]);
    const stored = (await conversations().findConversation(created.id))!.conversation.draft;
    expect(stored.outing!.lodging).toEqual([{ night: 1, place: { status: "bound", externalId: "DEMO-CAFE", name: "演示餐饮小馆", city: "330100" }, source: "suggested" }]);
    expect(card.card.fingerprint).toBe(fingerprint(stored));
    // 分配还在：之后“重排这一天”按卡片上的暂定住处排，不再选。
    expect(stored.outing!.allocation).toBeDefined();
  });

  it("stores the suggestions after the days; dismissing is once; adopting before saving changes the card, after saving goes through a change", async () => {
    // V4.1：“加兴趣”的建议先试排，排上了才给（演示地点里搜得到的兴趣才排得上）。
    const { chat, plan, save } = services([{
      fixes: [
        { action: "add_interest", day: 1, text: "公园花园", when: "afternoon", reason },
        { action: "add_interest", day: 2, text: "餐饮小馆", reason },
      ],
    }]);
    const store = conversations();
    const created = await store.createConversation({ id: randomUUID(), title: "演示出游", now: new Date(NOW) });
    const draft = outingCard();
    await store.updateDraft({ conversationId: created.id, expectedFingerprint: fingerprint(created.draft), draft, now: new Date(NOW) });
    const id = created.id;
    const split = await chat.allocate(id, fingerprint(draft)) as { card: { fingerprint: string } };

    const generated = await events((emit, signal) => plan.outing(id, { fingerprint: split.card.fingerprint }, emit as never, signal));
    const kinds = generated.map((event) => event.type).filter((type) => type !== "step");
    expect(kinds).toEqual(["day", "day", "review", "outing_done"]);
    expect(generated.filter((event) => event.type === "step").map((event) => (event.step as { text: string }).text)).toContain("正在检查整趟安排");
    const review = generated.find((event) => event.type === "review") as unknown as {
      message: { id: string; open: boolean; suggestions: { text: string; status: string; tried?: string }[] };
    };
    expect(review.message.open).toBe(true);
    expect(review.message.suggestions.map((item) => [item.text, item.status])).toEqual([["第 1 天下午加“公园花园”", "pending"], ["第 2 天加“餐饮小馆”", "pending"]]);
    expect(review.message.suggestions.every((item) => item.tried?.startsWith("已试排："))).toBe(true);
    const messageId = review.message.id;

    const current = async () => (await conversations().findConversation(id))!.conversation;
    expect(await plan.decideReview(id, { messageId, index: 1, decision: "dismiss", fingerprint: fingerprint((await current()).draft) })).toEqual({ status: "ok" });
    expect(await plan.decideReview(id, { messageId, index: 1, decision: "adopt", fingerprint: fingerprint((await current()).draft) })).toEqual({ status: "conflict" });

    const adopted = await plan.decideReview(id, { messageId, index: 0, decision: "adopt", fingerprint: fingerprint((await current()).draft) });
    expect(adopted).toMatchObject({ status: "ok", days: [1] });
    expect((await current()).draft.interests.map((item) => item.text)).toContain("公园花园");
    // 页面拿回复里卡片的指纹接着重排受影响的天。
    const after = await current();
    expect((adopted as { card: { fingerprint: string } }).card.fingerprint).toBe(fingerprint(after.draft));
    const redo = await events((emit, signal) => plan.outing(id, { fingerprint: (adopted as { card: { fingerprint: string } }).card.fingerprint, days: [1] }, emit as never, signal));
    expect(redo.filter((event) => event.type === "day")).toHaveLength(1);

    // 保存整趟后，采纳只能走改动流程：接口说 saved_trip，改动接口按这条建议重排、出改动卡片，建议记成已采纳。
    const latest = (await conversations().findConversation(id))!;
    const days = latest.messages.filter((message) => message.kind === "outing_day");
    expect(days.length).toBeGreaterThanOrEqual(2);
    const receipts = [...redo, ...generated].filter((event) => event.type === "day")
      .flatMap((event) => (event.receipts as { receipt: string }[]).map((item) => item.receipt));
    const generationId = (days[0]!.body as { generationId: string }).generationId;
    expect(await save(id, { generationId, receipts, acknowledgeUnknowns: true })).toMatchObject({ status: "saved" });

    const again = services([{ fixes: [{ action: "add_interest", day: 2, text: "餐饮小馆", reason }] }]);
    const before = fingerprint((await current()).draft);
    const regenerated = await events((emit, signal) => again.plan.outing(id, { fingerprint: before, days: [2] }, emit as never, signal));
    const second = regenerated.find((event) => event.type === "review") as unknown as { message: { id: string } } | undefined;
    // 重排第 2 天也会审查；这次脚本给了一条，新的建议卡片可以采纳。
    expect(second).toBeDefined();
    const saved = await again.plan.decideReview(id, { messageId: second!.message.id, index: 0, decision: "adopt", fingerprint: fingerprint((await current()).draft) });
    expect(saved).toEqual({ status: "saved_trip" });
    const count = (await current()).messageCount;
    const change = await events((emit, signal) => again.plan.outingChange(id, { expectedCount: count, request: { adopt: { messageId: second!.message.id, index: 0 } } }, emit as never, signal));
    expect(change.at(-1)).toMatchObject({ type: "change", messages: [{ kind: "outing_change" }] });
    const stored = (await conversations().findConversation(id))!.messages.find((message) => message.id === second!.message.id);
    expect(stored?.kind === "outing_review" && stored.body.suggestions[0]!.status).toBe("adopted");
  });
});
