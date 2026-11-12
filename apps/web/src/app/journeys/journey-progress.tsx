"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dayTime } from "@tripquest/domain";
import type { DayProgressCommand, DayProgressView } from "@tripquest/application/day-progress";
import { useWriteCoordinator } from "./write-coordinator";

/**
 * 演示行程的进度报告：完成、跳过、时间和位置只作为事实保存，不改计划。V3.6 删了途中重排（replan Agent），
 * 这里只剩报告；已保存的重排版本由 generated-day-details 照常显示。
 */
export interface ProgressMember {
  readonly id: string;
  readonly name: string;
  readonly role: "optional" | "required" | "fixed" | "discovered";
  readonly plannedStartsAt: number;
  readonly plannedEndsAt: number;
  readonly archived?: "completed" | "skipped";
}
type Mark = "none" | "completed" | "skipped";

const control = "mt-2 min-h-12 w-full rounded-xl border border-[#cbdacf] bg-white px-3 text-sm";
const button = "min-h-12 rounded-xl bg-[#236d55] px-5 text-sm font-medium text-white disabled:opacity-50";
const REPORT_ERRORS: Record<string, string> = {
  invalid_request: "报告格式不正确，请检查时间与勾选。",
  not_found: "找不到这份行程。",
  source_not_allowed: "仅支持当前演示目录的已保存行程。",
  invalid_report: "报告不成立：已报告的完成/跳过不能撤销或互换，时间不能早于上次报告，继续时间不能早于观察时间，且须在行程当天。",
  stale: "计划或状态已经变化，请刷新后基于最新版本重新报告。",
  intent_conflict: "这次报告编号已用于不同内容，请刷新后重新填写。",
  disabled: "请配置保存开关和独立确认密钥后启用进度报告。",
};
const UNCERTAIN = "尚未拿到保存结果。它可能已经保存，请保留同一内容重试；不会生成新的意图。";

