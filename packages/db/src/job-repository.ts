import { and, desc, eq, sql } from "drizzle-orm";
import type { JourneyDatabase } from "./connection";
import { conversationJobs, conversations } from "./schema";

/** V3.5 对话里的长任务（stages/V3.5.md §3.1）。 */
export type JobKind = "plan" | "outing" | "outing_change" | "adjust";
export type JobStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface StoredJob {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: JobKind;
  readonly requestKey: string;
  readonly status: JobStatus;
  readonly steps: readonly string[];
  readonly days: readonly number[];
  readonly planned: readonly number[];
  readonly rootRunId: string | null;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly finishedAt: Date | null;
}

export type BeginOutcome =
  | { readonly status: "started"; readonly job: StoredJob }
  /** 这段对话已经有一个在跑（同一个请求键的重试也是这样）：不开始新的，页面接到它上面。 */
  | { readonly status: "running"; readonly job: StoredJob }
  /** 同一个请求键之前已经跑完了（重发的请求晚到）。 */
  | { readonly status: "finished"; readonly job: StoredJob }
  | { readonly status: "not_found" };

/** 进度只留最近这么多条步骤文字（同 planning_progress）。 */
export const JOB_STEPS = 30;

type JobRow = typeof conversationJobs.$inferSelect;
const toJob = (row: JobRow): StoredJob => ({
  id: row.id,
  conversationId: row.conversationId,
  kind: row.kind as JobKind,
  requestKey: row.requestKey,
  status: row.status as JobStatus,
  steps: row.steps as string[],
  days: row.days as number[],
  planned: row.planned as number[],
  rootRunId: row.rootRunId,
  startedAt: row.startedAt,
  heartbeatAt: row.heartbeatAt,
  finishedAt: row.finishedAt,
});

/**
 * 长任务的登记（V3.5 §3.1–3.5）。仓库绑定一个用户，只看得到这个用户的任务。开始时锁住对话根（和 appendTurn 同一把锁），
 * 同一段对话的两次开始排队进来：先到的登记，后到的看到它在跑。心跳停了超过 staleBefore 的 running 改成 interrupted。
 */
export class DrizzleJobRepository {
  constructor(
    private readonly database: JourneyDatabase,
    private readonly userId: string,
  ) {}

  private mine(id: string) {
    return and(eq(conversationJobs.id, id), eq(conversationJobs.userId, this.userId));
  }

  async begin(input: {
    readonly id: string;
    readonly conversationId: string;
    readonly kind: JobKind;
    readonly requestKey: string;
    readonly planned?: readonly number[];
    readonly now: Date;
    readonly staleBefore: Date;
  }): Promise<BeginOutcome> {
    return this.database.transaction(async (transaction) => {
      const [owned] = await transaction.select({ id: conversations.id }).from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, this.userId))).for("update");
      if (!owned) return { status: "not_found" } as const;
      const [same] = await transaction.select().from(conversationJobs)
        .where(and(eq(conversationJobs.conversationId, input.conversationId), eq(conversationJobs.requestKey, input.requestKey)));
      const [running] = await transaction.select().from(conversationJobs)
        .where(and(eq(conversationJobs.conversationId, input.conversationId), eq(conversationJobs.status, "running")));
      if (running && running.heartbeatAt >= input.staleBefore) return { status: "running", job: toJob(running) } as const;
      // 心跳停了：上一个进程没了，改成中断（由用户点“继续”）。
      if (running) {
        await transaction.update(conversationJobs).set({ status: "interrupted", finishedAt: input.now }).where(eq(conversationJobs.id, running.id));
      }
      // 同一个请求键之前登记过、已经不在跑了：不重跑。
      if (same) {
        const status = same.id === running?.id ? "interrupted" : same.status;
        return { status: "finished", job: toJob({ ...same, status, finishedAt: same.finishedAt ?? input.now }) } as const;
      }
      const [row] = await transaction.insert(conversationJobs).values({
        id: input.id,
        userId: this.userId,
        conversationId: input.conversationId,
        kind: input.kind,
        requestKey: input.requestKey,
        status: "running",
        steps: [],
        days: [],
        planned: [...(input.planned ?? [])],
        startedAt: input.now,
        heartbeatAt: input.now,
      }).returning();
      return { status: "started", job: toJob(row!) } as const;
    });
  }

  /** 这段对话最近的一个任务（没有为 null）；心跳停了的 running 先改成 interrupted 再返回。 */
  async latest(conversationId: string, now: Date, staleBefore: Date): Promise<StoredJob | null> {
    const [row] = await this.database.select().from(conversationJobs)
      .where(and(eq(conversationJobs.conversationId, conversationId), eq(conversationJobs.userId, this.userId)))
      .orderBy(desc(conversationJobs.startedAt)).limit(1);
    if (!row) return null;
    if (row.status === "running" && row.heartbeatAt < staleBefore) {
      const [updated] = await this.database.update(conversationJobs).set({ status: "interrupted", finishedAt: now })
        .where(and(this.mine(row.id), eq(conversationJobs.status, "running"))).returning();
      return toJob(updated ?? row);
    }
    return toJob(row);
  }

  async get(id: string): Promise<StoredJob | null> {
    const [row] = await this.database.select().from(conversationJobs).where(this.mine(id));
    return row ? toJob(row) : null;
  }

  /** 记一步进度、一个排好的天（同时算一次心跳）。只写还在跑的任务。 */
  async progress(id: string, update: { readonly step?: string; readonly day?: number }, now: Date): Promise<void> {
    await this.database.update(conversationJobs).set({
      heartbeatAt: now,
      // 只留最近 JOB_STEPS 条，按原来的先后。
      ...(update.step ? { steps: sql`(SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (SELECT x, n FROM jsonb_array_elements(${conversationJobs.steps} || ${JSON.stringify([update.step])}::jsonb) WITH ORDINALITY AS t(x, n) ORDER BY n DESC LIMIT ${JOB_STEPS}) AS kept)` } : {}),
      ...(update.day !== undefined ? { days: sql`(SELECT coalesce(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM (SELECT DISTINCT jsonb_array_elements(${conversationJobs.days} || ${JSON.stringify([update.day])}::jsonb) AS d) AS all_days)` } : {}),
    }).where(and(this.mine(id), eq(conversationJobs.status, "running")));
  }

  async setRootRun(id: string, rootRunId: string): Promise<void> {
    await this.database.update(conversationJobs).set({ rootRunId }).where(this.mine(id));
  }

  async heartbeat(id: string, now: Date): Promise<void> {
    await this.database.update(conversationJobs).set({ heartbeatAt: now }).where(and(this.mine(id), eq(conversationJobs.status, "running")));
  }

  /** 结束：只改还在跑的（已被当成中断的不再改回来）。 */
  async finish(id: string, status: Exclude<JobStatus, "running">, now: Date): Promise<void> {
    await this.database.update(conversationJobs).set({ status, finishedAt: now, heartbeatAt: now })
      .where(and(this.mine(id), eq(conversationJobs.status, "running")));
  }
}
