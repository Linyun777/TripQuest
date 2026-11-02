"use client";

import { Bike, Bookmark, Car, CarTaxiFront, CloudLightning, Footprints, Info, RotateCcw, Sparkles, TrainFront } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "../_ui/card";
import type { LegView, PlanCardView, PlanStop, TravelModeView, TripNotesView } from "./view-models";
import { EASE_OUT } from "../_ui/motion";
import { PlatformLinks } from "./platform-links";
import { StopNotes, TripNotesBar, useTripNotes } from "./trip-notes";

/** One look per mode, shared by the card, the timeline and the map legend. */
export const MODE_STYLE: Record<TravelModeView, { label: string; icon: typeof Footprints; className: string; color: string }> = {
  walking: { label: "步行", icon: Footprints, className: "text-ink-faint", color: "#7f8a84" },
  transit: { label: "地铁/公交", icon: TrainFront, className: "text-lake-600", color: "#1f7159" },
  taxi: { label: "打车", icon: CarTaxiFront, className: "text-sun-700", color: "#e07b39" },
  bicycling: { label: "骑行", icon: Bike, className: "text-rain-500", color: "#4d78b8" },
  driving: { label: "自驾", icon: Car, className: "text-ink-soft", color: "#4a5751" },
};


const ROLE = {
  fixed: { label: "固定", tone: "sun" },
  required: { label: "必去", tone: "lake" },
  optional: { label: "想去", tone: "neutral" },
  discovered: { label: "推荐", tone: "lake" },
} as const;

export function PlanCard({
  plan,
  onSave,
  onReplan,
  saving = false,
  conversationId = null,
}: {
  plan: PlanCardView;
  onSave?: () => void;
  onReplan?: () => void;
  saving?: boolean;
  /** V2.7.2: lets the card look up "出发须知" for its stops. */
  conversationId?: string | null;
}) {
  const tripNotes = useTripNotes(conversationId ? `/api/conversations/${conversationId}/trip-notes` : null, { runId: plan.runId });
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <p className="text-xs font-medium text-lake-600">方案</p>
          <CardTitle className="mt-0.5 text-base">{plan.title}</CardTitle>
          <p className="tabular mt-1 text-sm text-ink-soft">
            {plan.date} · {plan.departAt} 出发 · {plan.arriveAt} 到达
          </p>
          {plan.totals && (
            <p className="tabular mt-0.5 text-sm text-ink-soft">
              交通共 {plan.totals.travelMinutes} 分钟
              {plan.totals.fareYuan > 0 && ` · 约 ${plan.totals.fareYuan} 元`}
              {plan.totals.fareUnknown && "（部分费用未知）"}
            </p>
          )}
        </div>
      </CardHeader>
      <CardBody className="pt-3">
        {conversationId && (
          <div className="mb-3">
            <TripNotesBar state={tripNotes.state} onLoad={() => void tripNotes.load()} />
          </div>
        )}
        <PlanTimeline plan={plan} notes={tripNotes.state.status === "ready" ? tripNotes.state.notes : null} />
        {plan.notes.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm text-ink-soft">
            {plan.notes.map((note) => (
              <li key={note} className="flex gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-ink-faint" />
                {note}
              </li>
            ))}
          </ul>
        )}
        {plan.pending.length > 0 && (
          <p className="mt-3 rounded-(--radius-field) bg-sunken px-3.5 py-2.5 text-sm text-ink-soft">
            出发前请确认：{plan.pending.join("；")}
          </p>
        )}
      </CardBody>
      <CardFooter>
        {plan.saved ? (
          <Button asChild size="sm">
            <Link href={`/journeys/${plan.saved.journeyId}`}>
              <Bookmark />
              查看已保存的行程
            </Link>
          </Button>
        ) : plan.live ? (
          <Button size="sm" onClick={onSave} disabled={!onSave || saving}>
            <Bookmark />
            {saving ? "保存中…" : "保存这个方案"}
          </Button>
        ) : (
          <span className="text-xs text-ink-faint">离开页面后需要重新规划才能保存</span>
        )}
        <Button size="sm" variant="ghost" onClick={onReplan} disabled={!onReplan}>
          <RotateCcw />
          换个方案
        </Button>
      </CardFooter>
    </Card>
  );
}

