import "server-only";
import { randomUUID } from "node:crypto";
import type { BeginOutcome, JobKind, StoredJob } from "@tripquest/db";
import { traced } from "../runs/runs";
import { logFailure } from "../api/planning/failure-code";

/**
 * V3.5 对话里的长任务（stages/V3.5.md §3.2–3.5）：开始规划、出游生成、跨天改动、调整今天的行程都经这里跑。
 * - 一段对话同时只跑一个：登记在 conversation_jobs（一个事务里查有没有在跑的）；有在跑的就不开始新的，页面接到它上面。
 * - 进程里按任务编号的事件中转：发起的请求照旧按行推送；接上的页面先回放这次已发出的事件（去掉保存凭据），再接着推。
 * - 每 5 秒一次心跳；心跳停了 30 秒、或者是上一个进程登记的（这个进程里没有它），就是中断，由用户点“继续”，不自动重跑。
 * - 停止：按任务编号的中止信号，只有主人能停。
 * 真实数据仍只在请求所在的进程里跑，不存检查点（D-045 / D-046、D-077）。
 */
export interface JobRepository {
  begin(input: Parameters<import("@tripquest/db").DrizzleJobRepository["begin"]>[0]): Promise<BeginOutcome>;
  latest(conversationId: string, now: Date, staleBefore: Date): Promise<StoredJob | null>;
  get(id: string): Promise<StoredJob | null>;
  progress(id: string, update: { readonly step?: string; readonly day?: number }, now: Date): Promise<void>;
  setRootRun(id: string, rootRunId: string): Promise<void>;
  heartbeat(id: string, now: Date): Promise<void>;
  finish(id: string, status: "done" | "failed" | "cancelled" | "interrupted", now: Date): Promise<void>;
}

export interface JobOptions {
  readonly jobs: () => JobRepository;
  readonly userId: string;
  readonly now?: () => number;
  /** 测试里缩短心跳间隔。 */
  readonly heartbeatMs?: number;
}

/** 心跳间隔、多久没心跳算中断（§3.5）。 */
export const JOB_HEARTBEAT_MS = 5_000;
export const JOB_STALE_MS = 30_000;

type JobEvent = { readonly type: string } & Record<string, unknown>;
interface Live {
  readonly userId: string;
  readonly conversationId: string;
  readonly kind: JobKind;
  /** 这次已发出的事件（去掉保存凭据），接上的页面先回放。 */
  readonly events: JobEvent[];
  readonly listeners: Set<(event: JobEvent | null) => void>;
  readonly controller: AbortController;
}

// 开发时热更新会重新加载模块；中转放在 globalThis 上，进行中的任务不丢。
const store = globalThis as typeof globalThis & { __tripquestJobs?: { live: Map<string, Live>; startedAt: number } };
store.__tripquestJobs ??= { live: new Map(), startedAt: Date.now() };
const hub = store.__tripquestJobs;

/** 只有发起的页面拿保存凭据（内存），接上的页面拿不到（§3.3）。 */
function withoutReceipts(event: JobEvent): JobEvent {
  if (!("receipts" in event) && !("receipt" in event)) return event;
  const rest: Record<string, unknown> = { ...event };
  delete rest.receipts;
  delete rest.receipt;
  return rest as JobEvent;
}

/** 任务的结束事件（页面收到才结束这一轮）。 */
const TERMINAL = new Set(["done", "refused", "outing_done", "change"]);

