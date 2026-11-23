"use client";

import { CalendarDays, CalendarRange, ChevronRight, Compass, MapPinned } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import type { JourneySummary } from "@tripquest/application";
import { Badge } from "../_ui/badge";
import { cn } from "../_ui/cn";
import { SPRING_BOUNCY } from "../_ui/motion";
import { DeleteTrip } from "../trip-delete";

type FilterKind = "all" | "outing" | "day";

const KIND = {
  real_day: { label: "真实地点", tone: "lake" },
  generated_day: { label: "演示数据", tone: "neutral" },
  manual: { label: "手动整理", tone: "neutral" },
} as const;

type GroupedItem =
  | { kind: "day"; trip: JourneySummary }
  | { kind: "outing"; id: string; title: string; days: JourneySummary[] };

function groupTrips(trips: readonly JourneySummary[]): GroupedItem[] {
  const items: GroupedItem[] = [];
  for (const trip of trips) {
    if (!trip.trip) {
      items.push({ kind: "day", trip });
      continue;
    }
    const existing = items.find((item) => item.kind === "outing" && item.id === trip.trip!.id);
    if (existing?.kind === "outing") existing.days.push(trip);
    else items.push({ kind: "outing", id: trip.trip.id, title: trip.trip.title, days: [trip] });
  }
  return items;
}

export function TripsView({ trips }: { trips: readonly JourneySummary[] | null }) {
  const [filter, setFilter] = useState<FilterKind>("all");
  const reduced = useReducedMotion();

  if (trips === null) {
    return (
      <p className="rounded-2xl border border-line bg-surface px-5 py-6 text-sm text-ink-soft">
        暂时读不到已保存的行程，请稍后刷新。
      </p>
    );
  }

  const all = groupTrips(trips);
  const outingCount = all.filter((item) => item.kind === "outing").length;
  const dayCount = all.filter((item) => item.kind === "day").length;

  if (all.length === 0) {
    return (
      <div className="glass-card rounded-[26px] px-6 py-12 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-lake-50 text-lake-600">
          <MapPinned className="size-5" />
        </span>
        <p className="mt-4 text-base font-medium text-ink">还没有保存的行程</p>
        <p className="mx-auto mt-1.5 max-w-xs text-sm leading-6 text-ink-soft">
          在「规划」里说一句想去的安排，确认方案后点「保存这个方案」，就会出现在这里。
        </p>
        <Link
          href="/"
          className="morandi-cta mt-5 inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-sm font-medium text-white transition-transform duration-150 active:scale-[0.96]"
        >
          <Compass className="size-4" />
          <span>去规划一趟</span>
        </Link>
      </div>
    );
  }

  const shown = all.filter((item) => (filter === "all" ? true : item.kind === filter));

  const tabs: { id: FilterKind; label: string }[] = [
    { id: "all", label: `全部 (${all.length})` },
    { id: "outing", label: `多日出游 (${outingCount})` },
    { id: "day", label: `一日行程 (${dayCount})` },
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="筛选行程类型"
        className="glass-pill inline-flex rounded-full p-1"
      >
        {tabs.map((tab) => {
          const active = filter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(tab.id)}
              className={cn(
                "relative z-10 h-8 rounded-full px-4 text-xs font-medium transition-colors duration-150 sm:text-sm",
                active ? "text-ink" : "text-ink-soft hover:text-ink",
              )}
            >
              {active && (
                <motion.span
                  layoutId="trips-filter-pill"
                  aria-hidden="true"
                  transition={reduced ? { duration: 0.12 } : SPRING_BOUNCY}
                  className="absolute inset-0 -z-10 rounded-full bg-white/92 shadow-card ring-1 ring-ink/[0.06]"
                />
              )}
              {tab.label}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="glass-card rounded-[22px] px-5 py-8 text-center text-sm text-ink-faint">
          这个分类下还没有行程。
        </p>
      ) : (
        <div className="glass-card divide-y divide-ink/[0.06] overflow-hidden rounded-[22px]">
          {shown.map((item) => {
            if (item.kind === "outing") {
              return <OutingRow key={item.id} id={item.id} title={item.title} days={item.days} />;
            }
            const { trip } = item;
            const kind = KIND[trip.creationKind];
            return (
              <Link
                key={trip.id}
                href={`/journeys/${trip.id}`}
                className="group flex items-center gap-3.5 px-4 py-4 transition-colors hover:bg-paper/60 active:bg-sunken/70 sm:px-5"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-lake-50 text-lake-600">
                  <CalendarDays className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-ink">
                    {trip.title}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
                    <span className="tabular">{trip.date}</span>
                    <Badge tone={kind.tone}>{kind.label}</Badge>
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OutingRow({ id, title, days }: { id: string; title: string; days: JourneySummary[] }) {
  const sorted = [...days].sort(
    (a, b) => a.trip!.day - b.trip!.day || a.trip!.part - b.trip!.part,
  );
  const { firstDate, lastDate } = sorted[0]!.trip!;
  const count = Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 86_400_000) + 1;
  const rows = Array.from({ length: count }, (_, index) => ({
    day: index + 1,
    date: new Date(Date.parse(firstDate) + index * 86_400_000).toISOString().slice(0, 10),
    parts: sorted.filter((item) => item.trip!.day === index + 1),
  }));

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3.5 px-4 py-4 transition-colors hover:bg-paper/60 sm:px-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-sun-50 text-sun-700">
          <CalendarRange className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink">{title}</span>
          <span className="tabular mt-1 block text-xs text-ink-soft">
            {firstDate} 起 · {count} 天出游
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform duration-200 ease-(--ease-out) group-open:rotate-90" />
      </summary>
      <div className="border-t border-line/70 bg-paper/45 px-3 py-2 sm:px-4">
        <ul className="space-y-1">
          {rows.map((row) =>
            row.parts.length ? (
              row.parts.map((part, index) => (
                <li key={part.id}>
                  <Link
                    href={`/journeys/${part.id}`}
                    className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm transition-colors hover:bg-surface active:bg-sunken"
                  >
                    <span className="w-14 shrink-0 font-medium text-ink">
                      {index === 0 ? `第 ${row.day} 天` : ""}
                    </span>
                    <span className="tabular text-ink-soft">{row.date}</span>
                    {part.cityName && <Badge tone="neutral">{part.cityName}</Badge>}
                    <ChevronRight className="ml-auto size-4 shrink-0 text-ink-faint" />
                  </Link>
                </li>
              ))
            ) : (
              <li key={`day-${row.day}`} className="flex items-center gap-3 px-2.5 py-2.5 text-sm">
                <span className="w-14 shrink-0 font-medium text-ink">第 {row.day} 天</span>
                <span className="tabular text-ink-soft">{row.date}</span>
                <span className="text-ink-faint">只有交通，没有安排地点</span>
              </li>
            ),
          )}
        </ul>
        <div className="mt-1 flex justify-end border-t border-line/60 px-2 pt-2">
          <DeleteTrip tripId={id} />
        </div>
      </div>
    </details>
  );
}
