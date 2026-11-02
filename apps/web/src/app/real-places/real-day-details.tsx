import "server-only";
import { traced } from "../runs/runs";
import Link from "next/link";
import type { JourneyDetails } from "@tripquest/application";
import {
  hydrateRealDay,
  storedRealDaySchema,
  type RealDayCheck,
  type RealDayLeg,
  type StoredRealDay,
} from "@tripquest/application/real-day";
import type { DayIssue } from "@tripquest/domain";
import { readPlanningMapConfig } from "../journeys/map-config";
import { createUserUsage, meteredAmap } from "../usage/usage";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { Card } from "../_ui/card";
import { PlanTimeline } from "../plan/plan-card";
import { PlanMap } from "../plan/plan-map";
import { freeTime, type LegView, type MapStop, type PlanCardView } from "../plan/view-models";
import { readRealPlaceMode } from "./real-mode";
import { createTripProgressService } from "../plan/trip-progress-service";
import { JourneyProgressPanel } from "./journey-progress-panel";

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const chinaClock = (iso: string) =>
  new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(11, 16);

const failureText: Record<string, string> = {
  places_missing: "有地点在高德已查不到（可能已关闭或更换编号）。",
  quota_exceeded: "今天的地点查询次数已用完，明天再来看看。",
  rate_limited: "请求过于频繁，请稍后再打开。",
  timeout: "高德请求超时。",
  upstream_unavailable: "高德服务或网络暂时不可用。",
  authorization_failed: "高德 Key 或服务权限不可用。",
};

function issueText(issue: DayIssue, name: (activityId?: string) => string): string {
  switch (issue.code) {
    case "day_frozen_changed":
    case "day_fixed_late":
      return `${name(issue.activityId)}：按当前路线最早 ${clock(issue.actual ?? 0)} 才能到，晚于计划的 ${clock(issue.expected ?? 0)}。`;
    case "day_window_exceeded":
      return `回到终点最早 ${clock(issue.actual ?? 0)}，晚于最晚抵达 ${clock(issue.expected ?? 0)}。`;
    case "day_route_unknown":
      return "有一段路线按原来的出行方式查不到了，无法核实这一段的时间。";
    default:
      return "按当前数据无法确认这份计划。";
  }
}

/** One live re-query per page render, metered against the daily ledger. */
function checkLive(details: StoredRealDay, key: string, userId: string): Promise<RealDayCheck> {
  const amap = meteredAmap({ key, usage: createUserUsage(userId), purpose: "open" });
  return traced({ trigger: "page_view", userId }, () => hydrateRealDay(details, { places: amap, routes: amap, nowMs: Date.now() }));
}

/**
 * S5.5 reopen of a saved real day. Names and times come from the database; coordinates
 * and walking legs are re-queried for this render only. Any failure leaves it read-only.
 */
