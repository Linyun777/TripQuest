"use client";

import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FilterX,
  Gauge,
  GitBranch,
  Globe,
  MapPin,
  MessageSquareText,
  Receipt,
  RefreshCw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { OpsFeedbackList, OpsReader } from "@tripquest/db";
import { Badge } from "../_ui/badge";
import { BrandMark } from "../_ui/brand";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import { EASE_OUT, SPRING_BOUNCY } from "../_ui/motion";
import type { fixedExpenses } from "../deployment/fixed-expenses";
import {
  beijingDate,
  beijingTime,
  codeTone,
  duration,
  money,
  name,
  statusTone,
  stepTone,
  trimAmount,
  type Cost,
  type Detail,
  type Lists,
  type UserOverview,
  type UsersSnapshot,
} from "./format";
import {
  FeedbackPanel,
  type FeedbackCategoryFilter,
  type FeedbackStatusFilter,
} from "./feedback-panel";
import { buildUserQuotaRows, QuotaEditor } from "./quota-editor";
import { UsersDirectory } from "./user-panel";

export { money };

type Overview = Awaited<ReturnType<OpsReader["usage"]>> & {
  fixed: ReturnType<typeof fixedExpenses>;
};

type OpsTab = "users" | "site_quotas" | "overview" | "feedback";

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "done":
    case "ok":
      return <CheckCircle2 className="size-3.5" />;
    case "failed":
    case "budget_exhausted":
      return <XCircle className="size-3.5" />;
    case "running":
      return <span className="size-2 rounded-full bg-rain-500 animate-pulse" aria-hidden="true" />;
    case "fallback":
    case "interrupted":
      return <AlertTriangle className="size-3.5" />;
    default:
      return <Clock className="size-3.5" />;
  }
}

function StepIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "model_call":
      return <Cpu className="size-3" />;
    case "tool_call":
      return <Globe className="size-3" />;
    case "repair":
      return <Wrench className="size-3" />;
    case "check":
      return <ShieldCheck className="size-3" />;
    case "handoff":
      return <GitBranch className="size-3" />;
    default:
      return <Activity className="size-3" />;
  }
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "model":
      return <Cpu className="size-4 text-lake-600" />;
    case "amap":
      return <MapPin className="size-4 text-sun-700" />;
    case "web":
      return <Globe className="size-4 text-rain-500" />;
    case "embed":
      return <Database className="size-4 text-ink-soft" />;
    default:
      return <Zap className="size-4 text-sun-500" />;
  }
}

function CostAmountDisplay({ cost, emptyLabel = "暂无计价样本" }: { cost: Cost; emptyLabel?: string }) {
  const entries = Object.entries(cost.amounts);
  if (entries.length === 0 && cost.pending === 0) {
    return <p className="text-base font-medium text-ink-faint">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-1">
      {entries.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {entries.map(([currency, value]) => (
            <span key={currency} className="inline-flex items-baseline gap-1.5">
              <span className="text-xs font-medium text-ink-faint">{currency}</span>
              <span className="tabular font-heading text-2xl font-semibold text-ink sm:text-3xl">
                {value}
              </span>
            </span>
          ))}
        </div>
      ) : (
        <p className="font-heading text-xl font-semibold text-sun-700">费用待核对</p>
      )}
      {cost.pending > 0 && <Badge tone="sun">{cost.pending} 笔待核对</Badge>}
    </div>
  );
}

function useRead<T>(path: string | null) {
  const [data, setData] = useState<{ path: string; value: T; at: string }>();
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let busy = false;

    async function refresh() {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const response = await fetch(path!, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const value: T = await response.json();
        if (!controller.signal.aborted) {
          setData({ path: path!, value, at: new Date().toLocaleTimeString("zh-CN") });
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        busy = false;
      }
    }

    void refresh();
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [path]);

  function replace(value: T) {
    if (!path) return;
    setData({ path, value, at: new Date().toLocaleTimeString("zh-CN") });
    setError(false);
  }

  return {
    data: data?.path === path ? data.value : undefined,
    at: data?.path === path ? data.at : null,
    error,
    replace,
  };
}

function OpsHeader({
  at,
  backHref,
  backLabel,
  onBack,
}: {
  at: string | null;
  backHref?: string;
  backLabel: string;
  onBack?: () => void;
}) {
  return (
    <header className="glass-bar sticky top-0 z-20 pt-[env(safe-area-inset-top)] transition-colors duration-200">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-8 md:h-[60px]">
        <div className="flex min-w-0 items-center gap-2.5">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-soft transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
            >
              <ArrowLeft className="size-4" />
              <span className="truncate">{backLabel}</span>
            </button>
          ) : (
            <Link
              href={backHref ?? "/account"}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-soft transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
            >
              <ArrowLeft className="size-4" />
              <span>{backLabel}</span>
            </Link>
          )}
          <span className="hidden h-3.5 w-px bg-ink/10 sm:block" aria-hidden="true" />
          <Link href="/" className="hidden items-center gap-2 sm:flex" aria-label="返回 TripQuest 首页">
            <BrandMark size="sm" />
            <span className="text-sm font-semibold tracking-tight text-ink">TripQuest</span>
          </Link>
        </div>

        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink/[0.08] bg-surface/65 px-2.5 py-1 text-xs text-ink-soft backdrop-blur-sm"
          title="每 5 秒自动刷新，页面隐藏时暂停"
        >
          <span className="size-1.5 rounded-full bg-lake-500" aria-hidden="true" />
          <RefreshCw className="size-3 text-ink-faint" />
          <span className="tabular">{at ?? "同步中"}</span>
        </span>
      </div>
    </header>
  );
}

