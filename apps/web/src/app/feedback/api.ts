import { z } from "zod";
import { FEEDBACK_CATEGORIES, FeedbackStore, getSharedJourneyDatabase } from "@tripquest/db";
import { sessionUser, type UserResolver } from "../auth/session";
import { readBody, sameOrigin } from "../api/planning/request-body";

const optionalShortText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value.length > 0 ? value : null))
    .refine((value) => value === null || value.length <= max, { message: "too long" })
    .nullable()
    .optional();

const submitSchema = z.strictObject({
  category: z.enum(FEEDBACK_CATEGORIES),
  content: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length >= 2 && value.length <= 1000, {
      message: "content length out of range",
    }),
  pagePath: z
    .string()
    .transform((value) => {
      const cleaned = value.trim().split(/[?#]/, 1)[0] ?? "";
      return cleaned.length > 0 ? cleaned : null;
    })
    .refine((value) => value === null || (value.startsWith("/") && value.length <= 160), {
      message: "invalid page path",
    })
    .nullable()
    .optional(),
  contextLabel: optionalShortText(80),
  conversationId: z.string().uuid().nullable().optional(),
  journeyId: z.string().uuid().nullable().optional(),
});

const privateJson = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

/** 已登录受邀用户提交产品反馈（同源校验 + 严格字段约束 + 频率限流）。 */
export function submitFeedbackApi(
  user: UserResolver = sessionUser,
  now: () => number = Date.now,
) {
  return async (request: Request) => {
    const account = await user(request.headers).catch(() => null);
    if (!account) return privateJson({ error: "unauthorized" }, 401);
    if (!sameOrigin(request)) return privateJson({ error: "forbidden" }, 403);

    const rawBody = await readBody(request);
    if (rawBody === "too_large") return privateJson({ error: "too_large" }, 413);
    let parsed: z.infer<typeof submitSchema> | null = null;
    try {
      const result = submitSchema.safeParse(rawBody === "invalid" ? null : JSON.parse(rawBody));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return privateJson({ error: "invalid_request" }, 400);

    try {
      const store = new FeedbackStore(getSharedJourneyDatabase().pool, now);
      const outcome = await store.submit({
        userId: account.id,
        category: parsed.category,
        content: parsed.content,
        pagePath: parsed.pagePath ?? null,
        contextLabel: parsed.contextLabel ?? null,
        conversationId: parsed.conversationId ?? null,
        journeyId: parsed.journeyId ?? null,
      });
      if (outcome.status === "rate_limited") {
        return privateJson({ error: "rate_limited" }, 429);
      }
      return privateJson(outcome, 201);
    } catch {
      return privateJson({ error: "unavailable" }, 503);
    }
  };
}