/** `conversationId`: the conversation this day was planned in, when there is one (V2.2). */
export async function RealDayDetails({
  journey,
  userId,
  conversationId,
  currentVersion = journey.version,
}: {
  journey: JourneyDetails;
  /** V2.12：当前用户（页面从会话取得）。 */
  userId: string;
  conversationId?: string | null;
  /** V2.5: the newest version; an older one is shown as it was, without live checks. */
  currentVersion?: number;
}) {
  const details = storedRealDaySchema.parse(journey.realDay);
  const mode = readRealPlaceMode();
  const old = journey.version !== currentVersion;
  const check = mode.enabled && !old ? await checkLive(details, mode.key, userId) : null;
  const progress = old ? null : await createTripProgressService({ userId }).load(journey.journeyId, conversationId ?? null).catch(() => null);
  const placeName = (placeId: string) =>
    details.places.find((item) => item.placeId === placeId)?.name ?? "地点";
  const activityName = (activityId?: string) => {
    const found = details.activities.find((item) => item.record.activity.activityId === activityId);
    return found ? placeName(found.record.activity.placeId) : "某项安排";
  };
  const checked = check?.status === "checked" ? check : null;
  // Walk the saved order: each stop's leg is the one from the previous stop's place.
  const path = [
    details.context.startPlaceId,
    ...details.activities.map((item) => item.record.activity.placeId),
    details.context.endPlaceId,
  ];
  const legInto = (step: number) => checked?.legs.find((leg) =>
    leg.fromPlaceId === path[step - 1] && leg.toPlaceId === path[step]);
  const mapConfig = readPlanningMapConfig();
  const plan = toPlanView(journey.title, details, checked, placeName, legInto);
  const mapStops = checked ? toMapStops(details, checked, placeName) : [];

  return (
    <div className="min-h-dvh bg-paper">
      <header className="flex h-14 items-center gap-2 border-b border-line px-3 sm:px-5">
        <Link
          href="/"
          aria-label="返回首页"
          className="grid size-9 place-items-center rounded-full text-ink-soft hover:bg-sunken"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <span className="grid size-7 place-items-center rounded-lg bg-lake-600 text-[11px] font-bold text-white">TQ</span>
        <span className="text-[15px] font-semibold">我的行程</span>
        {conversationId && (
          <Button asChild size="sm" variant="secondary" className="ml-auto">
            <Link href={`/plan/${conversationId}`}>
              <MessageSquare />
              回到对话
            </Link>
          </Button>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <p className="text-xs font-medium text-lake-600">已保存的一日行程</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{journey.title}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone={old ? "sun" : "lake"}>
            第 {journey.version} 版{details.change ? ` · ${details.change.note}` : ""}{old ? " · 旧版本，只读" : ""}
          </Badge>
          <Badge tone="lake">{details.context.date}</Badge>
          <Badge tone="lake">
            <span className="tabular">
              {clock(details.context.window.startsAt)}–{clock(details.context.window.endsAt)}
            </span>
          </Badge>
          <Badge>{details.activities.length} 项活动</Badge>
        </div>

        {currentVersion > 1 && (
          <nav aria-label="版本" className="mt-3 flex flex-wrap gap-1.5 text-sm">
            {Array.from({ length: currentVersion }, (_, index) => index + 1).map((number) => (
              <Link
                key={number}
                href={number === currentVersion ? `/journeys/${journey.journeyId}` : `/journeys/${journey.journeyId}?version=${number}`}
                aria-current={number === journey.version ? "page" : undefined}
                className={number === journey.version
                  ? "rounded-full bg-ink px-3 py-1 font-medium text-white"
                  : "rounded-full bg-sunken px-3 py-1 text-ink-soft hover:bg-line"}
              >
                第 {number} 版{number === currentVersion ? "（当前）" : ""}
              </Link>
            ))}
          </nav>
        )}

        {progress && (
          <Card className="mt-6 p-5 sm:p-6">
            <h2 className="mb-4 font-semibold">行程进度</h2>
            <JourneyProgressPanel initial={progress} mapConfig={readPlanningMapConfig()} />
          </Card>
        )}

        <div className="mt-6">
          {old ? (
            <p role="status" className="mb-4 rounded-(--radius-field) bg-sunken px-4 py-3 text-sm text-ink-soft">
              这是第 {journey.version} 版保存时的安排，只显示名称和时间，不再向高德核对。
            </p>
          ) : <CheckBanner check={check} enabled={mode.enabled} issueText={(issue) => issueText(issue, activityName)} />}
          {checked && checked.renamed.length > 0 && (
            <p className="mb-4 rounded-(--radius-field) bg-sunken px-4 py-3 text-sm text-ink-soft">
              高德上的名称已变化：
              {checked.renamed.map((item) => `${placeName(item.placeId)} → ${item.current}`).join("；")}
              。这里仍显示保存时的名称。
            </p>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <Card className="p-5 sm:p-6">
            <h2 className="font-semibold">当天时间线</h2>
            {plan.totals && (
              <p className="tabular mt-1 text-sm text-ink-soft">
                交通共 {plan.totals.travelMinutes} 分钟
                {plan.totals.fareYuan > 0 && ` · 约 ${plan.totals.fareYuan} 元`}
                {plan.totals.fareUnknown && "（部分费用未知）"}
              </p>
            )}
            <div className="mt-4">
              <PlanTimeline plan={plan} />
            </div>
          </Card>
          {checked && (
            <section aria-label="地图" className="space-y-3">
              <PlanMap
                stops={mapStops}
                paths={checked.legs.flatMap((leg) => (leg.path?.length ? [{ mode: leg.mode, points: leg.path }] : []))}
                config={mapConfig}
              />
            </section>
          )}
        </div>

        <p className="mt-6 text-sm leading-6 text-ink-faint">
          每次打开都会向高德重新查询地点和每段路线（按保存时的出行方式），核对这份安排还剩下的部分是否走得通。
          行程有变化时，回到对话里直接说，确认后会保存为新的版本。
        </p>
      </main>
    </div>
  );
}

/** Saved names and times, with today's live walking legs where the check succeeded. */
function toPlanView(
  title: string,
  details: StoredRealDay,
  checked: Extract<RealDayCheck, { status: "checked" }> | null,
  placeName: (placeId: string) => string,
  legInto: (step: number) => RealDayLeg | undefined,
): PlanCardView {
  const view = (leg: RealDayLeg | undefined, savedMode: LegView["mode"]): LegView =>
    !leg ? { mode: savedMode, minutes: null }
      : leg.samePlace ? { mode: "walking", minutes: 0, samePlace: true }
        : {
            mode: leg.mode,
            minutes: leg.travelMinutes,
            ...(leg.fareYuan !== undefined ? { fareYuan: leg.fareYuan } : {}),
            ...(leg.summary ? { summary: leg.summary } : {}),
          };
  const legs = checked?.legs ?? [];
  const priced = legs.filter((leg) => leg.mode === "transit" || leg.mode === "taxi");
  const scheduled = (activityId: string) =>
    checked?.schedule?.activities.find((item) => item.activityId === activityId);
  // V2.3: a wait before the first stop is shown as leaving later, as the plan card does.
  const firstWait = checked?.tightMinutes ? 0 : scheduled(details.activities[0].record.activity.activityId)?.waitMinutes ?? 0;
  return {
    runId: details.context.creationRunId,
    title,
    date: details.context.date,
    startName: placeName(details.context.startPlaceId),
    endName: placeName(details.context.endPlaceId),
    departAt: clock(details.context.window.startsAt + firstWait),
    arriveAt: clock(checked?.schedule?.endArrival ?? details.context.window.endsAt),
    travelBeforeEnd: view(legInto(details.activities.length + 1), details.context.endArrivalMode ?? "walking"),
    totals: checked?.schedule
      ? {
          // Live minutes per leg: a tight check schedules with drift-adjusted figures.
          travelMinutes: legs.reduce((sum, leg) => sum + (leg.travelMinutes ?? 0), 0),
          fareYuan: Math.round(priced.reduce((sum, leg) => sum + (leg.fareYuan ?? 0), 0)),
          fareUnknown: priced.some((leg) => leg.fareYuan === undefined),
        }
      : null,
    stops: details.activities.map((item, index) => ({
      key: item.record.activity.activityId,
      startsAt: clock(item.startsAt),
      endsAt: clock(item.endsAt),
      name: placeName(item.record.activity.placeId),
      role: item.record.activity.role,
      travelBefore: view(legInto(index + 1), item.arrivalMode ?? "walking"),
      // A tight check schedules with drift-adjusted legs; its waits would be invented.
      // Reopening waits at the stop; a long wait is the same free time the plan card shows.
      ...(() => {
        const wait = checked?.tightMinutes || index === 0 ? 0 : scheduled(item.record.activity.activityId)?.waitMinutes ?? 0;
        const free = freeTime(wait);
        return { waitMinutes: free.freeBefore ? 0 : wait, ...free };
      })(),
    })),
    notes: [],
    pending: [],
    saved: null,
    live: checked !== null,
  };
}

/** Live coordinates for this render only (D-046); the start and end may share a place. */
function toMapStops(
  details: StoredRealDay,
  checked: Extract<RealDayCheck, { status: "checked" }>,
  placeName: (placeId: string) => string,
): MapStop[] {
  const at = (placeId: string) => checked.places.find((item) => item.placeId === placeId)!.place.location;
  const stop = (key: string, label: string, kind: MapStop["kind"], placeId: string): MapStop => ({
    key,
    label,
    kind,
    name: placeName(placeId),
    longitude: at(placeId).longitude,
    latitude: at(placeId).latitude,
  });
  return [
    stop("start", "起", "start", details.context.startPlaceId),
    ...details.activities.map((item, index) =>
      stop(item.record.activity.activityId, String(index + 1), "stop", item.record.activity.placeId)),
    stop("end", "终", "end", details.context.endPlaceId),
  ];
}

function CheckBanner({
  check,
  enabled,
  issueText,
}: {
  check: RealDayCheck | null;
  enabled: boolean;
  issueText: (issue: DayIssue) => string;
}) {
  const box = "mb-4 rounded-(--radius-field) px-4 py-3 text-sm leading-6";
  if (!enabled || !check) {
    return (
      <p role="status" className={`${box} bg-sun-50 text-sun-700`}>
        这是本机真实地点行程。当前环境未开启真实地点模式，只显示保存时的名称和时间，未向高德发送任何请求。
      </p>
    );
  }
  if (check.status === "unavailable") {
    return (
      <p role="status" className={`${box} bg-sun-50 text-sun-700`}>
        实时详情暂时不可用：{failureText[check.reason] ?? "高德返回了无法识别的结果。"}以下为保存时的名称和时间，刷新页面可重试。
      </p>
    );
  }
  const problems = check.issues.filter((issue) =>
    issue.kind === "violation" || issue.code === "day_route_unknown");
  if (check.feasible && problems.length === 0 && check.tightMinutes) {
    return (
      <p role="status" className={`${box} bg-sun-50 text-sun-700`}>
        已按当前高德路线核对（{chinaClock(check.retrievedAt)}）：仍然走得通，但打车/公交按现在的估计会晚约 {check.tightMinutes} 分钟。这类估计常有一两分钟波动，出发前再看一眼。
      </p>
    );
  }
  if (check.feasible && problems.length === 0) {
    return (
      <p role="status" className={`${box} bg-lake-50 text-lake-700`}>
        已按当前高德路线核对（{chinaClock(check.retrievedAt)}）：这份安排仍然走得通。
      </p>
    );
  }
  return (
    <div role="status" className={`${box} bg-sun-50 text-sun-700`}>
      <p className="font-medium">按当前高德路线，这份计划已经排不开：</p>
      <ul className="mt-2 list-disc pl-5">
        {problems.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}
      </ul>
    </div>
  );
}
