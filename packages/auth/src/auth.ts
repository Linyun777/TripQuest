import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { admin, bearer, username } from "better-auth/plugins";
import type { JourneyDatabase } from "@tripquest/db";

/**
 * V2.12 账号与会话（stages/V2.12.md §3.1、§3.3）：用 Better Auth，不自己写认证。用户名 + 密码登录（用户名插件），
 * 网页用 cookie、以后的客户端用 Bearer 令牌，停用和角色用管理员插件的字段，登录限流存数据库。
 * 注册只走我们的邀请码接口（register.ts）：HTTP 上的 /sign-up/email 关掉，服务端调用不受影响。
 * 邮箱由注册接口填不对外的占位地址，不开邮箱登录、找回密码、验证邮箱这些接口。
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 24;

/** 字母、数字、下划线、点和汉字（库默认只允许前四种）。 */
export const USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_.]+$/u;

/** 对外不开放的接口：邮箱注册和登录、找回密码、邮箱验证与修改，管理员插件的全部接口（拥有者只用命令行）。 */
const CLOSED_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/is-username-available",
  "/admin/set-role",
  "/admin/get-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/list-users",
  "/admin/list-user-sessions",
  "/admin/unban-user",
  "/admin/ban-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
];

export interface AuthOptions {
  readonly database: JourneyDatabase;
  /** BETTER_AUTH_SECRET：签名 cookie 用，至少 32 个字符。 */
  readonly secret: string;
  /** 网站地址（BETTER_AUTH_URL），也是允许的来源。 */
  readonly baseURL: string;
  /** 登录、注册限流（开发时缺省关闭，测试里打开验证）。 */
  readonly rateLimit?: boolean;
}

export function createAuth(options: AuthOptions) {
  if (options.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  return betterAuth({
    appName: "TripQuest",
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [options.baseURL],
    database: drizzleAdapter(options.database, { provider: "pg", schema: authTables(options.database) }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      autoSignIn: true,
      // 改密码时撤销其他会话（§3.6）。
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    disabledPaths: CLOSED_PATHS,
    rateLimit: {
      enabled: options.rateLimit ?? false,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "tripquest",
      database: { generateId: "uuid" },
    },
    telemetry: { enabled: false },
    logger: { level: "error" },
    plugins: [
      username({
        minUsernameLength: USERNAME_MIN,
        maxUsernameLength: USERNAME_MAX,
        usernameValidator: (value) => USERNAME_PATTERN.test(value),
      }),
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** 库的模型名 → 我们的 Drizzle 表（表名、列名是我们的风格，属性名是库的字段名）。 */
function authTables(database: JourneyDatabase) {
  const tables = database._.fullSchema;
  return {
    user: tables.users,
    session: tables.sessions,
    account: tables.accounts,
    verification: tables.verifications,
    rateLimit: tables.rateLimits,
  };
}
