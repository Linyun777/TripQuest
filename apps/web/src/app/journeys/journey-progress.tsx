"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dayTime } from "@tripquest/domain";
import type { DayProgressCommand, DayProgressView } from "@tripquest/application/day-progress";
import type {
  ReplanCandidate,
  ReplanOffer,
  ReplanProgress,
  ReplanResult,
} from "@tripquest/application/day-replan-contract";
import type { ReplanGoal, ReplanScope } from "@tripquest/application/day-replan-contract";
import { DayMap } from "./day-map";
import type { PlanningMapConfig } from "./map-config";
import { ArchivedList, FutureTimeline } from "./replan-timeline";
import { readReplanStream } from "./replan-stream";
import { useWriteCoordinator } from "./write-coordinator";
import { isTerminalTask } from "@tripquest/application/planning-task";
import { rememberTask, usePlanningTask } from "../tasks/use-planning-task";

export interface ProgressMember {
  readonly id: string;
  readonly name: string;
  readonly role: "optional" | "required" | "fixed" | "discovered";
  readonly plannedStartsAt: number;
  readonly plannedEndsAt: number;
  readonly archived?: "completed" | "skipped";
}
type Mark = "none" | "completed" | "skipped";
type Issue = ReplanCandidate["checks"][number];

const control = "mt-2 min-h-12 w-full rounded-xl border border-[#cbdacf] bg-white px-3 text-sm";
const button = "min-h-12 rounded-xl bg-[#236d55] px-5 text-sm font-medium text-white disabled:opacity-50";
const secondary = "min-h-12 rounded-xl border border-[#b8cfc0] px-5 text-sm font-medium disabled:opacity-50";
const SCOPES: Record<ReplanScope, string> = {
  rest_of_day: "当天剩余全部",
  until_next_fixed: "下个固定事项前",
};
const GOALS: Record<ReplanGoal, string> = {
  keep_as_much: "尽量保留安排",
  less_walking: "少走路",
  relaxed: "更宽松",
};
const PHASES: Record<ReplanProgress["phase"], string> = {
  preparing: "准备调整",
  baseline: "先按当前顺序试排",
  deciding: "决定下一步",
  searching: "调查附近候选",
  routing: "核对步行交通",
  checking: "检查固定安排与时间",
  observing: "整理本步结果",
};
const FAILURES: Record<Extract<ReplanResult, { status: "failed" }>["code"], string> = {
  model_error: "模型调用失败，本次没有调整候选。",
  invalid_output: "模型返回了无法识别的动作，已停止。",
  semantic_invalid: "模型再次给出越权或不合规的动作，已停止。",
  provider_error: "演示地点或路线数据异常，已停止。",
  budget_exhausted: "达到本轮调用上限，已停止；这不表示无解。",
  timeout: "调整超过时间上限，已停止。",
  context_limit: "信息超出模型上下文上限，已安全停止。",
  engine_limit: "规划步数达到上限，已停止。",
  internal_error: "调整服务内部错误，本次没有候选。",
  live_budget: "本轮真实模型额度不可用，未继续调用。",
};
const REPORT_ERRORS: Record<string, string> = {
  invalid_request: "报告格式不正确，请检查时间与勾选。",
  not_found: "找不到这份行程。",
  source_not_allowed: "仅支持当前演示目录的已保存行程。",
  invalid_report: "报告不成立：已报告的完成/跳过不能撤销或互换，时间不能早于上次报告，继续时间不能早于观察时间，且须在行程当天。",
  stale: "计划或状态已经变化，请刷新后基于最新版本重新报告。",
  intent_conflict: "这次报告编号已用于不同内容，请刷新后重新填写。",
  disabled: "请配置保存开关和独立确认密钥后启用进度报告。",
};
const CONFIRM_ERRORS: Record<string, string> = {
  invalid_receipt: "确认已失效，请重新生成调整。",
  expired: "确认已过期（15 分钟），请重新生成调整。",
  stale: "计划或状态已经变化，此候选不能覆盖新状态；请刷新后重新生成。",
  candidate_changed: "重新核对后候选已变化，没有保存；请重新生成。",
  intent_conflict: "这次调整已有不同的确认意图，请刷新后查看当前版本。",
  acknowledgment_required: "请先知悉候选中尚未核实的信息。",
  disabled: "请配置保存开关和独立确认密钥后启用确认。",
  not_found: "找不到这份行程。",
};
const UNCERTAIN = "尚未拿到保存结果。它可能已经保存，请保留同一内容重试；不会生成新的意图。";

