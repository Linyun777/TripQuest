import { straightMeters } from "@tripquest/application/leg-choice";
import type { TripEstimate, TripProgressView } from "./trip-estimate";
import type { TravelModeView } from "./view-models";

/**
 * 纯函数组合设备位置与天气，设备点平时只留在页面内存。
 * 只有用户主动要求“从我这里重新排”时，才单次发送给服务端解析附近地点。
 */

/** 已转换为高德 GCJ-02 的设备读数，accuracy 单位为米。 */
export type LivePoint = {
  readonly longitude: number;
  readonly latitude: number;
  readonly accuracy: number;
  /** 本次设备读数的毫秒时间戳。 */
  readonly at: number;
};

/**
 * 在浏览器内将 WGS-84 设备读数按公开正向公式转换为 GCJ-02，避免地图坐标系错位。
 * 2026-10-18 已与高德转换对照三个杭州点，误差在 5 厘米内；转换本身无需发送设备点。
 */
export function deviceToAmap(longitude: number, latitude: number): [number, number] {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  const x = longitude - 105;
  const y = latitude - 35;
  const lat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) +
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3 +
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3 +
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  const lng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) +
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3 +
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3 +
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  const radians = (latitude / 180) * Math.PI;
  const magic = 1 - ee * Math.sin(radians) ** 2;
  const root = Math.sqrt(magic);
  return [
    longitude + (lng * 180) / ((a / root) * Math.cos(radians) * Math.PI),
    latitude + (lat * 180) / (((a * (1 - ee)) / (magic * root)) * Math.PI),
  ];
}

/** 精度差于此阈值的点只展示误差范围，不触发到达或晚到推断。 */
export const USABLE_ACCURACY = 100;
const ARRIVED_WITHIN = 80;
const WALK_METERS_PER_MINUTE = 70;
const LATE_LOOKAHEAD = 15;
const LATE_WALK_MINUTES = 25;

const meters = (point: LivePoint, target: readonly [number, number]) =>
  straightMeters({ longitude: point.longitude, latitude: point.latitude, coordinateSystem: "gcj02" },
    { longitude: target[0], latitude: target[1], coordinateSystem: "gcj02" });

/** 直线距离与粗略步行分钟数只作提示，文案显示“约”，不能作为排程路线证据。 */
export function distanceTo(point: LivePoint, target: readonly [number, number]) {
  const value = Math.round(meters(point, target));
  return { meters: value, walkMinutes: Math.max(1, Math.round(value / WALK_METERS_PER_MINUTE)) };
}

/** 高德导航 URI 没有独立打车模式，打车路段打开驾车导航，应用内可继续选择打车。 */
const AMAP_MODE: Record<TravelModeView, string> = {
  walking: "walk",
  transit: "bus",
  bicycling: "ride",
  driving: "car",
  taxi: "car",
};

/** 构造高德导航链接，手机通过 callnative 尝试唤起应用；未指定起点时由高德读取手机位置。 */
export function navigationUrl(input: {
  to: { name: string; point: readonly [number, number] };
  from?: { name: string; point: readonly [number, number] } | null;
  mode?: TravelModeView;
}): string {
  const at = (place: { name: string; point: readonly [number, number] }) =>
    `${place.point[0].toFixed(6)},${place.point[1].toFixed(6)},${place.name.slice(0, 40)}`;
  const query = new URLSearchParams({
    ...(input.from ? { from: at(input.from) } : {}),
    to: at(input.to),
    mode: AMAP_MODE[input.mode ?? "walking"],
    src: "tripquest",
    callnative: "1",
  });
  return `https://uri.amap.com/navigation?${query.toString()}`;
}

export type Reminder =
  | { readonly kind: "arrived"; readonly key: string; readonly stop: number; readonly name: string }
  | { readonly kind: "late"; readonly key: string; readonly stop: number; readonly name: string; readonly walkMinutes: number }
  | { readonly kind: "rain"; readonly key: string; readonly names: readonly string[]; readonly now: boolean };

/** 优先取估算中的当前或逾时站点，没有则取下一站，作为提醒目标。 */
function targetStop(view: TripProgressView, estimate: TripEstimate): number | null {
  const current = estimate.states.findIndex((state) => state === "current" || state === "overdue");
  if (current >= 0) return current;
  return estimate.next?.stop ?? null;
}

/** 连续两次可用读数均在目标 80 米内才建议确认到达，每站可关闭一次；不自动标完成。 */
export function arrivalReminder(view: TripProgressView, estimate: TripEstimate, readings: readonly LivePoint[], dismissed: ReadonlySet<string>): Reminder | null {
  const stop = targetStop(view, estimate);
  const point = stop === null ? null : view.stops[stop].point;
  if (stop === null || !point || view.stops[stop].status !== "todo") return null;
  const key = `arrived:${view.stops[stop].activityId}`;
  if (dismissed.has(key)) return null;
  // 先排除精度差的读数，再要求连续两次落在范围内，降低一次定位漂移带来的误提醒。
  const recent = readings.filter((reading) => reading.accuracy <= USABLE_ACCURACY).slice(-2);
  if (recent.length < 2 || recent.some((reading) => meters(reading, point) > ARRIVED_WITHIN)) return null;
  return { kind: "arrived", key, stop, name: view.stops[stop].name };
}

/**
 * 下一站 15 分钟内开始、而粗略步行超过 25 分钟时给建议。
 * 依据只是直线估算，每站提醒一次，不能据此自动改行程。
 */
export function lateReminder(view: TripProgressView, estimate: TripEstimate, reading: LivePoint | null, nowMinute: number, dismissed: ReadonlySet<string>): Reminder | null {
  const stop = estimate.next?.stop ?? null;
  const target = stop === null ? null : view.stops[stop];
  if (stop === null || !target?.point || !reading || reading.accuracy > USABLE_ACCURACY) return null;
  const key = `late:${target.activityId}`;
  const startsIn = target.startsAt - nowMinute;
  if (dismissed.has(key) || startsIn < 0 || startsIn > LATE_LOOKAHEAD) return null;
  const { walkMinutes } = distanceTo(reading, target.point);
  return walkMinutes > LATE_WALK_MINUTES ? { kind: "late", key, stop, name: target.name, walkMinutes } : null;
}

/** 按高德天气文字识别雨、雪、雷或冰雹，供提醒使用。 */
export function isWet(text: string | null | undefined): boolean {
  return !!text && /雨|雪|雷|冰雹/.test(text);
}

/**
 * 行程当天，当前或剩余半天的天气有降水，且未访问项包含室外地点时提醒。
 * 按日期与当前 / 预报类型分别去重，不把已结束白天天气用于夜间提醒。
 */
export function rainReminder(view: TripProgressView, nowMinute: number, today: boolean, dismissed: ReadonlySet<string>): Reminder | null {
  const weather = view.weather;
  if (!today || !weather) return null;
  const now = isWet(weather.now);
  const later = !now && (nowMinute < 18 * 60 ? isWet(weather.day) || isWet(weather.night) : isWet(weather.night));
  if (!now && !later) return null;
  const key = `rain:${view.date}:${now ? "now" : "later"}`;
  if (dismissed.has(key)) return null;
  const names = view.stops.filter((stop) => stop.status === "todo" && !stop.archived && stop.outdoor && stop.endsAt > nowMinute).map((stop) => stop.name);
  return names.length ? { kind: "rain", key, names, now } : null;
}
