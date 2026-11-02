"use client";

import { Luggage, Sun } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "./cn";

/** V2.11：日常（所在城市的一天）或出游（1–7 天、可以跨城市）。由用户在页面上选。 */
export type PlanMode = "daily" | "outing";

/** 顶部的“日常 / 出游”切换。 */
export function ModeSwitch({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: PlanMode;
  onChange?: (mode: PlanMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const options = [
    { mode: "daily" as const, label: "日常", icon: Sun },
    { mode: "outing" as const, label: "出游", icon: Luggage },
  ];
  return (
    <div role="radiogroup" aria-label="日常或出游" className={cn("inline-flex shrink-0 rounded-full bg-sunken p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          role="radio"
          aria-checked={value === option.mode}
          disabled={disabled || !onChange}
          onClick={() => value !== option.mode && onChange?.(option.mode)}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-full px-3 text-sm transition-colors",
            value === option.mode ? "bg-surface font-medium text-ink shadow-card" : "text-ink-soft hover:text-ink",
            "disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
          )}
        >
          <option.icon className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  );
}

const ModeContext = createContext<{ mode: PlanMode; setMode: (mode: PlanMode) => void }>({ mode: "daily", setMode: () => {} });

/** 首页：选中的模式决定整页的主题（出游换一套变量）。 */
export function ModeScope({ children, className }: { children: ReactNode; className?: string }) {
  const [mode, setMode] = useState<PlanMode>("daily");
  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      <div data-mode={mode} className={cn("bg-paper", className)}>{children}</div>
    </ModeContext.Provider>
  );
}

export const usePlanMode = () => useContext(ModeContext);

/** 首页里随模式换的文字（日常、出游各一份）。 */
export function ByMode({ daily, outing }: { daily: ReactNode; outing: ReactNode }) {
  return <>{usePlanMode().mode === "outing" ? outing : daily}</>;
}
