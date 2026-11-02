"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * V2.10（stages/V2.10.md §3.1）：打开页面时请求一次定位，服务端只换成所在城市（编码和名称），坐标不保存；
 * 拒绝或失败时是杭州。城市只存在本机浏览器里，下次打开先显示；开始对话时写进卡片。
 */
export interface PageCity {
  readonly adcode: string;
  readonly name: string;
  /** 是定位得到的（否则是缺省的杭州）。 */
  readonly located: boolean;
}

const KEY = "tripquest.city.v1";
const DEFAULT: PageCity = { adcode: "330100", name: "杭州市", located: false };
let current: PageCity = DEFAULT;
let asked = false;
const listeners = new Set<() => void>();

function set(city: PageCity) {
  current = city;
  for (const listener of listeners) listener();
}

function remembered(): PageCity | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<PageCity> | null;
    return value && /^\d{6}$/.test(value.adcode ?? "") && typeof value.name === "string" && value.name.length <= 40
      ? { adcode: value.adcode!, name: value.name, located: true }
      : null;
  } catch {
    return null;
  }
}

function remember(city: PageCity) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ adcode: city.adcode, name: city.name }));
  } catch {
    // 本机存不了也照常用这一次的结果。
  }
}

/** 每个页面只问一次定位；先用本机记住的城市，定位结果回来再更新。 */
function locateOnce() {
  if (asked || typeof window === "undefined") return;
  asked = true;
  const saved = remembered();
  if (saved) set(saved);
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(async (position) => {
    try {
      const response = await fetch("/api/city", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ longitude: position.coords.longitude, latitude: position.coords.latitude }),
      });
      const reply = await response.json() as { status: string; city?: { adcode: string; name: string } };
      if (reply.status === "ok" && reply.city) {
        const city = { adcode: reply.city.adcode, name: reply.city.name, located: true };
        remember(city);
        set(city);
      }
    } catch {
      // 查不到城市时保持现状（记住的城市或杭州）。
    }
  }, () => {}, { maximumAge: 10 * 60_000, timeout: 15_000 });
}

export function usePageCity(): PageCity {
  const city = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => DEFAULT,
  );
  useEffect(locateOnce, []);
  return city;
}

/** 城市的短名（“杭州市”→“杭州”），用于标题。 */
export function shortCity(name: string): string {
  return name.length > 2 ? name.replace(/市$/, "") : name;
}

/** 首页大字里的城市名（服务端渲染时是杭州，定位后换成所在城市）。 */
export function CityName() {
  return shortCity(usePageCity().name);
}