function CallReceiptCard({ call }: { call: Detail["calls"][number] }) {
  const hitRate =
    call.tokens && call.tokens.input > 0 && call.tokens.hit !== null
      ? Math.round((call.tokens.hit / call.tokens.input) * 100)
      : null;

  return (
    <div className="mt-2 rounded-xl bg-sunken/65 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink-soft">{name(call.category)}</span>
          {(call.provider || call.model) && (
            <span className="font-medium text-ink">
              {[call.provider, call.model].filter(Boolean).join(" / ")}
            </span>
          )}
        </div>
        <span
          className={cn(
            "tabular font-semibold",
            call.amount === null ? "text-sun-700" : "text-lake-700",
          )}
        >
          {call.amount === null
            ? name(call.status)
            : `${call.currency} ${trimAmount(call.amount)}`}
        </span>
      </div>

      {call.tokens && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-soft tabular">
          <span>输入 {call.tokens.input.toLocaleString("zh-CN")}</span>
          <span>输出 {call.tokens.output.toLocaleString("zh-CN")}</span>
          <span>
            命中 {call.tokens.hit !== null ? call.tokens.hit.toLocaleString("zh-CN") : "未知"}
            {hitRate !== null && hitRate > 0 && (
              <span className="ml-1 font-medium text-lake-700">({hitRate}%)</span>
            )}
          </span>
          <span>
            未命中 {call.tokens.miss !== null ? call.tokens.miss.toLocaleString("zh-CN") : "未返回"}
          </span>
        </div>
      )}

      {call.rates && (
        <p className="mt-1 text-[11px] text-ink-faint tabular">
          每百万 token（{call.currency}） ·{" "}
          {call.rates.input !== null
            ? "输入 " + call.rates.input
            : "命中 " + call.rates.hit + " / 未命中 " + call.rates.miss}{" "}
          / 输出 {call.rates.output} · 生效于 {beijingTime(call.rates.from)}
        </p>
      )}
    </div>
  );
}

