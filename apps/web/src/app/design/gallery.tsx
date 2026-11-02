"use client";

import { useState } from "react";
import type { PlanningMapConfig } from "../journeys/map-config";
import { ChatWorkspace } from "../plan/chat-workspace";
import { Composer } from "../plan/composer";
import { MessageList } from "../plan/message-list";
import type { ChatMessageView, MapStop, PlanCardView, RequirementsCardView } from "../plan/view-models";

// Sample content for review only: hand-written names and rough coordinates, not provider data.
const card: RequirementsCardView = {
  city: "杭州市",
  mode: "day",
  date: "2026-10-14",
  dateLabel: "10月14日 周三（明天）",
  window: { startsAt: "09:00", endsAt: "18:00" },
  start: { status: "bound", placeId: "s", name: "武林广场" },
  end: {
    status: "choose",
    mention: "湖滨",
    choices: [
      { placeId: "e1", name: "湖滨银泰in77", hint: "商场" },
      { placeId: "e2", name: "湖滨步行街", hint: "街区" },
    ],
  },
  visits: [{ key: "v1", place: { status: "bound", placeId: "m", name: "浙江省博物馆（孤山馆区）" }, role: "fixed", startsAt: "14:00", endsAt: "15:30" }],
  interests: [{ id: "i1", text: "越剧相关" }, { id: "i2", text: "安静的书店" }],
  pace: "relaxed",
  notes: "别太累",
  travel: { allowed: ["walking", "transit", "taxi"], prefer: "balanced", recommended: true },
  weather: { dayWeather: "小雨", highCelsius: 23, lowCelsius: 17, wet: true },
  missing: ["选择结束地点"],
};

const plan: PlanCardView = {
  runId: "sample",
  title: "西湖边的越剧与书店之旅",
  date: "10月14日",
  startName: "武林广场",
  endName: "湖滨银泰in77",
  departAt: "09:00",
  arriveAt: "17:20",
  travelBeforeEnd: { mode: "walking", minutes: 14 },
  totals: { travelMinutes: 76, fareYuan: 0, fareUnknown: false },
  stops: [
    { key: "a1", startsAt: "09:25", endsAt: "11:00", name: "中国越剧博物馆", role: "discovered", reason: "满足“越剧相关”，室内展陈，下雨也合适", travelBefore: { mode: "walking", minutes: 22 }, waitMinutes: 0 },
    { key: "a2", startsAt: "11:20", endsAt: "12:30", name: "晓风书屋（体育场路店）", role: "discovered", reason: "满足“安静的书店”，离上一站步行 18 分钟", travelBefore: { mode: "walking", minutes: 18 }, waitMinutes: 0 },
    { key: "a3", startsAt: "14:00", endsAt: "15:30", name: "浙江省博物馆（孤山馆区）", role: "fixed", travelBefore: { mode: "walking", minutes: 22 }, waitMinutes: 18 },
  ],
  notes: ["小雨，上午两站都在室内", "午饭可在书店附近解决，没有单独安排"],
  pending: ["浙博预约时间以你的预约为准", "越剧博物馆周一闭馆"],
  saved: null,
  live: true,
};

const mapStops: MapStop[] = [
  { key: "start", label: "起", name: "武林广场", kind: "start", longitude: 120.1645, latitude: 30.2741 },
  { key: "a1", label: "1", name: "中国越剧博物馆", kind: "stop", longitude: 120.1552, latitude: 30.2682 },
  { key: "a2", label: "2", name: "晓风书屋", kind: "stop", longitude: 120.1678, latitude: 30.2786 },
  { key: "a3", label: "3", name: "浙江省博物馆", kind: "stop", longitude: 120.1453, latitude: 30.2563 },
  { key: "end", label: "终", name: "湖滨银泰in77", kind: "end", longitude: 120.1692, latitude: 30.2569 },
];

const messages: ChatMessageView[] = [
  { id: "1", role: "user", kind: "text", text: "明天想在西湖边逛一天，早上 9 点从武林广场出发，下午 2 点在浙江省博物馆有预约，想看看越剧相关的东西，再找家安静的书店，别太累，晚上 6 点前到湖滨。" },
  { id: "2", role: "assistant", kind: "text", text: "好的！我整理了一下你的需求。明天杭州有小雨，我会优先安排室内的地方。“湖滨”有两个可能的地点，帮我选一下：" },
  { id: "3", role: "assistant", kind: "requirements_card", card, latest: true },
  { id: "4", role: "user", kind: "text", text: "湖滨银泰" },
  {
    id: "5", role: "assistant", kind: "planning_progress", running: false,
    steps: [
      { key: "s1", text: "在武林广场附近搜索“越剧相关”地点", state: "done" },
      { key: "s2", text: "在武林广场附近搜索“安静的书店”", state: "done" },
      { key: "s3", text: "试排第 1 种组合：去浙博会迟到 12 分钟", state: "done" },
      { key: "s4", text: "调整顺序后试排第 2 种组合：全部按时", state: "done" },
    ],
  },
  { id: "6", role: "assistant", kind: "plan_card", plan },
];

const runningSteps: ChatMessageView = {
  id: "7", role: "assistant", kind: "planning_progress", running: true,
  steps: [
    { key: "r1", text: "在武林广场附近搜索“越剧相关”地点", state: "done" },
    { key: "r2", text: "核对 3 段步行路线", state: "active" },
  ],
};

export function DesignGallery({ state, mapConfig }: { state: "full" | "empty"; mapConfig: PlanningMapConfig }) {
  const [shown, setShown] = useState<ChatMessageView[]>(state === "empty" ? [] : [...messages, runningSteps]);
  return (
    <ChatWorkspace
      title={state === "empty" ? "新的规划" : "西湖边的越剧与书店之旅"}
      plan={state === "empty" ? null : plan}
      mapStops={state === "empty" ? [] : mapStops}
      mapConfig={mapConfig}
      conversation={
        shown.length === 0 ? (
          <div className="pt-16 text-center">
            <p className="text-2xl font-semibold tracking-tight">想怎么过这一天？</p>
            <p className="mt-2 text-ink-soft">时间、出发地、预约和兴趣，想到什么说什么。</p>
          </div>
        ) : (
          <MessageList messages={shown} actions={{ onStart: () => {}, onSave: () => {}, onReplan: () => {}, onChoosePlace: () => {} }} />
        )
      }
      composer={
        <Composer
          onSend={(text) => setShown((list) => [...list, { id: String(list.length + 10), role: "user", kind: "text", text }])}
        />
      }
    />
  );
}
