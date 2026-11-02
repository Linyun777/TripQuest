"use client";

import { ArrowRight, Plane, TrainFront } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../_ui/cn";

/** V2.11 一趟出游在进度面板里的结构：每天的各部分（一日行程、固定交通、直接前往）。 */
export type OutingTripPart =
  | { readonly kind: "plan"; readonly journeyId: string }
  | {
      readonly kind: "transfer";
      readonly mode: "train" | "flight" | "other";
      readonly from: string;
      readonly to: string;
      readonly departAt: string;
      readonly arriveAt: string;
      readonly nextDay: boolean;
      readonly estimated: boolean;
    }
  | { readonly kind: "connect"; readonly from: string; readonly to: string; readonly departAt: string; readonly arriveAt: string };
export type OutingTrip = {
  readonly id: string;
  readonly title: string;
  readonly days: readonly { readonly day: number; readonly date: string; readonly parts: readonly OutingTripPart[] }[];
};

function chinaNow() {
  const local = new Date(Date.now() + 8 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), minute: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
}
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** 读出游结构（跨天改动保存后 revision 变了再读）；每 30 秒刷新“现在”，固定交通的倒计时跟着走。 */
export function useOutingTrip(tripId: string | null, revision = 0) {
  const [trip, setTrip] = useState<OutingTrip | null>(null);
  const [now, setNow] = useState(chinaNow);
  useEffect(() => {
    if (!tripId) return;
    let live = true;
    void fetch(`/api/trips/${tripId}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((reply: { status: string; trip?: OutingTrip } | null) => {
        if (live && reply?.status === "ok" && reply.trip) setTrip(reply.trip);
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [tripId, revision]);
  useEffect(() => {
    const timer = setInterval(() => setNow(chinaNow()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return { trip, now };
}

/**
 * 出游期间默认打开今天那一天、正在进行或下一段的一日行程；出游还没开始或已经结束时打开第一天。
 */
export function defaultJourney(trip: OutingTrip, now: { date: string; minute: number }): { day: number; journeyId: string | null } {
  const today = trip.days.find((day) => day.date === now.date) ?? trip.days[0]!;
  const plans = today.parts.flatMap((part, index) => (part.kind === "plan" ? [{ index, journeyId: part.journeyId }] : []));
  if (today.date !== now.date || plans.length < 2) return { day: today.day, journeyId: plans[0]?.journeyId ?? null };
  // 有固定交通的一天：过了某段交通的发车时刻，就打开它后面那段。
  let chosen = plans[0]!;
  for (const plan of plans) {
    const ride = today.parts.slice(0, plan.index).reverse().find((part) => part.kind === "transfer");
    if (ride?.kind === "transfer" && now.minute >= minutes(ride.departAt)) chosen = plan;
  }
  return { day: today.day, journeyId: chosen.journeyId };
}

/** 进度面板顶部：按天切换；选中那天的固定交通只显示时刻和发车倒计时，不给导航。 */
export function OutingProgressHeader({
  trip,
  now,
  day,
  journeyId,
  onSelect,
}: {
  trip: OutingTrip;
  now: { date: string; minute: number };
  day: number;
  journeyId: string | null;
  onSelect: (day: number, journeyId: string | null) => void;
}) {
  const selected = trip.days.find((item) => item.day === day) ?? trip.days[0]!;
  const plans = selected.parts.filter((part): part is Extract<OutingTripPart, { kind: "plan" }> => part.kind === "plan");
  return (
    <div className="mb-4 space-y-3">
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {trip.days.map((item) => {
          const [, month, date] = item.date.split("-").map(Number);
          const first = item.parts.find((part) => part.kind === "plan");
          return (
            <button
              key={item.day}
              type="button"
              onClick={() => onSelect(item.day, first?.kind === "plan" ? first.journeyId : null)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-sm",
                item.day === selected.day ? "border-lake-600 bg-lake-50 text-lake-700" : "border-line text-ink-soft hover:bg-sunken",
              )}
            >
              第 {item.day} 天 · {month}/{date}
              {item.date === now.date && <span className="ml-1 text-xs">今天</span>}
            </button>
          );
        })}
      </div>
      {selected.parts.some((part) => part.kind !== "plan") && (
        <ol className="space-y-1.5">
          {selected.parts.map((part, index) => {
            if (part.kind === "plan") {
              const order = plans.indexOf(part);
              return (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => onSelect(selected.day, part.journeyId)}
                    className={cn(
                      "w-full rounded-(--radius-field) border px-3 py-1.5 text-left text-sm",
                      part.journeyId === journeyId ? "border-lake-600 bg-lake-50 text-lake-700" : "border-line text-ink-soft hover:bg-sunken",
                    )}
                  >
                    {plans.length > 1 ? (order === 0 ? "坐车前" : "到站后") : "这天的安排"}
                  </button>
                </li>
              );
            }
            if (part.kind === "connect") {
              return (
                <li key={index} className="tabular flex items-center gap-2 px-1 text-sm text-ink-soft">
                  <ArrowRight className="size-4 shrink-0 text-ink-faint" />
                  {part.departAt} {part.from} → {part.arriveAt} {part.to}
                </li>
              );
            }
            return <Ride key={index} ride={part} today={selected.date === now.date} minute={now.minute} />;
          })}
        </ol>
      )}
    </div>
  );
}

function Ride({ ride, today, minute }: { ride: Extract<OutingTripPart, { kind: "transfer" }>; today: boolean; minute: number }) {
  const Icon = ride.mode === "flight" ? Plane : TrainFront;
  const left = minutes(ride.departAt) - minute;
  const status = !today ? null
    : left > 0 ? `距发车还有 ${left >= 60 ? `${Math.floor(left / 60)} 小时 ${left % 60} 分` : `${left} 分钟`}`
      : ride.nextDay || minute < minutes(ride.arriveAt) ? `在车上，约${ride.nextDay ? "次日 " : " "}${ride.arriveAt} 到` : "已到站";
  return (
    <li className="rounded-(--radius-field) bg-sunken px-3 py-2 text-sm">
      <p className="tabular flex items-center gap-2 font-medium">
        <Icon className="size-4 shrink-0 text-lake-600" />
        {ride.departAt} {ride.from} → {ride.nextDay ? "次日 " : ""}{ride.arriveAt} {ride.to}
      </p>
      <p className="mt-0.5 text-xs text-ink-faint">
        {ride.estimated ? "没填车次，时间是估计" : "车次由你填写"}
        {status && ` · ${status}`}
      </p>
    </li>
  );
}
