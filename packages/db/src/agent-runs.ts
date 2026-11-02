import type { JourneyDatabaseClient } from "./connection";

type Pool = JourneyDatabaseClient["pool"];

/** 与 @tripquest/agent/runs 的 RunRecord、StepRecord 同形（db 不依赖 agent 包）。 */
export interface StoredRun {
  readonly id: string;
  readonly rootId: string;
  readonly parentId: string | null;
  readonly agent: string;
  readonly version: string | null;
  readonly trigger: string | null;
  readonly links: { readonly conversationId?: string; readonly journeyId?: string; readonly tripId?: string };
  readonly status: string;
  readonly outcome: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly counts: {
    readonly model: number;
    readonly amap: number;
    readonly web: number;
    readonly embed: number;
    readonly jev: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheHitTokens: number;
  };
}

export interface StoredStep {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly name: string;
  readonly latencyMs: number | null;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly at: Date;
}

/** 一次插入的行数上限（参数个数不超过 Postgres 的 65535）。 */
const BATCH = 200;

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, (_, row) =>
    `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(", ")})`).join(", ");
}

/**
 * V3.0 运行记录（stages/V3.0.md §3.2–3.3）：根运行结束时一次写入整棵树；只读写这个用户的记录，别人的运行
 * 编号查不到（和不存在一样）。删除对话、行程、出游或账号时，记录随外键一起删除。
 */
export class PgAgentRunStore {
  constructor(private readonly pool: Pool, private readonly userId: string) {}

  async write(runs: readonly StoredRun[], steps: readonly StoredStep[]): Promise<void> {
    if (!runs.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 根运行在前（子运行的 root_id 指向它）。
      const ordered = [...runs].sort((a, b) => Number(b.id === b.rootId) - Number(a.id === a.rootId));
      for (let start = 0; start < ordered.length; start += BATCH) {
        const rows = ordered.slice(start, start + BATCH);
        await client.query(
          `INSERT INTO agent_runs (id, root_id, parent_id, user_id, conversation_id, journey_id, trip_id, agent, agent_version,
             trigger, status, outcome, attributes, started_at, finished_at, model_requests, input_tokens, output_tokens,
             cache_hit_tokens, map_requests, web_requests, knowledge_requests, jev_requests)
           VALUES ${placeholders(rows.length, 23)}`,
          rows.flatMap((run) => [
            run.id, run.rootId, run.parentId, this.userId,
            run.links.conversationId ?? null, run.links.journeyId ?? null, run.links.tripId ?? null,
            run.agent.slice(0, 40), run.version, run.trigger, run.status, run.outcome?.slice(0, 80) ?? null,
            JSON.stringify(run.attributes), run.startedAt, run.finishedAt,
            run.counts.model, run.counts.inputTokens, run.counts.outputTokens, run.counts.cacheHitTokens,
            run.counts.amap, run.counts.web, run.counts.embed, run.counts.jev,
          ]),
        );
      }
      for (let start = 0; start < steps.length; start += BATCH) {
        const rows = steps.slice(start, start + BATCH);
        await client.query(
          `INSERT INTO agent_steps (run_id, seq, kind, name, latency_ms, summary, at) VALUES ${placeholders(rows.length, 7)}`,
          rows.flatMap((step) => [step.runId, step.seq, step.kind, step.name, step.latencyMs, JSON.stringify(step.summary), step.at]),
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** 一个运行所在的整棵树；不是这个用户的返回 null。 */
  async findTree(runId: string): Promise<{ runs: Record<string, unknown>[]; steps: Record<string, unknown>[] } | null> {
    const { rows: roots } = await this.pool.query<{ root_id: string }>(
      "SELECT root_id FROM agent_runs WHERE id = $1 AND user_id = $2",
      [runId, this.userId],
    );
    if (!roots[0]) return null;
    const rootId = roots[0].root_id;
    const { rows: runs } = await this.pool.query(
      // 同一毫秒开始时根运行排在前面。
      "SELECT * FROM agent_runs WHERE root_id = $1 AND user_id = $2 ORDER BY started_at, id <> root_id, id",
      [rootId, this.userId],
    );
    const { rows: steps } = await this.pool.query(
      `SELECT s.* FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE r.root_id = $1 AND r.user_id = $2 ORDER BY s.at, s.run_id, s.seq`,
      [rootId, this.userId],
    );
    return { runs, steps };
  }

  /** 一段对话的根运行（新的在后）；对话不是这个用户的返回空列表。 */
  async listForConversation(conversationId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_runs WHERE conversation_id = $1 AND user_id = $2 AND id = root_id ORDER BY started_at`,
      [conversationId, this.userId],
    );
    return rows;
  }
}
