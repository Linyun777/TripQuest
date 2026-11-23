"use client";

import { Check, CheckCircle2, Compass, Inbox, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { FeedbackCategory, FeedbackStatus, OpsFeedbackItem, OpsFeedbackList } from "@tripquest/db";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import { beijingTime } from "./format";

export type FeedbackStatusFilter = "open" | "resolved" | "all";
export type FeedbackCategoryFilter = "all" | FeedbackCategory;

const CATEGORY_META: Record<
  FeedbackCategory,
  { readonly label: string; readonly tone: "sun" | "danger" | "lake" | "neutral" }
> = {
  plan_issue: { label: "规划不准", tone: "sun" },
  ui_bug: { label: "页面问题", tone: "danger" },
  suggestion: { label: "功能建议", tone: "lake" },
  other: { label: "其他", tone: "neutral" },
};

const CATEGORY_FILTERS: readonly { readonly id: FeedbackCategoryFilter; readonly label: string }[] = [
  { id: "all", label: "全部类型" },
  { id: "plan_issue", label: "规划不准" },
  { id: "ui_bug", label: "页面问题" },
  { id: "suggestion", label: "功能建议" },
  { id: "other", label: "其他" },
];

export function FeedbackPanel({
  data,
  statusFilter,
  categoryFilter,
  onStatusFilterChange,
  onCategoryFilterChange,
  onUpdated,
  onInspectUser,
}: {
  data: OpsFeedbackList | undefined;
  statusFilter: FeedbackStatusFilter;
  categoryFilter: FeedbackCategoryFilter;
  onStatusFilterChange: (next: FeedbackStatusFilter) => void;
  onCategoryFilterChange: (next: FeedbackCategoryFilter) => void;
  onUpdated: (next: OpsFeedbackList) => void;
  onInspectUser?: (userId: string) => void;
}) {
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggleStatus(item: OpsFeedbackItem) {
    if (!data || updatingId) return;
    const nextStatus: FeedbackStatus = item.status === "open" ? "resolved" : "open";
    setUpdatingId(item.id);
    setActionError(null);
    try {
      const response = await fetch("/api/ops/feedback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, status: nextStatus }),
      });
      if (!response.ok) throw new Error();
      const updated = (await response.json()) as {
        id: string;
        status: FeedbackStatus;
        resolvedAt: string | null;
      };
      const deltaOpen = nextStatus === "resolved" ? -1 : 1;
      const nextItems = data.items
        .map((row) =>
          row.id === updated.id
            ? { ...row, status: updated.status, resolvedAt: updated.resolvedAt }
            : row,
        )
        .filter((row) => statusFilter === "all" || row.status === statusFilter);
      onUpdated({
        openCount: Math.max(0, data.openCount + deltaOpen),
        resolvedCount: Math.max(0, data.resolvedCount - deltaOpen),
        totalCount: data.totalCount,
        items: nextItems,
      });
    } catch {
      setActionError("更新反馈状态失败，请稍后重试。");
    } finally {
      setUpdatingId(null);
    }
  }

  const openCount = data?.openCount ?? 0;
  const resolvedCount = data?.resolvedCount ?? 0;
  const totalCount = data?.totalCount ?? 0;

  return (
    <section aria-labelledby="ops-feedback-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="ops-feedback-heading" className="text-lg font-semibold text-ink">
            用户反馈
          </h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            来自受邀账号的规划问题、页面异常与功能建议；账号注销时随其数据一并删除。
          </p>
        </div>

        <div
          role="group"
          aria-label="按处理状态筛选"
          className="glass-pill inline-flex w-fit items-center gap-1 rounded-full p-1"
        >
          {(
            [
              { id: "open", label: "待处理", count: openCount },
              { id: "resolved", label: "已处理", count: resolvedCount },
              { id: "all", label: "全部", count: totalCount },
            ] as const
          ).map((option) => {
            const active = statusFilter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => onStatusFilterChange(option.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-white/92 text-ink shadow-card ring-1 ring-ink/[0.06]"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                <span>{option.label}</span>
                <span
                  className={cn(
                    "tabular rounded-full px-1.5 py-0.5 text-[11px] leading-none",
                    active ? "bg-lake-50 text-lake-700" : "bg-paper/70 text-ink-faint",
                  )}
                >
                  {option.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按问题类型筛选">
        {CATEGORY_FILTERS.map((option) => {
          const active = categoryFilter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onCategoryFilterChange(option.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-lake-600/30 bg-lake-50 text-lake-700"
                  : "glass-pill text-ink-soft hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {actionError && (
        <p role="alert" className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-xs font-medium text-danger-600">
          {actionError}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {!data ? (
          <div className="divide-y divide-line">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="space-y-2.5 px-5 py-4">
                <div className="flex items-center gap-2">
                  <div className="skeleton h-5 w-16 rounded-full" />
                  <div className="skeleton h-4 w-28 rounded-full" />
                </div>
                <div className="skeleton h-4 w-5/6 rounded-full" />
                <div className="skeleton h-3 w-44 rounded-full" />
              </div>
            ))}
          </div>
        ) : data.items.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-sunken text-ink-faint">
              <Inbox className="size-5" />
            </span>
            <p className="mt-3 text-sm font-medium text-ink">
              {statusFilter === "open"
                ? "暂无待处理反馈"
                : statusFilter === "resolved"
                  ? "暂无已处理反馈"
                  : "还没有收到任何反馈"}
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              用户在「我的」、对话规划页或行程详情页提交后会自动出现在这里。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((item) => {
              const meta = CATEGORY_META[item.category];
              const isBusy = updatingId === item.id;
              return (
                <li key={item.id} className="px-5 py-4 transition-colors hover:bg-paper/45">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {item.status === "resolved" && (
                          <Badge tone="neutral">
                            <CheckCircle2 className="size-3" />
                            已处理
                          </Badge>
                        )}
                        {onInspectUser ? (
                          <button
                            type="button"
                            onClick={() => onInspectUser(item.userId)}
                            className="font-medium text-ink underline-offset-2 hover:text-lake-700 hover:underline"
                          >
                            {item.displayUsername}
                          </button>
                        ) : (
                          <span className="font-medium text-ink">{item.displayUsername}</span>
                        )}
                        <span className="text-ink-faint">@{item.username}</span>
                        <span className="tabular text-ink-faint">{beijingTime(item.createdAt)}</span>
                      </div>

                      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                        {item.content}
                      </p>

                      {(item.contextLabel || item.pagePath || item.resolvedAt) && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                          {item.contextLabel && (
                            <span className="inline-flex items-center gap-1 text-ink-soft">
                              <Compass className="size-3 text-ink-faint" />
                              {item.contextLabel}
                            </span>
                          )}
                          {item.pagePath && (
                            <code className="rounded bg-sunken/80 px-1.5 py-0.5 text-[11px] text-ink-soft">
                              {item.pagePath}
                            </code>
                          )}
                          {item.resolvedAt && (
                            <span className="tabular">处理于 {beijingTime(item.resolvedAt)}</span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center sm:pt-0.5">
                      {item.status === "open" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={isBusy}
                          onClick={() => void toggleStatus(item)}
                        >
                          <Check className="size-3.5 text-lake-600" />
                          <span>{isBusy ? "保存中…" : "标记已处理"}</span>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => void toggleStatus(item)}
                        >
                          <RotateCcw className="size-3.5" />
                          <span>{isBusy ? "保存中…" : "重新打开"}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
