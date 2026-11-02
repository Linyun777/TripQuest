import { getJourney, isJourneyId } from "@tripquest/application";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { confirmJourneyAction, previewJourneyAction } from "./actions";
import { PreviewForm } from "./preview-form";
import { pageUser } from "../../../auth/session";

interface Props { readonly params: Promise<{ journeyId: string }> }

export const metadata: Metadata = { title: "试算延误后的安排 · TripQuest", description: "在已保存行程上进行只读差异试算。" };

export default async function PreviewPage({ params }: Props) {
  const { journeyId } = await params;
  const user = await pageUser(`/journeys/${journeyId}/preview`);
  if (!isJourneyId(journeyId)) notFound();
  await connection();
  let result;
  try {
    const client = getSharedJourneyDatabase();
    result = await getJourney(journeyId, new DrizzleJourneyRepository(client.database, user.id));
  } catch {
    return <main className="min-h-dvh bg-[#f7f9f7] px-4 py-10 text-[#21352e]"><div className="mx-auto max-w-3xl"><h1 className="text-2xl font-semibold">暂时无法读取行程</h1><p className="mt-3 text-[#62736c]">数据库暂不可用，请稍后刷新重试。</p><Link href={`/journeys/${journeyId}`} className="mt-6 inline-flex min-h-12 items-center text-[#236d55] underline">返回行程详情</Link></div></main>;
  }
  if (result.status !== "found") notFound();
  const journey = result.journey;
  if (journey.creationKind !== "manual") notFound();
  return <main className="min-h-dvh bg-[#f7f9f7] px-4 py-6 text-[#21352e] sm:px-6 sm:py-10"><div className="mx-auto max-w-3xl">
    <header className="mb-8 flex items-center justify-between gap-3"><Link href={`/journeys/${journeyId}`} className="inline-flex min-h-12 items-center rounded-xl text-sm font-medium text-[#236d55] underline focus-visible:outline-2">← 返回已保存行程</Link><span className="rounded-full bg-[#fff1e4] px-3 py-2 text-xs font-semibold text-[#81553e]">模拟试算 · 未保存</span></header>
    <p className="text-xs font-semibold tracking-[0.16em] text-[#4f806e]">当前数据库计划 · v{journey.version}</p>
    <h1 className="mt-3 text-3xl font-semibold tracking-tight">试算延误后的安排</h1>
    <p className="mt-3 text-sm leading-7 text-[#62736c]">{journey.title} · {journey.date} · 中国标准时间。只能试算一项未来普通活动与后续已确认固定预约。试算结果不会修改原计划。</p>
    <PreviewForm journey={journey} action={previewJourneyAction.bind(null, journeyId)} confirmAction={confirmJourneyAction.bind(null, journeyId)} />
  </div></main>;
}