/** V2.3: time left after a stop before the next leg, the user's to spend nearby. */
function FreeTime({ minutes }: { minutes: number }) {
  const hours = Math.floor(minutes / 60);
  const text = hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分钟`;
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-11 shrink-0" />
      <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-soft">自由时间约 {text}，可以在附近随意逛逛</span>
    </div>
  );
}

/** Start → stops → end, with the walk before each stop; stops slide in one by one. */
export function PlanTimeline({ plan, notes = null }: { plan: PlanCardView; notes?: TripNotesView | null }) {
  return (
    <ol className="relative">
      <Endpoint time={plan.departAt} name={plan.startName} label="出发" />
      {plan.stops.map((stop, index) => (
        <motion.li
          key={stop.key}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.08 * index, duration: 0.36, ease: EASE_OUT }}
        >
          {stop.freeBefore !== undefined && <FreeTime minutes={stop.freeBefore} />}
          <Leg leg={stop.travelBefore} wait={stop.waitMinutes} known={plan.live} />
          <Stop stop={stop} index={index} notes={notes?.stops[index]} />
        </motion.li>
      ))}
      <li>
        <Leg leg={plan.travelBeforeEnd} wait={0} known={plan.live} />
      </li>
      <Endpoint time={plan.arriveAt} name={plan.endName} label="到达" />
    </ol>
  );
}

function Endpoint({ time, name, label }: { time: string; name: string; label: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="tabular w-11 shrink-0 text-right text-sm font-medium">{time}</span>
      <span className="size-2.5 shrink-0 rounded-full border-2 border-ink" />
      <span className="text-sm text-ink-soft">{label} · <span className="text-ink">{name}</span></span>
    </li>
  );
}

/**
 * How to get to the next stop. A plan read back from storage keeps only the mode: its
 * minutes and fares were live estimates and never stored (D-046).
 */
function Leg({ leg, wait, known = true }: { leg: LegView | null; wait: number; known?: boolean }) {
  const style = MODE_STYLE[leg?.mode ?? "walking"];
  const Icon = style.icon;
  const text = !leg ? "路线未知"
    : leg.samePlace ? "同一地点"
      : !known || leg.minutes === null ? style.label
        : [
            leg.summary ?? style.label,
            `约 ${leg.minutes} 分钟`,
            leg.fareYuan !== undefined ? `${Math.round(leg.fareYuan)} 元` : undefined,
          ].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-11 shrink-0" />
      <span
        className="ml-[4px] h-8 border-l-2"
        style={{ borderColor: style.color, borderStyle: leg?.mode === "walking" || !leg ? "dashed" : "solid" }}
      />
      <span className={`flex items-center gap-1 text-xs ${style.className}`}>
        <Icon className="size-3.5" />
        {text}
        {known && wait > 0 && <span className="text-ink-faint"> · 早到等待 {wait} 分钟</span>}
      </span>
    </div>
  );
}

/** A plan card's notes come back in its stops' order. */
function Stop({ stop, index, notes }: { stop: PlanStop; index: number; notes?: TripNotesView["stops"][number] }) {
  const role = ROLE[stop.role];
  return (
    <div className="flex gap-3">
      <span className="tabular w-11 shrink-0 pt-3 text-right text-sm font-medium">{stop.startsAt}</span>
      <span className="mt-3.5 grid size-5 shrink-0 -translate-x-[5px] place-items-center rounded-full bg-lake-600 text-[11px] font-semibold text-white">
        {index + 1}
      </span>
      <div className="-ml-1 min-w-0 flex-1 rounded-(--radius-field) border border-line bg-surface px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{stop.name}</p>
          <Badge tone={role.tone}>{role.label}</Badge>
          <span className="tabular text-xs text-ink-faint">{stop.startsAt}–{stop.endsAt}</span>
        </div>
        {stop.reason && (
          <p className="mt-1 flex gap-1.5 text-sm text-ink-soft">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-sun-500" />
            {stop.reason}
          </p>
        )}
        {stop.alert && (
          <p className="mt-1.5 flex items-start gap-1.5 rounded-(--radius-field) bg-sun-50 px-2.5 py-1.5 text-xs font-medium text-sun-700">
            <CloudLightning className="mt-0.5 size-3.5 shrink-0" />
            {stop.alert}
          </p>
        )}
        <PlatformLinks name={stop.name} className="mt-1.5" />
        <StopNotes stop={notes} />
      </div>
    </div>
  );
}
