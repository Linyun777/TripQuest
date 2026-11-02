import { z } from "zod";
import { deleteAccount } from "@tripquest/auth";
import { getSharedJourneyDatabase } from "@tripquest/db";
import { getAuth, withUser } from "../../auth/session";
import { readBody, sameOrigin } from "../planning/request-body";

export const runtime = "nodejs";

const STATUS = { deleted: 200, wrong_password: 403, owner_protected: 409, not_found: 404 } as const;

/**
 * DELETE /api/account {password}：V2.12 删除我的全部数据（stages/V2.12.md §3.6）。要输入密码；账号和对话、行程、
 * 出游、偏好、决策记录、用量一起删除，不可恢复，然后退出。拥有者不能在页面上删除自己。
 */
export const DELETE = withUser({}, async (request, user): Promise<Response> => {
  const headers = { "cache-control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ status: "forbidden" }, { status: 403, headers });
  const body = await readBody(request, 2 * 1024);
  let password: string;
  try {
    password = z.strictObject({ password: z.string().min(1).max(256) }).parse(JSON.parse(body === "too_large" || body === "invalid" ? "null" : body)).password;
  } catch {
    return Response.json({ status: "invalid_request" }, { status: 400, headers });
  }
  try {
    const result = await deleteAccount({ auth: getAuth(), pool: getSharedJourneyDatabase().pool }, { userId: user.id, password });
    const reply = Response.json({ status: result }, { status: STATUS[result], headers });
    if (result === "deleted") {
      // 会话已随账号删除；把这个浏览器上本站的认证 cookie 也作废。
      for (const name of (request.headers.get("cookie") ?? "").split(";").map((item) => item.split("=")[0]!.trim())) {
        if (name.startsWith("tripquest.") || name.startsWith("__Secure-tripquest.")) {
          reply.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
        }
      }
    }
    return reply;
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
});