const TRIGGERS: Readonly<Record<JobKind, string>> = { plan: "plan", outing: "outing_generate", outing_change: "outing_change", adjust: "adjust" };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function ndjson(start: (send: (line: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // 页面走了；任务照样跑完、结果照样存进对话。
        }
      };
      try {
        await start(send);
      } finally {
        try {
          controller.close();
        } catch {
          // 已被断开的连接关掉。
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** 上一个进程登记的、这个进程里没有的 running：中断（不用等 30 秒，§3.5）。 */
function staleBefore(nowMs: number): Date {
  return new Date(nowMs - JOB_STALE_MS);
}

async function settleOrphan(repository: JobRepository, job: StoredJob | null, nowMs: number): Promise<StoredJob | null> {
  if (!job || job.status !== "running" || hub.live.has(job.id) || job.heartbeatAt.getTime() >= hub.startedAt) return job;
  await repository.finish(job.id, "interrupted", new Date(nowMs));
  return { ...job, status: "interrupted", finishedAt: new Date(nowMs) };
}

export interface JobSummary {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly status: StoredJob["status"];
  readonly steps: readonly string[];
  readonly days: readonly number[];
  readonly planned: readonly number[];
}
const summary = (job: StoredJob): JobSummary => ({
  jobId: job.id, kind: job.kind, status: job.status, steps: job.steps, days: job.days, planned: job.planned,
});

/**
 * 开始一个长任务。已有在跑的（或同一个请求键已经登记过）：不开始，回 JSON `{status:"running"|"finished", job}`，
 * 页面接上（GET .../job）。开始了：回按行推送的流，第一行是 `{type:"job"}`，之后是任务自己的事件。
 */
export async function startJob(
  options: JobOptions,
  input: { readonly conversationId: string; readonly kind: JobKind; readonly requestKey: string; readonly planned?: readonly number[]; readonly signal: AbortSignal },
  run: (emit: (event: JobEvent) => void, signal: AbortSignal) => Promise<void>,
): Promise<Response> {
  const now = options.now ?? Date.now;
  const repository = options.jobs();
  await settleOrphan(repository, await repository.latest(input.conversationId, new Date(now()), staleBefore(now())), now());
  const begun = await repository.begin({
    id: randomUUID(),
    conversationId: input.conversationId,
    kind: input.kind,
    requestKey: input.requestKey,
    ...(input.planned ? { planned: input.planned } : {}),
    now: new Date(now()),
    staleBefore: staleBefore(now()),
  });
  if (begun.status === "not_found") return json({ status: "not_found" }, 404);
  if (begun.status !== "started") return json({ status: begun.status, job: summary(begun.job) });
  const job = begun.job;
  const controller = new AbortController();
  const live: Live = { userId: options.userId, conversationId: input.conversationId, kind: input.kind, events: [], listeners: new Set(), controller };
  hub.live.set(job.id, live);
  const signal = AbortSignal.any([input.signal, controller.signal]);
  return ndjson(async (send) => {
    send({ type: "job", job: summary(job) });
    const heartbeat = setInterval(() => {
      repository.heartbeat(job.id, new Date(now())).catch(() => {});
    }, options.heartbeatMs ?? JOB_HEARTBEAT_MS);
    // 进度写进表里是顺序的（不抢着写），也不挡住推送。
    let writes = Promise.resolve();
    /** 发过结束事件没有（停止时任务自己没发，就补一条“已停止”）。 */
    let ended = false;
    const emit = (event: JobEvent) => {
      if (TERMINAL.has(event.type)) ended = true;
      send(event);
      const shared = withoutReceipts(event);
      live.events.push(shared);
      for (const listener of live.listeners) listener(shared);
      const step = event.type === "step" ? (event.step as { text?: string } | undefined)?.text : undefined;
      const day = event.type === "day" ? (event.message as { day?: number } | undefined)?.day : undefined;
      if (step || day !== undefined) {
        writes = writes.then(() => repository.progress(job.id, { ...(step ? { step } : {}), ...(day !== undefined ? { day } : {}) }, new Date(now()))).catch(() => {});
      }
    };
    let status: "done" | "failed" | "cancelled" = "done";
    try {
      await traced({ trigger: TRIGGERS[input.kind], userId: options.userId }, async (root) => {
        writes = writes.then(() => repository.setRootRun(job.id, root.id)).catch(() => {});
        await run(emit, signal);
      });
      if (controller.signal.aborted) status = "cancelled";
      if (status === "cancelled" && !ended) emit({ type: "refused", status: "cancelled", message: "已停止。" });
    } catch (error) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      if (status === "failed") logFailure("plan-stream", error);
      if (!ended) emit({ type: "refused", status: status === "cancelled" ? "cancelled" : "unavailable", message: status === "cancelled" ? "已停止。" : "规划服务暂时出错，请稍后再试。" });
    } finally {
      clearInterval(heartbeat);
      await writes;
      await repository.finish(job.id, status, new Date(now())).catch(() => {});
      hub.live.delete(job.id);
      for (const listener of live.listeners) listener(null);
    }
  });
}

/**
 * GET .../job：这段对话最近的任务。在跑、而且在这个进程里：按行推送，先 `{type:"job"}`，再回放已发出的事件，接着推后续的，
 * 直到结束。不在跑：回 JSON `{status:"none"}` 或最近那次的状态（中断时页面给“继续”）。
 */
export async function attachJob(options: JobOptions, conversationId: string): Promise<Response> {
  const now = options.now ?? Date.now;
  const repository = options.jobs();
  const job = await settleOrphan(repository, await repository.latest(conversationId, new Date(now()), staleBefore(now())), now());
  if (!job) return json({ status: "none" });
  const live = hub.live.get(job.id);
  if (job.status !== "running" || !live) return json({ status: job.status, job: summary(job) });
  return ndjson(async (send) => {
    send({ type: "job", job: summary(job), attached: true });
    let finished!: () => void;
    const ended = new Promise<void>((resolve) => (finished = resolve));
    const listener = (event: JobEvent | null) => (event ? send(event) : finished());
    // 先挂上再回放：回放和新事件之间不会漏掉。
    const replay = [...live.events];
    live.listeners.add(listener);
    for (const event of replay) send(event);
    if (!hub.live.has(job.id)) finished();
    await ended;
    live.listeners.delete(listener);
  });
}

/** POST .../job/stop：只有主人能停（仓库只看得到这个用户的任务）；不在这个进程里的就直接记成停止。 */
export async function stopJob(options: JobOptions, conversationId: string, jobId: string): Promise<Response> {
  const now = options.now ?? Date.now;
  const repository = options.jobs();
  const job = await repository.get(jobId);
  if (!job || job.conversationId !== conversationId) return json({ status: "not_found" }, 404);
  if (job.status !== "running") return json({ status: job.status });
  const live = hub.live.get(jobId);
  if (live && live.userId === options.userId) {
    live.controller.abort();
    return json({ status: "stopping" });
  }
  await repository.finish(jobId, "cancelled", new Date(now()));
  return json({ status: "cancelled" });
}
