"use client";

import { Luggage, Sun } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { EASE_OUT, SPRING_BOUNCY } from "./motion";

/** V2.11：日常（所在城市的一天）或出游（1–7 天、可以跨城市）。由用户在页面上选。 */
export type PlanMode = "daily" | "outing";

const MODE_THEME_COLOR: Record<PlanMode, string> = {
  daily: "#eeece8",
  outing: "#efeae6",
};

/**
 * 顶部的“日常 / 出游”毛玻璃分段切换：弹性弹簧滑块 + 图标物理旋转轻跳反馈。
 */
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
  const pillId = useId();
  const reduced = useReducedMotion();
  const options = [
    { mode: "daily" as const, label: "日常", icon: Sun },
    { mode: "outing" as const, label: "出游", icon: Luggage },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="日常或出游"
      className={cn(
        "glass-pill relative inline-flex shrink-0 items-center rounded-full p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = value === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || !onChange}
            onClick={() => !active && onChange?.(option.mode)}
            className={cn(
              "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-medium",
              "transition-[color,transform] duration-150 ease-(--ease-out) active:scale-[0.95]",
              active ? "text-ink" : "text-ink-soft hover:text-ink",
              "disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            )}
          >
            {active && (
              <motion.span
                layoutId={`mode-pill-${pillId}`}
                aria-hidden="true"
                transition={reduced ? { duration: 0.12 } : SPRING_BOUNCY}
                className="absolute inset-0 -z-10 rounded-full bg-white/92 shadow-card ring-1 ring-ink/[0.06]"
              />
            )}
            <motion.span
              aria-hidden="true"
              animate={
                reduced
                  ? undefined
                  : active
                    ? {
                        transform:
                          option.mode === "daily"
                            ? "rotate(24deg) scale(1.08)"
                            : "rotate(-7deg) scale(1.08)",
                      }
                    : { transform: "rotate(0deg) scale(0.94)" }
              }
              transition={SPRING_BOUNCY}
              className={cn(
                "inline-flex transition-colors duration-250",
                active ? "text-lake-600" : "text-ink-faint",
              )}
            >
              <option.icon className="size-3.5" />
            </motion.span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const ModeContext = createContext<{ mode: PlanMode; setMode: (mode: PlanMode) => void }>({
  mode: "daily",
  setMode: () => {},
});

/**
 * 莫兰迪水彩柔雾画布容器：
 * 日常（雾蓝青 + 晨雾杏 + 淡鼠尾草）与出游（烟熏蔷薇粉 + 柔麦金 + 雾藕灰）两层柔和色团
 * 在切换时错位漂移交叉溶解，透过上层毛玻璃卡片呈现出温润通透的季节光影流动。
 */
export function ModeScope({ children, className }: { children: ReactNode; className?: string }) {
  const [mode, setMode] = useState<PlanMode>("daily");

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = MODE_THEME_COLOR[mode];
    return () => {
      if (meta) meta.content = MODE_THEME_COLOR.daily;
    };
  }, [mode]);

  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      <div data-mode={mode} className={cn("relative min-h-dvh overflow-x-clip bg-paper", className)}>
        {/* 日常模式：莫兰迪雾霾蓝灰 × 淡鼠尾草 × 暖杏漫反射 */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none fixed inset-0 overflow-hidden transition-[opacity,transform] duration-700 ease-(--ease-out)",
            mode === "daily"
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 -translate-y-4 scale-[1.03]",
          )}
        >
          <div className="morandi-drift absolute -left-24 -top-28 h-[460px] w-[540px] rounded-full bg-[#b9ced1]/55 blur-[95px]" />
          <div className="morandi-drift-alt absolute -right-20 top-6 h-[420px] w-[460px] rounded-full bg-[#e3d3c6]/58 blur-[100px]" />
          <div className="morandi-drift absolute bottom-8 left-1/3 h-[340px] w-[440px] rounded-full bg-[#c8d5ce]/42 blur-[110px]" />
        </div>

        {/* 出游模式：莫兰迪烟熏蔷薇粉 × 浅麦金 × 雾藕灰漫反射 */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none fixed inset-0 overflow-hidden transition-[opacity,transform] duration-700 ease-(--ease-out)",
            mode === "outing"
              ? "opacity-100 translate-y-0 scale-100"
              : "opacity-0 translate-y-4 scale-[1.03]",
          )}
        >
          <div className="morandi-drift-alt absolute -right-24 -top-24 h-[480px] w-[560px] rounded-full bg-[#ddb9ae]/56 blur-[95px]" />
          <div className="morandi-drift absolute -left-20 top-10 h-[420px] w-[480px] rounded-full bg-[#e6d6bc]/60 blur-[100px]" />
          <div className="morandi-drift-alt absolute bottom-8 right-1/4 h-[340px] w-[440px] rounded-full bg-[#d6c6cb]/46 blur-[110px]" />
        </div>

        <div className="relative">{children}</div>
      </div>
    </ModeContext.Provider>
  );
}

export const usePlanMode = () => useContext(ModeContext);

/**
 * 随模式切换的标题与文案：带轻盈景深缩放与柔焦过渡，衔接日常与出游的语境转换。
 */
export function ByMode({
  daily,
  outing,
  className,
}: {
  daily: ReactNode;
  outing: ReactNode;
  className?: string;
}) {
  const { mode } = usePlanMode();
  const reduced = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={mode}
        className={cn("inline-block", className)}
        initial={
          reduced
            ? { opacity: 0 }
            : { opacity: 0, filter: "blur(4px)", transform: "translateY(8px) scale(0.985)" }
        }
        animate={
          reduced
            ? { opacity: 1 }
            : { opacity: 1, filter: "blur(0px)", transform: "translateY(0px) scale(1)" }
        }
        exit={
          reduced
            ? { opacity: 0 }
            : { opacity: 0, filter: "blur(4px)", transform: "translateY(-8px) scale(0.985)" }
        }
        transition={{ duration: 0.24, ease: EASE_OUT }}
      >
        {mode === "outing" ? outing : daily}
      </motion.span>
    </AnimatePresence>
  );
}
