"use client";

import { ArrowRight, Bookmark, CalendarRange, Info, Plane, RotateCcw, TrainFront, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "../_ui/card";
import { PlanTimeline } from "./plan-card";
import type { OutingChangeView, OutingDayPartView, OutingDayView } from "./view-models";

const MODE = { train: { label: "高铁/火车", icon: TrainFront }, flight: { label: "航班", icon: Plane }, other: { label: "交通", icon: ArrowRight } } as const;

/**
 * V2.11 出游的一天：按固定交通分成几部分，地点那段是一日方案的时间线，交通那段只写时刻（车次由用户填写，
 * 不给导航）。排不开的一天照实写原因，可以重排这一天。
 */
export function OutingDayCard({
  view,
  onRedo,
  busy = false,
}: {
  view: OutingDayView;
  onRedo?: () => void;
  busy?: boolean;
}) {
  const [, month, day] = view.date.split("-").map(Number);
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <p className="text-xs font-medium text-lake-600">第 {view.day} 天</p>
          <CardTitle className="mt-0.5 text-base">{month}月{day}日</CardTitle>
        </div>
        {view.status !== "draft" && <Badge tone="sun">没排出来</Badge>}
      </CardHeader>
      <CardBody className="space-y-4 pt-3">
        {view.status !== "draft" ? (
          <p className="flex gap-2 rounded-(--radius-field) bg-sun-50 px-3.5 py-2.5 text-sm text-sun-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {view.explanation ?? "这一天没排出来。"}
          </p>
        ) : (
          view.parts.map((part, index) => <Part key={index} part={part} />)
        )}
        {view.notes.length > 0 && (
          <ul className="space-y-1.5 text-sm text-ink-soft">
            {view.notes.map((note) => (
              <li key={note} className="flex gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-ink-faint" />
                {note}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {!view.tripId && onRedo && (
        <CardFooter>
          <Button size="sm" variant="ghost" onClick={onRedo} disabled={busy}>
            <RotateCcw />
            重排这一天
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Part({ part }: { part: OutingDayPartView }) {
  if (part.kind === "plan") return <PlanTimeline plan={part.plan} />;
  if (part.kind === "connect") {
    return (
      <p className="tabular flex items-center gap-2 rounded-(--radius-field) bg-sunken px-3.5 py-2.5 text-sm text-ink-soft">
        <ArrowRight className="size-4 shrink-0 text-ink-faint" />
        {part.departAt} 从{part.from}直接去{part.to}，约 {part.arriveAt} 到
      </p>
    );
  }
  const Icon = MODE[part.mode].icon;
  return (
    <div className="rounded-(--radius-field) border border-line px-3.5 py-2.5 text-sm">
      <p className="tabular flex items-center gap-2 font-medium">
        <Icon className="size-4 shrink-0 text-lake-600" />
        {part.departAt} {part.from} → {part.nextDay ? "次日 " : ""}{part.arriveAt} {part.to}
      </p>
      <p className="mt-1 text-xs text-ink-faint">
        {MODE[part.mode].label}
        {part.estimated ? " · 没填车次，时间是估计" : " · 车次由你填写"}
      </p>
    </div>
  );
}

/**
 * 整趟的操作：这次生成的每一天都排好了才能保存；少的天可以继续规划。保存凭据只在这次页面里，刷新后要重新生成。
 */
export function OutingBar({
  total,
  done,
  failed,
  savable,
  tripId,
  saving,
  busy,
  onSave,
  onContinue,
}: {
  total: number;
  done: number;
  failed: number;
  savable: boolean;
  tripId: string | null;
  saving: boolean;
  busy: boolean;
  onSave?: () => void;
  onContinue?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-(--radius-field) border border-line bg-surface px-3.5 py-2.5 text-sm">
      <CalendarRange className="size-4 shrink-0 text-lake-600" />
      <span className="mr-auto text-ink-soft">
        {tripId ? "整趟已保存" : `已排好 ${done}/${total} 天${failed ? `，${failed} 天没排出来` : ""}`}
      </span>
      {tripId ? (
        <Button asChild size="sm" variant="secondary">
          <Link href="/#trips">
            <Bookmark />
            去我的行程
          </Link>
        </Button>
      ) : (
        <>
          {done + failed < total && onContinue && (
            <Button size="sm" variant="secondary" onClick={onContinue} disabled={busy}>
              继续规划剩下的天
            </Button>
          )}
          {done === total && (
            <Button size="sm" onClick={onSave} disabled={!onSave || !savable || saving || busy}>
              <Bookmark />
              {saving ? "保存中…" : savable ? "保存整趟" : "刷新后要重新生成才能保存"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * V2.11 跨天改动：受影响的每一天先列原来去哪，再给新的安排；确认前不会改行程。保存凭据只在这次页面里，
 * 刷新后要重新说一次。
 */
export function OutingChangeCard({
  view,
  onConfirm,
  confirming = false,
}: {
  view: OutingChangeView;
  onConfirm?: () => void;
  confirming?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <p className="text-xs font-medium text-lake-600">出游改动</p>
          <CardTitle className="mt-0.5 text-base">{view.note}</CardTitle>
          <p className="mt-1 text-sm text-ink-soft">只重排受影响的天，其他天不动</p>
        </div>
        {view.saved && <Badge tone="lake">已保存</Badge>}
      </CardHeader>
      <CardBody className="space-y-4 pt-3">
        {view.days.map((day) => {
          const before = view.before.find((item) => item.day === day.day)?.stops ?? [];
          return (
            <div key={day.id} className="space-y-2">
              <p className="text-sm text-ink-soft">
                第 {day.day} 天原来：{before.length ? before.join("、") : "没有安排地点"}
              </p>
              <OutingDayCard view={day} />
            </div>
          );
        })}
      </CardBody>
      {!view.saved && (
        <CardFooter>
          {view.open ? (
            <Button size="sm" onClick={onConfirm} disabled={!onConfirm || confirming}>
              <Bookmark />
              {confirming ? "保存中…" : "确认改动"}
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">离开页面后需要再说一次才能确认</span>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
