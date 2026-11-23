import type { JourneyDatabaseClient } from "./connection";

type Pool = JourneyDatabaseClient["pool"];

export const FEEDBACK_CATEGORIES = ["plan_issue", "ui_bug", "suggestion", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ["open", "resolved"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackSubmitInput {
  readonly userId: string;
  readonly category: FeedbackCategory;
  readonly content: string;
  readonly pagePath?: string | null;
  readonly contextLabel?: string | null;
  readonly conversationId?: string | null;
  readonly journeyId?: string | null;
}

export interface OpsFeedbackItem {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly displayUsername: string;
  readonly role: "admin" | "user";
  readonly category: FeedbackCategory;
  readonly content: string;
  readonly pagePath: string | null;
  readonly contextLabel: string | null;
  readonly conversationId: string | null;
  readonly journeyId: string | null;
  readonly status: FeedbackStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface OpsFeedbackList {
  readonly openCount: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  readonly items: readonly OpsFeedbackItem[];
}

const UUID_RE = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const MINUTE_LIMIT = 3;
const DAY_LIMIT = 20;

export class FeedbackStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async submit(
    input: FeedbackSubmitInput,
  ): Promise<
    | { readonly status: "ok"; readonly id: string; readonly createdAt: string }
    | { readonly status: "rate_limited" }
  > {
    const nowDate = new Date(this.now());
    const minuteAgo = new Date(nowDate.getTime() - 60_000);
    const dayAgo = new Date(nowDate.getTime() - 86_400_000);

    const { rows: limits } = await this.pool.query<{ minute_count: string; day_count: string }>(
      `SELECT
         count(*) FILTER (WHERE created_at >= $2)::text AS minute_count,
         count(*) FILTER (WHERE created_at >= $3)::text AS day_count
       FROM user_feedback
       WHERE user_id = $1 AND created_at >= $3`,
      [input.userId, minuteAgo, dayAgo],
    );
    const minuteCount = Number(limits[0]?.minute_count ?? 0);
    const dayCount = Number(limits[0]?.day_count ?? 0);
    if (minuteCount >= MINUTE_LIMIT || dayCount >= DAY_LIMIT) {
      return { status: "rate_limited" };
    }

    const { rows } = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO user_feedback (
         user_id, category, content, page_path, context_label, conversation_id, journey_id, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        input.userId,
        input.category,
        input.content,
        input.pagePath ?? null,
        input.contextLabel ?? null,
        input.conversationId ?? null,
        input.journeyId ?? null,
        nowDate,
      ],
    );
    const row = rows[0]!;
    return { status: "ok", id: row.id, createdAt: row.created_at.toISOString() };
  }

  async listForOps(options: {
    readonly status?: "all" | FeedbackStatus;
    readonly category?: "all" | FeedbackCategory;
    readonly userId?: string | null;
    readonly limit?: number;
  } = {}): Promise<OpsFeedbackList> {
    const status = options.status ?? "open";
    const category = options.category ?? "all";
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const userId = options.userId && UUID_RE.test(options.userId) ? options.userId : null;
    if (options.userId && !userId) {
      return { openCount: 0, resolvedCount: 0, totalCount: 0, items: [] };
    }

    const { rows: countRows } = await this.pool.query<{ open_count: string; resolved_count: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'open')::text AS open_count,
         count(*) FILTER (WHERE status = 'resolved')::text AS resolved_count
       FROM user_feedback
       WHERE ($1::uuid IS NULL OR user_id = $1::uuid)`,
      [userId],
    );
    const openCount = Number(countRows[0]?.open_count ?? 0);
    const resolvedCount = Number(countRows[0]?.resolved_count ?? 0);

    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      username: string | null;
      display_username: string | null;
      role: string | null;
      category: FeedbackCategory;
      content: string;
      page_path: string | null;
      context_label: string | null;
      conversation_id: string | null;
      journey_id: string | null;
      status: FeedbackStatus;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT
         f.id,
         f.user_id,
         u.username,
         u.display_username,
         u.role,
         f.category,
         f.content,
         f.page_path,
         f.context_label,
         f.conversation_id,
         f.journey_id,
         f.status,
         f.created_at,
         f.resolved_at
       FROM user_feedback f
       JOIN users u ON u.id = f.user_id
       WHERE ($1::text = 'all' OR f.status = $1::text)
         AND ($2::text = 'all' OR f.category = $2::text)
         AND ($3::uuid IS NULL OR f.user_id = $3::uuid)
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $4`,
      [status, category, userId, limit],
    );

    return {
      openCount,
      resolvedCount,
      totalCount: openCount + resolvedCount,
      items: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username ?? "unknown",
        displayUsername: row.display_username || row.username || "未知用户",
        role: row.role === "admin" ? "admin" : "user",
        category: row.category,
        content: row.content,
        pagePath: row.page_path,
        contextLabel: row.context_label,
        conversationId: row.conversation_id,
        journeyId: row.journey_id,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
      })),
    };
  }

  async updateStatus(
    id: string,
    status: FeedbackStatus,
  ): Promise<{ readonly id: string; readonly status: FeedbackStatus; readonly resolvedAt: string | null } | null> {
    if (!UUID_RE.test(id)) return null;
    const resolvedAt = status === "resolved" ? new Date(this.now()) : null;
    const { rows } = await this.pool.query<{
      id: string;
      status: FeedbackStatus;
      resolved_at: Date | null;
    }>(
      `UPDATE user_feedback
       SET status = $2, resolved_at = $3
       WHERE id = $1
       RETURNING id, status, resolved_at`,
      [id, status, resolvedAt],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    };
  }
}
