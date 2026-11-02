import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  chinaDay,
  createJourneyDatabase,
  setUserDailyLimit,
  USAGE_CATEGORIES,
  usageByUser,
  type UsageCategory,
} from "@tripquest/db";
import { createAuth, PASSWORD_MAX, PASSWORD_MIN } from "./auth";
import { createInvite } from "./invites";
import { OWNER_USERNAME } from "./account";

/**
 * V2.12 拥有者的命令行（stages/V2.12.md §3.7）：pnpm users <命令>。默认连 DATABASE_URL（开发库），--test 连
 * TEST_DATABASE_URL；开头只打印库名，不打印地址和密码。写操作要确认（--yes 跳过）。
 * 管理员插件的接口在脚本里要管理员会话，所以这里用库自己的服务端方法（改密码、清会话、停用）和同一个密码哈希。
 */
const USAGE = `用法：pnpm users <命令> [--test] [--yes]
  invite [--days 7]                     生成一个邀请码（只显示这一次）
  list                                  用户、状态、注册与最后登录时间、今天的用量
  set-password <用户名>                 重置密码（交互输入），并让这个用户所有设备退出
  disable <用户名> | enable <用户名>     停用 / 恢复账号（停用时所有设备退出）
  limit <用户名> <类别> <次数>           调某人的每日上限（类别：${USAGE_CATEGORIES.join("、")}）
  import-usage                          把旧的本机用量文件 eval-results/local-usage.jsonl 导入数据库（记在拥有者名下，评测的记录不导）`;

const root = resolve(import.meta.dirname, "../../..");
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && args[index - 1] === "--days"));
const [command, ...rest] = positional;

