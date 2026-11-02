"use client";

import {
  generateBaselineCandidate,
  referenceCases,
  type BaselineAttempt,
  type BaselineNotConstructedReason,
  type BaselinePlanningInput,
  type BaselinePlanningResult,
  type BaselineStatus,
  type BaselineStrategy,
  type CandidateValidationResult,
  type PlannedActivity,
  type ValidationIssue,
  type ValidationIssueCode,
} from "@tripquest/domain";
import Link from "next/link";
import { useState } from "react";

const example = referenceCases[0];

const statusLabels: Record<BaselineStatus, string> = {
  candidate_found: "找到通过校验的候选",
  needs_information: "必要信息不足",
  no_feasible_candidate: "固定三种策略未找到可行候选",
  invalid_input: "输入无效",
  request_not_current: "请求基于旧版本或另一行程",
  unsupported_scenario: "超出单项活动基线的能力",
  planner_error: "候选构造错误",
};

const strategyLabels: Record<BaselineStrategy, string> = {
  keep: "保持原计划",
  shift: "完整顺延一项活动",
  omit: "提议移除一项未来活动",
};

const reasonLabels: Record<BaselineNotConstructedReason, string> = {
  outside_scope: "顺延后越出可改范围",
  would_reorder: "顺延后会挤到下一项活动",
  duplicate: "顺延所得日程与原计划相同",
  omit_not_allowed: "高优先级活动不能自动移除",
  multiple_editable_activities: "有多项可改活动，本基线只支持一项",
};

const issueLabels: Record<ValidationIssueCode, string> = {
  invalid_shape: "输入结构无效",
  invalid_datetime: "日期时间无效",
  invalid_interval: "时间区间无效",
  invalid_number: "分钟数或版本无效",
  duplicate_id: "标识重复",
  inconsistent_baseline: "基础计划与状态矛盾",
  ambiguous_travel_leg: "同方向交通重复",
  stale_base: "基础版本已变化",
  journey_mismatch: "行程标识不一致",
  protected_activity_changed: "受保护活动被修改",
  outside_scope_change: "修改越出范围",
  unauthorized_metadata_change: "活动元数据被擅改",
  reservation_conflict: "与预约事实冲突",
  activity_overlap: "活动时间重叠",
  delay_conflict: "开始时间早于可继续时间",
  travel_conflict: "交通后赶不上下一项活动",
  unknown_location: "观察位置未知",
  unknown_travel_duration: "交通时间未知",
  reservation_unverified: "预约尚未核实",
  current_activity_end_unknown: "当前活动实际结束时间未知",
  activity_progress_unknown: "活动执行进度未知",
};

const activityNames: Record<string, string> = {
  "A-MORNING": "上午活动",
  "A-LUNCH": "午餐",
  "A-AFTERNOON": "下午活动",
  "A-DINNER": "固定晚餐",
};

const placeNames: Record<string, string> = {
  "P-A": "虚构地点 A",
  "P-B": "虚构地点 B",
  "P-C": "虚构地点 C",
  "P-D": "虚构地点 D（晚餐）",
};

function activityName(id: string): string {
  return activityNames[id] ?? id;
}

function placeName(id: string): string {
  return placeNames[id] ?? id;
}

function time(value: string): string {
  return value.slice(11, 16);
}

function makeInput(resumeAt: string, travelKind: "known" | "unknown", minutes: string): BaselinePlanningInput {
  return {
    ...example.input,
    request: {
      ...example.input.request,
      delay: {
        ...example.input.request.delay,
        earliestResumeAt: `${example.input.plan.date}T${resumeAt}:00+08:00`,
      },
    },
    travelLegs: example.input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? {
            fromPlaceId: leg.fromPlaceId,
            toPlaceId: leg.toPlaceId,
            duration: travelKind === "known"
              ? { kind: "known" as const, minutes: minutes.trim() === "" ? NaN : Number(minutes) }
              : { kind: "unknown" as const, reason: "not_provided" },
          }
        : leg,
    ),
  };
}

