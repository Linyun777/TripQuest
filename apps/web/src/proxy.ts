import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "@tripquest/auth/cookies";

/**
 * V2.12（stages/V2.12.md §3.3）：页面没有会话 cookie 就去登录页。这里只是乐观的跳转（Next 文档要求 proxy
 * 不做完整的会话检查）；真正的检查在每个接口和服务端页面里（app/auth/session.ts）。接口不在这里拦，由接口回 401。
 */
const PUBLIC = ["/login", "/register"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (getSessionCookie(request, { cookiePrefix: "tripquest" })) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // 接口、静态资源、地图样式代理和图标不经过这里。
  matcher: ["/((?!api/|_next/|_AMapService/|favicon.ico|icon|apple-icon|.*\\.(?:png|svg|jpg|ico|webmanifest)$).*)"],
};