async function confirm(question: string): Promise<boolean> {
  if (flag("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question}（y/N）`);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

/** 不是终端时（管道输入）一次读完，按行取。 */
let piped: Promise<string[]> | undefined;
async function pipedLine(): Promise<string> {
  piped ??= (async () => {
    const lines: string[] = [];
    for await (const line of createInterface({ input: process.stdin })) lines.push(line);
    return lines;
  })();
  return (await piped).shift() ?? "";
}

/** 不回显地读一行（密码不进命令行历史，也不显示在终端上）。 */
async function secret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const line = await pipedLine();
    process.stdout.write("\n");
    return line;
  }
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((done) => {
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          done(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (!command || flag("--help")) {
    console.log(USAGE);
    return;
  }
  const url = flag("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(flag("--test") ? "TEST_DATABASE_URL is not set" : "DATABASE_URL is not set");
  console.log(`数据库：${new URL(url).pathname.slice(1)}`);
  const client = createJourneyDatabase(url, { applicationName: "tripquest-users-cli", maxConnections: 2 });
  const auth = createAuth({
    database: client.database,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  });
  const findUser = async (username: string | undefined) => {
    if (!username) throw new Error("缺少用户名");
    const { rows } = await client.pool.query<{ id: string; username: string; banned: boolean | null }>(
      "SELECT id, username, banned FROM users WHERE username = $1",
      [username.trim().toLowerCase()],
    );
    if (!rows[0]) throw new Error(`没有用户 ${username}`);
    return rows[0];
  };
  try {
    switch (command) {
      case "invite": {
        const days = option("--days") ? Number(option("--days")) : undefined;
        if (!(await confirm(`生成一个${days ?? 7}天有效的邀请码？`))) return;
        const owner = (await client.pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [OWNER_USERNAME])).rows[0];
        const invite = await createInvite(client.pool, { createdBy: owner?.id ?? null, ...(days ? { days } : {}), now: new Date() });
        console.log(`邀请码：${invite.code}（${invite.expiresAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 前有效，只显示这一次）`);
        return;
      }
      case "list": {
        const { rows } = await client.pool.query<{ id: string; username: string; role: string | null; banned: boolean | null; created_at: Date; last_login: Date | null }>(
          `SELECT u.id, u.username, u.role, u.banned, u.created_at, max(s.created_at) AS last_login
             FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.created_at`,
        );
        const usage = await usageByUser(client.pool, chinaDay(Date.now()), process.env);
        const time = (value: Date | null) => (value ? value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—");
        for (const row of rows) {
          const today = usage.find((item) => item.userId === row.id)?.categories
            .filter((item) => item.used > 0 || item.limit > 0)
            .map((item) => `${item.category} ${item.used}/${item.limit}`).join("，") ?? "";
          console.log(`${row.username}${row.role === "admin" ? "（拥有者）" : ""}  ${row.banned ? "已停用" : "正常"}  注册 ${time(row.created_at)}  最后登录 ${time(row.last_login)}\n    今天：${today}`);
        }
        return;
      }
      case "set-password": {
        const user = await findUser(rest[0]);
        const password = await secret(`${user.username} 的新密码：`);
        if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new Error(`密码要 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`);
        if (password !== (await secret("再输一次："))) throw new Error("两次输入不一样");
        if (!(await confirm(`重置 ${user.username} 的密码并让他所有设备退出？`))) return;
        const context = await auth.$context;
        const hash = await context.password.hash(password);
        const accounts = await context.internalAdapter.findAccounts(user.id);
        if (accounts.some((account) => account.providerId === "credential")) await context.internalAdapter.updatePassword(user.id, hash);
        else await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
        await context.internalAdapter.deleteUserSessions(user.id);
        console.log("已重置。");
        return;
      }
      case "disable":
      case "enable": {
        const user = await findUser(rest[0]);
        if (user.username === OWNER_USERNAME && command === "disable") throw new Error("不能停用拥有者");
        if (!(await confirm(`${command === "disable" ? "停用" : "恢复"} ${user.username}？`))) return;
        const context = await auth.$context;
        await context.internalAdapter.updateUser(user.id, command === "disable"
          ? { banned: true, banReason: "disabled by owner" }
          : { banned: false, banReason: null, banExpires: null });
        if (command === "disable") await context.internalAdapter.deleteUserSessions(user.id);
        console.log(command === "disable" ? "已停用，所有设备已退出。" : "已恢复。");
        return;
      }
      case "limit": {
        const user = await findUser(rest[0]);
        const category = rest[1] as UsageCategory;
        const limit = Number(rest[2]);
        if (!USAGE_CATEGORIES.includes(category)) throw new Error(`类别只能是 ${USAGE_CATEGORIES.join("、")}`);
        if (!(await confirm(`把 ${user.username} 每天的 ${category} 上限设为 ${limit}？`))) return;
        await setUserDailyLimit(client.pool, user.id, category, limit);
        console.log("已设置。");
        return;
      }
      case "import-usage": {
        const file = resolve(root, "eval-results/local-usage.jsonl");
        if (!existsSync(file)) {
          console.log("没有旧的用量文件，跳过。");
          return;
        }
        // 评测也往这个文件记自己的预算（purpose 以 eval 开头），那不是谁的用量，不导入；评测之后照旧写它自己的。
        const entries = readFileSync(file, "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as { day: string; pool: string; kind: string; purpose: string; at: string })
          .filter((entry) => !entry.purpose.startsWith("eval"));
        if (!(await confirm(`导入 ${entries.length} 条旧用量记录到拥有者名下？`))) return;
        const owner = await findUser(OWNER_USERNAME);
        for (const entry of entries) {
          if (!USAGE_CATEGORIES.includes(entry.pool as UsageCategory)) continue;
          await client.pool.query(
            "INSERT INTO usage_events (user_id, day, category, kind, purpose, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [owner.id, entry.day, entry.pool, entry.kind.slice(0, 40), entry.purpose.slice(0, 40), new Date(entry.at)],
          );
        }
        renameSync(file, resolve(root, "eval-results/local-usage.imported.jsonl"));
        console.log("已导入；原文件改名为 local-usage.imported.jsonl（网页不再写它，评测会另起一份记自己的预算）。");
        return;
      }
      default:
        console.log(USAGE);
        process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  // 不打印连接串、密码或驱动的原始信息。
  console.error(error instanceof Error && !/postgres|password|connect/i.test(error.message) ? error.message : "操作失败。");
  process.exitCode = 1;
});