function IssueList({ issues }: { issues: readonly ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="rounded-lg bg-[#fff6e9] px-3 py-2 leading-6">
          {issueLabels[issue.code]} <code className="break-all text-[#795734]">{issue.code}</code>
          {issue.activityId && <span className="ml-2">{activityName(issue.activityId)}</span>}
          {issue.relatedActivityId && <span className="ml-2">来自 {activityName(issue.relatedActivityId)}</span>}
          {issue.fromPlaceId && <span className="ml-2">{issue.fromPlaceId} → {issue.toPlaceId}</span>}
          {issue.fieldPath && <span className="ml-2 break-all">{issue.fieldPath}</span>}
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ activities }: { activities: readonly PlannedActivity[] }) {
  return (
    <ul className="mt-3 space-y-2 text-sm">
      {activities.map((activity) => (
        <li key={activity.id} className="flex flex-wrap justify-between gap-x-3 rounded-lg bg-[#f3f7f3] px-3 py-2">
          <span>{activityName(activity.id)} · {placeName(activity.placeId)}</span>
          <span className="font-mono">{time(activity.startsAt)}–{time(activity.endsAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function TransitionEvidence({ validation }: { validation: CandidateValidationResult }) {
  return (
    <div className="mt-3">
      <p className="text-sm font-medium">已核对的交通与时间</p>
      {validation.checkedTransitions.length === 0 ? (
        <p className="mt-1 text-sm text-[#617368]">没有足够数据证明到达时间。</p>
      ) : (
        <ul className="mt-2 space-y-2 text-sm leading-6">
          {validation.checkedTransitions.map((transition, index) => (
            <li key={`${transition.toActivityId}-${index}`} className="rounded-lg bg-[#eef6f0] p-3">
              <p>{transition.fromActivityId ? activityName(transition.fromActivityId) : "观察位置"} → {activityName(transition.toActivityId)}（{transition.fromPlaceId} → {transition.toPlaceId}）</p>
              <p>离开 {time(transition.departsAt)} + 交通 {transition.travelMinutes} 分钟 + 缓冲 {transition.bufferMinutes} 分钟 = 最早到达 <strong>{time(transition.earliestArrivalAt)}</strong>；下一项开始 {time(transition.nextStartsAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AttemptCard({ attempt, index }: { attempt: BaselineAttempt; index: number }) {
  return (
    <li className="rounded-xl border border-[#d9e5dc] p-4">
      <h3 className="font-semibold">{index + 1}. {strategyLabels[attempt.strategy]}</h3>
      {attempt.outcome === "not_constructed" ? (
        <p className="mt-2 text-sm text-[#745b41]">未构造候选：{reasonLabels[attempt.reasonCode]} <code className="break-all">{attempt.reasonCode}</code></p>
      ) : (
        <>
          <p className="mt-2 text-sm">校验：<strong>{attempt.validation.verdict}</strong></p>
          <IssueList issues={attempt.validation.issues} />
          <TransitionEvidence validation={attempt.validation} />
        </>
      )}
    </li>
  );
}

function describeChange(result: BaselinePlanningResult): string {
  if (!result.selected) return "";
  if (result.selected.strategy === "keep") return "原计划保持不变。";
  const before = example.input.plan.activities.find((item) => item.id === "A-AFTERNOON");
  const after = result.selected.candidate.activities.find((item) => item.id === "A-AFTERNOON");
  if (!after) return "下午活动从候选中移除；状态没有标记为已跳过，晚餐仍固定。";
  if (!before) return "候选已更新下午活动。";
  return `下午活动由 ${time(before.startsAt)}–${time(before.endsAt)} 顺延至 ${time(after.startsAt)}–${time(after.endsAt)}；晚餐保持原样。`;
}

export default function BaselineLab() {
  const [resumeAt, setResumeAt] = useState("15:30");
  const [travelKind, setTravelKind] = useState<"known" | "unknown">("known");
  const [minutes, setMinutes] = useState("40");
  const [result, setResult] = useState<BaselinePlanningResult | null>(null);

  function reset() {
    setResumeAt("15:30");
    setTravelKind("known");
    setMinutes("40");
    setResult(null);
  }

  const dinner = example.input.plan.activities.find((item) => item.id === "A-DINNER");
  const scope = example.input.request.scope;

  return (
    <main className="min-h-dvh bg-[#f6f8f5] px-4 py-6 text-[#21352e] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold tracking-[0.16em] text-[#398268]">TRIPQUEST · 本地实验</p>
            <h1 className="mt-2 text-3xl font-semibold">固定基线候选</h1>
          </div>
          <Link href="/" className="rounded-lg border border-[#b9cdc2] px-4 py-2 text-sm hover:bg-white">返回首页</Link>
        </header>

        <p className="rounded-2xl border border-[#e5cc87] bg-[#fff8e5] p-4 text-sm leading-6">
          使用 C1 的虚构原计划和交通输入独立生成候选，不读取其手写候选或预期。所有地点、预约及交通分钟数均为虚构；没有真实路线调用，也不会保存或取消行程。
        </p>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="original-heading">
            <h2 id="original-heading" className="text-lg font-semibold">1. 原计划与固定事实</h2>
            <p className="mt-3 text-sm text-[#536a5e]">观察 {time(example.input.state.observedAt)}；位置 {example.input.state.location.kind === "known" ? placeName(example.input.state.location.placeId) : "未知"}</p>
            <p className="mt-1 text-sm text-[#536a5e]">允许修改：{scope.kind === "selected_window" ? `${time(scope.window.startsAt)}–${time(scope.window.endsAt)}` : `${time(scope.from)} 至当天结束`}</p>
            <ActivityList activities={example.input.plan.activities} />
            {dinner && <p className="mt-4 rounded-lg bg-[#e9f3ec] p-3 text-sm">已确认且锁定的晚餐：{time(dinner.startsAt)}–{time(dinner.endsAt)}，地点 {placeName(dinner.placeId)}。</p>}
          </section>

          <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="input-heading">
            <h2 id="input-heading" className="text-lg font-semibold">2. 修改虚构输入</h2>
            <label className="mt-4 block text-sm font-medium" htmlFor="resume-at">最早可以继续的时间</label>
            <input
              id="resume-at" type="time" value={resumeAt}
              onChange={(event) => { setResumeAt(event.target.value); setResult(null); }}
              className="mt-2 w-full rounded-lg border border-[#aebfb4] px-3 py-2.5 sm:max-w-48"
            />
            <fieldset className="mt-5">
              <legend className="text-sm font-medium">虚构交通 P-C → P-D</legend>
              <div className="mt-2 flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" name="baseline-travel" checked={travelKind === "known"} onChange={() => { setTravelKind("known"); setResult(null); }} />已知分钟数</label>
                <label className="flex items-center gap-2"><input type="radio" name="baseline-travel" checked={travelKind === "unknown"} onChange={() => { setTravelKind("unknown"); setResult(null); }} />未知</label>
              </div>
            </fieldset>
            <label className="mt-4 block text-sm font-medium" htmlFor="baseline-minutes">交通分钟数</label>
            <input
              id="baseline-minutes" type="number" inputMode="numeric" value={minutes}
              disabled={travelKind === "unknown"}
              onChange={(event) => { setMinutes(event.target.value); setResult(null); }}
              className="mt-2 w-full rounded-lg border border-[#aebfb4] px-3 py-2.5 disabled:bg-[#edf0ed] sm:max-w-48"
            />
            <p className="mt-4 text-sm leading-6 text-[#536a5e]">按保持原计划、完整顺延、允许时移除下午活动的顺序尝试；每个候选都由同一个硬约束校验器判断。</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" onClick={() => setResult(generateBaselineCandidate(makeInput(resumeAt, travelKind, minutes)))} className="rounded-xl bg-[#236d55] px-5 py-3 font-medium text-white hover:bg-[#195740]">运行基线</button>
              <button type="button" onClick={reset} className="rounded-xl border border-[#aebfb4] px-5 py-3 font-medium hover:bg-[#f6f8f5]">重置</button>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-[#dbe6de] bg-white p-4 sm:p-6" aria-labelledby="result-heading" aria-live="polite">
          <h2 id="result-heading" className="text-lg font-semibold">3. 基线结果</h2>
          {!result ? (
            <p className="mt-3 text-sm text-[#536a5e]">点击“运行基线”查看结果；修改输入后旧结果会清空。</p>
          ) : (
            <div className="mt-4 space-y-5">
              <p className="inline-block rounded-lg bg-[#eaf4ec] px-3 py-2 font-semibold">{statusLabels[result.status]} <code className="break-all text-sm">{result.status}</code></p>
              {result.selected ? (
                <div className="rounded-xl border border-[#9bc4a7] p-4">
                  <h3 className="font-semibold">选中：{strategyLabels[result.selected.strategy]}</h3>
                  <p className="mt-2 text-sm leading-6">{describeChange(result)}</p>
                  <p className="mt-1 text-sm">校验结果：<strong>{result.selected.validation.verdict}</strong></p>
                  <ActivityList activities={result.selected.candidate.activities} />
                </div>
              ) : (
                <p className="text-sm leading-6 text-[#745b41]">没有可选候选。这只说明当前固定策略与已提供资料的结果，不代表所有旅行安排都无解。</p>
              )}
              {result.issues.length > 0 && (
                <div>
                  <h3 className="font-medium">{result.selected ? "前面尝试的拒绝原因或缺口" : "发现的冲突或信息缺口"}</h3>
                  <IssueList issues={result.issues} />
                </div>
              )}
              <div>
                <h3 className="font-medium">按顺序尝试</h3>
                <ol className="mt-3 space-y-3">
                  {result.attempts.map((attempt, index) => <AttemptCard key={`${attempt.strategy}-${index}`} attempt={attempt} index={index} />)}
                </ol>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
