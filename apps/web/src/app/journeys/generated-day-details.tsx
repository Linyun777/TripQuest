import Link from "next/link";
import type { JourneyDetails } from "@tripquest/application";
import { toSavedDayView } from "@tripquest/application/saved-day";
import { dayState } from "@tripquest/application/day-state";
import { storedReplanView } from "@tripquest/application/day-replan";
import { planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { DayEditWorkspace } from "./day-edit-workspace";
import { JourneyProgressWorkspace, type ProgressMember } from "./journey-progress";
import { readPlanningMapConfig } from "./map-config";
import { readDayEditConfig } from "./edit-receipt";
import { readReplanConfig } from "./replan-config";
import { ReplannedDayView } from "./replan-timeline";
import { WriteCoordinator } from "./write-coordinator";

export function GeneratedDayDetails({ journey, taskId }: { journey: JourneyDetails; taskId?: string }) {
  const details = journey.dayDetails;
  if (!details) throw new Error("Generated day details unavailable");
  const isCurrent = journey.version === journey.currentVersion;
  const mapConfig = readPlanningMapConfig();
  const replanConfig = readReplanConfig();
  const state = dayState(details, journey.activities);
  const placeName = (placeId: string) =>
    state.places.find((item) => item.placeId === placeId)!.selection.place.name;
  const members: ProgressMember[] = [
    ...state.archived.map((item) => ({
      id: item.record.activity.activityId,
      name: placeName(item.record.activity.placeId),
      role: item.record.activity.role,
      plannedStartsAt: item.planned.startsAt,
      plannedEndsAt: item.planned.endsAt,
      archived: item.status,
    })),
    ...state.future.map((item) => ({
      id: item.record.activity.activityId,
      name: placeName(item.record.activity.placeId),
      role: item.record.activity.role,
      plannedStartsAt: item.startsAt,
      plannedEndsAt: item.endsAt,
    })),
  ];
  const progress = journey.dayProgress ?? { status: "unreported" as const };
  const reported = progress.status === "reported"
    ? new Set([...progress.completedActivityIds, ...progress.skippedActivityIds])
    : new Set<string>();
  const fixedAhead = state.future.some((item) =>
    item.record.activity.role === "fixed" && !reported.has(item.record.activity.activityId));
  return (
    <main className="min-h-dvh bg-[#f7f9f7] px-4 py-6 text-[#21352e] sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="rounded-xl font-semibold focus-visible:outline-2 focus-visible:outline-[#236d55]"
          >
            TripQuest
          </Link>
          <span className="rounded-full border border-[#dce8e0] bg-white px-3 py-2 text-sm">
            查看 v{journey.version} · 当前 v{journey.currentVersion}
          </span>
        </header>
        <p className="mb-3 text-sm text-[#4f806e]">
          已保存的一日行程 · 演示数据
        </p>
        <h1 className="break-words text-3xl font-semibold sm:text-4xl">
          {journey.title}
        </h1>
        <p className="mt-4 text-sm leading-6 text-[#52665c]">
          {journey.date} · 中国标准时间 · {journey.timeZone}。
          营业、票务与预约仍待核实；固定事项按你声明的时间保留。
        </p>
        <nav className="mt-5 flex flex-wrap gap-2" aria-label="行程版本">
          {Array.from(
            { length: journey.currentVersion ?? journey.version },
            (_, index) => index + 1,
          ).map((version) => (
            <Link
              key={version}
              href={
                version === journey.currentVersion
                  ? `/journeys/${journey.journeyId}`
                  : `/journeys/${journey.journeyId}?version=${version}`
              }
              aria-current={version === journey.version ? "page" : undefined}
              className="inline-flex min-h-11 items-center rounded-xl border border-[#dce8e0] px-4 text-sm"
            >
              v{version}
              {version === journey.currentVersion ? " · 当前" : " · 只读"}
            </Link>
          ))}
        </nav>
        <WriteCoordinator>
          {details.schemaVersion === "stored-day-plan.v3" ? (
            <ReplannedDayView
              view={storedReplanView(details)}
              basis={{
                observationVersion: details.progressBasis.observationVersion,
                observedAt: details.progressBasis.observedAt,
                goal: details.replan.goal,
                scope: details.future.scope,
                mode: details.replan.execution.mode,
                model: details.replan.execution.model,
                recheckedAt: details.replan.recheckedAt,
              }}
              mapConfig={mapConfig}
            />
          ) : (
            <DayEditWorkspace
              journey={journey}
              initial={toSavedDayView(details)}
              mapConfig={mapConfig}
              enabled={readDayEditConfig().enabled}
              choices={planningFixturePlaces()
                .filter((place) => place.categoryCode !== "fixture:start")
                .map((place) => ({
                  externalId: place.ref.externalId,
                  name: place.name,
                  address: place.address ?? "",
                }))}
            />
          )}
          {isCurrent && (
            <JourneyProgressWorkspace
              key={`${journey.version}:${journey.observationVersion}`}
              journeyId={journey.journeyId}
              date={journey.date}
              planVersion={journey.version}
              observationVersion={journey.observationVersion ?? 0}
              members={members}
              places={state.places.map((item) => ({ id: item.placeId, name: item.selection.place.name }))}
              progress={progress}
              saveEnabled={replanConfig.save.enabled}
              availability={replanConfig.availability}
              fixedAhead={fixedAhead}
              mapConfig={mapConfig}
              initialTaskId={
                taskId && /^[0-9a-f-]{36}$/i.test(taskId) ? taskId : null
              }
            />
          )}
        </WriteCoordinator>
        <p className="mt-6 rounded-2xl border border-[#eddfd5] bg-[#fff8f1] p-4 text-sm leading-6 text-[#81553e]">
          {isCurrent
            ? "报告进度只保存事实；调整需要明确确认才会保存为新版本。报告前可修改一处普通活动；旧版只读。"
            : "这是只读的历史版本，显示它保存时的安排与依据，不叠加之后的报告。"}
        </p>
        <Link
          href="/planning/new"
          className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-[#236d55] px-6 font-medium text-white hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55]"
        >
          规划另一份行程
        </Link>
      </div>
    </main>
  );
}
