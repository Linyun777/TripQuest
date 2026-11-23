import { Activity, ChevronRight, Shield, UserRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getSharedJourneyDatabase, UsageLedger, type UsageToday } from "@tripquest/db";
import { OWNER_USERNAME } from "@tripquest/auth";
import { AppShell } from "../_ui/app-shell";
import { Badge } from "../_ui/badge";
import { FeedbackTrigger } from "../_ui/feedback-sheet";
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
  const { rows } = await pool.query<{ created_at: Date }>(
    "SELECT created_at FROM users WHERE id = $1",
    [userId],
  );
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
      <AppShell
        active="account"
        user={user}
        maxWidth="max-w-3xl"
        desktopHeaderRight={<SignOutButton />}
        mobileHeaderRight={<SignOutButton />}
      >
        <main className="mx-auto max-w-3xl space-y-8 px-4 pt-6 sm:px-8 md:pt-8">
          <section className="flex items-center gap-3.5">
            <span className="morandi-cta grid size-12 shrink-0 place-items-center rounded-2xl text-white">
              {user.role === "admin" ? (
                <Shield className="size-5" />
              ) : (
                <UserRound className="size-5" />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold text-ink">
                  {user.displayUsername}
                </h1>
                <Badge tone={user.role === "admin" ? "lake" : "neutral"}>
                  {user.role === "admin" ? "站长" : "受邀账号"}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-ink-soft tabular">
                @{user.username}
                {createdAt && (
                  <> · {createdAt.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 注册</>
                )}
              </p>
            </div>
          </section>

          {user.role === "admin" && (
            <Link
              href="/ops"
              className="glass-card group flex items-center justify-between gap-4 rounded-[22px] px-4 py-4 transition-[background-color,transform] duration-150 hover:bg-white/82 active:scale-[0.99]"
            >
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lake-50 text-lake-600">
                  <Activity className="size-4.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">费用与运行</p>
                  <p className="mt-0.5 text-xs text-ink-soft">
                    按用户观测用量与运行轨迹 · 动态调整全站与个人额度
                  </p>
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
          )}

          <section>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">今天的用量</h2>
              <span className="text-xs text-ink-faint">北京时间零点清零</span>
            </div>
            {usage === null ? (
              <p className="mt-3 text-sm text-sun-700">现在读不到用量，请稍后刷新。</p>
            ) : (
              <dl className="glass-card mt-3 divide-y divide-ink/[0.06] overflow-hidden rounded-[22px]">
                {usage
                  .filter((item) => item.limit > 0)
                  .map((item) => {
                    const pct = Math.min(100, Math.round((item.used / item.limit) * 100));
                    const high = pct >= 85;
                    return (
                      <div key={item.category} className="px-4 py-3.5">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <dt className="text-ink-soft">{CATEGORY_LABEL[item.category]}</dt>
                          <dd className="tabular font-medium text-ink">
                            {item.used}
                            <span className="font-normal text-ink-faint"> / {item.limit}</span>
                          </dd>
                        </div>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                          <div
                            className={`h-full rounded-full ${high ? "bg-sun-500" : "bg-lake-500"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </dl>
            )}
            <p className="mt-2 text-xs text-ink-faint">
              用完了会提示“明天再试”，不影响其他账号。
            </p>
          </section>

          <section aria-label="问题与建议">
            <FeedbackTrigger
              variant="card"
              context={{ pagePath: "/account", contextLabel: "我的账号" }}
            />
          </section>

          <section className="glass-card rounded-[22px] p-5">
            <h2 className="mb-3 text-base font-semibold text-ink">改密码</h2>
            <ChangePasswordForm />
          </section>

          <section className="glass-card rounded-[22px] p-5">
            <h2 className="mb-1.5 text-base font-semibold text-ink">删除我的全部数据</h2>
            {user.username === OWNER_USERNAME ? (
              <p className="text-sm leading-6 text-ink-soft">
                拥有者账号不能在这里删除（它持有原来的本机数据）。需要时用命令行处理。
              </p>
            ) : (
              <DeleteAccountForm />
            )}
          </section>
        </main>
      </AppShell>
    </div>
  );
}
