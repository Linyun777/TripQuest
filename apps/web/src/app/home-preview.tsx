"use client";

import { CloudRain, Footprints, Hotel, Sun, TrainFront } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Badge } from "./_ui/badge";
import { usePlanMode } from "./_ui/mode";
import { EASE_OUT, SPRING_BOUNCY, SPRING_SNAPPY } from "./_ui/motion";

// Decorative samples for the home page; hand-written, not provider data.
const DAILY_STOPS = [
  { time: "09:25", name: "中国越剧博物馆", reason: "室内展馆 · 贴合“越剧相关”", walk: "步行 22 分钟" },
  { time: "11:20", name: "晓风书屋", reason: "安静书店 · 顺路衔接午休", walk: "步行 18 分钟" },
  { time: "14:00", name: "浙江省博物馆", reason: "固定预约 · 准时抵达", walk: "步行 22 分钟", fixed: true },
];

const OUTING_DAYS = [
  { tag: "Day 1", title: "高铁抵苏 · 平江路与苏博", meta: "G7509 · 10:12 抵达", icon: TrainFront },
  { tag: "住处", title: "观前街附近连住两晚", meta: "按路线顺路暂定，可换", icon: Hotel },
  { tag: "Day 2", title: "拙政园 · 狮子林 · 山塘夜景", meta: "晴 16–24° · 节奏轻松", icon: Sun },
];

/**
 * 首页与登录页右侧的莫兰迪毛玻璃手账贴纸卡：
 * 保留随手一贴的微斜贴纸感（叠放背卡 + 半透明和纸胶带 + 反向微斜悬浮对话贴纸），
 * 日常 ↔ 出游切换时带真实的揭贴回弹动效，桌面悬停可轻轻扶正浮起。
 */
