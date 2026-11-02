"use client";

import { CalendarX2, ClipboardCheck, ExternalLink, LoaderCircle } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { Button } from "../_ui/button";
import { EASE_OUT } from "../_ui/motion";
import type { TripNotesView } from "./view-models";

type NotesStop = TripNotesView["stops"][number];

export type TripNotesState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly notes: TripNotesView }
  | { readonly status: "error"; readonly message: string };

/** V2.7.2: "出发须知", asked for with a tap; kept in the page only. */
export function useTripNotes(url: string | null, body: unknown = {}) {
  const [state, setState] = useState<TripNotesState>({ status: "idle" });
  async function load() {
    if (!url || state.status === "loading") return;
    setState({ status: "loading" });
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const reply = await response.json().catch(() => null) as { status?: string; notes?: TripNotesView } | null;
      if (reply?.status === "ok" && reply.notes) setState({ status: "ready", notes: reply.notes });
      else setState({ status: "error", message: reply?.status === "unavailable" ? "现在查不了出发须知（需要真实模型和联网搜索）" : "这次没查成，可以稍后再试" });
    } catch {
      setState({ status: "error", message: "这次没查成，可以稍后再试" });
    }
  }
  return { state, load };
}

/** The button and how the lookup went; nothing to show for a plan with no place to check. */
export function TripNotesBar({ state, onLoad }: { state: TripNotesState; onLoad: () => void }) {
  if (state.status === "ready") {
    const checked = state.notes.stops.filter((stop) => stop.checked).length;
    const warned = state.notes.stops.filter((stop) => stop.warning).length;
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <ClipboardCheck className="size-3.5" />
        {checked
          ? `查了 ${checked} 个景点类地点${warned ? `，${warned} 处当天可能闭馆` : ""}；网上信息，出发前以官方为准`
          : "这些地点不用提前办什么（餐饮购物类不查）"}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" className="h-8 px-3" onClick={onLoad} disabled={state.status === "loading"}>
        {state.status === "loading" ? <LoaderCircle className="animate-spin" /> : <ClipboardCheck />}
        {state.status === "loading" ? "正在查预约、门票和开放信息…" : "查出发须知"}
      </Button>
      {state.status === "error" && <span className="text-xs text-sun-700">{state.message}</span>}
    </div>
  );
}

/** One stop's notes: a closing-day warning first, then each note with its sources. */
export function StopNotes({ stop }: { stop: NotesStop | undefined }) {
  if (!stop?.checked) return null;
  return (
    <motion.div
      initial={{ opacity: 0, transform: "translateY(-2px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className="mt-2 space-y-1.5"
    >
      {stop.warning && (
        <p className="flex items-start gap-1.5 rounded-(--radius-field) bg-sun-50 px-2.5 py-1.5 text-xs font-medium text-sun-700">
          <CalendarX2 className="mt-px size-3.5 shrink-0" />
          {stop.warning}，可以在对话里说一声换一天或换个地方
        </p>
      )}
      {stop.notes.length === 0 && !stop.warning && <p className="text-xs text-ink-faint">没查到需要提前办的事</p>}
      {stop.notes.map((note) => (
        <div key={note.text} className="text-xs leading-5 text-ink-soft">
          <span>{note.text}</span>
          {note.stale && <span className="ml-1 text-ink-faint">（信息较旧）</span>}
          {note.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={source.title}
              className="ml-1.5 inline-flex items-center gap-0.5 text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-lake-700"
            >
              {source.site ?? new URL(source.url).hostname}
              {source.date && ` · ${source.date}`}
              <ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      ))}
    </motion.div>
  );
}
