"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deviceToAmap, distanceTo, type LivePoint } from "./trip-live";

// 手机可能每秒上报，页面只接收位置、精度或刷新间隔有实际变化的读数。
const MOVED_METERS = 8;
const ACCURACY_CHANGE = 15;
const HEARTBEAT_MS = 15_000;

export type LiveLocation = {
  /** unavailable 表示浏览器没有定位能力，与用户拒绝权限分开。 */
  readonly status: "off" | "asking" | "on" | "denied" | "error" | "unavailable";
  /** 最近一次已转换为 GCJ-02 的可展示读数。 */
  readonly point: LivePoint | null;
  /** 保留少量近期读数，供连续两次到达判断使用，不长期积累轨迹。 */
  readonly readings: readonly LivePoint[];
  /** 原始 WGS-84 点仅供用户主动要求从当前位置重排时单次发送。 */
  readonly device: () => { longitude: number; latitude: number } | null;
  readonly start: () => void;
  readonly stop: () => void;
};

/**
 * 用户主动开启后才监听设备位置，在浏览器转换并保留页面内存，不记录日志或持久存储。
 * 主动发起当前位置重排时，由调用方单次读取原始点解析起点。
 */
export function useLiveLocation(): LiveLocation {
  const [status, setStatus] = useState<LiveLocation["status"]>("off");
  const [readings, setReadings] = useState<LivePoint[]>([]);
  const watch = useRef<number | null>(null);
  const raw = useRef<{ longitude: number; latitude: number } | null>(null);
  const taken = useRef<LivePoint | null>(null);

  const stop = useCallback(() => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    raw.current = null;
    taken.current = null;
    setReadings([]);
    setStatus("off");
  }, []);

  const start = useCallback(() => {
    if (watch.current !== null) return;
    if (!("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }
    setStatus("asking");
    watch.current = navigator.geolocation.watchPosition((position) => {
      const { longitude, latitude, accuracy } = position.coords;
      raw.current = { longitude, latitude };
      const [lng, lat] = deviceToAmap(longitude, latitude);
      const reading = { longitude: lng, latitude: lat, accuracy: Math.round(accuracy), at: Date.now() };
      // raw 始终保留最新读数供用户主动发起调整；地图用的 React 状态只在移动、
      // 精度明显变化或达到刷新间隔时更新，避免手机定位每秒触发整片进度面板重渲染。
      const last = taken.current;
      if (last &&
        distanceTo(last, [lng, lat]).meters < MOVED_METERS &&
        Math.abs(last.accuracy - reading.accuracy) < ACCURACY_CHANGE &&
        reading.at - last.at < HEARTBEAT_MS) return;
      taken.current = reading;
      setReadings((list) => [...list, reading].slice(-3));
      setStatus("on");
    }, (error) => {
      // 只有拒绝权限才结束监听；静止时可能出现暂时无新位置，保留上次有效点继续等待。
      // 尚无任何有效读数时才把暂时失败显示为 error。
      if (error.code === error.PERMISSION_DENIED) {
        if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
        watch.current = null;
        setStatus("denied");
        return;
      }
      setStatus((current) => (current === "on" ? current : "error"));
    }, { enableHighAccuracy: true, maximumAge: 10_000 });
  }, []);

  useEffect(() => () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
  }, []);

  return { status, point: readings.at(-1) ?? null, readings, device: () => raw.current, start, stop };
}
