import { z } from "zod";
import { registerWithInvite } from "@tripquest/auth";
import { getSharedJourneyDatabase } from "@tripquest/db";
import { getAuth } from "../../auth/session";
import { readBody, sameOrigin } from "../planning/request-body";

export const runtime = "nodejs";

const schema = z.strictObject({
  inviteCode: z.string().trim().min(1).max(40),
  username: z.string().max(64),
  password: z.string().max(256),
});
const STATUS = { invite_unavailable: 403, username_taken: 409, invalid_username: 422, invalid_password: 422, unavailable: 503 } as const;

/**
 * POST /api/register：V2.12 邀请码注册（stages/V2.12.md §3.2）。成功即登录（带回会话 cookie）。
 * 邀请码无效、过期或已用统一回 invite_unavailable，不说是哪一种。
 */
export async function POST(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ status: "forbidden" }, { status: 403, headers });
  const body = await readBody(request, 4 * 1024);
  if (body === "too_large" || body === "invalid") return Response.json({ status: "invalid_request" }, { status: 400, headers });
  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(JSON.parse(body));
  } catch {
    return Response.json({ status: "invalid_request" }, { status: 400, headers });
  }
  try {
    const outcome = await registerWithInvite({ auth: getAuth(), pool: getSharedJourneyDatabase().pool, now: () => new Date() }, input);
    if (outcome.status !== "registered") return Response.json({ status: outcome.status }, { status: STATUS[outcome.status], headers });
    const reply = Response.json({ status: "registered" }, { status: 201, headers });
    for (const cookie of outcome.headers.getSetCookie()) reply.headers.append("set-cookie", cookie);
    return reply;
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
