"use client";

import { dayTime } from "@tripquest/domain";
import { ArrowRight, CalendarCheck, Check, ChevronDown } from "lucide-react";
import { Button } from "../_ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../_ui/tabs";
import { PlanTimeline } from "../plan/plan-card";
import { PlanMap } from "../plan/plan-map";
import { demoQuestions, trialRoute, trialText, type DemoConversation, type DemoOffer, type DemoPlan } from "./demo-conversation";
import { DEMO_INTERESTS, demoMapStops, demoPlaceName, demoTimeline, type DemoStop } from "./demo-schedule";

export function Requirements({
  requirements,
  onGenerate,
}: {
  requirements: DemoConversation["requirements"];
  onGenerate?: () => void;
}) {
  const missing = demoQuestions(requirements);
  const interests = requirements.interests.map((interest) => DEMO_INTERESTS[interest]);

  return (
    <section aria-label="需求卡" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-semibold text-ink">需求卡</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
        <div>
          <dt className="text-xs text-ink-soft">游客中心出发</dt>
          <dd className="tabular mt-0.5 font-medium">
            {requirements.departure === undefined ? "待补充" : dayTime(requirements.departure)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">最晚到松风湖站</dt>
          <dd className="tabular mt-0.5 font-medium">
            {requirements.returnBy === undefined ? "待补充" : dayTime(requirements.returnBy)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">偏好</dt>
          <dd className="mt-0.5 font-medium">{interests.length ? interests.join("、") : "由 TripQuest 按条件安排"}</dd>
        </div>
        {requirements.namedStops.length > 0 && (
          <div className="col-span-2">
            <dt className="text-xs text-ink-soft">指定地点</dt>
            <dd className="mt-0.5 font-medium">{requirements.namedStops.map(demoPlaceName).join("、")}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-ink-soft">固定导览</dt>
          <dd className="tabular mt-0.5 font-medium text-sun-700">
            {requirements.booking ? "14:00–15:00" : "待确认"}
          </dd>
        </div>
      </dl>
      {missing.length === 0 && (
        <Button type="button" onClick={onGenerate} disabled={!onGenerate} className="mt-4 min-h-11">
          生成行程
          <ArrowRight />
        </Button>
      )}
    </section>
  );
}

export function PlanningEvidence({ plan }: { plan: DemoPlan }) {
  const selected = plan.resumeFrom ? plan.stops.slice(1) : plan.stops;
  const comparable = plan.trials.filter((trial) => trial.stops.length === selected.length);
  const chosen = comparable.find((trial) => trial.stops.every((id, index) => id === selected[index]));
  if (!chosen) return null;

  const others = comparable.filter((trial) => trial !== chosen);
  const alternatives = [
    others.find((trial) => trial.result.status === "scheduled"),
    others.find((trial) => trial.result.status === "not_scheduled"),
  ].filter((trial) => trial !== undefined);

  return (
    <details className="group rounded-xl bg-sunken px-3.5 py-2">
      <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-lake-600 [&::-webkit-details-marker]:hidden">
        为什么这样排
        <ChevronDown className="size-4 text-ink-soft group-open:rotate-180" />
      </summary>
      <ul className="space-y-2 border-t border-line pb-1 pt-2 text-sm leading-6 text-ink-soft">
        {[chosen, ...alternatives].map((trial) => (
          <li key={trial.stops.join("-")}>
            <p className="font-medium text-ink">
              {trial === chosen && <Check aria-label="已选" className="mr-1.5 inline size-4 text-lake-700" />}
              {trialRoute(trial.stops)}
            </p>
            <p>{trialText(trial)}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AdjustmentPreview({
  offer,
  onDecision,
}: {
  offer: DemoOffer;
  onDecision: (accept: boolean) => void;
}) {
  const { base, next } = offer;
  const departAt = next.schedule.legs[0].departsAt;
  const removed = base.stops.filter((id) => !next.stops.includes(id));
  const added = next.stops.filter((id) => !base.stops.includes(id));
  return (
    <section aria-label="待确认调整" className="rounded-2xl border border-lake-200 bg-surface p-4 sm:p-5">
      <h2 className="font-semibold text-ink">待确认调整</h2>
      <ul className="mt-2.5 space-y-1.5 text-sm leading-6 text-ink-soft">
        {next.resumeFrom && (
          <li>{demoPlaceName(next.resumeFrom)}已完成，{dayTime(departAt)} 从这里继续。</li>
        )}
        {removed.length > 0 && <li>移出{removed.map(demoPlaceName).join("、")}。</li>}
        {added.length > 0 && <li>加上<span className="font-medium text-ink">{added.map(demoPlaceName).join("、")}</span>。</li>}
        {!next.resumeFrom && !added.length && !removed.length && next.stops.some((id, index) => id !== base.stops[index]) && (
          <li>顺序更新为{trialRoute(next.stops)}。</li>
        )}
        {!next.resumeFrom && next.departure !== base.departure && (
          <li>出发改为 {dayTime(departAt)}。</li>
        )}
        {next.returnBy !== base.returnBy && <li>最晚到站改为 {dayTime(next.returnBy)}。</li>}
        <li className="flex items-start gap-2 text-sun-700">
          <CalendarCheck className="mt-1 size-4 shrink-0" />
          博物馆导览保留在 14:00–15:00。
        </li>
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={() => onDecision(true)} className="min-h-11">采用调整</Button>
        <Button type="button" variant="secondary" onClick={() => onDecision(false)} className="min-h-11">
          保留原方案
        </Button>
      </div>
      <div className="mt-3"><PlanningEvidence plan={next} /></div>
    </section>
  );
}

function PlanSnapshot({ plan, completedStop }: { plan: DemoPlan; completedStop?: DemoStop }) {
  return (
    <div className="space-y-4">
      {completedStop && (
        <p className="flex items-center gap-2 text-sm text-ink-soft">
          <Check className="size-4 text-lake-700" />
          {demoPlaceName(completedStop)}已完成
        </p>
      )}
      <PlanMap stops={demoMapStops(plan.schedule)} config={{ mode: "schematic" }} />
      <PlanTimeline plan={demoTimeline(plan.schedule, plan.namedStops)} sample />
    </div>
  );
}

export function DemoPlanPanel({
  current,
  offer,
  completedStop,
}: {
  current: DemoPlan;
  offer: DemoOffer | null;
  completedStop?: DemoStop;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-ink">松风湖行程</h2>
        <p className="mt-0.5 text-xs text-ink-soft">示意地图与样例步行用时</p>
      </div>
      {offer ? (
        <Tabs defaultValue="preview" className="space-y-3">
          <TabsList className="w-full">
            <TabsTrigger value="current" className="flex-1">当前方案</TabsTrigger>
            <TabsTrigger value="preview" className="flex-1">待确认调整</TabsTrigger>
          </TabsList>
          <TabsContent value="current">
            <PlanSnapshot plan={current} completedStop={completedStop} />
          </TabsContent>
          <TabsContent value="preview">
            <PlanSnapshot plan={offer.next} completedStop={completedStop} />
          </TabsContent>
        </Tabs>
      ) : (
        <>
          <p className="text-sm font-medium text-ink">当前方案 · 第 {current.version} 版</p>
          <PlanSnapshot plan={current} completedStop={completedStop} />
        </>
      )}
    </div>
  );
}
