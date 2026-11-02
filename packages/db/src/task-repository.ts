import type { Pool } from "pg";
import {
  PLANNING_TASK_LIMITS,
  type ClaimedPlanningTask,
  type CreatePlanningTaskOutcome,
  type NewPlanningTask,
  type PlanningTaskRepository,
  type StoredPlanningTask,
} from "@tripquest/application/planning-task";

interface TaskRow {
  id: string;
  user_id: string;
  kind: StoredPlanningTask["kind"];
  journey_id: string | null;
  request_key: string;
  intent_fingerprint: string;
  input: unknown;
  status: StoredPlanningTask["status"];
  progress: unknown;
  result: unknown;
  offer: unknown;
  stop_reason: StoredPlanningTask["stopReason"];
  attempts: number;
  lease_token: string | null;
  cancel_requested_at: Date | null;
  deadline_at: Date;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toTask(row: TaskRow): StoredPlanningTask {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    journeyId: row.journey_id,
    requestKey: row.request_key,
    intentFingerprint: row.intent_fingerprint,
    input: row.input,
    status: row.status,
    progress: row.progress,
    result: row.result,
    offer: row.offer,
    stopReason: row.stop_reason,
    attempts: row.attempts,
    cancelRequestedAt: row.cancel_requested_at,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * 网页按用户用（userId：只看、只建、只取消这个用户的任务），Worker 用 "worker"（领取、续租、写结果跨用户，
 * 任务带着 userId 执行）。两边的方法互不能用（V2.12，stages/V2.12.md §3.4）。
 *
 * Worker 每次写入都匹配 lease_token 与 running 状态。
 * 租约被接管后，旧进程即使继续计算，也不能覆盖接管者的进度和结果。
 */
export class PgPlanningTaskRepository implements PlanningTaskRepository {
  constructor(
    private readonly pool: Pool,
    private readonly scope: { readonly userId: string } | "worker",
  ) {}

  private get userId(): string {
    if (this.scope === "worker") throw new Error("task repository: user method on the worker scope");
    return this.scope.userId;
  }

  private worker(): void {
    if (this.scope !== "worker") throw new Error("task repository: worker method on a user scope");
  }

  async createTask(task: NewPlanningTask): Promise<CreatePlanningTaskOutcome> {
    const inserted = await this.pool.query<TaskRow>(
      `INSERT INTO planning_tasks
        (id, user_id, kind, journey_id, request_key, intent_fingerprint, input, status, deadline_at, created_at)
       VALUES ($1, $9, $2, $3, $4, $5, $6::json, 'queued', $7, $8)
       ON CONFLICT (request_key) DO NOTHING
       RETURNING *`,
      [
        task.id,
        task.kind,
        task.journeyId,
        task.requestKey,
        task.intentFingerprint,
        json(task.input),
        new Date(task.createdAt.getTime() + PLANNING_TASK_LIMITS.deadlineMs),
        task.createdAt,
        this.userId,
      ],
    );
    if (inserted.rows[0]) return { status: "created", task: toTask(inserted.rows[0]) };
    const { rows } = await this.pool.query<TaskRow>(
      "SELECT * FROM planning_tasks WHERE request_key = $1 AND user_id = $2",
      [task.requestKey, this.userId],
    );
    const existing = rows[0];
    // 若冲突后的记录已经被清理，不能直接宣称找到了原任务；由调用方处理意图冲突。
    if (!existing || existing.intent_fingerprint !== task.intentFingerprint || existing.kind !== task.kind) {
      return { status: "intent_conflict" };
    }
    return { status: "existing", task: toTask(existing) };
  }

  async findTask(id: string): Promise<StoredPlanningTask | null> {
    const { rows } = await this.pool.query<TaskRow>("SELECT * FROM planning_tasks WHERE id = $1 AND user_id = $2", [id, this.userId]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  // 未开始的任务可直接取消；运行中的任务只记取消请求，由持有有效租约的 Worker 停止并落终态。
  async requestCancel(id: string, now: Date): Promise<StoredPlanningTask | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE planning_tasks SET
         cancel_requested_at = coalesce(cancel_requested_at, $2),
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         stop_reason = CASE WHEN status = 'queued' THEN 'cancelled' ELSE stop_reason END,
         finished_at = CASE WHEN status = 'queued' THEN $2 ELSE finished_at END
       WHERE id = $1 AND user_id = $3 AND status IN ('queued', 'running')
       RETURNING *`,
      [id, now, this.userId],
    );
    return rows[0] ? toTask(rows[0]) : this.findTask(id);
  }

  async sweep(now: Date): Promise<number> {
    this.worker();
    // 排队期间已经超过截止时间的任务直接结束，不能领取后再消耗模型与工具预算。
    const queued = await this.pool.query<{ id: string }>(
      `UPDATE planning_tasks SET status = 'failed', stop_reason = 'deadline', finished_at = $1
       WHERE status = 'queued' AND deadline_at <= $1
       RETURNING id`,
      [now],
    );
    // 失联任务只有仍可恢复时才允许接管；达到尝试次数、已取消或超时就明确结束。
    const lost = await this.pool.query<{ id: string }>(
      `UPDATE planning_tasks SET
         status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
         stop_reason = CASE
           WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
           WHEN deadline_at <= $1 THEN 'deadline'
           ELSE 'worker_lost' END,
         finished_at = $1, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at <= $1
         AND (attempts >= $2 OR deadline_at <= $1 OR cancel_requested_at IS NOT NULL)
       RETURNING id`,
      [now, PLANNING_TASK_LIMITS.attempts],
    );
    // 这些任务不会再由正常结束的 Worker 清理检查点，因此清扫时一并释放。
    await this.dropCheckpoints(lost.rows.map((row) => row.id));
    return queued.rows.length + lost.rows.length;
  }

  /**
   * 清理没有正常执行到结束步骤的任务所遗留的 LangGraph 检查点。
   * 按官方保存器的表依赖顺序删除；未初始化过检查点结构的数据库直接跳过。
   */
  private async dropCheckpoints(taskIds: readonly string[]): Promise<void> {
    if (!taskIds.length) return;
    const { rows } = await this.pool.query<{ ready: boolean }>(
      "SELECT to_regclass('langgraph.checkpoints') IS NOT NULL AS ready",
    );
    if (!rows[0]?.ready) return;
    for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
      await this.pool.query(`DELETE FROM langgraph.${table} WHERE thread_id = ANY($1::text[])`, [taskIds]);
    }
  }

  // 选中与领取放在一条 SQL 中完成；SKIP LOCKED 让多个 Worker 跳过别人正在领取的行。
  // 每次接管都换 lease_token，之后旧进程的心跳、进度和结果写入都匹配不到新租约。
  async claimNext(owner: string, now: Date): Promise<ClaimedPlanningTask | null> {
    this.worker();
    const { rows } = await this.pool.query<TaskRow>(
      `WITH candidate AS (
         SELECT id FROM planning_tasks
         WHERE deadline_at > $2 AND cancel_requested_at IS NULL
           AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= $2 AND attempts < $4))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE planning_tasks t SET
         status = 'running', attempts = t.attempts + 1, lease_owner = $1,
         lease_token = gen_random_uuid(), lease_expires_at = $3,
         started_at = coalesce(t.started_at, $2)
       FROM candidate WHERE t.id = candidate.id
       RETURNING t.*`,
      [owner, now, new Date(now.getTime() + PLANNING_TASK_LIMITS.leaseMs), PLANNING_TASK_LIMITS.attempts],
    );
    const row = rows[0];
    return row ? { ...toTask(row), leaseToken: row.lease_token! } : null;
  }

  // 心跳同时续租与读取取消标记；返回 null 表示任务已终结或被接管，调用者必须停止写入。
  async heartbeat(id: string, leaseToken: string, now: Date): Promise<{ cancelRequested: boolean } | null> {
    this.worker();
    const { rows } = await this.pool.query<{ cancel_requested_at: Date | null }>(
      `UPDATE planning_tasks SET lease_expires_at = $3
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
       RETURNING cancel_requested_at`,
      [id, leaseToken, new Date(now.getTime() + PLANNING_TASK_LIMITS.leaseMs)],
    );
    return rows[0] ? { cancelRequested: rows[0].cancel_requested_at !== null } : null;
  }

  async saveProgress(id: string, leaseToken: string, progress: unknown): Promise<boolean> {
    this.worker();
    const result = await this.pool.query(
      `UPDATE planning_tasks SET progress = $3::json
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [id, leaseToken, json(progress)],
    );
    return result.rowCount === 1;
  }

  // 终态只允许从匹配令牌的 running 状态写入一次；同一条更新还清除租约，后续旧写入自然失效。
  async finish(
    id: string,
    leaseToken: string,
    outcome: Parameters<PlanningTaskRepository["finish"]>[2],
    now: Date,
  ): Promise<boolean> {
    this.worker();
    const result = await this.pool.query(
      `UPDATE planning_tasks SET
         status = $3, result = $4::json, stop_reason = $5, finished_at = $6,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [id, leaseToken, outcome.status, json(outcome.result), outcome.stopReason ?? null, now],
    );
    return result.rowCount === 1;
  }

  // 轮询可能多次请求同一完成任务；只保留第一份确认凭据，避免每次刷新都重新签发有效期。
  async setOffer(id: string, offer: unknown): Promise<unknown> {
    const { rows } = await this.pool.query<{ offer: unknown }>(
      `UPDATE planning_tasks SET offer = coalesce(offer, $2::json)
       WHERE id = $1 AND user_id = $3 AND status = 'completed'
       RETURNING offer`,
      [id, json(offer), this.userId],
    );
    return rows[0]?.offer ?? null;
  }

  async purge(finishedBefore: Date): Promise<number> {
    this.worker();
    const { rows } = await this.pool.query<{ id: string }>(
      "DELETE FROM planning_tasks WHERE finished_at IS NOT NULL AND finished_at < $1 RETURNING id",
      [finishedBefore],
    );
    // 补清此前终态清理被打断时遗留的检查点，避免任务数据删掉后留下无法恢复的运行状态。
    await this.dropCheckpoints(rows.map((row) => row.id));
    return rows.length;
  }
}
