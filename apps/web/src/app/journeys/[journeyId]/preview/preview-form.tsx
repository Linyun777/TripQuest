"use client";

import type { JourneyDetails, PreviewJourneyOutcome, PreviewIssueCode } from "@tripquest/application";
import Link from "next/link";
import { useActionState, useState } from "react";
import { initialPreviewFormState, type PreviewFormState } from "./form-state";
import type { ConfirmFormState } from "./actions";

interface Props {
  readonly journey: JourneyDetails;
  readonly action: (previous: PreviewFormState, formData: FormData) => Promise<PreviewFormState>;
  readonly confirmAction: (previous: ConfirmFormState, formData: FormData) => Promise<ConfirmFormState>;
}

const issueText: Partial<Record<PreviewIssueCode, string>> = {
  prior_progress_unreported: "请确认观察时间之前的每项活动都已完成。",
  current_activity_unreported: "请确认目前没有正在进行的活动。",
  unknown_observed_location: "当前位置未知；请明确声明是否已在待调整活动地点。",
  unknown_travel_estimate: "待调整地点到固定预约地点的交通时间未知，请填写你的有向估计。",
  unknown_location: "当前位置未知。",
  unknown_travel_duration: "交通时间未知。",
  activity_progress_unknown: "较早活动的进度尚未报告。",
  reservation_unverified: "固定预约尚未确认。",
  unsupported_shape: "此行程或观察时间超出当前试算范围：需要恰好一项未来普通活动，紧随一项已确认固定预约，且无其他未来活动或正在进行的活动。",
  delay_conflict: "按最早继续时间，原活动无法保持原时间。",
  travel_conflict: "按用户交通估计和换乘缓冲，抵达时间晚于固定预约开始。",
  activity_overlap: "试算活动与后续活动时间重叠。",
};

const clock = (value: string) => value.slice(11, 16);
const span = (startsAt: string, endsAt: string) => `${clock(startsAt)}–${clock(endsAt)}`;

