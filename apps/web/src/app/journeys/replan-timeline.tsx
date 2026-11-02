"use client";

import { useState } from "react";
import { dayTime } from "@tripquest/domain";
import type { ReplanCandidate } from "@tripquest/application/day-replan-contract";
import { DayMap } from "./day-map";
import type { PlanningMapConfig } from "./map-config";

const ROLES = {
  fixed: "固定事项 · 预约未核实",
  required: "必去",
  optional: "可选",
  discovered: "新发现",
} as const;

function unknownText(code: string): string | null {
  if (code === "day_opening_unknown") return "营业/最晚入场";
  if (code === "day_tickets_unknown") return "票务/预约";
  return null;
}

/** Reported items keep their original planned times, labelled as such; nothing is inferred. */
export function ArchivedList({ view }: { view: ReplanCandidate }) {
  if (!view.archived.length) return null;
  return (
    <section aria-labelledby="archived-heading" className="mt-5 rounded-2xl border border-[#dce8e0] bg-[#fbfcfa] p-4 text-sm leading-6">
      <h3 id="archived-heading" className="font-semibold">已报告完成/跳过（原计划时刻）</h3>
      <ul className="mt-2 space-y-1">
        {view.archived.map((item) => (
          <li key={item.key}>
            {item.status === "completed" ? "已完成" : "已跳过"} · {item.name}
            <span className="text-[#62736c]">
              {" "}· 原计划 {dayTime(item.planned.startsAt)}–{dayTime(item.planned.endsAt)} · {ROLES[item.role]}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[#62736c]">
        以上时刻是原计划，不是实际执行时间；跳过固定事项不会取消预约。
      </p>
    </section>
  );
}

export function FutureTimeline({
  view,
  heading,
  selected,
  onSelect,
}: {
  view: ReplanCandidate;
  heading: string;
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const pending = view.activities.flatMap((activity) => {
    const items = view.checks
      .filter((check) => check.kind === "unknown" && check.activityId === activity.key)
      .map((check) => unknownText(check.code))
      .filter((text): text is string => text !== null);
    return items.length ? [{ activity, items }] : [];
  });
  return (
    <section aria-label={heading} className="mt-5 space-y-3">
      <div className="rounded-2xl border border-[#b8cfc0] bg-[#f1f7f2] p-4 text-sm leading-6">
        <h3 className="text-base font-semibold">{heading}</h3>
        <p>
          从 {view.resume.name} {dayTime(view.resume.startsAt)} 继续 · 结束到达 {dayTime(view.metrics.endArrival)}
          （最晚 {dayTime(view.end.endsAt)}）
        </p>
        <p>
          接下来 {view.metrics.activities} 项 · 步行 {view.metrics.walking} 分钟 · 最长一段 {view.metrics.longest} 分钟
          · 等待合计 {view.metrics.waiting} 分钟 · 演示地点与路线
        </p>
      </div>
      <ol className="space-y-3" aria-label={`${heading}时间线`}>
        <li className="rounded-2xl border border-[#dce8e0] bg-white p-4 text-sm">
          <p className="font-semibold">当前位置 · {view.resume.name}</p>
          <p className="text-[#52665c]">{dayTime(view.resume.startsAt)} 起可继续（你报告的时间）</p>
        </li>
        {view.legs.map((leg, index) => {
          const activity = view.activities[index];
          return (
            <li key={`${leg.fromKey}-${leg.toKey}-${index}`} className="space-y-3">
              <p className="rounded-2xl border border-dashed border-[#b8cfc0] px-4 py-3 text-sm leading-6">
                {leg.source === "same_place_assumption"
                  ? "同一地点，未估计场内移动"
                  : `步行约 ${leg.travelMinutes} 分钟（${leg.distanceMeters} 米，路线估计）+ 缓冲 ${leg.bufferMinutes} 分钟`}
                {" · "}
                {dayTime(leg.arrivesAt)} 到达{activity ? "" : `终点 ${view.end.name}`}
              </p>
              {activity && (
                <div className={`rounded-2xl border bg-white p-4 text-sm leading-6 ${selected === activity.key ? "border-[#236d55] ring-1 ring-[#236d55]" : "border-[#dce8e0]"}`}>
                  <p className="font-semibold">
                    {onSelect ? (
                      <button type="button" className="min-h-11 text-left underline" onClick={() => onSelect(activity.key)}>
                        {dayTime(activity.startsAt)}–{dayTime(activity.endsAt)} · {activity.name}
                      </button>
                    ) : `${dayTime(activity.startsAt)}–${dayTime(activity.endsAt)} · ${activity.name}`}
                  </p>
                  <p>
                    {ROLES[activity.role]}
                    {activity.frozen ? " · 范围外，保持原安排" : ""}
                    {activity.role === "fixed"
                      ? " · 时间按你声明的固定安排"
                      : ` · 停留 ${activity.stayMinutes} 分钟（${activity.staySource === "user" ? "你填写的预计" : "系统预计"}）`}
                  </p>
                  {activity.waitMinutes > 0 && <p className="text-[#52665c]">早到等待 {activity.waitMinutes} 分钟</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {view.activities.length === 0 && (
        <p className="text-sm text-[#52665c]">接下来没有安排活动，只保留前往终点的一段；不代表已经到达终点。</p>
      )}
      {pending.length > 0 && (
        <div className="rounded-2xl border border-[#e8d7c4] bg-[#fff8f0] p-4 text-sm leading-6">
          <p className="font-semibold">待核实</p>
          <ul className="mt-1 list-disc pl-5">
            {pending.map(({ activity, items }) => (
              <li key={activity.key}>{activity.name}：{items.join("、")}待核实</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const GOAL_LABELS = { keep_as_much: "尽量保留安排", less_walking: "少走路", relaxed: "更宽松" } as const;
const SCOPE_LABELS = { rest_of_day: "当天剩余全部", until_next_fixed: "下个固定事项前" } as const;

/** A saved v3: reported items, the confirmed upcoming plan, and the basis it was frozen on. */
export function ReplannedDayView({
  view,
  basis,
  mapConfig,
}: {
  view: ReplanCandidate;
  basis: {
    observationVersion: number;
    observedAt: string;
    goal: keyof typeof GOAL_LABELS;
    scope: keyof typeof SCOPE_LABELS;
    mode: "scripted" | "live";
    model: string;
    recheckedAt: string;
  };
  mapConfig: PlanningMapConfig;
}) {
  const [selected, setSelected] = useState("start");
  return (
    <>
      <p className="mt-5 rounded-2xl border border-[#dce8e0] bg-[#fbfcfa] p-4 text-sm leading-6">
        本版本依据状态 v{basis.observationVersion}（{basis.observedAt.slice(11, 16)} 你的报告）调整，
        范围“{SCOPE_LABELS[basis.scope]}”，目标“{GOAL_LABELS[basis.goal]}”；
        决策：{basis.mode === "live" ? `真实模型 ${basis.model}` : "规则演示"}；
        确认前检查：{new Date(basis.recheckedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。
      </p>
      <ArchivedList view={view} />
      <DayMap
        draft={{
          startPlace: { placeId: view.resume.key },
          endPlace: { placeId: view.end.key },
          activities: view.activities.map((item) => ({ activityId: item.key, placeId: item.placeKey })),
        }}
        places={view.places}
        selected={selected}
        onSelect={setSelected}
        config={mapConfig}
      />
      <FutureTimeline
        view={view}
        heading="接下来安排"
        selected={selected.replace(/^activity:/, "")}
        onSelect={(key) => setSelected(`activity:${key}`)}
      />
    </>
  );
}
