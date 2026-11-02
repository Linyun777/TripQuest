"use client";

import {
  referenceCases,
  validateCandidatePlan,
  type CandidateValidationInput,
  type CandidateValidationResult,
  type ReferenceCase,
  type ValidationIssueCode,
  type ValidationVerdict,
} from "@tripquest/domain";
import Link from "next/link";
import { useState } from "react";

const verdictLabels: Record<ValidationVerdict, string> = {
  feasible: "可行",
  known_violation: "已知违反硬约束",
  insufficient_information: "信息不足",
  invalid_input: "输入无效",
};

const issueLabels: Record<ValidationIssueCode, string> = {
  invalid_shape: "输入结构不正确",
  invalid_datetime: "日期或时间无效",
  invalid_interval: "时间区间无效",
  invalid_number: "分钟数或版本无效",
  duplicate_id: "标识重复",
  inconsistent_baseline: "当前计划与状态自相矛盾",
  ambiguous_travel_leg: "同一方向的交通记录重复",
  stale_base: "候选基于过期版本",
  journey_mismatch: "行程标识不一致",
  protected_activity_changed: "受保护的活动被修改",
  outside_scope_change: "修改超出了允许范围",
  unauthorized_metadata_change: "活动的优先级、锁定或预约关联被擅改",
  reservation_conflict: "候选与预约事实冲突",
  activity_overlap: "活动时间重叠",
  delay_conflict: "活动早于延误后的可继续时间",
  travel_conflict: "交通与缓冲后赶不上下一活动",
  unknown_location: "观察位置未知",
  unknown_travel_duration: "所需交通时间未知",
  reservation_unverified: "预约状态尚未核实",
  current_activity_end_unknown: "当前活动的实际结束时间未知",
  activity_progress_unknown: "活动在观察时的执行状态未知",
};

const placeNames: Record<string, string> = {
  "P-A": "虚构地点 A",
  "P-B": "虚构地点 B",
  "P-C": "虚构地点 C",
  "P-D": "虚构地点 D（晚餐）",
};

const activityNames: Record<string, string> = {
  "A-MORNING": "上午活动",
  "A-LUNCH": "午餐",
  "A-AFTERNOON": "下午活动",
  "A-DINNER": "固定晚餐",
};

function time(value: string): string {
  return value.slice(11, 16);
}

function activityName(id: string): string {
  return activityNames[id] ?? id;
}

function placeName(id: string): string {
  return placeNames[id] ?? id;
}

function originalControls(example: ReferenceCase) {
  const leg = example.input.travelLegs.find(
    (item) => item.fromPlaceId === "P-C" && item.toPlaceId === "P-D",
  );
  const afternoon = example.candidate.activities.find((item) => item.id === "A-AFTERNOON");
  return {
    travelKind: leg?.duration.kind ?? "unknown",
    travelMinutes: leg?.duration.kind === "known" ? String(leg.duration.minutes) : "",
    afternoonEndsAt: afternoon ? time(afternoon.endsAt) : "",
  } as const;
}

function buildInput(
  example: ReferenceCase,
  travelKind: "known" | "unknown",
  travelMinutes: string,
  afternoonEndsAt: string,
): CandidateValidationInput {
  return {
    ...example.input,
    travelLegs: example.input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? {
            ...leg,
            duration:
              travelKind === "known"
                ? { kind: "known" as const, minutes: travelMinutes.trim() === "" ? NaN : Number(travelMinutes) }
                : { kind: "unknown" as const, reason: "not_provided" },
          }
        : leg,
    ),
    candidate: {
      ...example.candidate,
      activities: example.candidate.activities.map((activity) =>
        activity.id === "A-AFTERNOON"
          ? {
              ...activity,
              endsAt: `${activity.endsAt.slice(0, 11)}${afternoonEndsAt}:00+08:00`,
            }
          : activity,
      ),
    },
  };
}

