import { getJourney, isJourneyId } from "@tripquest/application";
import {
  DrizzleConversationRepository,
  DrizzleJourneyRepository,
  getSharedJourneyDatabase,
} from "@tripquest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GeneratedDayDetails } from "../generated-day-details";
import { RealDayDetails } from "../../real-places/real-day-details";
import { pageUser } from "../../auth/session";

interface JourneyPageProps {
  readonly params: Promise<{ journeyId: string }>;
  readonly searchParams: Promise<{ saved?: string; version?: string }>;
}

export const metadata: Metadata = {
  title: "行程详情 · TripQuest",
  description: "查看已保存的一日行程与固定预约。",
};

export default async function JourneyPage({ params, searchParams }: JourneyPageProps) {
  const { journeyId } = await params;
  const { saved, version: versionText } = await searchParams;
  const version = versionText === undefined ? undefined : Number(versionText);
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) notFound();
  if (!isJourneyId(journeyId)) notFound();

  await connection();
  const user = await pageUser(`/journeys/${journeyId}`);
  let result;
  try {
    const client = getSharedJourneyDatabase();
    result = await getJourney(
      journeyId,
      new DrizzleJourneyRepository(client.database, user.id),
      version,
    );
  } catch {
    throw new Error("Journey read is temporarily unavailable");
  }
  if (result.status !== "found") notFound();

  const journey = result.journey;
  if (journey.creationKind === "real_day") {
    // The way back to the conversation is a convenience: the page still shows without it.
    const conversationId = await new DrizzleConversationRepository(getSharedJourneyDatabase().database, user.id)
      .findConversationIdByJourney(journey.journeyId)
      .catch(() => null);
    // V2.5: an earlier version is shown as it was, read-only, with a way to the current one.
    let currentVersion = journey.version;
    if (version !== undefined) {
      const current = await getJourney(journeyId, new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user.id)).catch(() => null);
      if (current?.status === "found") currentVersion = current.journey.version;
    }
    return <RealDayDetails journey={journey} userId={user.id} conversationId={conversationId} currentVersion={currentVersion} />;
  }
  if (journey.creationKind === "generated_day") {
    return <GeneratedDayDetails journey={journey} />;
  }
  if (version !== undefined) notFound();
  return (
    <main className="min-h-dvh bg-[#f7f9f7] px-4 py-6 text-[#21352e] sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-10 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55]" aria-label="返回 TripQuest 首页">
            <span className="grid size-10 place-items-center rounded-2xl bg-[#236d55] text-sm font-bold text-white">TQ</span>
            <span className="font-semibold">TripQuest</span>
          </Link>
          <span className="rounded-full border border-[#dce8e0] bg-white px-3 py-1.5 text-xs font-medium text-[#476357]">当前版本 · v{journey.version}</span>
        </header>

        <div className="mb-8">
          {(saved === "new" || saved === "again") && <p role="status" className="mb-5 rounded-2xl border border-[#b8d7c4] bg-[#eff8f1] p-4 text-sm font-medium text-[#236d55]">{saved === "again" ? "这次确认此前已保存，当前显示同一版本。" : "调整已确认并保存为当前版本。"}</p>}
          <p className="mb-3 text-xs font-semibold tracking-[0.16em] text-[#4f806e]">已保存的一日行程</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{journey.title}</h1>
          <div className="mt-4 flex flex-wrap gap-2 text-sm text-[#476357]">
            <span className="rounded-full bg-[#e6f2eb] px-3 py-1.5">{journey.date}</span>
            <span className="rounded-full bg-[#e6f2eb] px-3 py-1.5">中国标准时间 · {journey.timeZone}</span>
          </div>
        </div>

        <section aria-labelledby="timeline-title" className="rounded-3xl border border-[#dce8e0] bg-white p-5 shadow-[0_18px_45px_-38px_rgba(22,57,42,0.55)] sm:p-7">
          <div className="mb-6 flex items-center justify-between gap-3">
            <h2 id="timeline-title" className="text-lg font-semibold">当天时间线</h2>
            <span className="text-sm text-[#62736c]">{journey.activities.length} 项事项</span>
          </div>
          <ol className="space-y-0">
            {journey.activities.map((activity, index) => {
              const fixed = activity.kind === "reservation";
              return (
                <li key={activity.id} className="relative flex gap-4 pb-7 last:pb-0">
                  {index < journey.activities.length - 1 && <span aria-hidden="true" className="absolute left-[9px] top-6 bottom-0 w-px bg-[#dce8e0]" />}
                  <span aria-hidden="true" className={`relative mt-1 size-[19px] shrink-0 rounded-full border-4 border-white ring-2 ${fixed ? "bg-[#b88362] ring-[#ead9ca]" : "bg-[#43a078] ring-[#d9eddf]"}`} />
                  <div className={`min-w-0 flex-1 rounded-2xl border p-4 ${fixed ? "border-[#eddfd5] bg-[#fff8f1]" : "border-[#dce8e0] bg-[#fbfcfa]"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold tabular-nums text-[#236d55]">{activity.startsAt.slice(11, 16)}–{activity.endsAt.slice(11, 16)}</p>
                        <h3 className="mt-1 text-base font-semibold break-words">{activity.placeName}</h3>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${fixed ? "bg-[#f1e2d4] text-[#81553e]" : "bg-[#e6f2eb] text-[#236d55]"}`}>
                        {fixed ? "固定预约" : "普通活动"}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-[#62736c]">
                      优先级：{priorityText(activity.priority)}
                      {fixed && " · 已锁定 · 已确认（用户录入）"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="mt-6 rounded-2xl border border-[#eddfd5] bg-[#fff8f1] p-4 text-sm leading-6 text-[#81553e]">
          {journey.version > 1 && "当前版本基于用户报告的完成情况、位置和交通估计保存；旧计划版本仍在数据库中。"}地点与预约来自用户录入，尚未核验地图、营业时间、路线或现实可达性。
        </div>
        <Link href={`/journeys/${journey.journeyId}/preview`} className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-[#236d55] px-6 font-medium text-white hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55]">试算延误后的安排</Link>
        <p className="mt-8 text-xs leading-6 text-[#829188]">试算需要明确确认才会保存；本地切片尚无账号归属验证，请勿公开部署。</p>
        <Link href="/journeys/new" className="mt-5 inline-flex min-h-12 items-center rounded-2xl bg-[#236d55] px-6 font-medium text-white hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55]">再创建一份行程</Link>
      </div>
    </main>
  );
}

function priorityText(priority: "high" | "normal" | "low") {
  return { high: "高", normal: "普通", low: "低" }[priority];
}
