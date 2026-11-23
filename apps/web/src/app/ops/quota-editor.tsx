"use client";

import {
  AlertTriangle,
  Check,
  Cpu,
  Database,
  Globe,
  MapPin,
  RotateCcw,
  Save,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type { UsageCategory } from "@tripquest/db";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import {
  beijingTime,
  name,
  type SiteQuota,
  type UserOverview,
  type UsersSnapshot,
} from "./format";

type DraftMap = Partial<Record<UsageCategory, string>>;

const PRESETS: Readonly<Record<UsageCategory, readonly number[]>> = {
  model: [0, 100, 300, 1000],
  amap: [0, 200, 1000, 3000],
  web: [0, 50, 150, 300],
  embed: [0, 100, 300, 1000],
  jev: [0, 50, 200, 500],
};

function CategoryIcon({ category }: { category: UsageCategory }) {
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

export type QuotaRow = {
  category: UsageCategory;
  used: number;
  limit: number | null;
  defaultLimit: number | null;
  customLimit: number | null;
  remaining: number | null;
  effectiveRemaining?: number;
  cappedBySite?: boolean;
  siteRemaining?: number | null;
  updatedAt?: string | null;
};

function parseDraft(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 0 || num > 100_000) return { ok: false };
  return { ok: true, value: num };
}

function initialDrafts(rows: readonly QuotaRow[]): DraftMap {
  const map: DraftMap = {};
  for (const row of rows) {
    map[row.category] = row.limit === null ? "" : String(row.limit);
  }
  return map;
}

/**
 * 精简扁平版额度编辑器（适用于右侧/底部抽屉与全站面板）：
 * 去掉多层卡片嵌套，用清晰的水平分隔行呈现五类额度水位与即时修改。
 */
export function QuotaEditor({
  scope,
  userId,
  day,
  title,
  subtitle,
  rows,
  hideHeader = false,
  onSaved,
  onOpenSiteQuotas,
}: {
  scope: "site" | "user";
  userId?: string;
  day: string;
  title?: string;
  subtitle?: string;
  rows: readonly QuotaRow[];
  hideHeader?: boolean;
  onSaved: (snapshot: UsersSnapshot) => void;
  onOpenSiteQuotas?: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftMap>(() => initialDrafts(rows));
  const [resetTargets, setResetTargets] = useState<Partial<Record<UsageCategory, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const pendingUpdates: { category: UsageCategory; limit: number | null }[] = [];
  let hasInvalid = false;

  for (const row of rows) {
    if (resetTargets[row.category]) {
      if (row.customLimit !== null) {
        pendingUpdates.push({ category: row.category, limit: null });
      }
      continue;
    }
    const raw = drafts[row.category] ?? (row.limit === null ? "" : String(row.limit));
    const parsed = parseDraft(raw);
    if (!parsed.ok) {
      hasInvalid = true;
      continue;
    }
    if (parsed.value === null) {
      if (row.customLimit !== null) {
        pendingUpdates.push({ category: row.category, limit: null });
      }
    } else if (parsed.value !== row.limit) {
      pendingUpdates.push({ category: row.category, limit: parsed.value });
    }
  }

  function setField(category: UsageCategory, value: string) {
    setNotice(null);
    setResetTargets((prev) => ({ ...prev, [category]: false }));
    setDrafts((prev) => ({ ...prev, [category]: value }));
  }

  function markReset(row: QuotaRow) {
    setNotice(null);
    setResetTargets((prev) => ({ ...prev, [row.category]: true }));
    setDrafts((prev) => ({
      ...prev,
      [row.category]: row.defaultLimit === null ? "" : String(row.defaultLimit),
    }));
  }

  function discardAll() {
    setDrafts(initialDrafts(rows));
    setResetTargets({});
    setNotice(null);
  }

  async function save() {
    if (pendingUpdates.length === 0 || hasInvalid || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const url = "/api/ops/limits" + (day ? `?day=${encodeURIComponent(day)}` : "");
      const payload =
        scope === "site"
          ? { scope: "site" as const, updates: pendingUpdates }
          : { scope: "user" as const, userId: userId!, updates: pendingUpdates };
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          err?.error === "not_found"
            ? "未找到该账号，可能已被删除。"
            : err?.error === "invalid_request"
              ? "额度须为 0 至 100000 之间的整数。"
              : "保存失败，请稍后重试。",
        );
      }
      const snapshot = (await response.json()) as UsersSnapshot;
      onSaved(snapshot);
      const nextRows: QuotaRow[] =
        scope === "site"
          ? snapshot.site
          : (snapshot.users.find((item) => item.id === userId)?.quotas ?? []);
      setDrafts(initialDrafts(nextRows));
      setResetTargets({});
      setNotice({ kind: "ok", text: "已保存，立即在后续请求中生效。" });
    } catch (error) {
      setNotice({
        kind: "err",
        text: error instanceof Error ? error.message : "保存失败，请稍后重试。",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {!hideHeader && title && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>}
          </div>
          <span className="text-xs text-ink-faint">0 – 100,000（设 0 即暂停）</span>
        </div>
      )}

      <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {rows.map((row) => {
          const raw = drafts[row.category] ?? (row.limit === null ? "" : String(row.limit));
          const parsed = parseDraft(raw);
          const isResetting = Boolean(resetTargets[row.category]) && row.customLimit !== null;
          const isModified =
            isResetting ||
            (parsed.ok &&
              ((parsed.value === null && row.customLimit !== null) ||
                (parsed.value !== null && parsed.value !== row.limit)));
          const pct =
            row.limit !== null && row.limit > 0
              ? Math.min(100, Math.round((row.used / row.limit) * 100))
              : row.limit === 0
                ? 100
                : 0;
          const exhausted =
            (row.remaining !== null && row.remaining === 0) ||
            (row.effectiveRemaining !== undefined && row.effectiveRemaining === 0);

          return (
            <div
              key={row.category}
              className={cn(
                "px-4 py-3.5 transition-colors duration-150",
                !parsed.ok && "bg-danger-50/40",
                parsed.ok && isModified && "bg-lake-50/45",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CategoryIcon category={row.category} />
                  <span className="text-sm font-medium text-ink">{name(row.category)}</span>
                  {row.customLimit !== null && <Badge tone="lake">自定义</Badge>}
                </div>

                <div className="flex items-center gap-3 text-xs tabular">
                  <span className="text-ink-soft">
                    已用 <strong className="font-semibold text-ink">{row.used}</strong> /{" "}
                    {row.limit === null ? "不限" : row.limit}
                  </span>
                  <span
                    className={cn(
                      "font-medium",
                      exhausted ? "text-danger-600" : "text-lake-700",
                    )}
                  >
                    {row.limit === null
                      ? "未设上限"
                      : scope === "user" && row.effectiveRemaining !== undefined
                        ? `可用 ${row.effectiveRemaining}`
                        : `剩余 ${row.remaining}`}
                  </span>
                </div>
              </div>

              {row.limit !== null && (
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-sunken">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300 ease-(--ease-out)",
                      exhausted ? "bg-danger-600" : pct >= 80 ? "bg-sun-500" : "bg-lake-500",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}

              {scope === "user" && row.cappedBySite && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-sun-50 px-2.5 py-1.5 text-[11px] text-sun-700">
                  <span className="flex items-center gap-1">
                    <AlertTriangle className="size-3 shrink-0" />
                    个人剩 {row.remaining}，受全站余量限制（全站仅剩 {row.siteRemaining ?? 0}）
                  </span>
                  {onOpenSiteQuotas && (
                    <button
                      type="button"
                      onClick={onOpenSiteQuotas}
                      className="shrink-0 font-medium underline"
                    >
                      去调全站
                    </button>
                  )}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  aria-label={`${scope === "site" ? "全站" : "个人"}${name(row.category)}日额度`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100000}
                  step={1}
                  placeholder={row.defaultLimit === null ? "不限" : String(row.defaultLimit)}
                  value={raw}
                  onChange={(e) => setField(row.category, e.target.value)}
                  className={cn(
                    "tabular h-9 w-28 rounded-xl border bg-paper/60 px-3 text-sm text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600",
                    !parsed.ok ? "border-danger-600" : "border-line",
                  )}
                />

                <div className="flex flex-wrap items-center gap-1">
                  {PRESETS[row.category].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setField(row.category, String(preset))}
                      className={cn(
                        "tabular h-7 rounded-full border px-2.5 text-[11px] font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96]",
                        raw === String(preset) && !isResetting
                          ? "border-lake-600 bg-lake-600 text-white"
                          : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
                      )}
                    >
                      {preset === 0 ? "暂停" : preset}
                    </button>
                  ))}
                </div>

                {row.customLimit !== null && !isResetting && (
                  <button
                    type="button"
                    onClick={() => markReset(row)}
                    title={`恢复默认（${row.defaultLimit === null ? "不限" : row.defaultLimit}）`}
                    className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
                  >
                    <RotateCcw className="size-3" />
                    <span>恢复默认</span>
                  </button>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px] text-ink-faint tabular">
                <span>默认 {row.defaultLimit === null ? "不限" : row.defaultLimit}</span>
                {!parsed.ok ? (
                  <span className="font-medium text-danger-600">须为 0–100000 整数</span>
                ) : isResetting ? (
                  <span className="font-medium text-lake-700">
                    将恢复默认（{row.defaultLimit === null ? "不限" : row.defaultLimit}）
                  </span>
                ) : isModified && parsed.value !== null ? (
                  <span className="font-medium text-lake-700">
                    {row.limit === null ? "不限" : row.limit} → {parsed.value}
                  </span>
                ) : row.updatedAt ? (
                  <span>改于 {beijingTime(row.updatedAt)}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="min-w-0 text-xs">
          {notice ? (
            <p
              role={notice.kind === "err" ? "alert" : "status"}
              className={cn(
                "flex items-center gap-1.5 font-medium",
                notice.kind === "ok" ? "text-lake-700" : "text-danger-600",
              )}
            >
              {notice.kind === "ok" ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <AlertTriangle className="size-3.5 shrink-0" />
              )}
              <span>{notice.text}</span>
            </p>
          ) : pendingUpdates.length > 0 ? (
            <p className="text-ink-soft">待保存 {pendingUpdates.length} 项额度改动</p>
          ) : (
            <p className="text-ink-faint">北京时间每日零点清零已用次数，保存后立即生效。</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {pendingUpdates.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={discardAll} disabled={saving}>
              撤销
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => void save()}
            disabled={pendingUpdates.length === 0 || hasInvalid || saving}
          >
            <Save />
            <span>{saving ? "保存中…" : scope === "site" ? "保存全站额度" : "保存用户额度"}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function buildUserQuotaRows(user: UserOverview, site: readonly SiteQuota[]): QuotaRow[] {
  const siteMap = new Map(site.map((item) => [item.category, item]));
  return user.quotas.map((q) => ({
    category: q.category,
    used: q.used,
    limit: q.limit,
    defaultLimit: q.defaultLimit,
    customLimit: q.customLimit,
    remaining: q.remaining,
    effectiveRemaining: q.effectiveRemaining,
    cappedBySite: q.cappedBySite,
    siteRemaining: siteMap.get(q.category)?.remaining ?? null,
  }));
}