export function RunDetails({ d }: { d: Detail }) {
  const measured = d.steps.filter((s) => s.ms !== null);
  const slowest = measured.reduce<(typeof measured)[number] | undefined>(
    (longest, step) => (!longest || step.ms! > longest.ms! ? step : longest),
    undefined,
  );
  const maxStepMs = slowest?.ms && slowest.ms > 0 ? slowest.ms : 0;
  const stepId = (run: string, seq: number) => `step-${run}-${seq}`;
  const callSteps = new Map(d.steps.filter((s) => s.event).map((s) => [s.event, s]));
  const missing = d.calls.filter((c) => !d.steps.some((s) => s.event === c.id));
  const repairCount = d.steps.filter((s) => s.kind === "repair").length;

  const nodeView = (parent: string | null, depth: number): React.ReactNode => {
    const children = d.nodes.filter((n) => n.parent === parent);
    if (children.length === 0) return null;

    return children.map((n) => {
      const nodeSteps = d.steps.filter((s) => s.run === n.id);
      const hasSubNodes = d.nodes.some((child) => child.parent === n.id);

      return (
        <li
          key={n.id}
          className={cn(
            "relative",
            depth > 0 && "ml-3 border-l border-line pl-3.5 sm:ml-5 sm:pl-5",
          )}
        >
          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 bg-paper/50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Bot className="size-4 text-lake-600" />
                <strong className="text-sm font-semibold text-ink">{name(n.agent)}</strong>
                <Badge tone={statusTone(n.status)}>
                  <StatusIcon status={n.status} />
                  {name(n.status)}
                </Badge>
                {n.outcome && n.outcome !== "其他" && (
                  <Badge tone="neutral">{name(n.outcome)}</Badge>
                )}
              </div>
              {n.elapsed !== null && (
                <span className="tabular inline-flex items-center gap-1 text-xs font-medium text-ink-soft">
                  <Clock className="size-3 text-ink-faint" />
                  {duration(n.elapsed)}
                </span>
              )}
            </div>

            {nodeSteps.length > 0 && (
              <div className="divide-y divide-line/60">
                {nodeSteps.map((s) => {
                  const isSlowest = slowest?.run === s.run && slowest?.seq === s.seq;
                  const barPct =
                    s.ms !== null && maxStepMs > 0
                      ? Math.max(4, Math.min(100, Math.round((s.ms / maxStepMs) * 100)))
                      : 0;
                  const linkedCalls = d.calls.filter((c) => c.id === s.event);

                  return (
                    <div
                      key={s.seq}
                      id={stepId(s.run, s.seq)}
                      className={cn(
                        "scroll-mt-20 px-4 py-3 transition-colors target:bg-sun-50/80",
                        isSlowest && "bg-sun-50/45",
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="tabular text-xs font-medium text-ink-faint">
                            #{s.seq}
                          </span>
                          <Badge tone={stepTone(s.kind)}>
                            <StepIcon kind={s.kind} />
                            {name(s.kind)}
                          </Badge>
                          <span className="text-sm font-medium text-ink">{name(s.action)}</span>
                          {s.code && <Badge tone={codeTone(s.code)}>{name(s.code)}</Badge>}
                          {isSlowest && <Badge tone="sun">最慢</Badge>}
                        </div>

                        {s.ms !== null && (
                          <div className="flex shrink-0 items-center gap-2">
                            {maxStepMs > 0 && (
                              <span
                                className="hidden h-1 w-16 overflow-hidden rounded-full bg-sunken sm:block"
                                aria-hidden="true"
                              >
                                <span
                                  className={cn(
                                    "block h-full rounded-full",
                                    isSlowest ? "bg-sun-500" : "bg-lake-500/70",
                                  )}
                                  style={{ width: `${barPct}%` }}
                                />
                              </span>
                            )}
                            <span
                              className={cn(
                                "tabular text-xs font-medium",
                                isSlowest ? "text-sun-700" : "text-ink-soft",
                              )}
                            >
                              {duration(s.ms)}
                            </span>
                          </div>
                        )}
                      </div>

                      {s.kind === "repair" &&
                        (s.repair ? (
                          <div className="mt-2 rounded-xl bg-sun-50/80 px-3 py-2 text-xs text-sun-700">
                            <p className="font-medium">
                              本次修复涉及 {s.repair.events.length} 笔模型调用 ·{" "}
                              <span className="tabular font-semibold">{money(s.repair.cost)}</span>
                              （已计入总额）
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {s.repair.events.map((id) => {
                                const targetStep = callSteps.get(id);
                                if (!targetStep) return null;
                                const agent = d.nodes.find((node) => node.id === targetStep.run);
                                return (
                                  <a
                                    key={id}
                                    href={"#" + stepId(targetStep.run, targetStep.seq)}
                                    className="inline-flex items-center rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-sun-700 underline decoration-sun-500/50 underline-offset-2 transition-colors hover:bg-sun-100/50"
                                  >
                                    {agent && name(agent.agent)} #{targetStep.seq}
                                  </a>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-1.5 text-xs text-ink-faint">无已关联模型回执</p>
                        ))}

                      {linkedCalls.map((c) => (
                        <CallReceiptCard key={c.id} call={c} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {hasSubNodes && <ul className="mt-3 space-y-3">{nodeView(n.id, depth + 1)}</ul>}
        </li>
      );
    });
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{name(d.kind)}</Badge>
            <Badge tone={statusTone(d.status)}>
              <StatusIcon status={d.status} />
              {name(d.status)}
            </Badge>
            {d.simulated && <Badge tone="sun">含模拟步骤</Badge>}
            {d.stale && <Badge tone="danger">心跳过期</Badge>}
            <span className="ml-auto text-xs text-ink-faint tabular">受邀者 {d.user}</span>
          </div>

          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs text-ink-soft">本次规划费用（估算）</p>
              <h1 className="mt-1 font-heading text-2xl font-semibold text-ink sm:text-3xl tabular">
                {d.simulated && (
                  <span className="mr-1.5 text-base font-normal text-sun-700">含模拟步骤 ·</span>
                )}
                {d.root ? money(d.cost) : "等待关联"}
              </h1>
              {d.selectedDay && (
                <p className="mt-1 text-xs text-ink-soft tabular">
                  所选日期贡献 · {money(d.selectedDay)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs tabular">
              <div>
                <p className="text-ink-faint">墙钟耗时</p>
                <p className="mt-0.5 font-semibold text-ink">{duration(d.elapsed)}</p>
              </div>
              <div>
                <p className="text-ink-faint">执行规模</p>
                <p className="mt-0.5 font-semibold text-ink">
                  {d.nodes.length} 节点 · {d.steps.length} 步 · {d.calls.length} 调用
                </p>
              </div>
              {repairCount > 0 && (
                <div>
                  <p className="text-sun-700">自动修复</p>
                  <p className="mt-0.5 font-semibold text-sun-700">{repairCount} 次</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft tabular">
            <span>开始于 {beijingTime(d.started)}</span>
            {(d.status === "interrupted" || d.status === "running") && (
              <span>
                最近阶段 · <strong className="font-medium text-ink">{d.phase}</strong>
              </span>
            )}
            {d.status === "running" && d.heartbeat && (
              <span>
                {d.stale ? "最后心跳（已过期）" : "最后心跳"} {beijingTime(d.heartbeat)}
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-line/80 bg-paper/55 px-5 py-3 sm:px-6">
          {slowest ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink [&_a]:font-medium [&_a]:text-sun-700 [&_a]:decoration-sun-500/60 [&_a]:underline-offset-2 [&_a]:hover:text-ink">
              <Gauge className="size-4 shrink-0 text-sun-700" />
              <p className="tabular">
                已计时步骤中最慢 ·{" "}
                <a className="underline" href={"#" + stepId(slowest.run, slowest.seq)}>
                  {name(d.nodes.find((n) => n.id === slowest.run)?.agent ?? "其他")} #{slowest.seq} ·{" "}
                  {name(slowest.kind)} · {name(slowest.action)} · {duration(slowest.ms)}
                </a>
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-faint">
              <Gauge className="size-4" />
              暂无步骤耗时记录
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="trace-tree-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="trace-tree-heading" className="text-lg font-semibold text-ink">
            Agent 执行树
          </h2>
          <span className="text-xs text-ink-faint">按开始时间与步骤序号排列</span>
        </div>

        {d.nodes.length > 0 ? (
          <ul className="space-y-3">{nodeView(null, 0)}</ul>
        ) : (
          <div className="rounded-2xl border border-line bg-surface px-5 py-8 text-center text-sm text-ink-faint">
            暂无可展示的 Agent 节点记录。
          </div>
        )}
      </section>

      {missing.length > 0 && (
        <section className="rounded-2xl border border-sun-500/40 bg-sun-50/50 p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-sun-700">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              未关联步骤
              {missing.some((c) => c.category === "model") && " · 轨迹不完整"}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            以下调用已计入总账，但缺少对应的步骤轨迹记录。
          </p>
          <div className="mt-3 space-y-2">
            {missing.map((c) => (
              <CallReceiptCard key={c.id} call={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RunsListSection({
  title,
  subtitle,
  runs,
  error,
  status,
  seconds,
  cursor,
  onStatusChange,
  onSecondsChange,
  onCursorChange,
  onSelectRun,
  userLabels,
}: {
  title: string;
  subtitle: string;
  runs: Lists | undefined;
  error: boolean;
  status: string;
  seconds: string;
  cursor: string;
  onStatusChange: (value: string) => void;
  onSecondsChange: (value: string) => void;
  onCursorChange: (value: string) => void;
  onSelectRun: (run: Lists["runs"][number]) => void;
  userLabels?: ReadonlyMap<string, string>;
}) {
  const hasRunFilters = Boolean(status || seconds);

  return (
    <section aria-labelledby="runs-list-heading" className="space-y-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="runs-list-heading" className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="运行结果"
            value={status}
            onChange={(e) => {
              onCursorChange("");
              onStatusChange(e.target.value);
            }}
            className="h-9 rounded-full border border-line bg-surface px-3.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
          >
            <option value="">全部结果</option>
            {["running", "failed", "fallback", "none", "interrupted"].map((k) => (
              <option key={k} value={k}>
                {name(k)}
              </option>
            ))}
          </select>

          <label className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-ink-soft">
            <span>至少</span>
            <input
              type="number"
              min="0"
              placeholder="0"
              value={seconds}
              onChange={(e) => {
                onCursorChange("");
                onSecondsChange(e.target.value);
              }}
              className="tabular w-12 bg-transparent text-center text-ink outline-none"
            />
            <span>秒</span>
          </label>

          {hasRunFilters && (
            <button
              type="button"
              onClick={() => {
                onStatusChange("");
                onSecondsChange("");
                onCursorChange("");
              }}
              className="text-xs font-medium text-lake-700 hover:underline"
            >
              重置
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        {runs ? (
          runs.runs.length > 0 ? (
            <div className="divide-y divide-line">
              {runs.runs.map((r) => {
                const isRunning = r.status === "running";
                const resolvedUser = userLabels?.get(r.user);
                return (
                  <article
                    key={r.id}
                    className={cn(
                      "transition-colors hover:bg-paper/70",
                      isRunning && !r.stale && "bg-lake-50/35",
                      r.stale && "bg-danger-50/40",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectRun(r)}
                      className="group flex w-full flex-col gap-2 px-4 py-3.5 text-left active:bg-sunken/60 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-lake-600 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">{name(r.kind)}</span>
                          <Badge tone={statusTone(r.status)}>
                            <StatusIcon status={r.status} />
                            {name(r.status)}
                          </Badge>
                          <span className="tabular inline-flex items-center gap-1 text-xs text-ink-soft">
                            <Clock className="size-3 text-ink-faint" />
                            {duration(r.elapsed)}
                          </span>
                          {r.simulated && <Badge tone="sun">含模拟步骤</Badge>}
                          {r.stale && <Badge tone="danger">心跳过期</Badge>}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint tabular">
                          <span>
                            {resolvedUser ? `${resolvedUser} (${r.user})` : `受邀者 ${r.user}`}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{beijingTime(r.started)}</span>
                          {r.status === "interrupted" && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-sun-700">中断于 {r.phase}</span>
                            </>
                          )}
                          {isRunning && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-lake-700">{r.phase}</span>
                              <span aria-hidden="true">·</span>
                              <span className={r.stale ? "font-medium text-danger-600" : undefined}>
                                {r.stale ? "心跳过期" : "心跳"}{" "}
                                {r.heartbeat ? beijingTime(r.heartbeat) : "—"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center justify-between gap-3 pt-1 sm:pt-0">
                        <div className="sm:text-right">
                          <p className="text-[11px] text-ink-faint">估算费用</p>
                          <p className="text-sm font-semibold text-ink tabular">
                            {r.root ? money(r.cost) : "等待关联"}
                          </p>
                        </div>
                        <ChevronRight className="size-4 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-lake-700" />
                      </div>
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <p className="text-sm font-medium text-ink">没有符合条件的运行记录</p>
              <p className="mt-1 text-xs text-ink-faint">可以放宽筛选条件，或等待新任务发起。</p>
            </div>
          )
        ) : (
          !error && (
            <div className="divide-y divide-line">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="space-y-2">
                    <div className="skeleton h-4 w-40 rounded-full" />
                    <div className="skeleton h-3 w-56 rounded-full" />
                  </div>
                  <div className="skeleton h-5 w-20 rounded-full" />
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {(cursor || runs?.next) && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <div>
            {cursor && (
              <Button type="button" size="sm" variant="secondary" onClick={() => onCursorChange("")}>
                返回首页
              </Button>
            )}
          </div>
          <div>
            {runs?.next && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onCursorChange(runs.next!)}
              >
                下一页
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SevenDayCard({
  days,
  selectedDate,
  onSelectDate,
}: {
  days: Overview["days"];
  selectedDate: string;
  onSelectDate: (day: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card lg:col-span-7">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-ink">近七天（北京时间）</h3>
        {selectedDate && (
          <button
            type="button"
            onClick={() => onSelectDate("")}
            className="text-xs font-medium text-lake-700 hover:underline"
          >
            查看全部日期
          </button>
        )}
      </div>

      <div className="mt-3.5 divide-y divide-line/60">
        {days.map((d) => {
          const active = selectedDate === d.day;
          const currencies = Object.entries(d.amounts);
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => onSelectDate(active ? "" : d.day)}
              className={cn(
                "w-full px-2.5 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600",
                active ? "bg-lake-50/75" : "hover:bg-paper/65",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
                <span className={cn("tabular font-medium", active ? "text-lake-700" : "text-ink")}>
                  {d.day}
                </span>
                <span className="tabular text-ink-soft">{money(d)}</span>
              </div>
              {currencies.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {currencies.map(([k, v]) => {
                    const maxVal = Math.max(
                      ...days.map((x) => Number(x.amounts[k] ?? 0)),
                      0.00000000000001,
                    );
                    const pct = Math.max(
                      3,
                      Math.min(100, Math.round((Number(v) / maxVal) * 100)),
                    );
                    return (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-8 text-[11px] font-medium text-ink-faint">{k}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-300 ease-(--ease-out)",
                              active ? "bg-lake-700" : "bg-lake-500",
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <meter className="sr-only" aria-label={k} value={Number(v)} max={maxVal} />
                      </div>
                    );
                  })}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UserDetailView({
  user,
  snapshot,
  day,
  onBack,
  onSelectRun,
  onSaved,
  onOpenSiteQuotas,
}: {
  user: UserOverview;
  snapshot: UsersSnapshot;
  day: string;
  onBack: () => void;
  onSelectRun: (run: Lists["runs"][number]) => void;
  onSaved: (snapshot: UsersSnapshot) => void;
  onOpenSiteQuotas: () => void;
}) {
  const [date, setDate] = useState(day);
  const [status, setStatus] = useState("");
  const [seconds, setSeconds] = useState("");
  const [cursor, setCursor] = useState("");

  const userUsage = useRead<Overview>(
    "/api/ops/usage?" + new URLSearchParams({ userId: user.id, day: date }),
  );
  const userRuns = useRead<Lists>(
    "/api/ops/runs?" +
      new URLSearchParams({ userId: user.id, status, seconds, after: cursor, day: date }),
  );

  const u = userUsage.data;

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <OpsHeader at={userRuns.at ?? userUsage.at} backLabel="返回用户列表" onBack={onBack} />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 pb-20 sm:px-8">
        {(userUsage.error || userRuns.error) && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-2xl border border-danger-600/30 bg-danger-50 px-4 py-3 text-sm font-medium text-danger-600"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span>数据暂不可用</span>
          </div>
        )}

        {/* 扁平用户总览带 */}
        <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-center gap-3.5 px-5 py-5 sm:px-6">
            <span
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-2xl text-base font-semibold",
                user.role === "admin" ? "bg-lake-600 text-white" : "bg-sunken text-ink-soft",
              )}
            >
              {user.role === "admin" ? (
                <Shield className="size-5" />
              ) : (
                <UserRound className="size-5" />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-ink">{user.displayUsername}</h1>
                <Badge tone={user.role === "admin" ? "lake" : "neutral"}>
                  {user.role === "admin" ? "站长" : "受邀"}
                </Badge>
                {user.banned && <Badge tone="danger">已停用</Badge>}
                {user.runs.running > 0 && (
                  <Badge tone={user.runs.stale > 0 ? "danger" : "rain"}>
                    {user.runs.stale > 0 ? "心跳过期" : `运行中 ${user.runs.running}`}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-ink-soft tabular">
                @{user.username} · 代号 {user.code} · 注册 {beijingDate(user.createdAt)} · 最近登录{" "}
                {user.lastSignInAt ? beijingTime(user.lastSignInAt) : "暂无"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 divide-y divide-line/80 border-t border-line/80 bg-paper/45 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <div className="px-5 py-3.5">
              <p className="text-xs text-ink-faint">
                {snapshot.isToday ? "今日" : snapshot.day} API 估算
              </p>
              <p className="mt-1 text-base font-semibold text-ink tabular">{money(user.dayCost)}</p>
            </div>
            <div className="px-5 py-3.5">
              <p className="text-xs text-ink-faint">本月 API 估算</p>
              <p className="mt-1 text-base font-semibold text-ink tabular">{money(user.monthCost)}</p>
            </div>
            <div className="px-5 py-3.5">
              <p className="text-xs text-ink-faint">近 30 天运行</p>
              <p className="mt-1 text-base font-semibold text-ink tabular">
                {user.runs.total30d} 次
                <span className="ml-1.5 text-xs font-normal text-ink-faint">
                  （当日 {user.runs.dayTotal}）
                </span>
              </p>
            </div>
            <div className="px-5 py-3.5">
              <p className="text-xs text-ink-faint">异常统计（30 天）</p>
              <p className="mt-1 text-base font-semibold tabular">
                <span className={user.runs.failed30d > 0 ? "text-danger-600" : "text-ink"}>
                  失败 {user.runs.failed30d}
                </span>
                <span className="mx-1.5 text-ink-faint">/</span>
                <span className={user.runs.fallback30d > 0 ? "text-sun-700" : "text-ink-soft"}>
                  降级 {user.runs.fallback30d}
                </span>
              </p>
            </div>
          </div>
        </section>

        <QuotaEditor
          key={`${user.id}-${snapshot.day}`}
          scope="user"
          userId={user.id}
          day={snapshot.day}
          title={`「${user.displayUsername}」的每日额度`}
          subtitle="可单独提高、收紧或设为 0 暂停；如受全站上限约束，会直接提示全站剩余量"
          rows={buildUserQuotaRows(user, snapshot.site)}
          onSaved={onSaved}
          onOpenSiteQuotas={onOpenSiteQuotas}
        />

        {u && (
          <div className="grid gap-4 lg:grid-cols-12">
            <SevenDayCard
              days={u.days}
              selectedDate={date}
              onSelectDate={(nextDay) => {
                setDate(nextDay);
                setCursor("");
              }}
            />

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-card lg:col-span-5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">
                  {date || snapshot.day} 模型与任务
                </h3>
                <span className="text-xs text-ink-faint">仅该用户</span>
              </div>
              {u.groups.length > 0 ? (
                <div className="mt-3 divide-y divide-line/70">
                  {u.groups.map((g, i) => (
                    <div key={i} className="py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink">
                          {[g.provider, g.model].filter(Boolean).join(" / ") || "未记录"}
                        </span>
                        <span className="font-semibold text-lake-700 tabular">{money(g)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-ink-faint tabular">
                        <Badge tone="neutral">{name(g.kind ?? "其他")}</Badge>
                        <span>{g.roots} 次</span>
                        {g.average !== null && (
                          <span>
                            均值 {g.average} {g.currency ?? ""}（{g.samples}）
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 py-8 text-center text-xs text-ink-faint">
                  所选日期暂无模型计价明细。
                </p>
              )}
            </div>
          </div>
        )}

        <RunsListSection
          title={`「${user.displayUsername}」的运行记录`}
          subtitle="仅显示该账号近 30 天的任务与对话轨迹"
          runs={userRuns.data}
          error={userRuns.error}
          status={status}
          seconds={seconds}
          cursor={cursor}
          onStatusChange={setStatus}
          onSecondsChange={setSeconds}
          onCursorChange={setCursor}
          onSelectRun={onSelectRun}
        />
      </main>
    </div>
  );
}

export function Operations() {
  const [tab, setTab] = useState<OpsTab>("users");
  const [date, setDate] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [seconds, setSeconds] = useState("");
  const [cursor, setCursor] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<Lists["runs"][number]>();
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatusFilter>("open");
  const [feedbackCategory, setFeedbackCategory] = useState<FeedbackCategoryFilter>("all");
  const reduced = useReducedMotion();

  const usersState = useRead<UsersSnapshot>(
    selectedRun ? null : "/api/ops/users" + (date ? "?" + new URLSearchParams({ day: date }) : ""),
  );
  const feedbackState = useRead<OpsFeedbackList>(
    selectedRun || selectedUserId
      ? null
      : "/api/ops/feedback?" +
          new URLSearchParams(
            tab === "feedback"
              ? { status: feedbackStatus, category: feedbackCategory }
              : { status: "open" },
          ),
  );
  const costs = useRead<Overview>(
    selectedRun || selectedUserId || tab !== "overview"
      ? null
      : "/api/ops/usage?" + new URLSearchParams({ day: date, provider, model, kind }),
  );
  const runs = useRead<Lists>(
    selectedRun || selectedUserId || tab !== "overview"
      ? null
      : "/api/ops/runs?" +
          new URLSearchParams({ status, seconds, after: cursor, day: date, provider, model, kind }),
  );
  const detail = useRead<Detail>(
    selectedRun
      ? "/api/ops/runs/" +
          selectedRun.id +
          "?" +
          new URLSearchParams({ type: selectedRun.entity, day: date })
      : null,
  );

  const snapshot = usersState.data;
  const selectedUser = selectedUserId
    ? snapshot?.users.find((item) => item.id === selectedUserId) ?? null
    : null;
  const userLabels = snapshot
    ? new Map(snapshot.users.map((item) => [item.code, item.displayUsername]))
    : undefined;

  if (selectedRun) {
    return (
      <div className="min-h-dvh bg-paper text-ink">
        <OpsHeader
          at={detail.at}
          backLabel={selectedUser ? `返回 ${selectedUser.displayUsername}` : "费用与运行"}
          onBack={() => setSelectedRun(undefined)}
        />
        <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 pb-16 sm:px-8">
          {detail.error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-2xl border border-danger-600/30 bg-danger-50 px-4 py-3 text-sm font-medium text-danger-600"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span>数据暂不可用</span>
            </div>
          )}
          {detail.data ? (
            <RunDetails d={detail.data} />
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-line bg-surface p-6">
                <div className="skeleton h-4 w-32 rounded-full" />
                <div className="mt-3 skeleton h-8 w-52 rounded-full" />
              </div>
              <div className="rounded-2xl border border-line bg-surface p-6 space-y-3">
                <div className="skeleton h-4 w-44 rounded-full" />
                <div className="skeleton h-12 w-full rounded-xl" />
                <div className="skeleton h-12 w-full rounded-xl" />
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  if (selectedUser && snapshot) {
    return (
      <UserDetailView
        user={selectedUser}
        snapshot={snapshot}
        day={date}
        onBack={() => setSelectedUserId(null)}
        onSelectRun={setSelectedRun}
        onSaved={(next) => usersState.replace(next)}
        onOpenSiteQuotas={() => {
          setSelectedUserId(null);
          setTab("site_quotas");
        }}
      />
    );
  }

  const u = costs.data;
  const hasUsageFilters = Boolean(date || provider || model || kind);
  const openFeedbackCount = feedbackState.data?.openCount ?? 0;
  const topError =
    tab === "overview"
      ? costs.error || runs.error
      : tab === "feedback"
        ? feedbackState.error
        : usersState.error;

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <OpsHeader
        at={
          tab === "overview"
            ? (runs.at ?? costs.at ?? usersState.at)
            : tab === "feedback"
              ? (feedbackState.at ?? usersState.at)
              : usersState.at
        }
        backHref="/account"
        backLabel="我的账号"
      />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 pb-20 sm:px-8 md:py-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-ink sm:text-3xl">费用与运行</h1>
            <p className="mt-1 text-sm text-ink-soft">
              按用户与全站观测调用量、费用与 Agent 轨迹，动态调整额度并查看受邀用户反馈。
            </p>
          </div>

          <nav
            aria-label="站长观测视图"
            className="glass-pill inline-flex w-full overflow-x-auto rounded-full p-1 lg:w-auto"
          >
            {(
              [
                { id: "users", label: "按用户观测", icon: Users, badge: 0 },
                { id: "site_quotas", label: "全站额度", icon: SlidersHorizontal, badge: 0 },
                { id: "overview", label: "全站费用与运行", icon: Receipt, badge: 0 },
                { id: "feedback", label: "用户反馈", icon: MessageSquareText, badge: openFeedbackCount },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative z-10 inline-flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150 lg:flex-initial",
                    active ? "text-ink" : "text-ink-soft hover:text-ink",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="ops-tab-pill"
                      aria-hidden="true"
                      transition={reduced ? { duration: 0.12 } : SPRING_BOUNCY}
                      className="absolute inset-0 -z-10 rounded-full bg-white/92 shadow-card ring-1 ring-ink/[0.06]"
                    />
                  )}
                  <Icon className={cn("size-4", active ? "text-lake-600" : "text-ink-faint")} />
                  <span>{item.label}</span>
                  {item.badge > 0 && (
                    <span className="tabular rounded-full bg-sun-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {topError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-2xl border border-danger-600/30 bg-danger-50 px-4 py-3 text-sm font-medium text-danger-600"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span>数据暂不可用</span>
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(4px)" }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px)" }}
            transition={{ duration: 0.16, ease: EASE_OUT }}
          >
            {tab === "feedback" && (
              <FeedbackPanel
                data={feedbackState.data}
                statusFilter={feedbackStatus}
                categoryFilter={feedbackCategory}
                onStatusFilterChange={setFeedbackStatus}
                onCategoryFilterChange={setFeedbackCategory}
                onUpdated={(next) => feedbackState.replace(next)}
                onInspectUser={
                  snapshot
                    ? (userId) => {
                        if (snapshot.users.some((item) => item.id === userId)) {
                          setSelectedUserId(userId);
                        }
                      }
                    : undefined
                }
              />
            )}

            {tab === "users" && (
              <UsersDirectory
                snapshot={snapshot}
                day={date}
                onDayChange={(nextDay) => {
                  setDate(nextDay);
                  setCursor("");
                }}
                onSelectUser={(user) => setSelectedUserId(user.id)}
                onSaved={(next) => usersState.replace(next)}
                onOpenSiteQuotas={() => setTab("site_quotas")}
              />
            )}

            {tab === "site_quotas" && (
              <div className="space-y-5">
                {snapshot ? (
                  <QuotaEditor
                    key={`site-${snapshot.day}`}
                    scope="site"
                    day={snapshot.day}
                    title={`全站每日调用上限（${snapshot.day}）`}
                    subtitle="写入数据库并立即在所有用户的下一次请求中生效；点击「恢复默认」退回环境变量配置"
                    rows={snapshot.site}
                    onSaved={(next) => usersState.replace(next)}
                  />
                ) : (
                  !usersState.error && (
                    <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="space-y-2.5 p-4">
                          <div className="skeleton h-4 w-32 rounded-full" />
                          <div className="skeleton h-8 w-64 rounded-xl" />
                        </div>
                      ))}
                    </div>
                  )
                )}

                <div className="rounded-2xl border border-line/80 bg-surface/70 px-5 py-4 text-xs leading-6 text-ink-soft">
                  <p className="font-semibold text-ink">生效规则</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4">
                    <li>每次请求前在 PostgreSQL 事务锁内依次校验「个人日上限」与「全站日上限」，先到达者拦住请求。</li>
                    <li>被拦截的运行会在 Agent 轨迹步骤中明确标注「触发个人日上限」或「触发全站日上限」。</li>
                    <li>调整持久化在 <code className="rounded bg-sunken px-1 py-0.5 text-ink">site_usage_limits</code>，重启容器后仍保留。</li>
                  </ul>
                </div>
              </div>
            )}

            {tab === "overview" && (
              <div className="space-y-7">
                {u ? (
                  <section aria-labelledby="cost-overview-heading" className="space-y-5">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 id="cost-overview-heading" className="text-lg font-semibold text-ink">
                        费用总览
                      </h2>
                      <span className="text-xs text-ink-faint">估算不扣款，实际以供应商账单为准</span>
                    </div>

                    {/* 单一统一三栏账本条：今日 API | 本月 API | 固定支出 */}
                    <div className="grid divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                      <div className="p-5">
                        <p className="text-xs font-medium text-ink-soft">今日 API 估算</p>
                        <div className="mt-3">
                          <CostAmountDisplay cost={u.today} />
                        </div>
                        <p className="mt-2.5 text-xs text-ink-faint">北京时间自然日累计</p>
                      </div>

                      <div className="p-5">
                        <p className="text-xs font-medium text-ink-soft">本月 API 估算</p>
                        <div className="mt-3">
                          <CostAmountDisplay cost={u.month} />
                        </div>
                        <p className="mt-2.5 text-xs text-ink-faint">当前完整自然月累计</p>
                      </div>

                      <div className="p-5">
                        <p className="text-xs font-medium text-ink-soft">固定支出（服务器 / 域名）</p>
                        <div className="mt-3 space-y-2">
                          {u.fixed.length > 0 ? (
                            u.fixed.map((f, i) => (
                              <div
                                key={i}
                                className="flex items-baseline justify-between gap-2 text-xs"
                              >
                                <span className="text-ink-soft">
                                  <strong className="font-medium text-ink">
                                    {f.type === "server" ? "服务器" : "域名"}
                                  </strong>{" "}
                                  <span className="tabular">{f.period}</span>
                                  <span className="ml-1.5 text-ink-faint tabular">({f.paid})</span>
                                </span>
                                <span className="shrink-0 font-semibold text-ink tabular">
                                  {f.currency} {f.amount}
                                </span>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-ink-faint">固定支出未录入</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 中部双栏：近七天趋势 + 预留次数 */}
                    <div className="grid gap-4 lg:grid-cols-12">
                      <SevenDayCard
                        days={u.days}
                        selectedDate={date}
                        onSelectDate={(nextDay) => {
                          setDate(nextDay);
                          setCursor("");
                        }}
                      />

                      <div className="flex flex-col justify-between rounded-2xl border border-line bg-surface p-5 shadow-card lg:col-span-5">
                        <div>
                          <div className="flex items-baseline justify-between gap-2">
                            <h3 className="text-base font-semibold text-ink">预留次数</h3>
                            <span className="text-xs text-ink-faint">
                              {date ? date : "今日"}筛选范围
                            </span>
                          </div>
                          <dl className="mt-3.5 divide-y divide-line/70">
                            {Object.entries(u.counts).map(([k, v]) => (
                              <div
                                key={k}
                                className="flex items-center justify-between gap-3 py-2.5 text-sm"
                              >
                                <dt className="flex items-center gap-2 text-ink-soft">
                                  <CategoryIcon category={k} />
                                  <span>{name(k)}</span>
                                </dt>
                                <dd className="tabular font-semibold text-ink">{v}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>

                        <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-faint">
                          地图、联网、向量与 Jev 按操作计次。地图 SDK 和后台语料入库未计入。删除账号后，可查总额会随之变化。
                        </p>
                      </div>
                    </div>

                    {/* 筛选与模型分项明细 */}
                    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-ink">模型与任务明细</h3>
                          <p className="mt-0.5 text-xs text-ink-faint">
                            按供应商、模型、任务与币种分组；均值仅统计完整可计价的同币种运行
                          </p>
                        </div>
                        {hasUsageFilters && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setDate("");
                              setProvider("");
                              setModel("");
                              setKind("");
                              setCursor("");
                            }}
                          >
                            <FilterX />
                            清除筛选
                          </Button>
                        )}
                      </div>

                      <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                        <label className="block space-y-1">
                          <span className="text-xs text-ink-soft">日期</span>
                          <input
                            aria-label="日期"
                            type="date"
                            value={date}
                            onChange={(e) => {
                              setDate(e.target.value);
                              setCursor("");
                            }}
                            className="h-9 w-full rounded-xl border border-line bg-paper/50 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="text-xs text-ink-soft">供应商</span>
                          <input
                            aria-label="供应商"
                            placeholder="如 deepseek"
                            value={provider}
                            onChange={(e) => {
                              setProvider(e.target.value);
                              setCursor("");
                            }}
                            className="h-9 w-full rounded-xl border border-line bg-paper/50 px-3 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="text-xs text-ink-soft">模型</span>
                          <input
                            aria-label="模型"
                            placeholder="如 deepseek-chat"
                            value={model}
                            onChange={(e) => {
                              setModel(e.target.value);
                              setCursor("");
                            }}
                            className="h-9 w-full rounded-xl border border-line bg-paper/50 px-3 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="text-xs text-ink-soft">任务类型</span>
                          <select
                            aria-label="任务类型"
                            value={kind}
                            onChange={(e) => {
                              setKind(e.target.value);
                              setCursor("");
                            }}
                            className="h-9 w-full rounded-xl border border-line bg-paper/50 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600"
                          >
                            <option value="">全部任务</option>
                            {["plan", "outing", "adjust", "outing_change", "chat_turn"].map((k) => (
                              <option key={k} value={k}>
                                {name(k)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      {u.groups.length > 0 ? (
                        <div className="mt-4 overflow-x-auto">
                          <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                            <thead>
                              <tr className="border-b border-line text-xs text-ink-faint">
                                <th className="py-2.5 pr-4 font-medium">供应商 / 模型</th>
                                <th className="py-2.5 pr-4 font-medium">任务类型</th>
                                <th className="py-2.5 pr-4 font-medium">已估费用</th>
                                <th className="py-2.5 pr-4 font-medium">运行数</th>
                                <th className="py-2.5 font-medium">完整运行均值</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line/70">
                              {u.groups.map((g, i) => (
                                <tr key={i} className="hover:bg-paper/60">
                                  <td className="py-3 pr-4 font-medium text-ink">
                                    {[g.provider, g.model].filter(Boolean).join(" / ") || "未记录"}
                                  </td>
                                  <td className="py-3 pr-4">
                                    <Badge tone="neutral">{name(g.kind ?? "其他")}</Badge>
                                  </td>
                                  <td className="py-3 pr-4 font-semibold text-lake-700 tabular">
                                    {money(g)}
                                  </td>
                                  <td className="py-3 pr-4 text-ink-soft tabular">
                                    {g.roots} 次
                                    {g.pendingRoots > 0 && (
                                      <span className="ml-1.5 text-xs text-sun-700">
                                        （含待核对 {g.pendingRoots} 次）
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-3 text-ink-soft tabular">
                                    {g.average !== null ? `${g.average} ${g.currency ?? ""}` : "—"}
                                    <span className="ml-1 text-xs text-ink-faint">
                                      （{g.samples} 次样本）
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="mt-4 py-6 text-center text-sm text-ink-faint">
                          当前筛选条件下暂无模型计价明细。
                        </p>
                      )}
                    </div>
                  </section>
                ) : (
                  !costs.error && (
                    <div className="grid divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="space-y-3 p-5">
                          <div className="skeleton h-3.5 w-24 rounded-full" />
                          <div className="skeleton h-8 w-36 rounded-full" />
                        </div>
                      ))}
                    </div>
                  )
                )}

                <RunsListSection
                  title="全站运行记录"
                  subtitle="进行中的任务置顶显示；点击任意一条查看父子 Agent 树、工具耗时与单笔调用回执"
                  runs={runs.data}
                  error={runs.error}
                  status={status}
                  seconds={seconds}
                  cursor={cursor}
                  onStatusChange={setStatus}
                  onSecondsChange={setSeconds}
                  onCursorChange={setCursor}
                  onSelectRun={setSelectedRun}
                  userLabels={userLabels}
                />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