function issueText(issue: Issue, names: Map<string, string>): string {
  const name = issue.activityId ? names.get(issue.activityId) ?? "某项活动" : "";
  switch (issue.code) {
    case "day_fixed_late":
      return `固定事项${name}${dayTime(issue.expected ?? 0)} 开始，按路线最早 ${dayTime(issue.actual ?? 0)} 才能到。`;
    case "day_window_exceeded":
      return `回到终点最早 ${dayTime(issue.actual ?? 0)}，晚于最晚抵达 ${dayTime(issue.expected ?? 0)}。`;
    case "day_route_unknown":
      return "有一段步行路线无法核实，不能给出可靠时间线。";
    case "day_frozen_changed":
      return "范围外的安排不能被改动。";
    case "day_activity_count":
      return "已处理与接下来的活动合计不能超过 6 项。";
    default:
      return "组合或路线证据不满足要求。";
  }
}

function preflightText(body: unknown, names: Map<string, string>): string {
  const reply = (body ?? {}) as {
    status?: string;
    reason?: string;
    message?: string;
    conflicts?: { code: string; activityId?: string }[];
  };
  switch (reply.status) {
    case "needs_information":
      return reply.reason === "location_unknown"
        ? "当前位置未知：报告已保存，但调整前需要再保存一次带当前位置的报告。"
        : "请先保存一次进度报告（完成/跳过、时间和当前位置），再生成调整。";
    case "constraints_conflict":
      return (reply.conflicts ?? []).map((conflict) => {
        const name = names.get(conflict.activityId ?? "") ?? "该事项";
        return conflict.code === "hard_skipped"
          ? `你报告跳过了必去/固定事项「${name}」：不会自动删除它或取消预约，本步不能自动改线。`
          : conflict.code === "fixed_passed"
            ? `固定事项「${name}」的开始时间早于你能继续的时间：保留原安排，不自动顺延。`
            : "最早继续时间已到或晚于原定结束时间，当天剩余时间无法安排。";
      }).join(" ");
    case "invalid_scope":
      return "当前没有未完成的固定事项，不能选择“下个固定事项前”。";
    case "stale":
      return "计划或状态已经变化，请刷新后再调整。";
    case "disabled":
    case "temporarily_unavailable":
      return reply.message?.slice(0, 200) ?? "途中调整暂不可用。";
    default:
      return "暂时无法开始调整，请稍后手动重试。";
  }
}