export function HomePreview() {
  const { mode } = usePlanMode();
  const reduced = useReducedMotion();
  const isDaily = mode === "daily";

  const stickerEnter = isDaily
    ? { opacity: 0, filter: "blur(4px)", transform: "translateY(14px) scale(0.95) rotate(-2.8deg)" }
    : { opacity: 0, filter: "blur(4px)", transform: "translateY(14px) scale(0.95) rotate(2.8deg)" };

  const stickerExit = isDaily
    ? { opacity: 0, filter: "blur(3px)", transform: "translateY(-10px) scale(0.96) rotate(2.5deg)" }
    : { opacity: 0, filter: "blur(3px)", transform: "translateY(-10px) scale(0.96) rotate(-2.5deg)" };

  return (
    <div className="group relative mx-auto w-full max-w-sm select-none py-3" aria-hidden="true">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={reduced ? { opacity: 0 } : stickerEnter}
          animate={{
            opacity: 1,
            filter: "blur(0px)",
            transform: "translateY(0px) scale(1) rotate(0deg)",
            transition: reduced ? { duration: 0.16 } : SPRING_BOUNCY,
          }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0.12 } }
              : { ...stickerExit, transition: { duration: 0.18, ease: EASE_OUT } }
          }
          className="relative"
        >
          {/* 背后叠放的莫兰迪半透明票根底卡：营造随手叠贴的实体厚度 */}
          <div
            className={
              isDaily
                ? "pointer-events-none absolute inset-x-2 inset-y-1 rounded-[26px] border border-white/65 bg-lake-100/50 backdrop-blur-md shadow-card transition-transform duration-300 ease-(--ease-out) -rotate-[2.8deg] translate-y-1 group-hover:-rotate-[3.6deg] group-hover:translate-y-1.5"
                : "pointer-events-none absolute inset-x-2 inset-y-1 rounded-[26px] border border-white/65 bg-lake-100/50 backdrop-blur-md shadow-card transition-transform duration-300 ease-(--ease-out) rotate-[2.8deg] translate-y-1 group-hover:rotate-[3.6deg] group-hover:translate-y-1.5"
            }
          />

          {/* 主毛玻璃手账贴纸卡（微斜 + 悬停柔和扶正上浮） */}
          <div
            className={
              isDaily
                ? "relative transition-transform duration-300 ease-(--ease-out) rotate-[1.6deg] group-hover:rotate-[0.45deg] group-hover:-translate-y-1"
                : "relative transition-transform duration-300 ease-(--ease-out) -rotate-[1.6deg] group-hover:-rotate-[0.45deg] group-hover:-translate-y-1"
            }
          >
            {/* 顶部半透明莫兰迪和纸胶带 */}
            <span
              className={
                isDaily
                  ? "pointer-events-none absolute -top-2.5 left-1/2 z-20 h-5 w-20 -translate-x-1/2 -rotate-[2.4deg] rounded-[4px] border border-white/70 bg-lake-200/55 shadow-[0_2px_8px_-3px_rgb(38_43_45/0.18)] backdrop-blur-md"
                  : "pointer-events-none absolute -top-2.5 left-1/2 z-20 h-5 w-20 -translate-x-1/2 rotate-[2.4deg] rounded-[4px] border border-white/70 bg-lake-200/55 shadow-[0_2px_8px_-3px_rgb(38_43_45/0.18)] backdrop-blur-md"
              }
            />

            <div className="glass-card relative overflow-hidden rounded-[26px] px-5 pb-6 pt-5">
              {isDaily ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-medium text-lake-600">日常示例</p>
                      <p className="mt-0.5 text-[15px] font-semibold text-ink">
                        西湖边的越剧与书店之旅
                      </p>
                    </div>
                    <Badge tone="rain">
                      <CloudRain />
                      小雨 17–23°
                    </Badge>
                  </div>

                  <ol className="mt-4 space-y-2.5">
                    {DAILY_STOPS.map((stop, index) => (
                      <motion.li
                        key={stop.name}
                        initial={reduced ? false : { opacity: 0, transform: "translateY(8px)" }}
                        animate={{ opacity: 1, transform: "translateY(0px)" }}
                        transition={
                          reduced
                            ? { duration: 0.12 }
                            : { ...SPRING_SNAPPY, delay: 0.06 + index * 0.05 }
                        }
                      >
                        {index > 0 && (
                          <p className="mb-1.5 flex items-center gap-1 pl-13 text-[11px] text-ink-faint">
                            <Footprints className="size-3" />
                            {stop.walk}
                          </p>
                        )}
                        <div className="flex items-center gap-3">
                          <span className="tabular w-10 shrink-0 text-right text-xs font-medium text-ink-soft">
                            {stop.time}
                          </span>
                          <div className="min-w-0 flex-1 rounded-2xl border border-white/85 bg-white/62 px-3.5 py-2 shadow-[0_2px_10px_-6px_rgb(38_43_45/0.12)]">
                            <p className="flex items-center gap-2 text-sm font-medium text-ink">
                              <span className="grid size-4.5 shrink-0 place-items-center rounded-full bg-lake-600 text-[10px] font-semibold text-white">
                                {index + 1}
                              </span>
                              <span className="truncate">{stop.name}</span>
                              {stop.fixed && <Badge tone="sun">固定</Badge>}
                            </p>
                            <p className="mt-0.5 text-xs text-ink-soft">{stop.reason}</p>
                          </div>
                        </div>
                      </motion.li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-medium text-lake-600">出游示例 · 3 天 2 晚</p>
                      <p className="mt-0.5 text-[15px] font-semibold text-ink">
                        苏州园林与古镇慢游
                      </p>
                    </div>
                    <Badge tone="lake">高铁往返</Badge>
                  </div>

                  <ol className="mt-4 space-y-2.5">
                    {OUTING_DAYS.map((item, index) => {
                      const Icon = item.icon;
                      return (
                        <motion.li
                          key={item.tag}
                          initial={reduced ? false : { opacity: 0, transform: "translateY(8px)" }}
                          animate={{ opacity: 1, transform: "translateY(0px)" }}
                          transition={
                            reduced
                              ? { duration: 0.12 }
                              : { ...SPRING_SNAPPY, delay: 0.06 + index * 0.05 }
                          }
                          className="flex items-start gap-3 rounded-2xl border border-white/85 bg-white/62 px-3.5 py-2.5 shadow-[0_2px_10px_-6px_rgb(38_43_45/0.12)]"
                        >
                          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-xl bg-lake-50 text-lake-600">
                            <Icon className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-semibold text-lake-700">
                                {item.tag}
                              </span>
                              <span className="truncate text-sm font-medium text-ink">
                                {item.title}
                              </span>
                            </div>
                            <p className="mt-0.5 text-xs text-ink-soft">{item.meta}</p>
                          </div>
                        </motion.li>
                      );
                    })}
                  </ol>
                </>
              )}
            </div>
          </div>

          {/* 右下角反向微斜的悬浮对话贴纸：外层负责弹性落位，内层负责微斜贴纸与悬停上浮 */}
          <motion.div
            initial={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, transform: "translateY(10px) scale(0.92)" }
            }
            animate={{
              opacity: 1,
              transform: "translateY(0px) scale(1)",
              transition: reduced ? { duration: 0.14 } : { ...SPRING_BOUNCY, delay: 0.14 },
            }}
            className="relative z-20 -mt-3.5 ml-auto mr-[-8px] w-fit"
          >
            <div
              className={
                isDaily
                  ? "morandi-cta rounded-[20px] rounded-br-[6px] px-4 py-2.5 text-[13px] font-medium text-white ring-2 ring-white/80 transition-transform duration-300 ease-(--ease-out) -rotate-[2.2deg] group-hover:-rotate-[0.9deg] group-hover:-translate-y-0.5"
                  : "morandi-cta rounded-[20px] rounded-br-[6px] px-4 py-2.5 text-[13px] font-medium text-white ring-2 ring-white/80 transition-transform duration-300 ease-(--ease-out) rotate-[2.2deg] group-hover:rotate-[0.9deg] group-hover:-translate-y-0.5"
              }
            >
              {isDaily ? "下午有点累，书店换个近一点的？" : "第二天想多睡会儿，9 点半再出门"}
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
