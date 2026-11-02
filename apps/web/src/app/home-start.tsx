"use client";

import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { shortCity, usePageCity } from "./_ui/city";
import { cn } from "./_ui/cn";
import { ModeSwitch, usePlanMode } from "./_ui/mode";

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
  // V2.11：日常或出游由用户选；出游的对话从出游卡片开始。
  const { mode, setMode } = usePlanMode();

  function start() {
    const trimmed = text.trim();
    if (!trimmed) return;
    router.push(`/plan/new?q=${encodeURIComponent(trimmed.slice(0, 1000))}${mode === "outing" ? "&mode=outing" : ""}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    start();
  }

  return (
    <div>
      <ModeSwitch value={mode} onChange={setMode} className="mb-3" />
      <div className="rounded-[28px] border border-line bg-surface p-3 shadow-float transition-shadow focus-within:border-lake-200">
        <textarea
          rows={3}
          value={text}
          maxLength={1000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === "outing"
            ? "比如：17 号到 19 号去苏州玩三天，坐高铁去，想逛园林、古镇，吃面"
            : "比如：明天 9 点从酒店出发，下午 2 点博物馆有预约，想找家安静的书店，6 点前回来"}
          aria-label={mode === "outing" ? "说说这趟出游" : "说说你想怎么过这一天"}
          className="w-full resize-none bg-transparent px-2 py-1.5 text-base leading-7 outline-none placeholder:text-ink-faint"
        />
        <div className="flex items-center justify-between gap-3 pl-2">
          <span className="text-xs text-ink-faint">
            {mode === "outing" ? "出游 · 1–7 天 · 可以跨城市" : `${shortCity(city.name)} · 一天 · 步行 / 地铁公交 / 打车`}
          </span>
          <button
            type="button"
            onClick={start}
            disabled={!text.trim()}
            className={cn(
              "inline-flex h-11 items-center gap-1.5 rounded-full bg-lake-600 px-5 text-[15px] font-medium text-white",
              "shadow-card transition-[background-color,box-shadow,transform] hover:bg-lake-700 active:scale-[0.98] disabled:bg-line-strong disabled:shadow-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            )}
          >
            开始规划
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {(mode === "outing" ? OUTING_EXAMPLES : EXAMPLES).map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className={cn(
              "rounded-2xl border border-line bg-surface/70 px-3.5 py-1.5 text-left text-sm text-ink-soft transition-colors sm:rounded-full",
              "hover:border-lake-200 hover:bg-lake-50 hover:text-lake-700",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
            )}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