export function JourneyProgressWorkspace({
  journeyId,
  date,
  planVersion,
  observationVersion,
  members,
  places,
  progress,
  saveEnabled,
  availability,
  fixedAhead,
  mapConfig,
  initialTaskId = null,
}: {
  journeyId: string;
  date: string;
  planVersion: number;
  observationVersion: number;
  members: ProgressMember[];
  places: { id: string; name: string }[];
  progress: DayProgressView;
  saveEnabled: boolean;
  availability: { enabled: boolean; message: string };
  fixedAhead: boolean;
  mapConfig: PlanningMapConfig;
  /** `?task=` from the address: resume watching a durable replan task. */
  initialTaskId?: string | null;
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

  const [scope, setScope] = useState<ReplanScope>("rest_of_day");
  const [goal, setGoal] = useState<ReplanGoal>("keep_as_much");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<ReplanProgress | null>(null);
  const [result, setResult] = useState<ReplanResult | null>(null);
  const [offer, setOffer] = useState<ReplanOffer | undefined>();
  const [notice, setNotice] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmPending, setConfirmPending] = useState<{ receipt: string; acknowledgeUnknowns: boolean } | null>(null);
  const [confirmMessage, setConfirmMessage] = useState("");
  const [selected, setSelected] = useState("start");
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [taskId, setTaskId] = useState<string | null>(initialTaskId);
  const task = usePlanningTask(taskId);
  const taskView = task.view?.kind === "day_replan" ? task.view : null;
  // A task built on other versions (or another journey) is history, not this page's candidate.
  const foreignTask = taskView !== null && (
    taskView.journeyId !== journeyId ||
    taskView.base.planVersion !== planVersion ||
    taskView.base.observationVersion !== observationVersion
  );
  const taskActive = taskId !== null && !task.missing && !foreignTask &&
    !(taskView && isTerminalTask(taskView.status));
  const [stoppedByUser, setStoppedByUser] = useState(false);

  useEffect(() => () => {
    sequence.current += 1;
    controller.current?.abort();
    release("replan");
    release("report");
    release("confirm");
  }, [release]);

  // The page claim follows the task; a missing or foreign task is dropped from the address.
  useEffect(() => {
    if (!taskId) return;
    if (task.missing || foreignTask) {
      rememberTask(null);
      release("replan");
    } else if (taskActive) {
      claim("replan");
    } else if (taskView) {
      release("replan");
    }
  }, [taskId, task.missing, foreignTask, taskActive, taskView, claim, release]);
  const taskDone = taskView !== null && !foreignTask && isTerminalTask(taskView.status);
  const taskResult = taskDone && !stoppedByUser && taskView.status !== "cancelled" ? taskView.result : null;
  const shownResult = taskResult ?? result;
  const shownOffer = taskResult ? taskView?.offer ?? undefined : offer;
  const taskNotice = !taskDone ? ""
    : stoppedByUser || taskView.status === "cancelled"
      ? "已取消本次调整；迟到的结果不会显示，已保存的报告不受影响。"
      : !taskView.result && taskView.stopReason === "deadline"
        ? "调整超过时间上限，已停止；已保存的报告不受影响，可以重新生成。"
        : !taskView.result && taskView.stopReason
          ? "后台执行多次中断，本次没有结果；已保存的报告不受影响，可以重新生成。"
          : "";

  const blocked = (intent: "report" | "replan" | "confirm") => owner !== null && owner !== intent;
  const frozen = reportPending !== null || confirmPending !== null;

  /** Any new input, report or version change drops the candidate and its acknowledgment. */
  function clearCandidate() {
    if (taskId) {
      if (taskActive) void task.cancel();
      setStoppedByUser(false);
      setTaskId(null);
      rememberTask(null);
    }
    sequence.current += 1;
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
    setPhase(null);
    setResult(null);
    setOffer(undefined);
    setAcknowledge(false);
    setNotice("");
    setConfirmMessage("");
    release("replan");
  }

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
    clearCandidate();
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

  async function generate() {
    if (running || taskActive || !availability.enabled) return;
    clearCandidate();
    if (!claim("replan")) return;
    const serial = ++sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    let startedTask = false;
    try {
      const response = await fetch(`/api/journeys/${journeyId}/replan`, {
        method: "POST",
        // One key per click: a network retry of this request joins the same task.
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ basePlanVersion: planVersion, baseObservationVersion: observationVersion, scope, goal }),
        cache: "no-store",
        signal: abort.signal,
      });
      if (serial !== sequence.current) return;
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/x-ndjson") || !response.body) {
        const body = await response.json().catch(() => null) as { taskId?: unknown } | null;
        if (serial !== sequence.current) return;
        if (response.ok && typeof body?.taskId === "string") {
          // Durable task: the hook follows it; the page claim stays until it ends.
          startedTask = true;
          setStoppedByUser(false);
          setTaskId(body.taskId);
          rememberTask(body.taskId);
          return;
        }
        setNotice(preflightText(body, names));
        return;
      }
      const outcome = await readReplanStream(response.body, (next) => {
        if (serial === sequence.current) setPhase(next);
      });
      if (serial !== sequence.current) return;
      if (outcome.kind === "result") {
        setResult(outcome.result);
        setOffer(outcome.offer);
      } else {
        setNotice("调整连接中断或数据不完整，本次没有结果；可以手动重新生成。已保存的报告不受影响。");
      }
    } catch {
      if (serial === sequence.current) setNotice("暂时无法连接调整服务，请稍后手动重试。");
    } finally {
      if (serial === sequence.current) {
        controller.current = null;
        setRunning(false);
        if (!startedTask) release("replan");
      }
    }
  }

  function cancel() {
    if (taskId) {
      setStoppedByUser(true);
      void task.cancel();
      return;
    }
    sequence.current += 1;
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
    setPhase(null);
    release("replan");
    setNotice("已取消本次调整；迟到的结果不会显示，已保存的报告不受影响。");
  }

  async function confirm() {
    if (confirmBusy || shownOffer?.status !== "available") return;
    const body = confirmPending ?? { receipt: shownOffer.receipt, acknowledgeUnknowns: acknowledge };
    if (!claim("confirm")) return;
    setConfirmBusy(true);
    setConfirmMessage("");
    try {
      const response = await fetch(`/api/journeys/${journeyId}/replan/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await response.json() as { status: string; planVersion?: number };
      if (reply.status === "saved" || reply.status === "already_saved") {
        setConfirmPending(null);
        release("confirm");
        setConfirmMessage(`调整已保存为 v${reply.planVersion}，正在读取真实当前版本。`);
        rememberTask(null);
        router.refresh();
      } else if (reply.status === "temporarily_unavailable") {
        setConfirmPending(body);
        setConfirmMessage(UNCERTAIN);
      } else {
        setConfirmPending(null);
        release("confirm");
        if (reply.status !== "acknowledgment_required") {
          setResult(null);
          setOffer(undefined);
          setAcknowledge(false);
          setTaskId(null);
          rememberTask(null);
        }
        setConfirmMessage(CONFIRM_ERRORS[reply.status] ?? "没有保存，请重新生成调整。");
      }
    } catch {
      setConfirmPending(body);
      setConfirmMessage(UNCERTAIN);
    } finally {
      setConfirmBusy(false);
    }
  }

  const busy = running || taskActive;
  const shownPhase = phase ?? taskView?.progress ?? null;
  const candidate = shownResult?.status === "completed" && shownResult.outcome === "candidate" ? shownResult : null;
  const candidateNames = new Map(candidate?.candidate.activities.map((a) => [a.key, a.name]) ?? []);
  const allNames = new Map([...names, ...candidateNames]);
  const reportInputsDisabled = !saveEnabled || reportBusy || frozen || blocked("report");

  return (
    <section aria-labelledby="progress-title" className="mt-8 rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-7">
      <h2 id="progress-title" className="text-lg font-semibold">旅途状态与途中调整</h2>
      <div className="mt-3 rounded-2xl bg-[#f1f7f2] p-4 text-sm leading-6" role="status">
        {reported ? (
          <>
            <p className="font-semibold">
              当前状态 v{reported.version} · {reported.observedAt.slice(11, 16)} 观察 · 最早 {reported.earliestResumeAt.slice(11, 16)} 继续
            </p>
            <p>
              当前位置：{reported.locationPlaceId ? names.get(reported.locationPlaceId) ?? "已保存地点" : "未知（调整前需补充）"}
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
                        clearCandidate();
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
            <input type="time" className={control} value={observed} onChange={(e) => { clearCandidate(); setObserved(e.target.value); }} />
          </label>
          <label className="block text-sm font-medium">
            最早继续时间
            <input type="time" className={control} value={resume} onChange={(e) => { clearCandidate(); setResume(e.target.value); }} />
          </label>
        </div>
        <label className="block text-sm font-medium">
          当前位置
          <select className={control} value={location} onChange={(e) => { clearCandidate(); setLocation(e.target.value); }}>
            <option value="unknown">未知（可以保存，但调整前需补充）</option>
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
            onChange={(e) => { clearCandidate(); setNoCurrent(e.target.checked); }}
          />
          我确认当前没有正在进行的活动（本阶段不推断进行中活动的剩余时间）。
        </label>
        <button type="button" className={button} onClick={() => void submitReport()} disabled={reportBusy}>
          {reportBusy ? "正在保存…" : reportPending ? "按同一内容重试保存" : "保存进度报告"}
        </button>
      </fieldset>
      {reportMessage && <p role="status" className="mt-3 text-sm leading-6 text-[#81553e]">{reportMessage}</p>}

      <div className="mt-8 border-t border-[#dce8e0] pt-6">
        <h3 className="font-semibold">调整接下来的安排</h3>
        <p className="mt-2 text-sm leading-6 text-[#52665c]">{availability.message}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            调整范围
            <select
              className={control}
              value={scope}
              disabled={running || frozen}
              onChange={(e) => { clearCandidate(); setScope(e.target.value as ReplanScope); }}
            >
              <option value="rest_of_day">{SCOPES.rest_of_day}</option>
              <option value="until_next_fixed" disabled={!fixedAhead}>{SCOPES.until_next_fixed}</option>
            </select>
          </label>
          <label className="block text-sm font-medium">
            调整目标（软偏好，不保证最优）
            <select
              className={control}
              value={goal}
              disabled={running || frozen}
              onChange={(e) => { clearCandidate(); setGoal(e.target.value as ReplanGoal); }}
            >
              {(Object.keys(GOALS) as ReplanGoal[]).map((value) => (
                <option key={value} value={value}>{GOALS[value]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className={button}
            disabled={!availability.enabled || !reported || busy || frozen || blocked("replan")}
            onClick={() => void generate()}
          >
            {busy ? "正在调整…" : shownResult ? "重新生成调整" : "生成调整候选"}
          </button>
          {busy && !taskView?.cancelRequested && (
            <button type="button" className={secondary} onClick={cancel}>取消调整</button>
          )}
        </div>
        {!reported && <p className="mt-2 text-sm text-[#52665c]">先保存一次进度报告后才能生成调整。</p>}
        <div className="mt-4 text-sm leading-6" role="status" aria-live="polite">
          {busy && shownPhase && (
            <p>
              {PHASES[shownPhase.phase]} · 调查 {shownPhase.counts.searches}/2 · 试算 {shownPhase.counts.tries}/3
              · 路线 {shownPhase.counts.routes}/28 · 决策 {shownPhase.counts.model}/8
            </p>
          )}
          {busy && !shownPhase && <p>{taskId ? "已提交，等待后台开始调整…" : "正在开始调整…"}</p>}
          {taskActive && (
            <p className="text-[#52665c]">调整在后台进行；离开或刷新本页后回来，仍会看到同一次结果。</p>
          )}
          {taskActive && task.unreachable && (
            <p className="text-[#8f392e]">暂时联系不上服务，正在继续尝试；调整本身不会因此丢失。</p>
          )}
          {taskActive && task.overdue && (
            <p className="text-[#8f392e]">已超过预计时间仍未结束；可以继续等待或取消。</p>
          )}
          {(notice || taskNotice) && <p>{taskNotice || notice}</p>}
        </div>

        {candidate && (
          <div className="mt-4 space-y-4 rounded-2xl border border-[#b8cfc0] p-4">
            <p className="text-sm font-semibold">调整候选 · 尚未保存，当前仍为 v{planVersion}</p>
            <p className="text-sm leading-6">{candidate.explanation}</p>
            <Comparison result={candidate} names={allNames} />
            <ArchivedList view={candidate.candidate} />
            <DayMap
              draft={{
                startPlace: { placeId: candidate.candidate.resume.key },
                endPlace: { placeId: candidate.candidate.end.key },
                activities: candidate.candidate.activities.map((item) => ({ activityId: item.key, placeId: item.placeKey })),
              }}
              places={candidate.candidate.places}
              selected={selected}
              onSelect={setSelected}
              config={mapConfig}
            />
            <FutureTimeline
              view={candidate.candidate}
              heading="候选：接下来安排"
              selected={selected.replace(/^activity:/, "")}
              onSelect={(key) => setSelected(`activity:${key}`)}
            />
            {shownOffer?.status === "available" ? (
              <>
                <label className="flex min-h-12 items-start gap-3 text-sm leading-6">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={acknowledge}
                    disabled={confirmBusy || frozen}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                  />
                  我已知悉：营业、票务和预约仍未核实；这是演示地点及路线，确认不会完成或取消任何预约。
                </label>
                <button
                  type="button"
                  className={button}
                  disabled={confirmBusy || (!acknowledge && shownOffer.acknowledgeUnknownsRequired) || blocked("confirm")}
                  onClick={() => void confirm()}
                >
                  {confirmBusy ? "正在保存…" : confirmPending ? "按同一内容重试保存" : "确认调整并保存新版本"}
                </button>
              </>
            ) : (
              <p className="text-sm text-[#81553e]">
                {shownOffer?.reason === "stale"
                  ? "生成期间计划或状态已变化，此候选不能确认；请刷新后重新生成。"
                  : shownOffer?.reason === "disabled"
                    ? CONFIRM_ERRORS.disabled
                    : "暂时无法提供确认，请重新生成。"}
              </p>
            )}
          </div>
        )}
        {shownResult?.status === "completed" && shownResult.outcome === "unchanged" && (
          <p className="mt-4 text-sm leading-6">{shownResult.explanation}</p>
        )}
        {shownResult?.status === "completed" && shownResult.outcome === "bounded_no_candidate" && (
          <div className="mt-4 rounded-2xl border border-[#e8d7c4] bg-[#fff8f0] p-4 text-sm leading-6">
            <p className="font-semibold">有限尝试未找到可行调整</p>
            <p>{shownResult.explanation}</p>
            <ul className="mt-2 list-disc pl-5">
              {[...shownResult.baselineIssues, ...shownResult.issues].map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issueText(issue, allNames)}</li>
              ))}
            </ul>
            <p className="mt-2 text-[#52665c]">可以换一个调整目标、报告跳过某个可选事项，或提早继续时间后再试。</p>
          </div>
        )}
        {(shownResult?.status === "failed" || shownResult?.status === "cancelled") && (
          <p className="mt-4 text-sm leading-6 text-[#8f392e]" role="alert">
            {shownResult.status === "failed" ? FAILURES[shownResult.code] : "本次调整已取消。"}已保存的报告不受影响。
          </p>
        )}
        {confirmMessage && <p role="status" className="mt-3 text-sm leading-6 text-[#81553e]">{confirmMessage}</p>}
      </div>
    </section>
  );
}

function Comparison({
  result,
  names,
}: {
  result: Extract<ReplanResult, { outcome: "candidate" }>;
  names: Map<string, string>;
}) {
  const { comparison, candidate } = result;
  const metrics = (m: ReplanCandidate["metrics"]) =>
    `${m.activities} 项 · 步行 ${m.walking} 分钟 · 等待 ${m.waiting} 分钟 · ${dayTime(m.endArrival)} 到终点`;
  const CHANGE = { kept: "保持", moved: "时间变化", removed: "移出接下来安排", added: "新增" } as const;
  return (
    <div className="rounded-2xl bg-[#f1f7f2] p-4 text-sm leading-6">
      <p className="font-semibold">与当前版本的差异</p>
      <ul className="mt-1 list-disc pl-5">
        {comparison.changes.map((change) => (
          <li key={change.key}>
            {change.name}：{CHANGE[change.change]}
            {change.before && ` · 原 ${dayTime(change.before.startsAt)}–${dayTime(change.before.endsAt)}`}
            {change.after && ` → ${dayTime(change.after.startsAt)}–${dayTime(change.after.endsAt)}`}
          </li>
        ))}
        {comparison.changes.length === 0 && <li>没有未处理活动需要变化。</li>}
      </ul>
      <p className="mt-2">
        保留当前顺序：
        {comparison.baseline === null ? "未试排"
          : comparison.baseline.status === "scheduled"
            ? `可行（${metrics(comparison.baseline.metrics)}）${comparison.baseline.sameAsCandidate ? "，即本候选" : ""}`
            : `不可行（${comparison.baseline.issues.map((issue) => issueText(issue, names)).join("；")}）`}
      </p>
      <p>本候选：{metrics(candidate.metrics)}</p>
      <p className="text-xs text-[#62736c]">
        移出不等于你报告了“跳过”；时间由程序按演示路线、停留与缓冲计算，不代表实际执行或全局最优。
      </p>
    </div>
  );
}