export default function ValidatorLab() {
  const [caseIndex, setCaseIndex] = useState(0);
  const example = referenceCases[caseIndex];
  const [controls, setControls] = useState(() => originalControls(referenceCases[0]));
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<CandidateValidationResult | null>(null);

  function selectCase(index: number) {
    setCaseIndex(index);
    setControls(originalControls(referenceCases[index]));
    setDirty(false);
    setResult(null);
  }

  function changeControls(patch: Partial<typeof controls>) {
    setControls((previous) => ({ ...previous, ...patch }));
    setDirty(true);
    setResult(null);
  }

  function reset() {
    setControls(originalControls(example));
    setDirty(false);
    setResult(null);
  }

  function runValidation() {
    const input = buildInput(
      example,
      controls.travelKind,
      controls.travelMinutes,
      controls.afternoonEndsAt,
    );
    setResult(validateCandidatePlan(input));
  }

  const scope = example.input.request.scope;
  const fixedDinner = example.input.reservations.find((item) => item.id === "R-DINNER");

  return (
    <main className="min-h-dvh bg-[#f6f8f5] px-4 py-6 text-[#21352e] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold tracking-[0.16em] text-[#398268]">TRIPQUEST · 本地实验</p>
            <h1 className="mt-2 text-3xl font-semibold">一日候选行程校验</h1>
          </div>
          <Link href="/" className="rounded-lg border border-[#b9cdc2] px-4 py-2 text-sm hover:bg-white">返回首页</Link>
        </header>

        <p className="rounded-2xl border border-[#e5cc87] bg-[#fff8e5] p-4 text-sm leading-6">
          以下地点、预约和交通时间均为手写虚构样例，仅供本地验收；结果不代表真实可达，也不会保存行程。
        </p>

        <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="case-heading">
          <h2 id="case-heading" className="text-lg font-semibold">1. 选择案例</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {referenceCases.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectCase(index)}
                aria-pressed={caseIndex === index}
                className={`rounded-xl border px-4 py-2.5 font-medium ${caseIndex === index ? "border-[#236d55] bg-[#236d55] text-white" : "border-[#c9d9cf] bg-white hover:bg-[#f1f7f2]"}`}
              >
                {item.id}
              </button>
            ))}
          </div>
          <p className="mt-4 font-medium">{example.id} · {example.title}</p>
          <p className="mt-2 text-sm leading-6 text-[#536a5e]">
            人工预期：{verdictLabels[example.expected.kind]}
            {"arrivalAtNextLockedActivity" in example.expected && example.expected.arrivalAtNextLockedActivity && `，到达晚餐 ${time(example.expected.arrivalAtNextLockedActivity)}`}
            {dirty && <strong className="ml-2 text-[#a25716]">仅适用于原始样例</strong>}
          </p>
          <p className="mt-1 text-sm leading-6 text-[#536a5e]">人工依据（原始样例）：{example.expected.reasoning}</p>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="facts-heading">
            <h2 id="facts-heading" className="text-lg font-semibold">2. 查看原计划与约束</h2>
            <p className="mt-3 text-sm text-[#536a5e]">观察 {time(example.input.state.observedAt)}；最早继续 {time(example.input.request.delay.earliestResumeAt)}</p>
            <p className="mt-2 text-sm text-[#536a5e]">
              允许修改：{scope.kind === "selected_window" ? `${time(scope.window.startsAt)}–${time(scope.window.endsAt)}` : `${time(scope.from)} 起至当天结束`}
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {example.input.plan.activities.map((activity) => (
                <li key={activity.id} className="flex flex-wrap justify-between gap-x-3 rounded-lg bg-[#f6f8f5] px-3 py-2">
                  <span>{activityName(activity.id)} · {placeName(activity.placeId)}</span>
                  <span className="font-mono">{time(activity.startsAt)}–{time(activity.endsAt)}</span>
                </li>
              ))}
            </ul>
            {fixedDinner && (
              <p className="mt-4 rounded-lg bg-[#eaf4ec] p-3 text-sm">
                固定晚餐预约：{placeName(fixedDinner.placeId)} {time(fixedDinner.startsAt)}–{time(fixedDinner.endsAt)}，状态：已确认。
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="edit-heading">
            <h2 id="edit-heading" className="text-lg font-semibold">3. 修改候选与交通</h2>
            <p className="mt-3 text-sm text-[#536a5e]">当前候选完整安排：</p>
            <ul className="mt-2 space-y-1 text-sm text-[#536a5e]">
              {example.candidate.activities.map((activity) => (
                <li key={activity.id}>{activityName(activity.id)} {time(activity.startsAt)}–{activity.id === "A-AFTERNOON" ? controls.afternoonEndsAt || "无效时间" : time(activity.endsAt)} · {placeName(activity.placeId)}</li>
              ))}
            </ul>
            <fieldset className="mt-5">
              <legend className="font-medium">虚构交通 P-C → P-D</legend>
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="travelKind" checked={controls.travelKind === "known"} onChange={() => changeControls({ travelKind: "known" })} />已知分钟数</label>
                <label className="flex items-center gap-2"><input type="radio" name="travelKind" checked={controls.travelKind === "unknown"} onChange={() => changeControls({ travelKind: "unknown" })} />未知</label>
              </div>
            </fieldset>
            <label className="mt-4 block text-sm font-medium" htmlFor="travel-minutes">交通分钟数</label>
            <input
              id="travel-minutes"
              type="number"
              inputMode="numeric"
              value={controls.travelMinutes}
              disabled={controls.travelKind === "unknown"}
              onChange={(event) => changeControls({ travelMinutes: event.target.value })}
              className="mt-2 w-full rounded-lg border border-[#aebfb4] px-3 py-2.5 disabled:bg-[#edf0ed] sm:max-w-44"
            />
            <label className="mt-4 block text-sm font-medium" htmlFor="afternoon-end">候选下午活动结束时间</label>
            <input
              id="afternoon-end"
              type="time"
              value={controls.afternoonEndsAt}
              onChange={(event) => changeControls({ afternoonEndsAt: event.target.value })}
              className="mt-2 w-full rounded-lg border border-[#aebfb4] px-3 py-2.5 sm:max-w-44"
            />
            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" onClick={runValidation} className="rounded-xl bg-[#236d55] px-5 py-3 font-medium text-white hover:bg-[#195740]">运行校验</button>
              <button type="button" onClick={reset} className="rounded-xl border border-[#aebfb4] px-5 py-3 font-medium hover:bg-[#f6f8f5]">重置</button>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="result-heading" aria-live="polite">
          <h2 id="result-heading" className="text-lg font-semibold">4. 校验结果</h2>
          {!result ? (
            <p className="mt-3 text-sm text-[#536a5e]">点击“运行校验”查看实时结果；修改输入后需重新运行。</p>
          ) : (
            <div className="mt-4 space-y-5">
              <p className="inline-block rounded-lg bg-[#eaf4ec] px-3 py-2 font-semibold">{verdictLabels[result.verdict]} <span className="font-mono text-sm">{result.verdict}</span></p>
              {result.issues.length > 0 && (
                <div>
                  <h3 className="font-medium">原因</h3>
                  <ul className="mt-2 space-y-2">
                    {result.issues.map((issue, index) => (
                      <li key={`${issue.code}-${index}`} className="rounded-lg bg-[#fff6e9] px-3 py-2 text-sm leading-6">
                        <span className="font-medium">{issueLabels[issue.code]}</span> <code className="break-all text-[#7d5731]">{issue.code}</code>
                        {(issue.activityId || issue.relatedActivityId || issue.fieldPath || issue.fromPlaceId) && (
                          <span className="block text-[#6f6254]">{[issue.activityId, issue.relatedActivityId, issue.fieldPath, issue.fromPlaceId && `${issue.fromPlaceId} → ${issue.toPlaceId}`].filter(Boolean).join(" · ")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="font-medium">已核对的交通衔接</h3>
                {result.checkedTransitions.length === 0 ? (
                  <p className="mt-2 text-sm text-[#536a5e]">没有可验证的到达时间。</p>
                ) : (
                  <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                    {result.checkedTransitions.map((transition, index) => (
                      <li key={`${transition.toActivityId}-${index}`} className="rounded-xl bg-[#f2f7f3] p-3 text-sm leading-6">
                        <p className="font-medium">{transition.fromActivityId ? activityName(transition.fromActivityId) : "观察位置"} → {activityName(transition.toActivityId)}</p>
                        <p>{placeName(transition.fromPlaceId)} → {placeName(transition.toPlaceId)}</p>
                        <p>离开 {time(transition.departsAt)} + 交通 {transition.travelMinutes} 分钟 + 缓冲 {transition.bufferMinutes} 分钟</p>
                        <p>最早到达 <strong>{time(transition.earliestArrivalAt)}</strong>；下一活动开始 {time(transition.nextStartsAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