export function PreviewForm({ journey, action, confirmAction }: Props) {
  const [state, formAction, pending] = useActionState(action, initialPreviewFormState);
  const [editedRevision, setEditedRevision] = useState<number | null>(null);
  const changed = editedRevision === state.revision;
  return <div className="mt-8 space-y-6">
    <section className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-7" aria-labelledby="base-heading">
      <h2 id="base-heading" className="text-lg font-semibold">原计划 · v{journey.version}</h2>
      <ol className="mt-4 space-y-3">{journey.activities.map((activity) => <li key={activity.id} className={`rounded-2xl border p-4 ${activity.kind === "reservation" ? "border-[#eddfd5] bg-[#fff8f1]" : "border-[#dce8e0] bg-[#fbfcfa]"}`}><div className="flex flex-wrap justify-between gap-2"><strong>{activity.placeName}</strong><span className="tabular-nums">{span(activity.startsAt, activity.endsAt)}</span></div><p className="mt-1 text-xs text-[#62736c]">{activity.kind === "reservation" ? `固定预约 · ${activity.reservation?.confirmationStatus === "confirmed" ? "已确认（用户录入，未经外部核验）" : "未确认"} · 保持不变` : "普通活动"}</p></li>)}</ol>
    </section>

    <form action={formAction} onChange={() => setEditedRevision(state.revision)} noValidate className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-7">
      <fieldset disabled={pending} className="space-y-6 disabled:opacity-70"><legend className="text-lg font-semibold">填写本次临时观察事实</legend>
        <input type="hidden" name="basePlanVersion" value={journey.version} />
        <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">观察时间<input name="observedAt" type="time" required defaultValue={state.values.observedAt} className="journey-input mt-2" /></label><label className="block text-sm font-medium">最早可以继续时间<input name="earliestResumeAt" type="time" required defaultValue={state.values.earliestResumeAt} className="journey-input mt-2" /></label></div>
        <div><p className="text-sm font-medium">逐项确认：观察时间之前哪些活动已经完成？</p><p className="mt-1 text-xs text-[#62736c]">未完成或未报告的较早活动会使试算信息不足。</p><div className="mt-3 space-y-2">{journey.activities.map((activity) => <label key={activity.id} className="flex min-h-11 items-center gap-3 rounded-xl border border-[#dce8e0] px-3 py-2 text-sm"><input type="checkbox" name="completedActivityId" value={activity.id} defaultChecked={state.values.completedActivityIds.includes(activity.id)} className="size-5 accent-[#236d55]" /><span>{activity.placeName} · {span(activity.startsAt, activity.endsAt)}</span></label>)}</div></div>
        <label className="flex min-h-12 items-center gap-3 rounded-xl border border-[#dce8e0] px-3 py-2 text-sm"><input type="checkbox" name="noCurrentActivity" value="yes" defaultChecked={state.values.noCurrentActivity} className="size-5 accent-[#236d55]" />当前没有正在进行的活动</label>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">当前位置</legend><label className="flex min-h-11 items-center gap-3 rounded-xl border border-[#dce8e0] px-3 py-2 text-sm"><input type="radio" name="location" value="unknown" defaultChecked={state.values.location !== "at_target"} className="size-5 accent-[#236d55]" />未知（默认）</label><label className="flex min-h-11 items-center gap-3 rounded-xl border border-[#dce8e0] px-3 py-2 text-sm"><input type="radio" name="location" value="at_target" defaultChecked={state.values.location === "at_target"} className="size-5 accent-[#236d55]" />我现在就在待调整活动地点</label></fieldset>
        <label className="block text-sm font-medium">待调整地点 → 固定预约地点：你估计的交通分钟数<input name="travelMinutes" type="number" min="1" max="240" step="1" inputMode="numeric" defaultValue={state.values.travelMinutes} placeholder="未知；明确估计后填 1–240" className="journey-input mt-2" /><span className="mt-2 block text-xs leading-5 text-[#62736c]">仅使用你填的有向估计；跨地点另加 10 分钟换乘缓冲。同一地点无需估计交通。不是高德路线或现实可达保证。</span></label>
        <button disabled={pending} type="submit" className="min-h-12 w-full rounded-2xl bg-[#236d55] px-6 font-semibold text-white hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55] disabled:cursor-wait disabled:opacity-60">{pending ? "正在试算…" : "重新试算 · 不保存"}</button>
      </fieldset>
    </form>
    <div aria-live="polite">{pending ? <p className="text-sm text-[#62736c]">正在按当前输入重新试算…</p> : <>{state.formError && <p role="alert" className="rounded-2xl border border-[#ebc7c0] bg-[#fff1ee] p-4 text-sm text-[#9b3f32]">{state.formError}</p>}{state.result && <><PreviewResult result={state.result} />{state.result.status === "candidate_found" && state.result.strategy !== "keep" && state.confirmationKey && (changed ? <p role="status" className="mt-3 rounded-2xl bg-[#fff8f1] p-4 text-sm text-[#81553e]">输入已改变，请重新试算后再确认。</p> : <ConfirmForm key={state.revision} values={state.values} result={state.result} idempotencyKey={state.confirmationKey} action={confirmAction} />)}</>}</>}</div>
    <Link href={`/journeys/${journey.journeyId}`} className="inline-flex min-h-12 items-center text-sm font-medium text-[#236d55] underline">返回原行程</Link>
  </div>;
}

function ConfirmForm({ values, result, idempotencyKey, action }: { readonly values: PreviewFormState["values"]; readonly result: Extract<PreviewJourneyOutcome, { status: "candidate_found" }>; readonly idempotencyKey: string; readonly action: Props["confirmAction"] }) {
  const [state, formAction, pending] = useActionState(action, {} as ConfirmFormState);
  const canRetry = state.status === undefined || state.status === "temporarily_unavailable";
  const message: Record<NonNullable<ConfirmFormState["status"]>, string> = {
    invalid_input: "确认数据无效，请重新试算。",
    stale: "计划或观察版本已变化，请刷新页面并重新试算。",
    preview_changed: "试算结果或预约事实已变化，请重新试算。",
    not_confirmable: "当前结果不能保存，请重新试算。",
    not_found: "行程不存在。",
    idempotency_conflict: "这次确认编号已用于另一份输入，请重新试算。",
    temporarily_unavailable: "暂时无法保存。可使用同一次确认重试。",
  };
  return <form action={formAction} className="mt-4 rounded-3xl border border-[#b8d7c4] bg-white p-5 sm:p-7">
    <input type="hidden" name="basePlanVersion" value={result.basePlanVersion} />
    <input type="hidden" name="baseObservationVersion" value={result.baseObservationVersion} />
    <input type="hidden" name="observedAt" value={values.observedAt} />
    <input type="hidden" name="earliestResumeAt" value={values.earliestResumeAt} />
    {values.completedActivityIds.map((id) => <input key={id} type="hidden" name="completedActivityId" value={id} />)}
    <input type="hidden" name="noCurrentActivity" value={values.noCurrentActivity ? "yes" : ""} />
    <input type="hidden" name="location" value={values.location} />
    <input type="hidden" name="travelMinutes" value={values.travelMinutes} />
    <input type="hidden" name="strategy" value={result.strategy} />
    <input type="hidden" name="semanticFingerprint" value={result.semanticFingerprint} />
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <h3 className="text-lg font-semibold">确认这次调整</h3>
    <p className="mt-2 text-sm leading-6 text-[#476357]">将{result.strategy === "shift" ? "顺延" : "省略"}普通活动并保存为新版本；固定预约不变。依据是你报告的完成情况、位置与交通估计，尚未经地图或预约方核验。</p>
    {state.status && <p role="alert" className="mt-3 rounded-xl bg-[#fff8f1] p-3 text-sm text-[#81553e]">{message[state.status]}</p>}
    {canRetry && <button type="submit" disabled={pending} className="mt-5 min-h-12 w-full rounded-2xl bg-[#236d55] px-6 font-semibold text-white disabled:opacity-60">{pending ? "正在核对并保存…" : state.status ? "用同一次确认重试" : "确认并保存为新版本"}</button>}
    <p className="mt-3 text-xs text-[#62736c]">仅供本地演示，当前没有账号归属验证，请勿公开部署。行程 ID 不代表访问权限。</p>
  </form>;
}

function PreviewResult({ result }: { result: PreviewJourneyOutcome }) {
  if (result.status === "candidate_found") return <section className="rounded-3xl border border-[#b8d7c4] bg-[#eff8f1] p-5 sm:p-7" aria-labelledby="result-heading">
    <p className="text-xs font-semibold text-[#236d55]">模拟试算 · 未保存 · 基于 v{result.basePlanVersion}</p>
    <h2 id="result-heading" className="mt-2 text-xl font-semibold">{result.travelSource === "same_place" ? "按你提供的事实，时间上可衔接" : "按你提供的事实和交通估计，时间上可衔接"}</h2>
    <p className="mt-2 text-sm text-[#476357]">策略：{{ keep: "保持", shift: "顺延", omit: "省略" }[result.strategy]}。固定预约保持不变。</p>
    <ol className="mt-5 space-y-3">{result.differences.map((item) => <li key={item.activityId} className="rounded-2xl border border-[#dce8e0] bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{item.placeName}</strong><span className="rounded-full bg-[#e6f2eb] px-2 py-1 text-xs font-semibold text-[#236d55]">{{ keep: "保持", shift: "顺延", omit: "省略" }[item.change]}</span></div><p className="mt-2 text-sm tabular-nums">原 {span(item.before.startsAt, item.before.endsAt)} → {item.after ? `试算 ${span(item.after.startsAt, item.after.endsAt)}` : "本次省略"}</p>{item.kind === "reservation" && <p className="mt-1 text-xs text-[#81553e]">已确认固定预约未变（用户录入，未经外部核验）</p>}</li>)}</ol>
    <div className="mt-5 rounded-2xl border border-[#eddfd5] bg-[#fff8f1] p-4 text-sm leading-7 text-[#81553e]">衔接算式：{clock(result.transition.departsAt)} 出发 + {result.travelSource === "same_place" ? "同一地点 0 分钟" : `用户估计 ${result.transition.travelMinutes} 分钟`} + 换乘缓冲 {result.transition.bufferMinutes} 分钟 = 预计 {clock(result.transition.earliestArrivalAt)} 到达；固定预约 {clock(result.transition.nextStartsAt)} 开始。{result.travelSource === "user_estimate" && "该估计未经路线核验。"}</div>
  </section>;
  const title: Record<Exclude<PreviewJourneyOutcome["status"], "candidate_found">, string> = {
    needs_information: "信息不足，暂不能判断是否可衔接",
    no_feasible_candidate: "固定三种策略未找到通过的候选",
    unsupported_scenario: "当前切片不支持这份行程或观察时间",
    stale: "行程版本已变化",
    invalid_input: "输入无效",
    not_found: "行程不存在",
    unavailable: "数据暂不可读",
  };
  return <section role="status" className="rounded-3xl border border-[#eddfd5] bg-[#fff8f1] p-5 sm:p-7"><p className="text-xs font-semibold text-[#81553e]">模拟试算 · 未保存</p><h2 className="mt-2 text-lg font-semibold">{title[result.status]}</h2>{result.status === "stale" && <p className="mt-2 text-sm">当前版本是 v{result.currentPlanVersion}。请刷新页面后重新填写。</p>}{result.status === "no_feasible_candidate" && <p className="mt-2 text-sm">保持、顺延、省略在本次输入下均未通过；这不代表所有安排都无解。</p>}{result.status === "unavailable" && <p className="mt-2 text-sm">请稍后重试；恢复后可重新试算。</p>}{"issueCodes" in result && result.issueCodes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{[...new Set(result.issueCodes)].map((code) => <li key={code}>{issueText[code] ?? "请检查输入或当前行程数据后重试。"}</li>)}</ul>}</section>;
}
