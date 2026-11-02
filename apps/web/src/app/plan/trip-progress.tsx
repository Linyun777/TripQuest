"use client";

import { CloudRain, Check, Footprints, LocateFixed, MapPin, MessageSquare, Navigation, SkipForward, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";
import { mountPlanningMap, type AmapApi, type AmapInstance, type MapOverlay } from "../journeys/amap-loader";
import type { PlanningMapConfig } from "../journeys/map-config";
import { durationText, estimateTrip, tripClock, type StopState, type TripEstimate, type TripProgressView } from "./trip-estimate";
import { EASE_OUT } from "../_ui/motion";
import { arrivalReminder, distanceTo, lateReminder, navigationUrl, rainReminder, USABLE_ACCURACY, type LivePoint, type Reminder } from "./trip-live";
import type { LiveLocation } from "./use-live-location";
import { PlatformLinks } from "./platform-links";
import { StopNotes, TripNotesBar, useTripNotes } from "./trip-notes";
import type { TripNotesView } from "./view-models";

/** 用设备时钟换算北京时间的日期与当天分钟数。 */
function chinaNow() {
  const local = new Date(Date.now() + 8 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), minute: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
}

/** 读取失败保留已有展示，后续操作或刷新继续尝试，避免暂时失败清空整张面板。 */
async function fetchProgress(journeyId: string): Promise<TripProgressView | null> {
  try {
    const response = await fetch(`/api/journeys/${journeyId}/trip-progress`, { cache: "no-store" });
    const reply: { status: string; view?: TripProgressView } = await response.json();
    return reply.status === "ok" && reply.view ? reply.view : null;
  } catch {
    return null;
  }
}

const MARK_FAILED: Record<string, string> = {
  stale: "行程刚在别处更新过，已为你刷新，请再点一次。",
  not_today: "行程当天才能标记完成或跳过。",
  invalid_report: "这一步不能这样标记（已完成的站不能撤回）。",
};

/**
 * 面板先实时读取事实，设备每 30 秒重算一次计划估算；完成或跳过则另发明确写入请求。
 * 时钟刷新不请求写入，实时坐标也不随报告保存。
 */
export function useTripProgress(journeyId: string | null, initial: TripProgressView | null = null) {
  const [view, setView] = useState<TripProgressView | null>(initial);
  const [now, setNow] = useState(chinaNow);
  const [marking, setMarking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!journeyId) return;
    const next = await fetchProgress(journeyId);
    if (next) setView(next);
  }, [journeyId]);

  // V2.11：出游里切换到别的天（另一个一日行程）时重新读取；首屏已带着同一个行程时不重复读。
  const first = useRef(true);
  useEffect(() => {
    const skip = first.current && !!initial && initial.journeyId === journeyId;
    first.current = false;
    if (skip || !journeyId) return;
    let live = true;
    void fetchProgress(journeyId).then((next) => {
      if (live && next) setView(next);
    });
    return () => {
      live = false;
    };
  }, [initial, journeyId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(chinaNow()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function mark(action: "complete" | "skip", activityId: string) {
    if (!view || marking) return;
    setMarking(activityId);
    setMessage(null);
    try {
      const response = await fetch(`/api/journeys/${view.journeyId}/trip-progress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          activityId,
          reportId: crypto.randomUUID(),
          basePlanVersion: view.planVersion,
          baseObservationVersion: view.observationVersion,
        }),
      });
      const reply: { status: string } = await response.json();
      if (!["saved", "already_saved", "no_change"].includes(reply.status)) setMessage(MARK_FAILED[reply.status] ?? "暂时没能记下，请稍后再试。");
      // 不乐观地改完成集合，写入后重读；双版本冲突时显示服务端新事实，避免在旧计划上继续点击。
      await reload();
    } catch {
      setMessage("暂时没能记下，请稍后再试。");
    } finally {
      setMarking(null);
    }
  }

  // 切换中的旧行程不显示（等新的一天读回来）。
  const current = view && view.journeyId === journeyId ? view : null;
  const today = !!current && current.date === now.date;
  // 仅行程当天每 30 分钟重读天气与用户标记，避免过期天气一直停留在页面。
  useEffect(() => {
    if (!today) return;
    const timer = setInterval(() => void reload(), 30 * 60_000);
    return () => clearInterval(timer);
  }, [today, reload]);
  // 时间推进只更新“预计在哪”，不会自动写 completed；实际完成事实必须来自用户的标记或确认。
  const estimate = useMemo(() => (current ? estimateTrip(current, now.minute, today) : null), [current, now.minute, today]);
  return { view: current, estimate, today, nowMinute: now.minute, mark, marking, message, reload };
}

export type TripProgressState = ReturnType<typeof useTripProgress>;

export function ProgressRing({ done, total, size = 44, stroke = 4, className }: { done: number; total: number; size?: number; stroke?: number; className?: string }) {
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const share = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("-rotate-90", className)} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-lake-100)" strokeWidth={stroke} />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-lake-600)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={length}
        initial={false}
        animate={{ strokeDashoffset: length * (1 - share) }}
        transition={{ duration: 0.3, ease: EASE_OUT }}
      />
    </svg>
  );
}

/** 摘要、地图与时间轴共用同一面板，聊天侧栏、手机弹层与行程页保持一致。 */
export function TripProgressPanel({
  state,
  mapConfig,
  onAdjust,
  onSuggest,
  live,
  showConversationLink = false,
}: {
  state: TripProgressState;
  mapConfig: PlanningMapConfig;
  /** 聊天页将光标移到输入框，仍由用户输入调整请求。 */
  onAdjust?: () => void;
  /** 只把建议填入聊天输入框，不自动发送，调整意图仍由用户确认。 */
  onSuggest?: (text: string) => void;
  /** 页面显式提供的设备定位状态，未开启时使用计划估算。 */
  live?: LiveLocation;
  showConversationLink?: boolean;
}) {
  const { view, estimate } = state;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // 用户点击后才为未完成站点查询出发须知。
  const tripNotes = useTripNotes(view ? `/api/journeys/${view.journeyId}/trip-notes` : null);
  const point = live?.point ?? null;
  const reminder = useMemo((): Reminder | null => {
    if (!view || !estimate || !state.today) return null;
    return arrivalReminder(view, estimate, live?.readings ?? [], dismissed) ??
      lateReminder(view, estimate, point, state.nowMinute, dismissed) ??
      rainReminder(view, state.nowMinute, state.today, dismissed);
  }, [view, estimate, live?.readings, point, state.nowMinute, state.today, dismissed]);
  if (!view || !estimate) {
    return <div className="grid h-40 place-items-center text-sm text-ink-faint">正在读取行程进度…</div>;
  }
  const dismiss = (key: string) => setDismissed((keys) => new Set([...keys, key]));
  const usable = point && point.accuracy <= USABLE_ACCURACY ? point : null;
  return (
    <div className="space-y-4">
      <Summary view={view} estimate={estimate} today={state.today} />
      {live && state.today && <LiveControl live={live} />}
      {reminder && (
        <ReminderBanner
          reminder={reminder}
          onDismiss={() => dismiss(reminder.key)}
          onDone={reminder.kind === "arrived" ? () => {
            dismiss(reminder.key);
            void state.mark("complete", view.stops[reminder.stop].activityId);
          } : undefined}
          onSuggest={onSuggest}
          conversationId={view.conversationId}
        />
      )}
      <ProgressMap view={view} estimate={estimate} config={mapConfig} live={point} />
      <TripNotesBar state={tripNotes.state} onLoad={() => void tripNotes.load()} />
      <Track state={state} view={view} estimate={estimate} live={usable} notes={tripNotes.state.status === "ready" ? tripNotes.state.notes : null} />
      {state.message && <p className="rounded-(--radius-field) bg-sun-50 px-3.5 py-2 text-sm text-sun-700">{state.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {onAdjust && (
          <Button size="sm" variant="secondary" onClick={onAdjust}>
            <MessageSquare />
            调整行程
          </Button>
        )}
        {showConversationLink && view.conversationId && (
          <Button asChild size="sm" variant="secondary">
            <Link href={`/plan/${view.conversationId}`}>
              <MessageSquare />
              去对话里调整
            </Link>
          </Button>
        )}
        <span className="text-xs text-ink-faint">
          {usable ? "蓝点是你的实时位置；距离按直线估算" : "位置按计划时间估算，不是实时定位"}
        </span>
      </div>
    </div>
  );
}

/** 点击才开启定位，用可读文字说明权限与读取状态。 */
function LiveControl({ live }: { live: LiveLocation }) {
  if (live.status === "unavailable") return null;
  const text = {
    off: null,
    asking: "正在定位…",
    on: live.point ? `实时位置 · 精度约 ${live.point.accuracy} 米${live.point.accuracy > USABLE_ACCURACY ? "（偏差较大，先不用来判断到站）" : ""}` : "正在定位…",
    denied: "没有定位权限：可以在浏览器设置里允许，现在按计划时间估算",
    error: "暂时定不到位置，现在按计划时间估算",
  }[live.status];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
      {live.status === "on" || live.status === "asking" ? (
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={live.stop}>
          <LocateFixed />
          关闭定位
        </Button>
      ) : (
        <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={live.start}>
          <MapPin />
          显示我的位置
        </Button>
      )}
      {text && <span>{text}</span>}
    </div>
  );
}

/** 一次展示一条建议，是否完成或调整仍由用户决定。 */
function ReminderBanner({
  reminder,
  onDismiss,
  onDone,
  onSuggest,
  conversationId,
}: {
  reminder: Reminder;
  onDismiss: () => void;
  onDone?: () => void;
  onSuggest?: (text: string) => void;
  conversationId: string | null;
}) {
  const content = reminder.kind === "arrived"
    ? { icon: MapPin, text: `到${reminder.name}了吗？`, suggest: null }
    : reminder.kind === "late"
      ? { icon: Footprints, text: `照现在的位置，到${reminder.name}步行还要约 ${reminder.walkMinutes} 分钟，可能会晚到。`, suggest: "我可能要晚到，帮我把后面的往后排" }
      : { icon: CloudRain, text: `${reminder.now ? "现在下雨了" : "今天晚些时候有雨"}，后面的${reminder.names.join("、")}在户外。`, suggest: `下雨了，把后面户外的${reminder.names.join("、")}换成室内的` };
  const Icon = content.icon;
  return (
    <motion.div
      initial={{ opacity: 0, transform: "translateY(-4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      role="status"
      className="flex items-start gap-2.5 rounded-(--radius-field) bg-sun-50 px-3.5 py-2.5 text-sm text-sun-700"
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{content.text}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {onDone && (
            <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onDone}>
              <Check />
              标记完成
            </Button>
          )}
          {content.suggest && onSuggest && (
            <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" onClick={() => onSuggest(content.suggest!)}>
              <MessageSquare />
              去调整
            </Button>
          )}
          {content.suggest && !onSuggest && conversationId && (
            <Button asChild size="sm" variant="secondary" className="h-7 px-2.5 text-xs">
              <Link href={`/plan/${conversationId}`}>
                <MessageSquare />
                去对话里调整
              </Link>
            </Button>
          )}
        </div>
      </div>
      <button type="button" onClick={onDismiss} aria-label="不用提醒" className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-sun-100">
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

function Summary({ view, estimate, today }: { view: TripProgressView; estimate: TripEstimate; today: boolean }) {
  const next = estimate.next ? view.stops[estimate.next.stop] : null;
  return (
    <div className="flex items-center gap-3.5">
      <div className="relative grid size-14 shrink-0 place-items-center">
        <ProgressRing done={estimate.done} total={estimate.total} size={56} stroke={5} className="absolute inset-0" />
        <span className="tabular text-sm font-semibold">{estimate.done}/{estimate.total}</span>
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-[15px] font-semibold">
          已完成 {estimate.done}/{estimate.total} 站
          <span className="rounded-full bg-lake-50 px-2 py-0.5 text-[11px] font-medium text-lake-700">
            第 {view.planVersion} 版{view.note ? ` · ${view.note}` : ""}
          </span>
        </p>
        <p className="tabular mt-0.5 text-sm text-ink-soft">
          {[
            today && estimate.remainingMinutes > 0 ? `还剩约 ${durationText(estimate.remainingMinutes)}` : null,
            next ? `下一站 ${tripClock(next.startsAt)} ${next.name}` : null,
          ].filter(Boolean).join(" · ") || estimate.label}
        </p>
      </div>
    </div>
  );
}

const DOT: Record<StopState, string> = {
  done: "bg-ink-faint text-white",
  skipped: "border-2 border-dashed border-line-strong bg-surface text-ink-faint",
  current: "bg-lake-600 text-white ring-4 ring-lake-100",
  // 目标站用稳定光晕，避免常驻面板持续闪烁；仅估算当前位置标记轻微呼吸。
  next: "bg-lake-600 text-white ring-4 ring-lake-100",
  overdue: "bg-sun-500 text-white",
  todo: "border-2 border-lake-500 bg-surface text-lake-600",
};
const STATE_TEXT: Partial<Record<StopState, string>> = {
  done: "已完成",
  skipped: "已跳过",
  current: "进行中",
  next: "下一站",
  overdue: "待确认",
};

/**
 * 时间轴填充到估算位置，完成和跳过标记保持用户事实。
 * 操作入口只开放给当前可处理项，历史归档不能再次标记。
 */
function Track({ state, view, estimate, live, notes }: {
  state: TripProgressState;
  view: TripProgressView;
  estimate: TripEstimate;
  live: LivePoint | null;
  notes: TripNotesView | null;
}) {
  const { position } = estimate;
  // 有可用定位时显示距目标站的距离，不再把按时钟估算的位置说成真实当前位置。
  const target = estimate.next ? view.stops[estimate.next.stop] : null;
  const liveLabel = live && target?.point
    ? (() => {
        const { meters, walkMinutes } = distanceTo(live, target.point);
        return meters < 80 ? `已在${target.name}附近` : `离${target.name}约 ${meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${meters} 米`}（步行约 ${walkMinutes} 分钟）`;
      })()
    : null;
  // 已走过路段画满，当前估算路段按比例填充，后续路段保持未走状态。
  const fill = (index: number) => {
    if (position.kind === "finished") return 1;
    if (position.kind === "before") return 0;
    if (position.kind === "travel" && position.to === index) return position.fraction;
    const reached = position.kind === "at" ? position.stop : position.to;
    return index < reached || (position.kind === "at" && index === reached) ? 1 : 0;
  };
  const actionable = new Set(view.stops.flatMap((stop, index) =>
    !stop.archived && stop.status === "todo" && ["current", "next", "overdue"].includes(estimate.states[index]) ? [index] : []));
  return (
    <ol className="relative">
      <TrackNode
        time={tripClock(view.window.startsAt)}
        name={view.start.name}
        label="出发"
        dot="bg-ink text-white"
        rail={null}
      />
      {/**
       * 只对新加入或状态改变的行执行进入、退出动画，首次展示不播放。
       * 动画按版本和活动身份区分，不能让新版本的旧状态残留在原位置。
       */}
      <AnimatePresence initial={false}>
      {view.stops.map((stop, index) => {
        const stateOf = estimate.states[index];
        const here = position.kind === "travel" && position.to === index;
        return (
          <motion.li
            key={`${stop.activityId}:${stop.status}`}
            initial={{ opacity: 0, transform: "translateY(6px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
          >
            {here && <NowMarker label={liveLabel ?? estimate.label} />}
            <TrackNode
              time={`${tripClock(stop.startsAt)}–${tripClock(stop.endsAt)}`}
              name={stop.name}
              label={STATE_TEXT[stateOf] ?? (stop.fixed ? "预约" : undefined)}
              dot={DOT[stateOf]}
              icon={stateOf === "done" ? <Check className="size-3" /> : stateOf === "skipped" ? <X className="size-3" /> : null}
              rail={stop.status === "skipped" ? null : fill(index)}
              muted={stateOf === "done" || stateOf === "skipped"}
            >
              {position.kind === "at" && position.stop === index && (
                <p className="mt-1 text-xs text-lake-700">{estimate.label}</p>
              )}
              {stop.status === "todo" && !stop.archived && <PlatformLinks name={stop.name} className="mt-1" />}
              {stop.status === "todo" && !stop.archived && <StopNotes stop={notes?.stops.find((entry) => entry.id === stop.activityId)} />}
              {actionable.has(index) && state.today && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => void state.mark("complete", stop.activityId)} disabled={!!state.marking}>
                    <Check />
                    完成
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => void state.mark("skip", stop.activityId)} disabled={!!state.marking}>
                    <SkipForward />
                    跳过
                  </Button>
                  {stop.point && (
                    <Button asChild size="sm" variant="secondary" className="h-7 px-2.5 text-xs">
                      <a href={navigationUrl({ to: { name: stop.name, point: stop.point }, mode: stop.arrivalMode })} target="_blank" rel="noopener noreferrer">
                        <Navigation />
                        导航
                      </a>
                    </Button>
                  )}
                </div>
              )}
            </TrackNode>
          </motion.li>
        );
      })}
      </AnimatePresence>
      {view.end && (
        <TrackNode time="" name={view.end.name} label="终点" dot="bg-ink text-white" rail={position.kind === "finished" ? 1 : 0} />
      )}
    </ol>
  );
}

function TrackNode({
  time,
  name,
  label,
  dot,
  icon = null,
  rail,
  muted = false,
  children,
}: {
  time: string;
  name: string;
  label?: string;
  dot: string;
  icon?: React.ReactNode;
  /** 节点上方路段的完成比例；首站和跳过项没有此路段，用 null 区分。 */
  rail: number | null;
  muted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative flex gap-3 pt-5 first:pt-0">
      {rail !== null && (
        <span aria-hidden="true" className="absolute left-[11px] -top-0 h-5 w-[3px] overflow-hidden rounded-full bg-lake-100">
          <motion.span
            className="block w-full rounded-full bg-lake-600"
            initial={false}
            animate={{ height: `${Math.round(rail * 100)}%` }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
          />
        </span>
      )}
      <span className="relative mt-0.5 grid size-[25px] shrink-0 place-items-center">
        <span className={cn("relative grid size-[25px] place-items-center rounded-full text-[11px] font-semibold", dot)}>{icon}</span>
      </span>
      <div className={cn("min-w-0 flex-1 pb-0.5", muted && "text-ink-faint")}>
        <p className="flex items-center gap-2 text-xs">
          <span className="tabular text-ink-soft">{time}</span>
          {label && <span className="rounded-full bg-sunken px-1.5 py-px text-[10px] font-medium text-ink-soft">{label}</span>}
        </p>
        <p className={cn("truncate text-[15px] font-medium", muted && "line-through decoration-ink-faint/50")}>{name}</p>
        {children}
      </div>
    </div>
  );
}

function NowMarker({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className="relative flex items-center gap-3 pt-5"
    >
      <span aria-hidden="true" className="absolute left-[11px] top-0 h-5 w-[3px] rounded-full bg-lake-600" />
      <span className="grid size-[25px] shrink-0 place-items-center rounded-full bg-sun-500 text-white shadow-[0_0_0_4px_var(--color-sun-100)]">
        <Footprints className="size-3.5" />
      </span>
      <span className="tabular rounded-full bg-sun-50 px-2.5 py-1 text-xs font-medium text-sun-700">{label}</span>
    </motion.div>
  );
}

// 地图展示与覆盖物更新。

type Node = { key: string; name: string; point: readonly [number, number] | null; state: StopState | "endpoint" };

/** 访问路径排除跳过项，估算标记可位于两个站点之间；这仍是按计划推演的位置。 */
function mapModel(view: TripProgressView, estimate: TripEstimate) {
  const path: Node[] = [
    { key: "start", name: view.start.name, point: view.start.point, state: "endpoint" },
    ...view.stops.flatMap((stop, index) => (stop.status === "skipped" ? [] : [{ key: stop.activityId, name: stop.name, point: stop.point, state: estimate.states[index] }])),
    ...(view.end ? [{ key: "end", name: view.end.name, point: view.end.point, state: "endpoint" as const }] : []),
  ];
  const skipped: Node[] = view.stops.flatMap((stop) => (stop.status === "skipped" ? [{ key: stop.activityId, name: stop.name, point: stop.point, state: "skipped" as const }] : []));
  const indexOf = (stop: number | "start") => (stop === "start" ? 0 : path.findIndex((node) => node.key === view.stops[stop].activityId));
  const { position } = estimate;
  // walked 表示路径中已走到哪个索引，you 表示当前估算段和段内比例。
  let walked = 0;
  let you: { leg: number; fraction: number } | null = null;
  if (position.kind === "finished") walked = path.length - 1;
  else if (position.kind === "at") {
    walked = indexOf(position.stop);
    you = { leg: walked, fraction: 0 };
  } else if (position.kind === "travel") {
    walked = indexOf(position.from);
    you = { leg: walked, fraction: position.fraction };
  } else you = { leg: 0, fraction: 0 };
  return { path, skipped, walked, you };
}

function ProgressMap({ view, estimate, config, live }: { view: TripProgressView; estimate: TripEstimate; config: PlanningMapConfig; live: LivePoint | null }) {
  const model = useMemo(() => mapModel(view, estimate), [view, estimate]);
  const hasLive = live !== null;
  const located = model.path.every((node) => node.point) && model.skipped.every((node) => node.point);
  const mapKey = config.mode === "amap" && located ? config.key : "";
  const serviceHost = config.mode === "amap" ? config.serviceHost : "";
  const container = useRef<HTMLDivElement>(null);
  const current = useRef<{ api: AmapApi; map: AmapInstance } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!mapKey || !container.current) return;
    const dispose = mountPlanningMap({
      container: container.current,
      key: mapKey,
      serviceHost,
      center: [...model.path[0].point!] as [number, number],
      onReady: (api, map) => {
        current.current = { api, map };
        setStatus("ready");
      },
      onError: () => setStatus("error"),
    });
    return () => {
      current.current = null;
      dispose();
    };
    // 每个 Key 只建一个地图实例，覆盖物由后续数据变化单独更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, serviceHost]);

  useEffect(() => {
    if (status !== "ready" || !current.current) return;
    const { api, map } = current.current;
    const remove = drawProgress(api, map, model, hasLive);
    return () => {
      // 卸载时先销毁地图，其覆盖物随实例释放，避免再操作已销毁对象。
      if (current.current?.map === map) remove();
    };
  }, [model, status, hasLive]);

  // 设备点复用一个可移动标记；新定位不重画计划、不重新适配视角，
  // 避免手机高频定位使地图不断跳动。
  const dot = useRef<{ marker: MapOverlay; content: HTMLDivElement } | null>(null);
  useEffect(() => {
    if (status !== "ready" || !current.current) return;
    const { api, map } = current.current;
    if (!live) {
      if (dot.current) map.remove([dot.current.marker]);
      dot.current = null;
      return;
    }
    const position: [number, number] = [live.longitude, live.latitude];
    if (!dot.current) {
      const content = document.createElement("div");
      content.className = "relative grid size-8 place-items-center";
      content.innerHTML = '<span class="absolute inset-0 animate-ping rounded-full bg-[#2f6fd6]/35"></span><span class="relative size-4 rounded-full border-[3px] border-white bg-[#2f6fd6] shadow"></span>';
      content.title = "我的位置";
      dot.current = { marker: new api.Marker({ position, content, anchor: "center" }), content };
      map.add([dot.current.marker]);
    } else {
      dot.current.marker.setPosition?.(position);
    }
    // 定位精度差时弱化标记，避免视觉上暗示位置非常确定。
    dot.current.content.style.opacity = live.accuracy > USABLE_ACCURACY ? "0.5" : "1";
  }, [live, status]);
  useEffect(() => () => {
    if (dot.current && current.current) current.current.map.remove([dot.current.marker]);
    dot.current = null;
  }, []);

  const point = live;
  const ready = mapKey !== "" && status === "ready";
  return (
    <div className="relative overflow-hidden rounded-(--radius-card) border border-line bg-lake-50">
      <div ref={container} className="h-64 w-full" />
      {!ready && (
        <div className="absolute inset-0 bg-lake-50">
          <ProgressSchematic model={model} />
        </div>
      )}
      <p className="absolute left-3 top-3 rounded-full bg-surface/85 px-2.5 py-0.5 text-[11px] text-ink-faint backdrop-blur">
        {ready ? (point ? "高德地图 · 实时位置" : "高德地图 · 按计划估算的位置") : "示意图 · 按计划估算的位置"}
      </p>
    </div>
  );
}

const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function youPoint(model: ReturnType<typeof mapModel>): [number, number] | null {
  if (!model.you) return null;
  const from = model.path[model.you.leg]?.point;
  const to = model.path[model.you.leg + 1]?.point ?? from;
  return from && to ? lerp(from, to, model.you.fraction) : null;
}

/** 已走部分画实线，后续画虚线，估算位置另用轻微脉冲标记；这些线只表达进度。 */
function drawProgress(api: AmapApi, map: AmapInstance, model: ReturnType<typeof mapModel>, hasLive: boolean) {
  const overlays: MapOverlay[] = [];
  const points = model.path.map((node) => [...node.point!] as [number, number]);
  const you = youPoint(model);
  const walked = you ? [...points.slice(0, model.walked + 1), you] : points.slice(0, model.walked + 1);
  const ahead = you ? [you, ...points.slice(model.walked + 1)] : points.slice(model.walked);
  if (walked.length > 1) overlays.push(new api.Polyline({ path: walked, strokeColor: "#1f7159", strokeWeight: 5, strokeStyle: "solid" }));
  if (ahead.length > 1) overlays.push(new api.Polyline({ path: ahead, strokeColor: "#2f8a6f", strokeWeight: 3, strokeStyle: "dashed" }));
  const chip = (node: Node, label: string) => {
    const element = document.createElement("span");
    element.title = node.name;
    element.className = [
      "grid size-7 place-items-center rounded-full border-[2.5px] text-[11px] font-semibold",
      node.state === "done" ? "border-white bg-ink-faint text-white"
        : node.state === "skipped" ? "border-dashed border-line-strong bg-surface text-ink-faint"
          : node.state === "endpoint" ? "border-white bg-ink text-white"
            : node.state === "todo" ? "border-lake-500 bg-surface text-lake-600"
              : node.state === "overdue" ? "border-white bg-sun-500 text-white"
                : "border-white bg-lake-600 text-white ring-4 ring-lake-500/25",
    ].join(" ");
    element.textContent = label;
    return element;
  };
  const labelled = [
    ...model.path.map((node, index) => ({ node, label: node.state === "done" ? "✓" : node.state === "endpoint" ? (index === 0 ? "起" : "终") : String(index) })),
    ...model.skipped.map((node) => ({ node, label: "×" })),
  ];
  // 相距几十米的地点合并标记并并排显示标签，避免地图缩放时互相遮挡。
  for (const group of nearbyGroups(labelled, (item) => item.node.point!)) {
    const content = document.createElement("div");
    content.className = "flex gap-0.5 rounded-full shadow-[0_4px_12px_rgb(23_33_29/0.22)]";
    content.title = group.map((item) => item.node.name).join("、");
    for (const item of group) content.append(chip(item.node, item.label));
    overlays.push(new api.Marker({ position: [...group[0].node.point!] as [number, number], content, anchor: "bottom-center" }));
  }
  // 启用设备位置时用独立设备点替换估算点，避免两个“当前位置”同时出现。
  if (you && !hasLive) {
    // 估算标记层级略低于站点，不遮挡地点点击区域。
    const content = document.createElement("div");
    content.className = "relative grid size-8 place-items-center";
    content.innerHTML = '<span class="absolute inset-0 animate-ping rounded-full bg-[#e07b39]/40"></span><span class="relative size-4 rounded-full border-[3px] border-white bg-[#e07b39] shadow"></span>';
    content.title = "预计在这里";
    overlays.push(new api.Marker({ position: you, content, anchor: "top-center" }));
  }
  map.add(overlays);
  map.setFitView(overlays, true, [48, 48, 48, 48], 16);
  return () => map.remove(overlays);
}

/** 约 60 米内视为视觉重叠组，便于同楼或近邻站点合并展示，不合并业务活动身份。 */
function nearbyGroups<T>(items: readonly T[], at: (item: T) => readonly [number, number], within = 0.0006): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const [x, y] = at(item);
    const group = groups.find((entry) => Math.abs(at(entry[0])[0] - x) < within && Math.abs(at(entry[0])[1] - y) < within);
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** 无底图时优先按实时坐标排示意图，未知坐标则沿曲线均匀摆放。 */
function ProgressSchematic({ model }: { model: ReturnType<typeof mapModel> }) {
  const all = [...model.path, ...model.skipped];
  const located = all.every((node) => node.point);
  const xs = all.map((node) => node.point?.[0] ?? 0);
  const ys = all.map((node) => node.point?.[1] ?? 0);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const at = (node: Node, index: number, count: number): [number, number] => {
    if (located && node.point) {
      return [
        minX === maxX ? 200 : 40 + ((node.point[0] - minX) / (maxX - minX)) * 320,
        minY === maxY ? 128 : 216 - ((node.point[1] - minY) / (maxY - minY)) * 176,
      ];
    }
    const t = count > 1 ? index / (count - 1) : 0.5;
    return [40 + t * 320, 128 + Math.sin(t * Math.PI * 1.6) * 52];
  };
  const pathPoints = model.path.map((node, index) => at(node, index, model.path.length));
  const skippedPoints = model.skipped.map((node, index) => {
    if (located) return at(node, 0, 1);
    const base = pathPoints[Math.min(pathPoints.length - 1, index + 1)];
    return [base[0] + 18, base[1] - 42] as [number, number];
  });
  // 极近地点在示意图中适当错开，仅改变显示位置，不改原坐标或计划顺序。
  const drawn: [number, number][] = [];
  for (const point of [...pathPoints, ...skippedPoints]) {
    while (drawn.some((other) => Math.abs(other[0] - point[0]) < 24 && Math.abs(other[1] - point[1]) < 24)) point[0] += 30;
    drawn.push(point);
  }
  const you = model.you ? lerp(pathPoints[model.you.leg], pathPoints[model.you.leg + 1] ?? pathPoints[model.you.leg], model.you.fraction) : null;
  const walked = you ? [...pathPoints.slice(0, model.walked + 1), you] : pathPoints.slice(0, model.walked + 1);
  const ahead = you ? [you, ...pathPoints.slice(model.walked + 1)] : pathPoints.slice(model.walked);
  const line = (points: readonly (readonly [number, number])[]) => points.map((point) => point.join(",")).join(" ");
  return (
    <svg viewBox="0 0 400 256" role="img" aria-label="按计划估算的进度示意" className="h-64 w-full">
      <defs>
        <pattern id="progress-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="var(--color-lake-100)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="400" height="256" fill="url(#progress-grid)" />
      {ahead.length > 1 && (
        <polyline points={line(ahead)} fill="none" stroke="var(--color-lake-500)" strokeOpacity="0.6" strokeWidth="2.5" strokeDasharray="2 7" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {walked.length > 1 && (
        <motion.polyline
          points={line(walked)}
          fill="none"
          stroke="var(--color-lake-600)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: EASE_OUT }}
        />
      )}
      {model.skipped.map((node, index) => (
        <g key={node.key} opacity="0.7">
          <circle cx={skippedPoints[index][0]} cy={skippedPoints[index][1]} r="10" fill="var(--color-surface)" stroke="var(--color-line-strong)" strokeWidth="2" strokeDasharray="3 3" />
          <text x={skippedPoints[index][0]} y={skippedPoints[index][1] + 4} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">×</text>
        </g>
      ))}
      {model.path.map((node, index) => {
        const [x, y] = pathPoints[index];
        const pulse = node.state === "next" || node.state === "current";
        const fill = node.state === "done" ? "var(--color-ink-faint)"
          : node.state === "endpoint" ? "var(--color-ink)"
            : node.state === "todo" ? "var(--color-surface)"
              : node.state === "overdue" ? "var(--color-sun-500)" : "var(--color-lake-600)";
        const text = node.state === "todo" ? "var(--color-lake-600)" : "white";
        return (
          <g key={node.key}>
            {/** 下一站光晕保持稳定，只有下方估算标记做轻微脉冲，减少常驻动效干扰。 */}
            {pulse && <circle cx={x} cy={y} r="19" fill="var(--color-lake-500)" opacity="0.18" />}
            <circle cx={x} cy={y} r="13" fill={fill} stroke={node.state === "todo" ? "var(--color-lake-500)" : "white"} strokeWidth={node.state === "todo" ? 2.5 : 3} />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={text}>
              {node.state === "done" ? "✓" : node.state === "endpoint" ? (index === 0 ? "起" : "终") : index}
            </text>
            <text x={x} y={y + 29} textAnchor="middle" fontSize="10.5" fill="var(--color-ink-soft)">
              {node.name.length > 7 ? `${node.name.slice(0, 7)}…` : node.name}
            </text>
          </g>
        );
      })}
      {you && (
        <g>
          <motion.circle cx={you[0]} cy={you[1]} r="9" fill="var(--color-sun-500)" initial={{ opacity: 0.45, scale: 1 }}
            animate={{ opacity: 0, scale: 2.2 }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
            style={{ transformOrigin: `${you[0]}px ${you[1]}px` }} />
          <motion.circle cx={you[0]} cy={you[1]} r="7" fill="var(--color-sun-500)" stroke="white" strokeWidth="3"
            initial={false} animate={{ cx: you[0], cy: you[1] }} transition={{ duration: 0.8 }} />
          <text x={you[0]} y={you[1] - 14} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="var(--color-sun-700)">预计在这里</text>
        </g>
      )}
    </svg>
  );
}

// 手机端入口与进度弹层。

/** 手机用可拖动小球展示进度和下一站，点击打开同一套面板，拖动仅用于避让聊天内容。 */
export function ProgressBall({ state, onOpen }: { state: TripProgressState; onOpen: () => void }) {
  const { view, estimate } = state;
  const bounds = useRef<HTMLDivElement>(null);
  if (!view || !estimate) return null;
  const next = estimate.next ? view.stops[estimate.next.stop] : null;
  return (
    <div ref={bounds} className="pointer-events-none fixed inset-x-3 bottom-32 top-20 z-30 lg:hidden">
      <motion.button
        type="button"
        drag
        dragConstraints={bounds}
        dragMomentum={false}
        dragElastic={0.12}
        whileTap={{ scale: 0.94 }}
        onClick={onOpen}
        aria-label={`行程进度：已完成 ${estimate.done}/${estimate.total} 站`}
        // 默认放在右侧略低于中线，允许用户拖到不遮挡内容的位置。
        className="pointer-events-auto absolute right-0 top-[55%] flex touch-none items-center gap-2"
      >
        {next && (
          <span className="tabular rounded-full bg-surface/95 px-2.5 py-1 text-xs font-medium text-ink shadow-card backdrop-blur">
            下一站 {tripClock(next.startsAt)}
          </span>
        )}
        <span className="relative grid size-14 place-items-center rounded-full bg-surface shadow-float">
          <ProgressRing done={estimate.done} total={estimate.total} size={50} stroke={4} className="absolute" />
          <span className="tabular text-[13px] font-semibold text-lake-700">{estimate.done}/{estimate.total}</span>
          {estimate.position.kind === "travel" && (
            <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-surface bg-sun-500" />
          )}
        </span>
      </motion.button>
    </div>
  );
}
