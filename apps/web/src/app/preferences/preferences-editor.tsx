"use client";

import { Check, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import type { PreferenceView } from "../plan/view-models";

type Category = PreferenceView["category"];
const CATEGORIES: readonly { value: Category; label: string }[] = [
  { value: "food", label: "饮食" },
  { value: "pace", label: "节奏" },
  { value: "travel", label: "出行" },
  { value: "interest", label: "兴趣" },
  { value: "other", label: "其他" },
];
const label = (category: Category) => CATEGORIES.find((item) => item.value === category)?.label ?? "其他";

async function send(url: string, method: "PATCH" | "DELETE", body?: unknown): Promise<string> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return ((await response.json().catch(() => null)) as { status?: string } | null)?.status ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

/** 列表：改正文或类别、删除单条（确认一次）、全部删除（确认一次）。 */
export function PreferencesEditor({ initial }: { initial: readonly PreferenceView[] }) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<{ id: string; text: string; category: Category } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!editing || busy) return;
    setBusy(true);
    const status = await send(`/api/preferences/${editing.id}`, "PATCH", { text: editing.text, category: editing.category });
    setBusy(false);
    if (status === "updated") {
      setItems((list) => list.map((item) => (item.id === editing.id ? { ...item, text: editing.text.trim(), category: editing.category } : item)));
      setEditing(null);
      setError(null);
    } else {
      setError(status === "invalid" ? "1–40 个字，不能含住处、坐标或号码。" : "这次没保存成功，请稍后再试。");
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    const status = id === "all" ? await send("/api/preferences", "DELETE") : await send(`/api/preferences/${id}`, "DELETE");
    setBusy(false);
    setConfirming(null);
    if (status === "removed" || status === "not_found") {
      setItems((list) => (id === "all" ? [] : list.filter((item) => item.id !== id)));
      setError(null);
    } else {
      setError("这次没删除成功，请稍后再试。");
    }
  }

  if (!items.length) {
    return <p className="mt-8 rounded-(--radius-field) bg-sunken px-4 py-6 text-center text-sm text-ink-soft">还没有记住的偏好。在对话里说“我不吃辣”这类话，点“记住”就会出现在这里。</p>;
  }
  return (
    <div className="mt-6 space-y-3">
      <ul className="divide-y divide-line overflow-hidden rounded-(--radius-field) border border-line bg-surface">
        {items.map((item) => (
          <li key={item.id} className="px-4 py-3">
            {editing?.id === item.id ? (
              <div className="space-y-2">
                <input
                  value={editing.text}
                  maxLength={40}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  className="w-full rounded-(--radius-field) border border-line bg-paper px-3 py-2 text-[16px] focus:border-lake-400 focus:outline-none"
                  aria-label="偏好内容"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {CATEGORIES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setEditing({ ...editing, category: option.value })}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs",
                        editing.category === option.value ? "border-lake-200 bg-lake-50 text-lake-700" : "border-line text-ink-soft",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                  <span className="flex-1" />
                  <Button size="sm" className="h-8 px-3" onClick={() => void save()} disabled={busy}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 px-3" onClick={() => setEditing(null)} disabled={busy}>
                    <X />
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs text-ink-soft">{label(item.category)}</span>
                <span className="min-w-0 flex-1 break-words text-[15px]">{item.text}</span>
                {confirming === item.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="accent" className="h-8 px-3" onClick={() => void remove(item.id)} disabled={busy}>确定删除</Button>
                    <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setConfirming(null)} disabled={busy}>取消</Button>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`修改：${item.text}`} onClick={() => setEditing({ id: item.id, text: item.text, category: item.category })}>
                      <Pencil />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`删除：${item.text}`} onClick={() => setConfirming(item.id)}>
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-sun-700">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {confirming === "all" ? (
          <>
            <span className="text-sm text-ink-soft">删除全部 {items.length} 条？不能恢复。</span>
            <Button size="sm" variant="accent" className="h-8 px-3" onClick={() => void remove("all")} disabled={busy}>确定全部删除</Button>
            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setConfirming(null)} disabled={busy}>取消</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" className="h-8 px-3" onClick={() => setConfirming("all")}>
            <Trash2 />
            全部删除
          </Button>
        )}
      </div>
    </div>
  );
}
