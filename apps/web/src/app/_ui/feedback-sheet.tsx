"use client";

import { CheckCircle2, ChevronRight, MessageSquarePlus, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Sheet } from "./sheet";

export type FeedbackCategory = "plan_issue" | "ui_bug" | "suggestion" | "other";

export interface FeedbackContext {
  readonly pagePath?: string;
  readonly contextLabel?: string;
  readonly conversationId?: string | null;
  readonly journeyId?: string | null;
}

const CATEGORIES: readonly {
  readonly id: FeedbackCategory;
  readonly label: string;
  readonly placeholder: string;
}[] = [
  {
    id: "plan_issue",
    label: "规划不准",
    placeholder: "比如：路线绕远了、推荐的店关门了、没理解我的时间或必去要求…",
  },
  {
    id: "ui_bug",
    label: "页面问题",
    placeholder: "比如：按钮点不动、手机上显示遮挡、刷新后丢状态…",
  },
  {
    id: "suggestion",
    label: "功能建议",
    placeholder: "希望增加什么小功能，或者哪一步用起来不够顺手？",
  },
  {
    id: "other",
    label: "其他",
    placeholder: "想对站长说什么都可以，写下你的想法…",
  },
];

const MAX_LENGTH = 1000;

export function FeedbackTrigger({
  variant,
  context,
  className,
}: {
  variant: "header" | "card";
  context: FeedbackContext;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="提交反馈"
          title="提交反馈"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink-soft",
            "transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink active:scale-[0.96]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600 sm:px-2.5",
            className,
          )}
        >
          <MessageSquarePlus className="size-4 text-ink-soft" />
          <span className="hidden sm:inline">反馈</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "glass-card group flex w-full items-center justify-between gap-4 rounded-[22px] px-4 py-4 text-left",
            "transition-[background-color,transform] duration-150 hover:bg-white/82 active:scale-[0.99]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            className,
          )}
        >
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lake-50 text-lake-600">
              <MessageSquarePlus className="size-4.5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">问题与建议</p>
              <p className="mt-0.5 text-xs text-ink-soft">
                规划不顺手、页面有小毛病或想要新功能，随时告诉站长
              </p>
            </div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5" />
        </button>
      )}

      <FeedbackSheet open={open} onOpenChange={setOpen} context={context} />
    </>
  );
}

function FeedbackSheet({
  open,
  onOpenChange,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: FeedbackContext;
}) {
  const [category, setCategory] = useState<FeedbackCategory>("plan_issue");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const selected = CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0]!;
  const trimmedLength = content.trim().length;
  const canSubmit = !submitting && trimmedLength >= 2 && trimmedLength <= MAX_LENGTH;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setError(null);
      if (submitted) {
        setSubmitted(false);
        setContent("");
      }
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      if (trimmedLength < 2) setError("请至少写两个字，方便站长定位问题。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const pagePath =
        context.pagePath ??
        (typeof window !== "undefined" ? window.location.pathname : undefined);
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          content: content.trim(),
          pagePath: pagePath ?? null,
          contextLabel: context.contextLabel ?? null,
          conversationId: context.conversationId ?? null,
          journeyId: context.journeyId ?? null,
        }),
      });
      if (response.ok) {
        setSubmitted(true);
        setContent("");
        return;
      }
      if (response.status === 429) {
        setError("提交太频繁了，请稍等一分钟再试。");
      } else if (response.status === 401) {
        setError("登录状态已过期，请刷新页面后重试。");
      } else if (response.status === 400 || response.status === 413) {
        setError("反馈内容需要在 2 到 1000 字之间。");
      } else {
        setError("提交暂时失败了，请稍后再试。");
      }
    } catch {
      setError("网络似乎断开了，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={handleOpenChange}
      title="提交反馈"
      subtitle="直接发给站长，用于持续改进规划体验"
      desktopSide
    >
      {submitted ? (
        <div className="flex flex-col items-center py-8 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-lake-50 text-lake-600">
            <CheckCircle2 className="size-6" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-ink">已收到你的反馈</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-6 text-ink-soft">
            谢谢帮忙一起打磨 TripQuest，站长会在观测后台尽快查看。
          </p>
          <div className="mt-6 flex items-center gap-2.5">
            <Button type="button" variant="secondary" size="sm" onClick={() => setSubmitted(false)}>
              再提一条
            </Button>
            <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
              完成
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5 pt-1">
          <fieldset>
            <legend className="text-xs font-medium text-ink-soft">问题类型</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CATEGORIES.map((item) => {
                const active = item.id === category;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategory(item.id)}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm font-medium transition-colors duration-150 active:scale-[0.98]",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
                      active
                        ? "border-lake-600/30 bg-lake-50 text-lake-700"
                        : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="feedback-content" className="text-xs font-medium text-ink-soft">
                具体说明
              </label>
              <span
                className={cn(
                  "tabular text-xs",
                  trimmedLength > MAX_LENGTH ? "font-medium text-danger-600" : "text-ink-faint",
                )}
              >
                {trimmedLength} / {MAX_LENGTH}
              </span>
            </div>
            <textarea
              id="feedback-content"
              rows={5}
              maxLength={MAX_LENGTH + 50}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                if (error) setError(null);
              }}
              placeholder={selected.placeholder}
              className={cn(
                "mt-2 w-full resize-y rounded-2xl border border-line bg-surface px-3.5 py-3 text-sm leading-6 text-ink placeholder:text-ink-faint",
                "transition-colors focus:border-lake-600 focus:outline-none focus:ring-2 focus:ring-lake-600/15",
              )}
            />
          </div>

          {context.contextLabel && (
            <p className="rounded-xl bg-sunken/70 px-3.5 py-2.5 text-xs leading-5 text-ink-soft">
              将自动附带当前来源：<span className="font-medium text-ink">{context.contextLabel}</span>
              ，仅用于定位页面与上下文，不会采集额外定位信息。
            </p>
          )}

          {error && (
            <p role="alert" className="rounded-xl bg-danger-50 px-3.5 py-2.5 text-xs font-medium text-danger-600">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              <Send className="size-3.5" />
              <span>{submitting ? "提交中…" : "发送反馈"}</span>
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