export function JourneyProgressWorkspace({
  journeyId,
  date,
  planVersion,
  observationVersion,
  members,
  places,
  progress,
  saveEnabled,
}: {
  journeyId: string;
  date: string;
  planVersion: number;
  observationVersion: number;
  members: ProgressMember[];
  places: { id: string; name: string }[];
  progress: DayProgressView;
  saveEnabled: boolean;
}) {
  const router = useRouter();
  const { owner, claim, release } = useWriteCoordinator();
  const reported = progress.status === "reported" ? progress : null;
  const previous = (id: string): Mark =>
    reported?.completedActivityIds.includes(id) ? "completed"
      : reported?.skippedActivityIds.includes(id) ? "skipped" : "none";
  const names = new Map([...members.map((m) => [m.id, m.name] as const), ...places.map((p) => [p.id, p.name] as const)]);

  const [marks, setMarks] = useState<Record<string, Mark>>(() =>
    Object.fromEntries(members.map((member) => [member.id, previous(member.id)])));
  const [observed, setObserved] = useState(reported ? reported.observedAt.slice(11, 16) : "");
  const [resume, setResume] = useState(reported ? reported.earliestResumeAt.slice(11, 16) : "");
  const [location, setLocation] = useState(reported?.locationPlaceId ?? "unknown");
  const [noCurrent, setNoCurrent] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportPending, setReportPending] = useState<DayProgressCommand | null>(null);
  const [reportMessage, setReportMessage] = useState("");

  useEffect(() => () => release("report"), [release]);

  const blocked = (intent: "report") => owner !== null && owner !== intent;
  const frozen = reportPending !== null;

  function buildReport(): DayProgressCommand | null {
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!clock.test(observed) || !clock.test(resume) || !noCurrent) return null;
    return {
      reportId: crypto.randomUUID(),
      basePlanVersion: planVersion,
      baseObservationVersion: observationVersion,
      completedActivityIds: members.filter((m) => marks[m.id] === "completed").map((m) => m.id),
      skippedActivityIds: members.filter((m) => marks[m.id] === "skipped").map((m) => m.id),
      observedAt: `${date}T${observed}+08:00`,
      earliestResumeAt: `${date}T${resume}+08:00`,
      location: location === "unknown" ? { kind: "unknown" } : { kind: "known", placeId: location },
      noCurrentActivity: true,
    };
  }

  async function submitReport() {
    if (reportBusy || !saveEnabled) return;
    const command = reportPending ?? buildReport();
    if (!command) {
      setReportMessage("请填写观察时间与最早继续时间，并明确确认当前没有正在进行的活动。");
      return;
    }
    if (!claim("report")) return;
    setReportBusy(true);
    setReportMessage("");
    try {
      const response = await fetch(`/api/journeys/${journeyId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const reply = await response.json() as { status: string; observationVersion?: number };
      if (reply.status === "saved" || reply.status === "already_saved") {
        setReportPending(null);
        release("report");
        setReportMessage(`进度已保存为状态 v${reply.observationVersion}，正在读取最新状态。`);
        router.refresh();
      } else if (reply.status === "no_change") {
        setReportPending(null);
        release("report");
        setReportMessage("与上次报告相同，未新增状态版本。");
      } else if (reply.status === "temporarily_unavailable") {
        setReportPending(command);
        setReportMessage(UNCERTAIN);
      } else {
        setReportPending(null);
        release("report");
        setReportMessage(REPORT_ERRORS[reply.status] ?? "报告未保存，请检查后重试。");
      }
    } catch {
      setReportPending(command);
      setReportMessage(UNCERTAIN);
    } finally {
      setReportBusy(false);
    }
  }

  const reportInputsDisabled = !saveEnabled || reportBusy || frozen || blocked("report");

  return (
    <section aria-labelledby="progress-title" className="mt-8 rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-7">
      <h2 id="progress-title" className="text-lg font-semibold">旅途状态</h2>
      <div className="mt-3 rounded-2xl bg-[#f1f7f2] p-4 text-sm leading-6" role="status">
        {reported ? (
          <>
            <p className="font-semibold">
              当前状态 v{reported.version} · {reported.observedAt.slice(11, 16)} 观察 · 最早 {reported.earliestResumeAt.slice(11, 16)} 继续
            </p>
            <p>
              当前位置：{reported.locationPlaceId ? names.get(reported.locationPlaceId) ?? "已保存地点" : "未知"}
              · 来源：你的报告
            </p>
            <ul className="mt-1">
              {members.map((member) => (
                <li key={member.id}>
                  {member.name}：
                  {reported.completedActivityIds.includes(member.id) ? "已完成"
                    : reported.skippedActivityIds.includes(member.id) ? "已跳过" : "未报告完成"}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>尚未报告进度。报告只记录你告诉我们的事实，不会改动计划。</p>
        )}
      </div>

      <fieldset disabled={reportInputsDisabled} className="mt-5 space-y-4">
        <legend className="font-semibold">报告进度</legend>
        {!saveEnabled && <p className="text-sm">{REPORT_ERRORS.disabled}</p>}
        <div className="space-y-2">
          {members.map((member) => {
            const locked = previous(member.id) !== "none";
            return (
              <div key={member.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-40 font-medium">
                  {member.name}
                  <span className="font-normal text-[#62736c]">
                    {" "}· 原计划 {dayTime(member.plannedStartsAt)}–{dayTime(member.plannedEndsAt)}
                    {member.role === "fixed" ? " · 固定" : member.role === "required" ? " · 必去" : ""}
                  </span>
                </span>
                {(["none", "completed", "skipped"] as const).map((mark) => (
                  <label key={mark} className="flex min-h-11 items-center gap-2">
                    <input
                      type="radio"
                      name={`mark-${member.id}`}
                      checked={marks[member.id] === mark}
                      disabled={locked}
                      onChange={() => {
                        setMarks((value) => ({ ...value, [member.id]: mark }));
                      }}
                    />
                    {mark === "none" ? "未报告" : mark === "completed" ? "已完成" : "已跳过"}
                  </label>
                ))}
              </div>
            );
          })}
          <p className="text-xs text-[#62736c]">
            已报告的完成/跳过不能撤销；跳过必去或固定事项只记录事实，不会取消预约。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            观察时间（{date}）
            <input type="time" className={control} value={observed} onChange={(e) => setObserved(e.target.value)} />
          </label>
          <label className="block text-sm font-medium">
            最早继续时间
            <input type="time" className={control} value={resume} onChange={(e) => setResume(e.target.value)} />
          </label>
        </div>
        <label className="block text-sm font-medium">
          当前位置
          <select className={control} value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="unknown">未知</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>{place.name}</option>
            ))}
          </select>
        </label>
        <label className="flex min-h-12 items-start gap-3 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={noCurrent}
            onChange={(e) => setNoCurrent(e.target.checked)}
          />
          我确认当前没有正在进行的活动（本阶段不推断进行中活动的剩余时间）。
        </label>
        <button type="button" className={button} onClick={() => void submitReport()} disabled={reportBusy}>
          {reportBusy ? "正在保存…" : reportPending ? "按同一内容重试保存" : "保存进度报告"}
        </button>
      </fieldset>
      {reportMessage && <p role="status" className="mt-3 text-sm leading-6 text-[#81553e]">{reportMessage}</p>}

    </section>
  );
}
