import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth, type Auth } from "@tripquest/auth";
import { getSharedJourneyDatabase } from "@tripquest/db";

/**
 * V2.12 当前用户（stages/V2.12.md §3.3）：每个接口和服务端页面从会话拿用户，往下传；不接受请求里自带的用户 id。
 * 拦截（src/proxy.ts）只负责没登录时跳到登录页；这里才是真正的检查。网页用 cookie，以后的客户端用 Bearer 令牌。
 */
export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly displayUsername: string;
  readonly role: "admin" | "user";
}

/** 测试里换成固定用户；缺省按 Better Auth 的会话。 */
export type UserResolver = (requestHeaders: Headers) => Promise<SessionUser | null>;

const shared = globalThis as typeof globalThis & { __tripquestAuth?: Auth };

/** 一个进程一个实例（开发时模块热重载也复用）。缺少密钥或地址时直接报错，不带着默认值上线。 */
export function getAuth(environment: NodeJS.ProcessEnv = process.env): Auth {
  if (shared.__tripquestAuth) return shared.__tripquestAuth;
  const secret = environment.BETTER_AUTH_SECRET ?? "";
  const baseURL = environment.BETTER_AUTH_URL ?? "";
  if (!baseURL) throw new Error("BETTER_AUTH_URL is not set");
  shared.__tripquestAuth = createAuth({
    database: getSharedJourneyDatabase().database,
    secret,
    baseURL,
    rateLimit: environment.AUTH_RATE_LIMIT === "true" || environment.NODE_ENV === "production",
  });
  return shared.__tripquestAuth;
}

export const sessionUser: UserResolver = async (requestHeaders) => {
  const session = await getAuth().api.getSession({ headers: requestHeaders }).catch(() => null);
  const user = session?.user as { id: string; username?: string | null; displayUsername?: string | null; role?: string | null; banned?: boolean | null } | undefined;
  if (!user?.id || !user.username || user.banned) return null;
  return {
    id: user.id,
    username: user.username,
    displayUsername: user.displayUsername || user.username,
    role: user.role === "admin" ? "admin" : "user",
  };
};

/** 服务端页面：没登录就去登录页（登录后回到原来的地址）。 */
export async function pageUser(path: string): Promise<SessionUser> {
  const user = await sessionUser(await headers());
  if (!user) redirect(`/login?next=${encodeURIComponent(path)}`);
  return user;
}

const unauthorized = () =>
  Response.json({ status: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });

/**
 * 接口：拿到当前用户再执行，没登录返回 401。处理器选项里的 user 用于测试注入。
 * 按 id 访问别人的数据由仓库按用户过滤，结果和不存在一样（404），见 packages/db。
 */
export function withUser<Context = undefined>(
  options: { readonly user?: UserResolver },
  handler: (request: Request, user: SessionUser, context: Context) => Promise<Response>,
): (request: Request, ...context: Context extends undefined ? [] : [context: Context]) => Promise<Response> {
  const resolve = options.user ?? sessionUser;
  return async (request, ...context) => {
    const user = await resolve(request.headers).catch(() => null);
    if (!user) return unauthorized();
    return handler(request, user, context[0] as Context);
  };
}

/** 处理器的选项加上可注入的当前用户（测试用）。 */
export type WithUser<T> = T & { readonly user?: UserResolver };
