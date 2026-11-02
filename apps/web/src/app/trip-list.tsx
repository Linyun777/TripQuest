import { CalendarDays, CalendarRange, ChevronRight, MapPinned } from "lucide-react";
import Link from "next/link";
import type { JourneySummary } from "@tripquest/application";
import { Badge } from "./_ui/badge";
import { DeleteTrip } from "./trip-delete";

const KIND = {
  real_day: { label: "真实地点", tone: "lake" },
  generated_day: { label: "演示数据", tone: "neutral" },
  manual: { label: "手动整理", tone: "neutral" },
} as const;

export function TripList({ trips }: { trips: readonly JourneySummary[] | null }) {
  if (trips === null) {
    return <p className="text-sm text-ink-faint">暂时读不到已保存的行程，请确认数据库已启动。</p>;
  }
  if (trips.length === 0) {
    return (
      <div className="flex items-center gap-4 rounded-(--radius-card) border border-dashed border-line-strong px-5 py-6">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-sunken text-ink-faint">
          <MapPinned className="size-5" />
        </span>
        <p className="text-sm leading-6 text-ink-soft">还没有保存的行程。规划满意后点“保存这个方案”，它会出现在这里。</p>
      </div>
    );
  }
  // V2.11：一趟出游显示为一项，展开是各天（每天一段或按固定交通分成几段，标出所在城市）。
  const items: ({ kind: "day"; trip: JourneySummary } | { kind: "outing"; id: string; title: string; days: JourneySummary[] })[] = [];
  for (const trip of trips) {
    if (!trip.trip) {
      items.push({ kind: "day", trip });
      continue;
    }
    const group = items.find((item) => item.kind === "outing" && item.id === trip.trip!.id);
    if (group?.kind === "outing") group.days.push(trip);
    else items.push({ kind: "outing", id: trip.trip.id, title: trip.trip.title, days: [trip] });
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => {
        if (item.kind === "outing") return <OutingItem key={item.id} id={item.id} title={item.title} days={item.days} />;
        const { trip } = item;
        const kind = KIND[trip.creationKind];
        return (
          <li key={trip.id}>
            <Link
              href={`/journeys/${trip.id}`}
              className="group flex items-center gap-4 rounded-(--radius-card) border border-line bg-surface px-5 py-4 shadow-card transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-float focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-lake-50 text-lake-600">
                <CalendarDays className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{trip.title}</span>
                <span className="mt-1 flex items-center gap-2 text-sm text-ink-soft">
                  <span className="tabular">{trip.date}</span>
                  <Badge tone={kind.tone}>{kind.label}</Badge>
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function OutingItem({ id, title, days }: { id: string; title: string; days: JourneySummary[] }) {
  const sorted = [...days].sort((a, b) => a.trip!.day - b.trip!.day || a.trip!.part - b.trip!.part);
  const { firstDate, lastDate } = sorted[0]!.trip!;
  const count = Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 86_400_000) + 1;
  // 每一天：有一日行程的列出来（按固定交通分段的一天有几段）；只有交通的一天也要占一行。
  const rows = Array.from({ length: count }, (_, index) => ({
    day: index + 1,
    date: new Date(Date.parse(firstDate) + index * 86_400_000).toISOString().slice(0, 10),
    parts: sorted.filter((item) => item.trip!.day === index + 1),
  }));
  return (
    <li className="sm:col-span-2">
      <details className="group rounded-(--radius-card) border border-line bg-surface shadow-card">
        <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-lake-50 text-lake-600">
            <CalendarRange className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{title}</span>
            <span className="tabular mt-1 block text-sm text-ink-soft">
              {firstDate} 起 · {count} 天
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
        </summary>
        <ul className="space-y-1 border-t border-line px-3 py-2">
          {rows.map((row) => (row.parts.length ? row.parts.map((part, index) => (
            <li key={part.id}>
              <Link href={`/journeys/${part.id}`} className="flex items-center gap-3 rounded-(--radius-field) px-2 py-2 text-sm hover:bg-sunken">
                <span className="w-14 shrink-0 font-medium">{index === 0 ? `第 ${row.day} 天` : ""}</span>
                <span className="tabular text-ink-soft">{row.date}</span>
                {part.cityName && <Badge tone="neutral">{part.cityName}</Badge>}
                <ChevronRight className="ml-auto size-4 shrink-0 text-ink-faint" />
              </Link>
            </li>
          )) : (
            <li key={`day-${row.day}`} className="flex items-center gap-3 px-2 py-2 text-sm">
              <span className="w-14 shrink-0 font-medium">第 {row.day} 天</span>
              <span className="tabular text-ink-soft">{row.date}</span>
              <span className="text-ink-faint">只有交通，没有安排地点</span>
            </li>
          )))}
        </ul>
        <div className="flex justify-end border-t border-line px-5 py-2.5">
          <DeleteTrip tripId={id} />
        </div>
      </details>
    </li>
  );
}
