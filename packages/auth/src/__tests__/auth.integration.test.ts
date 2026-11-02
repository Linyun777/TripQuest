import { fileURLToPath } from "node:url";
import { createJourneyDatabase, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth, type Auth } from "../auth";
import { createInvite } from "../invites";
import { registerWithInvite } from "../register";

const BASE = "http://localhost:3999";
const NOW = new Date("2026-10-27T10:00:00Z");

/**
 * V2.12 账号（stages/V2.12.md §5）：只测我们写的（邀请码注册）和我们的配置是否生效（关掉的接口、改密码撤销
 * 其他会话、cookie 与 Bearer、登录限流、停用），不重复测 Better Auth 本身。
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("V2.12 sign-up with an invite, sessions and limits", () => {
  const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let client: JourneyDatabaseClient;
  let auth: Auth;
  const register = (inviteCode: string, username: string, password = "correct-horse-1") =>
    registerWithInvite({ auth, pool: client.pool, now: () => NOW }, { inviteCode, username, password });
  const http = (path: string, init: { body?: unknown; headers?: Record<string, string>; method?: string } = {}) =>
    auth.handler(new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { origin: BASE, "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
  const cookieOf = (headers: Headers) => headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
  const signIn = async (username: string, password = "correct-horse-1") => {
    const response = await http("/sign-in/username", { body: { username, password } });
    return { status: response.status, cookie: cookieOf(response.headers), token: response.headers.get("set-auth-token") };
  };
  const whoAmI = async (headers: Record<string, string>) => {
    const response = await http("/get-session", { headers });
    const body = await response.json() as { user?: { username?: string } } | null;
    return body?.user?.username ?? null;
  };

  beforeAll(async () => {
    client = createJourneyDatabase(url, { applicationName: "tripquest-v212-auth-test", maxConnections: 4 });
    await migrateJourneyDatabase(client.database, { migrationsFolder: fileURLToPath(new URL("../../../db/drizzle", import.meta.url)) });
    auth = createAuth({ database: client.database, secret: "s".repeat(40), baseURL: BASE, rateLimit: true });
  });
  beforeEach(async () => {
    await client.pool.query("DELETE FROM users WHERE username LIKE 'test\\_%'");
    await client.pool.query("DELETE FROM invites");
    await client.pool.query("DELETE FROM rate_limits");
  });
  afterAll(async () => {
    await client?.pool.query("DELETE FROM users WHERE username LIKE 'test\\_%'");
    await client?.pool.query("DELETE FROM invites");
    await client?.close();
  });

  it("an invite works once; a used, expired or unknown code gets the same answer", async () => {
    const { code } = await createInvite(client.pool, { createdBy: null, now: NOW });
    const first = await register(code.toLowerCase().replace(/-/g, " "), "test_ann");
    expect(first.status).toBe("registered");
    if (first.status !== "registered") throw new Error("register");
    expect(cookieOf(first.headers)).toMatch(/tripquest\.session_token=/);
    expect(await register(code, "test_bob")).toEqual({ status: "invite_unavailable" });
    expect(await register("AAAA-BBBB-CCCC", "test_bob")).toEqual({ status: "invite_unavailable" });
    const old = await createInvite(client.pool, { createdBy: null, days: 1, now: new Date(NOW.getTime() - 2 * 86_400_000) });
    expect(await register(old.code, "test_bob")).toEqual({ status: "invite_unavailable" });
    // 邮箱是不对外的占位地址，用户名保留原样大小写作显示名。
    const { rows } = await client.pool.query("SELECT email, username, display_username, role FROM users WHERE id = $1", [first.userId]);
    expect(rows[0]).toMatchObject({ username: "test_ann", display_username: "test_ann", role: "user" });
    expect(rows[0].email).toMatch(/^[0-9a-f-]{36}@users\.invalid$/);
    const { rows: used } = await client.pool.query("SELECT used_by FROM invites WHERE used_at IS NOT NULL");
    expect(used).toEqual([{ used_by: first.userId }]);
  });

  it("two sign-ups with one code at the same time: only one account, and a taken name gives the code back", async () => {
    const { code } = await createInvite(client.pool, { createdBy: null, now: NOW });
    const results = await Promise.all([register(code, "test_cat"), register(code, "test_dan"), register(code, "test_eve")]);
    expect(results.filter((result) => result.status === "registered")).toHaveLength(1);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM users WHERE username IN ('test_cat','test_dan','test_eve')")).rows[0].n).toBe(1);

    const taken = results.find((result) => result.status === "registered")!;
    const name = (await client.pool.query("SELECT username FROM users WHERE id = $1", [(taken as { userId: string }).userId])).rows[0].username;
    const next = await createInvite(client.pool, { createdBy: null, now: NOW });
    expect(await register(next.code, name.toUpperCase())).toEqual({ status: "username_taken" });
    expect((await register(next.code, "test_fay")).status).toBe("registered");
  });

  it("closes sign-up without an invite and the email endpoints over HTTP", async () => {
    for (const path of ["/sign-up/email", "/sign-in/email", "/request-password-reset", "/admin/list-users"]) {
      const response = await http(path, { body: { email: "x@example.com", password: "correct-horse-1", name: "x" } });
      expect(response.status, path).toBe(404);
    }
  });

  it("cookie and Bearer both carry the session; changing the password signs other sessions out", async () => {
    const { code } = await createInvite(client.pool, { createdBy: null, now: NOW });
    await register(code, "test_gus");
    expect((await signIn("test_gus", "wrong-password")).status).toBe(401);
    const laptop = await signIn("test_gus");
    const phone = await signIn("test_gus");
    expect(laptop.status).toBe(200);
    expect(phone.token).toBeTruthy();
    expect(await whoAmI({ cookie: laptop.cookie })).toBe("test_gus");
    expect(await whoAmI({ authorization: `Bearer ${phone.token}` })).toBe("test_gus");

    const changed = await http("/change-password", {
      headers: { cookie: laptop.cookie },
      body: { currentPassword: "correct-horse-1", newPassword: "new-horse-battery-2", revokeOtherSessions: true },
    });
    expect(changed.status).toBe(200);
    expect(await whoAmI({ authorization: `Bearer ${phone.token}` })).toBeNull();
    expect((await signIn("test_gus")).status).toBe(401);
    expect((await signIn("test_gus", "new-horse-battery-2")).status).toBe(200);

    const out = await signIn("test_gus", "new-horse-battery-2");
    await http("/sign-out", { headers: { cookie: out.cookie }, body: {} });
    expect(await whoAmI({ cookie: out.cookie })).toBeNull();
  });

  it("limits sign-in attempts, and a disabled account cannot sign in", async () => {
    const { code } = await createInvite(client.pool, { createdBy: null, now: NOW });
    await register(code, "test_hal");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await signIn("test_hal", "wrong-password")).status);
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);

    await client.pool.query("DELETE FROM rate_limits");
    await client.pool.query("UPDATE users SET banned = true WHERE username = 'test_hal'");
    expect((await signIn("test_hal")).status).toBe(403);
  });
});
