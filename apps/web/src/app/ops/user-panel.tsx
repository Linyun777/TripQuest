"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Search,
  Shield,
  SlidersHorizontal,
  UserRound,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import { Sheet } from "../_ui/sheet";
import {
  beijingDate,
  beijingTime,
  money,
  name,
  statusTone,
  type SiteQuota,
  type UserOverview,
  type UsersSnapshot,
} from "./format";
import { buildUserQuotaRows, QuotaEditor } from "./quota-editor";

function InlineQuotaTracks({ user }: { user: UserOverview }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-5">
      {user.quotas.map((q) => {
        const pct =
          q.limit > 0
            ? Math.min(100, Math.round((q.used / q.limit) * 100))
            : q.used > 0
              ? 100
              : 0;
        const exhausted = q.effectiveRemaining === 0 && (q.limit > 0 || q.used > 0);
        return (
          <div key={q.category} className="min-w-0">
            <div className="flex items-baseline justify-between gap-1 text-[11px]">
              <span className="flex items-center gap-1 truncate text-ink-soft">
                <span>{name(q.category)}</span>
                {q.customLimit !== null && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-lake-600"
                    title="已自定义个人额度"
                  />
                )}
              </span>
              <span className="tabular font-medium text-ink">
                {q.used}
                <span className="font-normal text-ink-faint">/{q.limit}</span>
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-sunken">
              <div
                className={cn(
                  "h-full rounded-full",
                  exhausted
                    ? "bg-danger-600"
                    : q.cappedBySite || pct >= 80
                      ? "bg-sun-500"
                      : "bg-lake-500",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {q.cappedBySite && (
              <p className="mt-0.5 truncate text-[10px] font-medium text-sun-700 tabular">
                受全站限 · 剩 {q.effectiveRemaining}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SiteQuotaSummaryBar({
  site,
  day,
  onOpenSiteQuotas,
}: {
  site: readonly SiteQuota[];
  day: string;
  onOpenSiteQuotas: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/80 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold text-ink">全站日额度水位</h2>
          <span className="tabular text-xs text-ink-faint">{day}</span>
        </div>
        <button
          type="button"
          onClick={onOpenSiteQuotas}
          className="inline-flex items-center gap-1.5 rounded-full bg-lake-50 px-3 py-1 text-xs font-medium text-lake-700 transition-[background-color,transform] duration-150 hover:bg-lake-100/80 active:scale-[0.97]"
        >
          <SlidersHorizontal className="size-3.5" />
          <span>调整全站额度</span>
        </button>
      </div>

      <div className="grid grid-cols-2 divide-y divide-line/70 sm:grid-cols-5 sm:divide-x sm:divide-y-0">
        {site.map((item) => {
          const pct =
            item.limit !== null && item.limit > 0
              ? Math.min(100, Math.round((item.used / item.limit) * 100))
              : item.limit === 0
                ? 100
                : 0;
          const exhausted = item.remaining !== null && item.remaining === 0;
          return (
            <div
              key={item.category}
              className={cn("px-4 py-3", exhausted && "bg-danger-50/35")}
            >
              <div className="flex items-center justify-between gap-1 text-xs">
                <span className="text-ink-soft">{name(item.category)}</span>
                {item.customLimit !== null && (
                  <span className="text-[10px] font-medium text-lake-700">自定义</span>
                )}
              </div>
              <p className="mt-1 tabular text-base font-semibold text-ink">
                {item.used}
                <span className="text-xs font-normal text-ink-faint">
                  {" "}
                  / {item.limit === null ? "不限" : item.limit}
                </span>
              </p>
              {item.limit !== null && (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-sunken">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      exhausted ? "bg-danger-600" : pct >= 80 ? "bg-sun-500" : "bg-lake-500",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <p
                className={cn(
                  "mt-1 text-[11px] tabular",
                  exhausted ? "font-medium text-danger-600" : "text-ink-faint",
                )}
              >
                {item.remaining === null ? "未设上限" : `余 ${item.remaining}`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DirectorySkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-28 rounded-2xl border border-line bg-surface p-5">
        <div className="skeleton h-4 w-36 rounded-full" />
        <div className="mt-4 grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded-xl" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-3 p-5">
            <div className="flex items-center gap-3">
              <div className="skeleton size-10 rounded-2xl" />
              <div className="space-y-1.5">
                <div className="skeleton h-4 w-32 rounded-full" />
                <div className="skeleton h-3 w-48 rounded-full" />
              </div>
            </div>
            <div className="skeleton h-6 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsersDirectory({
  snapshot,
  day,
  onDayChange,
  onSelectUser,
  onSaved,
  onOpenSiteQuotas,
}: {
  snapshot: UsersSnapshot | undefined;
  day: string;
  onDayChange: (day: string) => void;
  onSelectUser: (user: UserOverview) => void;
  onSaved: (snapshot: UsersSnapshot) => void;
  onOpenSiteQuotas: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "failed" | "limited">("all");
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  if (!snapshot) return <DirectorySkeleton />;

  const keyword = search.trim().toLowerCase();
  const filtered = snapshot.users.filter((u) => {
    if (keyword) {
      const hay = `${u.displayUsername} ${u.username} ${u.code}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    if (filter === "running") return u.runs.running > 0;
    if (filter === "failed") return u.runs.failed30d > 0;
    if (filter === "limited") {
      return u.quotas.some((q) => (q.limit > 0 && q.effectiveRemaining === 0) || q.cappedBySite);
    }
    return true;
  });

  const activeCount = snapshot.users.filter((u) => u.runs.running > 0).length;
  const failedUsersCount = snapshot.users.filter((u) => u.runs.failed30d > 0).length;
  const editingUser = editingUserId
    ? snapshot.users.find((item) => item.id === editingUserId) ?? null
    : null;

  return (
    <div className="space-y-5">
      <SiteQuotaSummaryBar
        site={snapshot.site}
        day={snapshot.day}
        onOpenSiteQuotas={onOpenSiteQuotas}
      />

      {/* 扁平工具栏 */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:flex-initial">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              aria-label="搜索用户"
              type="search"
              placeholder="搜用户名或代号"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-full border border-line bg-surface pl-9 pr-3.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600 sm:w-52"
            />
          </div>

          <div className="no-scrollbar flex gap-1 overflow-x-auto">
            {(
              [
                { id: "all", label: `全部 ${snapshot.users.length}` },
                { id: "running", label: `运行中 ${activeCount}` },
                { id: "failed", label: `有失败 ${failedUsersCount}` },
                { id: "limited", label: "额度紧张" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFilter(opt.id)}
                className={cn(
                  "h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]",
                  filter === opt.id
                    ? "border-lake-600 bg-lake-600 text-white"
                    : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-ink-soft">
          <span>日期</span>
          <input
            aria-label="用户观测日期"
            type="date"
            value={day || snapshot.day}
            onChange={(e) => onDayChange(e.target.value)}
            className="h-9 rounded-full border border-line bg-surface px-3 text-sm text-ink tabular focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
          />
        </label>
      </div>

      {/* 单一账本列表容器：去掉卡片套卡片 */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/65 px-6 py-12 text-center">
          <Users className="mx-auto size-6 text-ink-faint" />
          <p className="mt-2 text-sm font-medium text-ink">没有符合条件的账号</p>
          <p className="mt-1 text-xs text-ink-faint">可以清空搜索词或切换筛选条件。</p>
        </div>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          {filtered.map((user) => {
            const hasRunning = user.runs.running > 0;
            const hasStale = user.runs.stale > 0;
            return (
              <article
                key={user.id}
                className={cn(
                  "px-4 py-4 transition-colors sm:px-5 sm:py-5",
                  hasStale && "bg-danger-50/35",
                  !hasStale && hasRunning && "bg-lake-50/30",
                )}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        "grid size-10 shrink-0 place-items-center rounded-2xl text-sm font-semibold",
                        user.role === "admin"
                          ? "bg-lake-600 text-white"
                          : "bg-sunken text-ink-soft",
                      )}
                    >
                      {user.role === "admin" ? (
                        <Shield className="size-4" />
                      ) : (
                        <UserRound className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-[15px] font-semibold text-ink">
                          {user.displayUsername}
                        </h3>
                        <span className="text-xs text-ink-faint">@{user.username}</span>
                        <Badge tone={user.role === "admin" ? "lake" : "neutral"}>
                          {user.role === "admin" ? "站长" : "受邀"}
                        </Badge>
                        {user.banned && <Badge tone="danger">已停用</Badge>}
                        {hasRunning && (
                          <Badge tone={hasStale ? "danger" : "rain"}>
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                hasStale ? "bg-danger-600" : "bg-rain-500 animate-pulse",
                              )}
                            />
                            {hasStale ? "心跳过期" : `运行中 ${user.runs.running}`}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-ink-faint tabular">
                        <span>代号 {user.code}</span>
                        <span>注册 {beijingDate(user.createdAt)}</span>
                        <span>
                          最近登录 {user.lastSignInAt ? beijingTime(user.lastSignInAt) : "暂无"}
                        </span>
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditingUserId(user.id)}
                    >
                      <SlidersHorizontal />
                      <span>调额度</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onSelectUser(user)}
                      className="text-ink hover:bg-sunken"
                    >
                      <span>详情</span>
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>

                {/* 扁平指标行：费用 + 执行概况 + 最近一次运行 */}
                <div className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-line/60 py-2.5 text-xs tabular">
                  <div>
                    <span className="text-ink-faint">
                      {snapshot.isToday ? "今日" : snapshot.day}费用{" "}
                    </span>
                    <strong className="font-semibold text-ink">{money(user.dayCost)}</strong>
                    <span className="ml-2 text-ink-faint">当月 {money(user.monthCost)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-ink-faint">30天运行</span>
                    <strong className="font-semibold text-ink">{user.runs.total30d} 次</strong>
                    {user.runs.failed30d > 0 && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-danger-600">
                        <XCircle className="size-3" />
                        失败 {user.runs.failed30d}
                      </span>
                    )}
                    {user.runs.fallback30d > 0 && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-sun-700">
                        <AlertTriangle className="size-3" />
                        降级 {user.runs.fallback30d}
                      </span>
                    )}
                    {user.runs.failed30d === 0 &&
                      user.runs.fallback30d === 0 &&
                      user.runs.total30d > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-lake-700">
                          <CheckCircle2 className="size-3" />
                          正常
                        </span>
                      )}
                  </div>

                  {user.runs.lastRunAt && user.runs.lastRunKind && user.runs.lastRunStatus && (
                    <div className="flex items-center gap-1.5 text-ink-soft">
                      <Clock className="size-3 text-ink-faint" />
                      <span>{name(user.runs.lastRunKind)}</span>
                      <Badge tone={statusTone(user.runs.lastRunStatus)}>
                        {name(user.runs.lastRunStatus)}
                      </Badge>
                      {user.runs.lastRunPhase && (
                        <span className="text-lake-700">{user.runs.lastRunPhase}</span>
                      )}
                      <span className="text-ink-faint">{beijingTime(user.runs.lastRunAt)}</span>
                    </div>
                  )}
                </div>

                {/* 无边框五类额度细条 */}
                <div className="mt-3">
                  <InlineQuotaTracks user={user} />
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 响应式调额抽屉：手机底部滑出、桌面右侧滑出 */}
      <Sheet
        open={editingUser !== null}
        onOpenChange={(open) => {
          if (!open) setEditingUserId(null);
        }}
        desktopSide
        title={editingUser ? `调整「${editingUser.displayUsername}」的额度` : "调整用户额度"}
        subtitle={
          editingUser
            ? `@${editingUser.username} · 修改仅作用于该账号，同时受全站上限约束`
            : undefined
        }
      >
        {editingUser && (
          <QuotaEditor
            key={`${editingUser.id}-${snapshot.day}`}
            scope="user"
            userId={editingUser.id}
            day={snapshot.day}
            hideHeader
            rows={buildUserQuotaRows(editingUser, snapshot.site)}
            onSaved={onSaved}
            onOpenSiteQuotas={() => {
              setEditingUserId(null);
              onOpenSiteQuotas();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}
