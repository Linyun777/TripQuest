/**
 * 根据计划时刻与用户标记估算进度，页面明确标为估算。
 * 时钟推演不能替代设备定位，也不能自动产生“已完成”的业务事实。
 */

export type TripStopView = {
  readonly activityId: string;
  readonly name: string;
  /** 自有计划中的当天分钟数。 */
  readonly startsAt: number;
  readonly endsAt: number;
  readonly status: "done" | "skipped" | "todo";
  /** 早期版本留下的归档项只展示，不再允许重新标记。 */
  readonly archived: boolean;
  readonly fixed: boolean;
  /** 本次实时查到的坐标只用于渲染，查询失败为 null，不从存储兜底恢复。 */
  readonly point: readonly [number, number] | null;
  /** 室外判断来自本次查点的高德类别，只用于天气提醒。 */
  readonly outdoor?: boolean;
  /** 到达本站的计划交通方式，旧记录缺失时按步行展示。 */
  readonly arrivalMode?: "walking" | "transit" | "taxi" | "bicycling" | "driving";
};

export type TripProgressView = {
  readonly journeyId: string;
  readonly conversationId: string | null;
  readonly title: string;
  readonly date: string;
  readonly planVersion: number;
  readonly observationVersion: number;
  readonly note: string | null;
  readonly window: { readonly startsAt: number; readonly endsAt: number };
  /** 本版从何时继续；第一版使用当天出发时间。 */
  readonly resumeAt: number;
  readonly start: { readonly name: string; readonly point: readonly [number, number] | null };
  /** 短途终止于最后一站时没有单独返程终点。 */
  readonly end: { readonly name: string; readonly point: readonly [number, number] | null } | null;
  /** 按时间展示早期版本归档与当前版本未来安排，两个区域的事实来源不同。 */
  readonly stops: readonly TripStopView[];
  /** 本次实时天气描述，不长期保存；查不到时为 null，不能按晴天处理。 */
  readonly weather?: { readonly now: string | null; readonly day: string | null; readonly night: string | null } | null;
};

export type StopState = "done" | "skipped" | "current" | "next" | "overdue" | "todo";

export type TripEstimate = {
  readonly states: readonly StopState[];
  readonly done: number;
  /** 计入进度的访问项总数，跳过项不进入分母。 */
  readonly total: number;
  /** 估算在访问路径中的位置，以站点索引和下一段比例表示，不是实际地理坐标。 */
  readonly position:
    | { readonly kind: "before" }
    | { readonly kind: "at"; readonly stop: number }
    | { readonly kind: "travel"; readonly from: number | "start"; readonly to: number; readonly fraction: number; readonly minutesLeft: number }
    | { readonly kind: "finished" };
  readonly next: { readonly stop: number; readonly startsAt: number } | null;
  /** 按计划到最后一站结束的剩余分钟数。 */
  readonly remainingMinutes: number;
  readonly label: string;
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 当前路段在前站结束与后站开始之间插值；版本首段从本版恢复时刻起算。
 * 重排后的归档时刻属于历史计划，不能继续用作新版本的出发依据。
 */
export function estimateTrip(view: TripProgressView, nowMinute: number, today: boolean): TripEstimate {
  const states: StopState[] = view.stops.map((stop) => (stop.status === "done" ? "done" : stop.status === "skipped" ? "skipped" : "todo"));
  const visits = view.stops.map((stop, index) => ({ stop, index })).filter(({ stop }) => stop.status !== "skipped");
  const done = visits.filter(({ stop }) => stop.status === "done").length;
  const total = visits.length;
  const last = visits.at(-1)?.stop.endsAt ?? view.window.endsAt;
  const k = visits.findIndex(({ stop }) => stop.status !== "done");
  const remainingMinutes = today ? Math.max(0, last - Math.max(nowMinute, view.window.startsAt)) : 0;
  if (k < 0) {
    return { states, done, total, position: { kind: "finished" }, next: null, remainingMinutes: 0, label: "今天的安排都完成了" };
  }
  const target = visits[k];
  const previous = k > 0 ? visits[k - 1] : null;
  const legStart = previous && !previous.stop.archived ? previous.stop.endsAt : view.resumeAt;
  const nextOf = (offset: number) => {
    const item = visits[k + offset];
    return item ? { stop: item.index, startsAt: item.stop.startsAt } : null;
  };
  if (!today || nowMinute < view.window.startsAt) {
    states[target.index] = "next";
    return {
      states, done, total, position: { kind: "before" }, next: nextOf(0), remainingMinutes,
      label: today ? `${clock(target.stop.startsAt)} 到${target.stop.name}` : `行程当天开始后，这里会估算进度`,
    };
  }
  if (nowMinute >= target.stop.endsAt) {
    // 时间已过但用户未标记时显示逾时待确认，不能自动跳到下一站或算作完成。
    states[target.index] = "overdue";
    if (visits[k + 1]) states[visits[k + 1].index] = "next";
    return {
      states, done, total, position: { kind: "at", stop: target.index }, next: nextOf(1), remainingMinutes,
      label: `按计划${target.stop.name}已结束，去过了可以标记完成`,
    };
  }
  if (nowMinute >= target.stop.startsAt) {
    states[target.index] = "current";
    if (visits[k + 1]) states[visits[k + 1].index] = "next";
    return {
      states, done, total, position: { kind: "at", stop: target.index }, next: nextOf(1), remainingMinutes,
      label: `${clock(nowMinute)} · 在${target.stop.name}，计划到 ${clock(target.stop.endsAt)}`,
    };
  }
  states[target.index] = "next";
  // 这里只是在计划时间轴上插值，比例限制在 0～1；负间隔或零长度不能制造越界的地图位置。
  const length = Math.max(1, target.stop.startsAt - legStart);
  const fraction = Math.min(1, Math.max(0, (nowMinute - legStart) / length));
  const minutesLeft = target.stop.startsAt - nowMinute;
  return {
    states, done, total,
    position: { kind: "travel", from: previous ? previous.index : "start", to: target.index, fraction, minutesLeft },
    next: nextOf(0), remainingMinutes,
    label: nowMinute < legStart
      ? `${clock(nowMinute)} · ${clock(legStart)} 出发去${target.stop.name}`
      : `${clock(nowMinute)} · 去往${target.stop.name}，约 ${minutesLeft} 分钟到`,
  };
}

/** "2 小时 10 分" */
export function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分` : ""}` : `${rest} 分钟`;
}

export { clock as tripClock };
