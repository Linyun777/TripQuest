import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getSharedJourneyDatabase, UsageLedger, type UsageToday } from "@tripquest/db";
import { OWNER_USERNAME } from "@tripquest/auth";
import { pageUser } from "../auth/session";
import { ChangePasswordForm, DeleteAccountForm, SignOutButton } from "./account-actions";

export const runtime = "nodejs";
export const metadata: Metadata = { title: "我的账号 · TripQuest" };

const CATEGORY_LABEL: Record<UsageToday["category"], string> = {
  model: "规划和对话",
  amap: "地图查询",
  web: "联网搜索",
  embed: "资料库",
  jev: "Jev 判断",
};

async function readAccount(userId: string) {
  const pool = getSharedJourneyDatabase().pool;
  const { rows } = await pool.query<{ created_at: Date }>("SELECT created_at FROM users WHERE id = $1", [userId]);
  const usage = await new UsageLedger(pool, userId).today().catch(() => null);
  return { createdAt: rows[0]?.created_at ?? null, usage };
}

/** V2.12 我的账号（stages/V2.12.md §3.6）：用户名、注册时间、今天的用量，改密码、退出、删除全部数据。 */
export default async function AccountPage() {
  await connection();
  const user = await pageUser("/account");
  const { createdAt, usage } = await readAccount(user.id);
  return (
    <div className="min-h-dvh bg-paper">
      <div className="mx-auto max-w-2xl px-4 sm:px-8">
        <header className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5" aria-label="返回 TripQuest 首页">
            <span className="grid size-9 place-items-center rounded-xl bg-lake-600 text-xs font-bold text-white">TQ</span>
            <span className="font-semibold tracking-tight">TripQuest</span>
          </Link>
          <SignOutButton />
        </header>
        <main className="grid gap-10 pb-16 pt-4">
          <section>
            <h1 className="text-2xl font-semibold tracking-tight">{user.displayUsername}</h1>
            <p className="mt-2 text-sm text-ink-soft">
              用户名 {user.username}
              {createdAt && <> · {createdAt.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 注册</>}
            </p>
          </section>
          <section>
            <h2 className="text-base font-semibold">今天的用量</h2>
            {usage === null
              ? <p className="mt-3 text-sm text-sun-700">现在读不到用量，请稍后刷新。</p>
              : (
                <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                  {usage.filter((item) => item.limit > 0).map((item) => (
                    <div key={item.category} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-sm">
                      <dt className="text-ink-soft">{CATEGORY_LABEL[item.category]}</dt>
                      <dd className="tabular-nums">{item.used} / {item.limit}</dd>
                    </div>
                  ))}
                </dl>
              )}
            <p className="mt-2 text-xs text-ink-faint">每天零点（北京时间）重新计。用完了会提示“明天再试”，不影响别人。</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold">改密码</h2>
            <ChangePasswordForm />
          </section>
          <section>
            <h2 className="mb-1 text-base font-semibold">删除我的全部数据</h2>
            {user.username === OWNER_USERNAME
              ? <p className="text-sm text-ink-soft">拥有者账号不能在这里删除（它持有原来的本机数据）。需要时用命令行处理。</p>
              : <DeleteAccountForm />}
          </section>
        </main>
      </div>
    </div>
  );
}
