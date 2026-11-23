import { z } from "zod";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  FeedbackStore,
  getSharedJourneyDatabase,
  OpsReader,
  USAGE_CATEGORIES,
  type FeedbackCategory,
  type FeedbackStatus,
} from "@tripquest/db";
import { sessionUser, type UserResolver } from "../auth/session";
import { readBody, sameOrigin } from "../api/planning/request-body";
import { fixedExpenses } from "../deployment/fixed-expenses";

const singleLimitSchema = z.strictObject({
  category: z.enum(USAGE_CATEGORIES),
  limit: z.number().int().min(0).max(100_000).nullable(),
});

const limitsPatchSchema = z
  .discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("site"),
      updates: z.array(singleLimitSchema).min(1).max(USAGE_CATEGORIES.length),
    }),
    z.strictObject({
      scope: z.literal("user"),
      userId: z.string().uuid(),
      updates: z.array(singleLimitSchema).min(1).max(USAGE_CATEGORIES.length),
    }),
  ])
  .refine(
    (payload) => new Set(payload.updates.map((item) => item.category)).size === payload.updates.length,
    { message: "duplicate categories" },
  );

const privateJson = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

export function opsApi(
  resource: "usage" | "runs" | "detail" | "users",
  user: UserResolver = sessionUser,
) {
  return async (request: Request, id?: string) => {
    const account = await user(request.headers).catch(() => null);
    if (!account) return privateJson({ error: "unauthorized" }, 401);
    if (account.role !== "admin") return privateJson({ error: "forbidden" }, 403);
    try {
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!secret) throw new Error("Missing auth secret");
      const reader = new OpsReader(getSharedJourneyDatabase().pool, secret);
      const query = new URL(request.url).searchParams;
      if (resource === "runs") return privateJson(await reader.runs(query));
      if (resource === "users") return privateJson(await reader.users(query.get("day"), process.env));
      if (resource === "usage") {
        return privateJson({
          ...(await reader.usage(query)),
          fixed: fixedExpenses(process.env.FIXED_EXPENSE_FILE),
        });
      }
      const detail = await reader.detail(query.get("type") ?? "", id ?? "", query.get("day"));
      return detail ? privateJson(detail) : privateJson({ error: "not_found" }, 404);
    } catch {
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}

/** 站长动态调整全站或单个用户的每日调用上限（同源校验 + 原子事务写入账本表，立即生效）。 */
export function opsLimitsApi(user: UserResolver = sessionUser) {
  return async (request: Request) => {
    const account = await user(request.headers).catch(() => null);
    if (!account) return privateJson({ error: "unauthorized" }, 401);
    if (account.role !== "admin") return privateJson({ error: "forbidden" }, 403);
    if (!sameOrigin(request)) return privateJson({ error: "forbidden" }, 403);

    const rawBody = await readBody(request);
    if (rawBody === "too_large") return privateJson({ error: "too_large" }, 413);
    let parsed: z.infer<typeof limitsPatchSchema> | null = null;
    try {
      const result = limitsPatchSchema.safeParse(rawBody === "invalid" ? null : JSON.parse(rawBody));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return privateJson({ error: "invalid_request" }, 400);

    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) return privateJson({ error: "unavailable" }, 503);

    const pool = getSharedJourneyDatabase().pool;
    const client = await pool.connect().catch(() => null);
    if (!client) return privateJson({ error: "unavailable" }, 503);

    try {
      await client.query("BEGIN");
      if (parsed.scope === "user") {
        const exists = await client.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [
          parsed.userId,
        ]);
        if (exists.rows.length === 0) {
          await client.query("ROLLBACK");
          return privateJson({ error: "not_found" }, 404);
        }
        for (const item of parsed.updates) {
          if (item.limit === null) {
            await client.query("DELETE FROM usage_limits WHERE user_id = $1 AND category = $2", [
              parsed.userId,
              item.category,
            ]);
          } else {
            await client.query(
              `INSERT INTO usage_limits (user_id, category, daily_limit) VALUES ($1, $2, $3)
               ON CONFLICT (user_id, category) DO UPDATE SET daily_limit = EXCLUDED.daily_limit`,
              [parsed.userId, item.category, item.limit],
            );
          }
        }
      } else {
        const now = new Date();
        for (const item of parsed.updates) {
          if (item.limit === null) {
            await client.query("DELETE FROM site_usage_limits WHERE category = $1", [item.category]);
          } else {
            await client.query(
              `INSERT INTO site_usage_limits (category, daily_limit, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (category) DO UPDATE SET daily_limit = EXCLUDED.daily_limit, updated_at = EXCLUDED.updated_at`,
              [item.category, item.limit, now],
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      return privateJson({ error: "unavailable" }, 503);
    } finally {
      client.release();
    }

    try {
      const query = new URL(request.url).searchParams;
      const reader = new OpsReader(pool, secret);
      return privateJson(await reader.users(query.get("day"), process.env));
    } catch {
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}

const feedbackPatchSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(FEEDBACK_STATUSES),
});

function parseFeedbackStatusFilter(raw: string | null): "all" | FeedbackStatus {
  if (raw === "all" || raw === "open" || raw === "resolved") return raw;
  return "open";
}

function parseFeedbackCategoryFilter(raw: string | null): "all" | FeedbackCategory {
  if (raw && (FEEDBACK_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as FeedbackCategory;
  }
  return "all";
}

/** 站长查看受邀用户提交的反馈列表与待处理计数。 */
export function opsFeedbackGetApi(user: UserResolver = sessionUser) {
  return async (request: Request) => {
    const account = await user(request.headers).catch(() => null);
    if (!account) return privateJson({ error: "unauthorized" }, 401);
    if (account.role !== "admin") return privateJson({ error: "forbidden" }, 403);
    try {
      const query = new URL(request.url).searchParams;
      const store = new FeedbackStore(getSharedJourneyDatabase().pool);
      const list = await store.listForOps({
        status: parseFeedbackStatusFilter(query.get("status")),
        category: parseFeedbackCategoryFilter(query.get("category")),
        userId: query.get("userId"),
      });
      return privateJson(list);
    } catch {
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}

/** 站长更新单条用户反馈状态（标记已处理 / 重新打开）。 */
export function opsFeedbackPatchApi(user: UserResolver = sessionUser) {
  return async (request: Request) => {
    const account = await user(request.headers).catch(() => null);
    if (!account) return privateJson({ error: "unauthorized" }, 401);
    if (account.role !== "admin") return privateJson({ error: "forbidden" }, 403);
    if (!sameOrigin(request)) return privateJson({ error: "forbidden" }, 403);

    const rawBody = await readBody(request);
    if (rawBody === "too_large") return privateJson({ error: "too_large" }, 413);
    let parsed: z.infer<typeof feedbackPatchSchema> | null = null;
    try {
      const result = feedbackPatchSchema.safeParse(rawBody === "invalid" ? null : JSON.parse(rawBody));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return privateJson({ error: "invalid_request" }, 400);

    try {
      const store = new FeedbackStore(getSharedJourneyDatabase().pool);
      const updated = await store.updateStatus(parsed.id, parsed.status);
      if (!updated) return privateJson({ error: "not_found" }, 404);
      return privateJson(updated);
    } catch {
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
