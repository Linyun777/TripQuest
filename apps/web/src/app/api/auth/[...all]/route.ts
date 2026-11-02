import { toNextJsHandler } from "@tripquest/auth/next";
import { getAuth } from "../../../auth/session";

export const runtime = "nodejs";

/** V2.12 Better Auth 的接口：用户名登录、退出、会话、改密码（注册只走 /api/register）。 */
const handler = (request: Request) => toNextJsHandler(getAuth()).POST(request);
export const GET = (request: Request) => toNextJsHandler(getAuth()).GET(request);
export const POST = handler;
