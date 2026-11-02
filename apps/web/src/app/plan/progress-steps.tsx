"use client";

import { Check, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ProgressStep } from "./view-models";
import { EASE_OUT } from "../_ui/motion";

/** What the planning agent is doing, one line per step, appearing as it happens. */
/** V3.5：进行中可以停止（已经排好的天留着）。 */
export function ProgressSteps({ steps, running, onStop, stopping = false }: {
  steps: readonly ProgressStep[];
  running: boolean;
  onStop?: () => void;
  stopping?: boolean;
}) {
  return (
    <div className="rounded-(--radius-card) border border-line bg-surface/70 px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-ink-faint">{running ? "正在规划" : "规划过程"}</p>
        {running && onStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-ink-soft transition-colors hover:border-lake-200 hover:text-lake-700 disabled:opacity-60"
          >
            {stopping ? "正在停止…" : "停止"}
          </button>
        ) : null}
      </div>
      <ol className="space-y-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {steps.map((step) => (
            <motion.li
              key={step.key}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: EASE_OUT }}
              className="flex items-start gap-2.5 text-sm"
            >
              {step.state === "active" ? (
                <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-sun-500" />
              ) : (
                <Check className="mt-0.5 size-4 shrink-0 text-lake-500" />
              )}
              <span className={step.state === "active" ? "shimmer-text font-medium" : "text-ink-soft"}>
                {step.text}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}
