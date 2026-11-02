import { randomUUID } from "node:crypto";
import type { JourneyDatabaseClient } from "@tripquest/db";
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, USERNAME_PATTERN, type Auth } from "./auth";
import { claimInvite, completeInvite, releaseInvite } from "./invites";

/**
 * V2.12 邀请码注册（stages/V2.12.md §3.2；与设计不同之处见“结果”的第 1 步核对）：HTTP 上关掉了库的
 * /sign-up/email，只能走这里。先原子占用邀请码，再在服务端调库的注册（填不对外的占位邮箱），失败释放邀请码，
 * 成功写上使用者并把会话 cookie 带回去（注册成功即登录）。
 */
export type RegisterOutcome =
  | { readonly status: "registered"; readonly userId: string; readonly headers: Headers }
  | { readonly status: "invite_unavailable" | "username_taken" | "invalid_username" | "invalid_password" | "unavailable" };

export async function registerWithInvite(
  dependencies: { readonly auth: Auth; readonly pool: JourneyDatabaseClient["pool"]; readonly now: () => Date },
  input: { readonly inviteCode: string; readonly username: string; readonly password: string },
): Promise<RegisterOutcome> {
  const username = input.username.trim();
  if ([...username].length < USERNAME_MIN || [...username].length > USERNAME_MAX || !USERNAME_PATTERN.test(username)) {
    return { status: "invalid_username" };
  }
  if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) return { status: "invalid_password" };
  const inviteId = await claimInvite(dependencies.pool, input.inviteCode, dependencies.now());
  if (!inviteId) return { status: "invite_unavailable" };
  try {
    const { headers, response } = await dependencies.auth.api.signUpEmail({
      body: { email: `${randomUUID()}@users.invalid`, name: username, password: input.password, username, displayUsername: username },
      returnHeaders: true,
    });
    await completeInvite(dependencies.pool, inviteId, response.user.id, dependencies.now());
    return { status: "registered", userId: response.user.id, headers };
  } catch (error) {
    await releaseInvite(dependencies.pool, inviteId).catch(() => {});
    const code = (error as { body?: { code?: string } }).body?.code;
    if (code === "USERNAME_IS_ALREADY_TAKEN") return { status: "username_taken" };
    if (code === "INVALID_USERNAME" || code === "USERNAME_TOO_SHORT" || code === "USERNAME_TOO_LONG") return { status: "invalid_username" };
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") return { status: "invalid_password" };
    return { status: "unavailable" };
  }
}
