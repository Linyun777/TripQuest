"use client";

import { ArrowLeft, Map as MapIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Sheet } from "../_ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../_ui/tabs";
import type { PlanningMapConfig } from "../journeys/map-config";
import { PlanTimeline } from "./plan-card";
import { PlanMap } from "./plan-map";
import { ProgressBall, TripProgressPanel, type TripProgressState } from "./trip-progress";
import type { LiveLocation } from "./use-live-location";
import type { MapPath, MapStop, PlanCardView } from "./view-models";

/**
 * Chat on the left, the current plan on the right. On phones the plan becomes a bottom
 * sheet behind a floating button, so the conversation keeps the whole screen.
 */
export function ChatWorkspace({
  title,
  conversation,
  composer,
  plan,
  mapStops,
  mapPaths = [],
  mapConfig,
  trip = null,
  outingHeader = null,
  mode = "daily",
  modeSwitch = null,
  onAdjust,
  onSuggest,
  live,
}: {
  title: string;
  conversation: ReactNode;
  composer: ReactNode;
  plan: PlanCardView | null;
  mapStops: readonly MapStop[];
  mapPaths?: readonly MapPath[];
  mapConfig: PlanningMapConfig;
  /** V2.5: the trip saved from this conversation, with its progress. */
  trip?: TripProgressState | null;
  /** V2.11：出游的按天切换和固定交通，显示在进度上面。 */
  outingHeader?: ReactNode;
  /** V2.11：出游换一套主题变量；顶部的“日常 / 出游”切换。 */
  mode?: "daily" | "outing";
  modeSwitch?: ReactNode;
  onAdjust?: () => void;
  /** V2.6: put a suggested message in the composer; the device's position for the panel. */
  onSuggest?: (text: string) => void;
  live?: LiveLocation;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const planPanel = <PlanPanel plan={plan} mapStops={mapStops} mapPaths={mapPaths} mapConfig={mapConfig} />;
  // V2.11：出游里选中只有交通的一天（没有一日行程）也照样显示按天切换和交通那一行。
  const progressPanel = trip?.view || outingHeader
    ? <>
      {outingHeader}
      {trip?.view ? <TripProgressPanel
        state={trip}
        mapConfig={mapConfig}
        live={live}
        onAdjust={onAdjust && (() => {
          setProgressOpen(false);
          onAdjust();
        })}
        onSuggest={onSuggest && ((text) => {
          setProgressOpen(false);
          onSuggest(text);
        })}
      /> : <p className="rounded-(--radius-field) bg-sunken px-3.5 py-2.5 text-sm text-ink-soft">这一天只有交通，没有安排地点。</p>}
    </>
    : null;
  // With a saved trip, its progress comes first beside the conversation; the plan is a tab away.
  const panel = progressPanel ? (
    <Tabs defaultValue="progress" className="space-y-4">
      <TabsList className="w-full">
        <TabsTrigger value="progress" className="flex-1">行程进度</TabsTrigger>
        <TabsTrigger value="plan" className="flex-1">方案</TabsTrigger>
      </TabsList>
      <TabsContent value="progress" className="outline-none">{progressPanel}</TabsContent>
      <TabsContent value="plan" className="outline-none">{planPanel}</TabsContent>
    </Tabs>
  ) : planPanel;
  return (
    <div data-mode={mode} className="flex h-dvh flex-col bg-paper">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-paper/90 px-3 backdrop-blur sm:px-5">
        <Link
          href="/"
          aria-label="返回首页"
          className="grid size-9 place-items-center rounded-full text-ink-soft hover:bg-sunken"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <span className="grid size-7 place-items-center rounded-lg bg-lake-600 text-[11px] font-bold text-white">TQ</span>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h1>
        {modeSwitch}
        {(plan || mapStops.length > 0) && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-sm font-medium text-white lg:hidden"
          >
            <MapIcon className="size-4" />
            地图
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">{conversation}</div>
          </div>
          <div className="shrink-0 bg-gradient-to-t from-paper via-paper to-paper/0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6">
            <div className="mx-auto w-full max-w-2xl">{composer}</div>
          </div>
        </main>

        <aside className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-line bg-surface/50 p-5 lg:block xl:w-[480px]">
          {panel}
        </aside>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="方案详情">
        {planPanel}
      </Sheet>
      {progressPanel && (
        <>
          {trip?.view ? <ProgressBall state={trip} onOpen={() => setProgressOpen(true)} /> : (
            <button
              type="button"
              onClick={() => setProgressOpen(true)}
              className="fixed bottom-32 right-3 z-30 rounded-full bg-surface px-3.5 py-2 text-sm font-medium shadow-float lg:hidden"
            >
              行程进度
            </button>
          )}
          <Sheet open={progressOpen} onOpenChange={setProgressOpen} title="行程进度">
            <div className="overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{progressPanel}</div>
          </Sheet>
        </>
      )}
    </div>
  );
}

export function PlanPanel({
  plan,
  mapStops,
  mapPaths = [],
  mapConfig,
}: {
  plan: PlanCardView | null;
  mapStops: readonly MapStop[];
  mapPaths?: readonly MapPath[];
  mapConfig: PlanningMapConfig;
}) {
  if (!plan && mapStops.length) {
    // V2.4: a short trip's candidates, before anything is picked into a plan.
    return (
      <div className="space-y-4">
        <p className="font-semibold">这一步的候选</p>
        <PlanMap stops={mapStops} paths={mapPaths} config={mapConfig} connect={false} />
        <ol className="space-y-1.5 text-sm">
          {mapStops.map((stop) => (
            <li key={stop.key} className="flex items-center gap-2.5">
              <span className={stop.kind === "stop"
                ? "grid size-6 place-items-center rounded-full bg-lake-600 text-[11px] font-semibold text-white"
                : "grid size-6 place-items-center rounded-full bg-ink text-[11px] font-semibold text-white"}
              >
                {stop.label}
              </span>
              <span className="truncate">{stop.name}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-lake-50 text-lake-600">
          <MapIcon className="size-6" />
        </span>
        <p className="font-medium">方案会出现在这里</p>
        <p className="text-sm leading-6 text-ink-soft">说说你想怎么过这一天，确认需求卡片后开始规划。</p>
      </div>
    );
  }
  return (
    <Tabs defaultValue="map" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{plan.title}</p>
          <p className="tabular text-sm text-ink-soft">{plan.date} · {plan.departAt}–{plan.arriveAt}</p>
        </div>
        <TabsList>
          <TabsTrigger value="map">地图</TabsTrigger>
          <TabsTrigger value="timeline">时间线</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="map" className="space-y-4 outline-none">
        <PlanMap stops={mapStops} paths={mapPaths} config={mapConfig} />
        <ol className="space-y-1.5 text-sm">
          {mapStops.map((stop) => (
            <li key={stop.key} className="flex items-center gap-2.5">
              <span
                className={
                  stop.kind === "stop"
                    ? "grid size-6 place-items-center rounded-full bg-lake-600 text-[11px] font-semibold text-white"
                    : "grid size-6 place-items-center rounded-full bg-ink text-[11px] font-semibold text-white"
                }
              >
                {stop.label}
              </span>
              <span className="truncate">{stop.name}</span>
            </li>
          ))}
        </ol>
      </TabsContent>
      <TabsContent value="timeline" className="outline-none">
        <PlanTimeline plan={plan} />
      </TabsContent>
    </Tabs>
  );
}
