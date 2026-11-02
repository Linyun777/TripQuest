import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatTurnResult } from "@tripquest/agent/chat";
import {
  closeSharedJourneyDatabase,
  createJourneyDatabase,
  DrizzleConversationRepository,
  DrizzleJobRepository,
  getSharedJourneyDatabase,
  migrateJourneyDatabase,
  requireSafeTestDatabaseUrl,
} from "@tripquest/db";
import { attachJob, startJob, stopJob, JOB_STALE_MS, type JobOptions } from "../jobs";
import { createConversationService } from "../conversation-service";

/**
 * V3.5 对话里的长任务（stages/V3.5.md §3.2–3.5、§4）：一次只跑一个、请求键重试接上、接上回放再接着推、停止、心跳停了
 * 是中断、额度只扣一次、看不到别人的任务、随对话和账号删除；消息客户端编号不重复写。连自己的临时 *_test 库，任务是假的
 * （不发模型、地图请求，只数“请求”次数）。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V3.5 conversation jobs", () => {
  const database = "tripquest_v35_jobs_test";
  const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const url = Object.assign(new URL(safe), { pathname: `/${database}` }).toString();
  const admin = () => createJourneyDatabase(safe, { maxConnections: 1 });
  let owner: string;
  let other: string;
  let clock = Date.parse("2026-11-02T02:00:00Z");
  const now = () => clock;
  const jobs = (user: string) => new DrizzleJobRepository(getSharedJourneyDatabase().database, user);
  const options = (user = owner): JobOptions => ({ jobs: () => jobs(user), userId: user, now, heartbeatMs: 50 });
  const conversations = (user = owner) => new DrizzleConversationRepository(getSharedJourneyDatabase().database, user);
  async function conversation(user = owner) {
    return (await conversations(user).createConversation({ id: randomUUID(), title: "测试对话", now: new Date(clock) })).id;
  }
  type Line = { type?: string; status?: string; [key: string]: unknown };
  async function lines(response: Response): Promise<Line[]> {
    if (!(response.headers.get("content-type") ?? "").includes("ndjson")) return [await response.json()];
    return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  /** 一个假的长任务：先发一步、排好第 1 天（带保存凭据），等放行后再排第 2 天；每次“请求”计数加一。 */
  function slowRun(counter: { requests: number }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run = async (emit: (event: { type: string } & Record<string, unknown>) => void, signal: AbortSignal) => {
      counter.requests += 1;
      emit({ type: "step", step: { key: "s1", text: "正在排第 1 天", state: "active" } });
      emit({ type: "day", message: { day: 1 }, receipts: [{ runId: "r1", receipt: "secret" }], messageCount: 3 });
      await Promise.race([gate, new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
      if (signal.aborted) {
        emit({ type: "outing_done", messageCount: 3 });
        return;
      }
      counter.requests += 1;
      emit({ type: "day", message: { day: 2 }, receipts: [{ runId: "r2", receipt: "secret" }], messageCount: 4 });
      emit({ type: "outing_done", messageCount: 4 });
    };
    return { run, release: () => release() };
  }

  beforeAll(async () => {
    const setup = admin();
    await setup.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await setup.pool.query(`CREATE DATABASE ${database}`);
    await setup.close();
    vi.stubEnv("DATABASE_URL", requireSafeTestDatabaseUrl(url, process.env.DATABASE_URL));
    const { pool, database: client } = getSharedJourneyDatabase();
    await migrateJourneyDatabase(client, { migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle") });
    owner = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'")).rows[0]!.id;
    other = (await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, username, display_username, role)
       VALUES ('test_jobs_b', gen_random_uuid()::text || '@users.invalid', 'test_jobs_b', 'test_jobs_b', 'user') RETURNING id`,
    )).rows[0]!.id;
  });
  afterAll(async () => {
    await closeSharedJourneyDatabase();
    vi.unstubAllEnvs();
    const cleanup = admin();
    await cleanup.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cleanup.close();
  });

  it("runs one at a time: a second start or a retried key joins it, replays without receipts, and the count stays at one", async () => {
    const id = await conversation();
    const counter = { requests: 0 };
    const first = slowRun(counter);
    const key = randomUUID();
    const started = startJob(options(), { conversationId: id, kind: "outing", requestKey: key, signal: new AbortController().signal }, first.run);
    const response = await started;
    // 发起的请求：第一行是任务本身，之后是任务的事件（带保存凭据）。
    const reading = lines(response);
    await vi.waitFor(async () => expect((await jobs(owner).latest(id, new Date(clock), new Date(0)))?.days).toEqual([1]));

    // 再点一次开始（新的键）、同一个键重试：都不开始新的，回在跑的那个。
    const again = await lines(await startJob(options(), { conversationId: id, kind: "outing", requestKey: randomUUID(), signal: new AbortController().signal }, slowRun(counter).run));
    const retried = await lines(await startJob(options(), { conversationId: id, kind: "outing", requestKey: key, signal: new AbortController().signal }, slowRun(counter).run));
    const job = (again[0]!.job as { jobId: string }).jobId;
    expect(again[0]).toMatchObject({ status: "running", job: { kind: "outing", days: [1], steps: ["正在排第 1 天"] } });
    expect((retried[0]!.job as { jobId: string }).jobId).toBe(job);

    // 接上两次：先回放已发出的（没有保存凭据），再接着推，直到结束。
    const attached = [attachJob(options(), id), attachJob(options(), id)].map(async (pending) => lines(await pending));
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.release();
    const [own, ...joined] = await Promise.all([reading, ...attached]);
    expect(own!.map((line) => line.type)).toEqual(["job", "step", "day", "day", "outing_done"]);
    expect(own!.filter((line) => line.type === "day").every((line) => Array.isArray(line.receipts))).toBe(true);
    for (const seen of joined) {
      expect(seen.map((line) => line.type)).toEqual(["job", "step", "day", "day", "outing_done"]);
      expect(seen.some((line) => "receipts" in line)).toBe(false);
    }
    expect(counter.requests).toBe(2);
    expect(await jobs(owner).latest(id, new Date(clock), new Date(0))).toMatchObject({ status: "done", days: [1, 2] });

    // 跑完以后同一个键晚到：不重跑。
    const late = await lines(await startJob(options(), { conversationId: id, kind: "outing", requestKey: key, signal: new AbortController().signal }, slowRun(counter).run));
    expect(late[0]).toMatchObject({ status: "finished", job: { status: "done" } });
    expect(counter.requests).toBe(2);
  });

  it("stops: the run is aborted, the days already planned stay, only the owner can stop", async () => {
    const id = await conversation();
    const counter = { requests: 0 };
    const slow = slowRun(counter);
    const reading = startJob(options(), { conversationId: id, kind: "outing", requestKey: randomUUID(), signal: new AbortController().signal }, slow.run).then(lines);
    await vi.waitFor(async () => expect((await jobs(owner).latest(id, new Date(clock), new Date(0)))?.days).toEqual([1]));
    const job = (await jobs(owner).latest(id, new Date(clock), new Date(0)))!;
    expect(await (await stopJob(options(other), id, job.id)).json()).toEqual({ status: "not_found" });
    expect(await (await stopJob(options(), id, job.id)).json()).toEqual({ status: "stopping" });
    await reading;
    expect(await jobs(owner).get(job.id)).toMatchObject({ status: "cancelled", days: [1] });
    expect(counter.requests).toBe(1);
  });

  it("a stopped heartbeat is an interruption; the user starts again, nothing reruns by itself; others never see the job", async () => {
    const id = await conversation();
    const repository = jobs(owner);
    // 上一个进程登记的、心跳停了的任务（这个进程里没有它）。
    const begun = await repository.begin({ id: randomUUID(), conversationId: id, kind: "outing", requestKey: randomUUID(), planned: [2, 3], now: new Date(clock), staleBefore: new Date(0) });
    if (begun.status !== "started") throw new Error(begun.status);
    // 步骤按先后保留最近 30 条。
    for (let index = 1; index <= 32; index += 1) await repository.progress(begun.job.id, { step: `第 ${index} 步` }, new Date(clock));
    await repository.progress(begun.job.id, { step: "正在排第 2 天", day: 2 }, new Date(clock));
    const steps = (await repository.get(begun.job.id))!.steps;
    expect(steps).toHaveLength(30);
    expect([steps[0], steps.at(-2), steps.at(-1)]).toEqual(["第 4 步", "第 32 步", "正在排第 2 天"]);
    clock += JOB_STALE_MS + 1_000;
    expect(await lines(await attachJob(options(other), id))).toEqual([{ status: "none" }]);
    expect(await lines(await attachJob(options(), id))).toEqual([{ status: "interrupted", job: expect.objectContaining({ days: [2], planned: [2, 3] }) }]);
    // 用户点“继续”：是一次新的开始，只排剩下的天（由页面传 days）。
    const counter = { requests: 0 };
    const resumed = await lines(await startJob(options(), { conversationId: id, kind: "outing", requestKey: randomUUID(), planned: [3], signal: new AbortController().signal }, async (emit) => {
      counter.requests += 1;
      emit({ type: "outing_done", messageCount: 5 });
    }));
    expect(resumed.map((line) => line.type)).toEqual(["job", "outing_done"]);
    expect(counter.requests).toBe(1);
    // 心跳还新、但不是这个进程的（服务刚重启）：也当中断，不用等 30 秒。
    const fresh = await conversation();
    const orphan = await repository.begin({ id: randomUUID(), conversationId: fresh, kind: "plan", requestKey: randomUUID(), now: new Date(Date.now() - 60_000), staleBefore: new Date(0) });
    if (orphan.status !== "started") throw new Error(orphan.status);
    await repository.heartbeat(orphan.job.id, new Date(Date.now() - 60_000));
    expect(await lines(await attachJob({ ...options(), now: Date.now }, fresh))).toMatchObject([{ status: "interrupted" }]);
  });

  it("jobs go with the conversation and with the account", async () => {
    const { pool } = getSharedJourneyDatabase();
    const id = await conversation();
    await startJob(options(), { conversationId: id, kind: "plan", requestKey: randomUUID(), signal: new AbortController().signal }, async () => {}).then(lines);
    const count = async (where: string, value: string) =>
      Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM conversation_jobs WHERE ${where} = $1`, [value])).rows[0]!.n);
    expect(await count("conversation_id", id)).toBe(1);
    await pool.query("DELETE FROM conversations WHERE id = $1", [id]);
    expect(await count("conversation_id", id)).toBe(0);
    const theirs = await conversation(other);
    await startJob(options(other), { conversationId: theirs, kind: "plan", requestKey: randomUUID(), signal: new AbortController().signal }, async () => {}).then(lines);
    // 别人的对话：开始不了。
    expect(await lines(await startJob(options(), { conversationId: theirs, kind: "plan", requestKey: randomUUID(), signal: new AbortController().signal }, async () => {}))).toEqual([{ status: "not_found" }]);
    await pool.query("DELETE FROM users WHERE id = $1", [other]);
    expect(await count("user_id", other)).toBe(0);
  });

  it("a message sent again with the same client id answers the stored turn and runs the chat once", async () => {
    let turns = 0;
    const service = createConversationService({
      userId: owner,
      now,
      environment: { NODE_ENV: "test" },
      repository: () => conversations(),
      runner: async () => ({
        run: async (input) => {
          turns += 1;
          return { status: "completed", reply: { text: "好的。", asking: false, fallback: false }, draft: input.draft, draftChanged: false, counts: { model: 1, searches: 0, weather: 0, webSearches: 0, knowledge: 0, repairs: 0 }, usage: null } satisfies ChatTurnResult;
        },
      }),
    });
    const clientId = randomUUID();
    const first = await service.start("明天想喝茶", undefined, undefined, undefined, clientId);
    const repeat = await service.start("明天想喝茶", undefined, undefined, undefined, clientId);
    if (first.status !== "ok" || repeat.status !== "ok") throw new Error("turn failed");
    expect(repeat.conversationId).toBe(first.conversationId);
    expect(repeat.messageCount).toBe(first.messageCount);
    const second = randomUUID();
    const sent = await service.send(first.conversationId, "下午去", first.messageCount, undefined, second);
    const resent = await service.send(first.conversationId, "下午去", first.messageCount, undefined, second);
    if (sent.status !== "ok" || resent.status !== "ok") throw new Error("send failed");
    expect(resent.messageCount).toBe(sent.messageCount);
    expect(resent.messages.map((message) => message.kind)).toEqual(sent.messages.map((message) => message.kind));
    expect(turns).toBe(2);
  });
});
