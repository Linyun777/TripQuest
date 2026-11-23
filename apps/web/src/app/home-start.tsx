"use client";

import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { shortCity, usePageCity } from "./_ui/city";
import { cn } from "./_ui/cn";
import { ModeSwitch, usePlanMode } from "./_ui/mode";
import { EASE_OUT, SPRING_BOUNCY, SPRING_SNAPPY } from "./_ui/motion";

// V2.10：示例不指向具体城市（定位得到哪个城市都能用）。
const EXAMPLES = [
  "明天慢慢逛一天，想看看本地的老街和博物馆，别太累",
  "周六带爸妈出去走走，中午想吃素，下午 4 点前回酒店",
  "现在想去附近喝杯咖啡，再找个地方吃点辣的",
];
// V2.11：出游的示例。
const OUTING_EXAMPLES = [
  "下周五到周日去成都玩三天，坐高铁去，想吃火锅、看熊猫",
  "国庆去黄山两天，第一天轻松点，住山上",
  "17 号上午的航班去厦门，19 号晚上回来，想去鼓浪屿",
];

/** The first message starts a conversation; examples fill the box instead of sending. */
export function HomeStart() {
  const router = useRouter();
  const [text, setText] = useState("");
  const city = usePageCity();
  const { mode, setMode } = usePlanMode();
  const reduced = useReducedMotion();

  const hasText = Boolean(text.trim());

  function start() {
    const trimmed = text.trim();
    if (!trimmed) return;
    router.push(
      `/plan/new?q=${encodeURIComponent(trimmed.slice(0, 1000))}${mode === "outing" ? "&mode=outing" : ""}`,
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    start();
  }

  const examples = mode === "outing" ? OUTING_EXAMPLES : EXAMPLES;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <ModeSwitch value={mode} onChange={setMode} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={mode}
            initial={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(4px)" }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px)" }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="truncate text-xs font-medium text-ink-soft"
          >
            {mode === "outing" ? "1–7 天 · 可跨城市" : `${shortCity(city.name)} · 一日或短途`}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* 毛玻璃主输入面板 */}
      <div className="glass-card rounded-[26px] p-3.5 transition-[box-shadow,border-color] duration-250 focus-within:border-lake-200 focus-within:ring-2 focus-within:ring-lake-500/20">
        <textarea
          rows={3}
          value={text}
          maxLength={1000}
          enterKeyHint="send"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === "outing"
              ? "比如：17 号到 19 号去苏州玩三天，坐高铁去，想逛园林、古镇，吃面"
              : "比如：明天 9 点从酒店出发，下午 2 点博物馆有预约，想找家安静的书店，6 点前回来"
          }
          aria-label={mode === "outing" ? "说说这趟出游" : "说说你想怎么过这一天"}
          className="w-full resize-none bg-transparent px-2 py-1.5 text-base leading-7 text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="flex items-center justify-between gap-3 border-t border-ink/[0.06] pl-2 pt-2.5">
          <span className="text-xs text-ink-faint">
            {mode === "outing"
              ? "按高铁 / 航班与住处逐天排程"
              : "步行 / 地铁公交 / 打车实时核对"}
          </span>
          <motion.button
            type="button"
            onClick={start}
            disabled={!hasText}
            animate={
              reduced
                ? undefined
                : hasText
                  ? { transform: "scale(1)" }
                  : { transform: "scale(0.97)" }
            }
            transition={SPRING_BOUNCY}
            className={cn(
              "group inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-5 text-sm font-medium text-white",
              "transition-[opacity,transform,box-shadow] duration-150 ease-(--ease-out) active:scale-[0.95]",
              hasText ? "morandi-cta" : "bg-line-strong/80 text-white/90 shadow-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            )}
          >
            <span>开始规划</span>
            <ArrowUp className="size-4 transition-transform duration-150 group-hover:-translate-y-0.5" />
          </motion.button>
        </div>
      </div>

      {/* 手机端横向滑动莫兰迪玻璃示例，切换模式逐条错落弹入 */}
      <div>
        <p className="mb-2 px-0.5 text-xs font-medium text-ink-faint">试试这样说</p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: reduced ? 0 : 0.045 } },
              exit: { transition: { duration: 0.14 } },
            }}
            className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
          >
            {examples.map((example) => (
              <motion.button
                key={example}
                type="button"
                onClick={() => setText(example)}
                variants={{
                  hidden: reduced
                    ? { opacity: 0 }
                    : { opacity: 0, transform: "translateY(8px) scale(0.97)" },
                  visible: {
                    opacity: 1,
                    transform: "translateY(0px) scale(1)",
                    transition: reduced ? { duration: 0.14 } : SPRING_SNAPPY,
                  },
                  exit: reduced
                    ? { opacity: 0 }
                    : { opacity: 0, transform: "translateY(-4px)", transition: { duration: 0.14 } },
                }}
                className={cn(
                  "glass-pill w-[78vw] max-w-[292px] shrink-0 snap-start rounded-2xl px-3.5 py-2.5 text-left text-sm leading-snug text-ink-soft",
                  "transition-[background-color,border-color,color,transform] duration-180 ease-(--ease-out) active:scale-[0.97]",
                  "hover:border-lake-200 hover:bg-white/80 hover:text-ink sm:hover:-translate-y-0.5",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
                  "sm:w-auto sm:max-w-none sm:shrink sm:rounded-full sm:py-2",
                )}
              >
                {example}
              </motion.button>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
