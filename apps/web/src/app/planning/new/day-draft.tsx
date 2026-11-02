"use client";

import { useEffect, useRef, useState } from "react";
import {
  DAY_STREAM_EVENT_BYTES,
  DAY_STREAM_TOTAL_BYTES,
  dayStreamEventSchema,
  type DayDraft,
  type DayPlanningResult,
  type DayProgress,
  type DaySaveOffer,
} from "@tripquest/application/day-planning";
import { dayTime } from "@tripquest/domain";
import { INTEREST_LABELS, type GenerationAvailability } from "./contracts";
import { primaryButton, secondaryButton } from "./place-search";
import { DraftSavePanel } from "./draft-save";
import { isTerminalTask } from "@tripquest/application/planning-task";
import { rememberTask, usePlanningTask, type PlanningTaskState } from "../../tasks/use-planning-task";

const ROUTE_REFRESH_MS = 5 * 60 * 1000;
const PHASES: Record<DayProgress["phase"], string> = {
  preparing: "准备生成",
  deciding: "决定下一步",
  searching: "调查候选地点",
  routing: "核对步行交通",
  checking: "检查固定安排与时间",
  observing: "整理本步结果",
};
const FAILURES: Record<Extract<DayPlanningResult, { status: "failed" }>["code"], string> = {
  model_error: "规划服务暂时出错，本次没有生成行程。",
  invalid_output: "规划服务给出了无法使用的结果，本次没有生成行程。",
  semantic_invalid: "规划结果不满足你的硬性要求，本次没有生成行程。",
  provider_error: "高德地点或路线服务暂时出错，本次没有生成行程，请稍后重试。",
  budget_exhausted: "尝试次数用完仍未排出安排；这不代表一定排不开，可以调整需求后重试。",
  timeout: "生成超过时间上限，已停止。",
  context_limit: "需求内容太多，本次无法规划，请减少活动后重试。",
  engine_limit: "规划步数用完仍未完成，请调整需求后重试。",
  internal_error: "规划服务内部出错，本次没有生成行程。",
  live_budget: "今日规划次数已用完，请明天再试。",
};
const NO_PLAN: Record<Extract<DayPlanningResult, { outcome: "no_plan" }>["reason"], string> = {
  no_suitable_places: "没有找到合适的候选地点。",
  constraints_not_met: "试算过的组合无法同时满足时段与固定安排。",
  insufficient_information: "关键路线或信息无法核实。",
};
const ROLES = {
  fixed: "固定事项 · 预约/票务未核实",
  required: "必去",
  optional: "可选",
  discovered: "新发现",
} as const;

type Issue = Extract<DayPlanningResult, { outcome: "no_plan" }>["issues"][number];
type StreamOutcome =
  | { kind: "result"; result: DayPlanningResult; saveOffer?: DaySaveOffer }
  | { kind: "incomplete" };

function issueText(issue: Issue): string {
  switch (issue.code) {
    case "day_fixed_late":
      return `固定事项 ${dayTime(issue.expected ?? 0)} 开始，按路线最早 ${dayTime(issue.actual ?? 0)} 才能到。`;
    case "day_window_exceeded":
      return `回到终点最早 ${dayTime(issue.actual ?? 0)}，晚于最晚抵达 ${dayTime(issue.expected ?? 0)}。`;
    case "day_route_unknown":
      return "有一段步行路线无法核实，不能给出可靠时间线。";
    case "day_opening_conflict":
      return "已知营业时间无法容纳该停留。";
    case "day_opening_unknown":
      return "营业或最晚入场时间待核实。";
    case "day_tickets_unknown":
      return "票务或预约待核实。";
    default:
      return "组合或路线证据不满足要求。";
  }
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > DAY_STREAM_EVENT_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function preflightMessage(body: unknown): string {
  if (body && typeof body === "object" && "fieldErrors" in body) {
    return "地点选择已过期或需求有变化，请重新选择相关地点并核对需求后再生成。";
  }
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message.slice(0, 200);
  }
  return "暂时无法开始生成，请稍后手动重试。";
}

/** Accepts only a complete, ordered stream for one run; anything else counts as unfinished. */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: DayProgress) => void,
): Promise<StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let total = 0;
  let expected = 0;
  let runId: string | null = null;
  let result: DayPlanningResult | null = null;
  let saveOffer: DaySaveOffer | undefined;
  const accept = (line: string): boolean => {
    if (encoder.encode(line).byteLength > DAY_STREAM_EVENT_BYTES || result) return false;
    let parsed;
    try {
      parsed = dayStreamEventSchema.safeParse(JSON.parse(line));
    } catch {
      return false;
    }
    if (!parsed.success || parsed.data.sequence !== expected) return false;
    const event = parsed.data;
    expected += 1;
    if (event.type === "started") {
      runId = event.runId;
      return true;
    }
    if (event.runId !== runId) return false;
    if (event.type === "progress") onProgress(event.progress);
    else if (event.result.runId === runId) {
      result = event.result;
      saveOffer = event.saveOffer;
    }
    else return false;
    return true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DAY_STREAM_TOTAL_BYTES) throw new Error("stream_limit");
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        if (!accept(buffer.slice(0, newline))) throw new Error("invalid_event");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (encoder.encode(buffer).byteLength > DAY_STREAM_EVENT_BYTES) {
        throw new Error("event_limit");
      }
    }
    buffer += decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    return { kind: "incomplete" };
  }
  return result && !buffer ? { kind: "result", result, saveOffer } : { kind: "incomplete" };
}

export function DraftTimeline({ draft, saved = false, recheckedAt, savedVersion = 1, selectedActivityId, onSelectActivity }: {
  draft: DayDraft; saved?: boolean; recheckedAt?: string; savedVersion?: number;
  selectedActivityId?: string; onSelectActivity?: (id: string) => void;
}) {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (saved) return;
    const age = Date.now() - Date.parse(draft.createdAt);
    const timer = setTimeout(() => setStale(true), Math.max(0, ROUTE_REFRESH_MS - age));
    return () => clearTimeout(timer);
  }, [draft.createdAt, saved]);
  const name = (placeId: string) =>
    draft.places.find((place) => place.placeId === placeId)?.name ?? "未命名地点";
  // One line per activity: "博物馆：营业/最晚入场、票务/预约待核实".
  const pending = draft.activities.flatMap((activity) => {
    const items = draft.checks
      .filter((check) => check.kind === "unknown" && check.activityId === activity.activityId)
      .map((check) =>
        check.code === "day_opening_unknown" ? "营业/最晚入场"
          : check.code === "day_tickets_unknown" ? "票务/预约"
            : issueText(check),
      );
    return items.length ? [{ activity, items }] : [];
  });
  const sourceLabel = draft.startPlace.source.sourceKind === "fixture" ? "演示地点与路线" : "高德地图";

  return (
    <section className="mt-5 space-y-4" aria-labelledby="draft-heading">
      <div className="rounded-2xl border border-[#b8cfc0] bg-[#f1f7f2] p-5">
        <h3 id="draft-heading" className="text-lg font-semibold">
          {saved ? "已保存的一日安排" :
            draft.verification === "checked" ? "一日安排草稿" : "一日安排草稿（部分信息待核实）"}
        </h3>
        <p className="mt-2 text-sm leading-6">
          {draft.date} · 出发 {dayTime(draft.window.startsAt)} · 结束到达 {dayTime(draft.endArrival)}
          （最晚 {dayTime(draft.window.endsAt)}）
        </p>
        <p className="text-sm leading-6">
          步行合计 {draft.totalWalkingMinutes} 分钟 · 最长一段 {draft.longestWalkingMinutes} 分钟 · 来源：{sourceLabel}
        </p>
        <p className="mt-2 text-sm leading-6 text-[#52665c]">
          {saved ? `已保存（第 ${savedVersion} 版）。营业、票务与预约请出发前确认。` :
            "满意的话在下方保存；未保存时，刷新或修改需求后草稿会消失。"}
        </p>
        {saved && recheckedAt && (
          <p className="mt-2 text-sm leading-6 text-[#52665c]">
            生成时间：{new Date(draft.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}；
            保存前检查：{new Date(recheckedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。
            {draft.startPlace.source.sourceKind === "fixture" && "演示路线为本地虚构数据，不代表真实出行可达性。"}
          </p>
        )}
        {stale && (
          <p className="mt-2 text-sm font-medium text-[#8f392e]" role="status">
            生成已超过 5 分钟，路线估计需重新检查；本页不会自动查询。
          </p>
        )}
      </div>
      <ol className="space-y-3" aria-label="草稿时间线">
        <li className="rounded-2xl border border-[#dce8e0] bg-white p-4 text-sm">
          <p className="font-semibold">起点 · {draft.startPlace.name}</p>
          <p className="text-[#52665c]">{dayTime(draft.window.startsAt)} 出发</p>
        </li>
        {draft.legs.map((leg, index) => {
          const activity = draft.activities[index];
          return (
            <li key={`${leg.fromPlaceId}-${leg.toPlaceId}-${index}`} className="space-y-3">
              <p className="rounded-2xl border border-dashed border-[#b8cfc0] px-4 py-3 text-sm leading-6 text-[#21352e]">
                {leg.source === "same_place_assumption"
                  ? "同一地点，未估计场内移动"
                  : `步行约 ${leg.travelMinutes} 分钟（${leg.distanceMeters} 米）+ 预留 ${leg.bufferMinutes} 分钟`}
                {" · "}
                {dayTime(leg.arrivesAt)} 到达{activity ? "" : `终点 ${draft.endPlace.name}`}
              </p>
              {activity && (
                <div className={`rounded-2xl border bg-white p-4 text-sm leading-6 ${selectedActivityId === activity.activityId ? "border-[#236d55] ring-1 ring-[#236d55]" : "border-[#dce8e0]"}`}>
                  <p className="font-semibold">
                    {onSelectActivity ? <button type="button" className="min-h-11 text-left underline" onClick={() => onSelectActivity(activity.activityId)}>
                      {index + 1} · {dayTime(activity.startsAt)}–{dayTime(activity.endsAt)} · {name(activity.placeId)}
                    </button> : `${dayTime(activity.startsAt)}–${dayTime(activity.endsAt)} · ${name(activity.placeId)}`}
                  </p>
                  <p>
                    {ROLES[activity.role]}
                    {activity.interest && activity.interest in INTEREST_LABELS
                      ? ` · ${INTEREST_LABELS[activity.interest as keyof typeof INTEREST_LABELS]}` : ""}
                    {activity.role === "fixed"
                      ? " · 按你填写的时间，预约请自行确认"
                      : ` · 停留 ${activity.stayMinutes} 分钟（${
                          activity.staySource === "user" ? "你填写的预计" : "系统预计"
                        }）`}
                  </p>
                  {activity.waitMinutes > 0 && (
                    <p className="text-[#52665c]">早到等待 {activity.waitMinutes} 分钟</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {pending.length > 0 && (
        <div className="rounded-2xl border border-[#e8d7c4] bg-[#fff8f0] p-4 text-sm leading-6">
          <p className="font-semibold">待核实</p>
          <ul className="mt-1 list-disc pl-5">
            {pending.map(({ activity, items }) => (
              <li key={activity.activityId}>
                {dayTime(activity.startsAt)} {name(activity.placeId)}：{items.join("、")}待核实
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-sm leading-6 text-[#52665c]">
        <p className="font-semibold text-[#21352e]">说明</p>
        <ul className="mt-1 list-disc pl-5">
          {draft.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        {draft.omittedOptional.length > 0 && (
          <>
            <p className="mt-3 font-semibold text-[#21352e]">未纳入的可选地点</p>
            <ul className="mt-1 list-disc pl-5">
              {draft.omittedOptional.map((item) => (
                <li key={item.activityId}>
                  {item.name}：{item.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

export function Outcome({ result, saveOffer }: { result: DayPlanningResult; saveOffer?: DaySaveOffer }) {
  if (result.status === "completed" && result.outcome === "draft") {
    return (
      <>
        <p className="mt-4 text-sm leading-6">{result.explanation}</p>
        <DraftTimeline draft={result.draft} />
        <DraftSavePanel key={result.runId} draft={result.draft} offer={saveOffer} />
      </>
    );
  }
  if (result.status === "completed") {
    return (
      <div className="mt-4 rounded-2xl border border-[#e8d7c4] bg-[#fff8f0] p-4 text-sm leading-6">
        <p className="font-semibold">没有可用草稿</p>
        <p>{NO_PLAN[result.reason]} {result.explanation}</p>
        {result.issues.length > 0 && (
          <ul className="mt-2 list-disc pl-5">
            {result.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issueText(issue)}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[#52665c]">
          可以延长出行时段、把部分必去改为可选、减少活动或调整固定事项后，重新核对并生成。
        </p>
      </div>
    );
  }
  return (
    <p className="mt-4 text-sm leading-6 text-[#8f392e]" role="alert">
      {result.status === "failed" ? FAILURES[result.code] : "本次生成已取消。"}
    </p>
  );
}

const STOPPED: Record<"cancelled" | "deadline" | "worker_lost", string> = {
  cancelled: "本次生成已取消；不会再继续运行。",
  deadline: "生成超过时间上限，已停止；可以重新生成。",
  worker_lost: "后台执行多次中断，本次没有结果；可以重新生成。",
};

/** Progress, waiting notices and the final outcome of a durable draft task. */
export function DraftTaskView({ task, onCancel }: { task: PlanningTaskState; onCancel?: () => void }) {
  const view = task.view?.kind === "day_draft" ? task.view : null;
  const done = view ? isTerminalTask(view.status) : false;
  return (
    <div className="mt-4 text-sm leading-6" role="status" aria-live="polite">
      {task.missing && <p>这次生成的记录已不存在（结果保留 24 小时）。可以重新核对需求并生成。</p>}
      {!task.missing && !done && (
        <>
          <p>
            {!view || view.status === "queued"
              ? "已提交，等待后台开始生成…"
              : view.progress
                ? `${PHASES[view.progress.phase]} · 已搜索 ${view.progress.counts.searches} 次 · 已试排 ${view.progress.counts.tries} 次`
                : "后台正在生成…"}
            {view?.cancelRequested ? " · 正在取消" : ""}
          </p>
          <p className="text-[#52665c]">生成在后台进行；离开或刷新本页后回来，仍会看到同一次结果。</p>
          {task.unreachable && <p className="text-[#8f392e]">暂时联系不上服务，正在继续尝试；生成本身不会因此丢失。</p>}
          {task.overdue && <p className="text-[#8f392e]">已超过预计时间仍未结束；可以继续等待或取消。</p>}
          {onCancel && !view?.cancelRequested && (
            <button type="button" className={`${secondaryButton} mt-3`} onClick={onCancel}>取消生成</button>
          )}
        </>
      )}
      {done && view?.result && <Outcome result={view.result} saveOffer={view.offer ?? undefined} />}
      {done && !view?.result && view?.stopReason && (
        <p className="text-[#8f392e]" role="alert">{STOPPED[view.stopReason]}</p>
      )}
    </div>
  );
}

/** Reopened `/planning/new?task=…`: shows the same task without the cleared requirement form. */
export function ResumedDraftTask({ taskId }: { taskId: string }) {
  const task = usePlanningTask(taskId);
  return (
    <section className="mt-6 rounded-2xl border border-[#dce8e0] bg-white p-5" aria-labelledby="resumed-heading">
      <h3 id="resumed-heading" className="text-lg font-semibold">上次的一日草稿</h3>
      <p className="mt-2 text-sm leading-6 text-[#52665c]">
        这是之前提交的生成任务；需求表单已清空，修改需求请在下方重新核对后生成。
      </p>
      <DraftTaskView task={task} onCancel={() => void task.cancel()} />
    </section>
  );
}

/** Mounted only for a ready summary: any requirement edit unmounts it and aborts the run. */
export function DayDraftPanel({
  submission,
  availability,
}: {
  submission: unknown;
  availability: GenerationAvailability;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DayProgress | null>(null);
  const [result, setResult] = useState<DayPlanningResult | null>(null);
  const [saveOffer, setSaveOffer] = useState<DaySaveOffer | undefined>();
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const task = usePlanningTask(taskId);
  const liveTask = useRef<string | null>(null);
  const taskActive = taskId !== null && !task.missing &&
    !(task.view && isTerminalTask(task.view.status));
  useEffect(() => {
    liveTask.current = taskActive ? taskId : null;
  }, [taskActive, taskId]);
  useEffect(
    () => () => {
      request.current += 1;
      controller.current?.abort();
      // A requirement edit invalidates the draft: stop its task and forget it.
      const active = liveTask.current;
      if (active) {
        void fetch(`/api/tasks/${active}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          keepalive: true,
        }).catch(() => {});
        rememberTask(null);
      }
    },
    [],
  );

  async function generate() {
    if (running || taskActive || !availability.enabled) return;
    const current = ++request.current;
    setTaskId(null);
    rememberTask(null);
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setProgress(null);
    setResult(null);
    setSaveOffer(undefined);
    setNotice("");
    try {
      const response = await fetch("/api/planning/draft", {
        method: "POST",
        // One key per click: a network retry of this request joins the same task.
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(submission),
        cache: "no-store",
        signal: abort.signal,
      });
      if (current !== request.current) return;
      const type = response.headers.get("content-type") ?? "";
      if (response.ok && type.startsWith("application/json")) {
        const body = await readJsonLimited(response) as { taskId?: unknown } | null;
        if (current !== request.current) return;
        if (typeof body?.taskId === "string") {
          setTaskId(body.taskId);
          rememberTask(body.taskId);
          return;
        }
      }
      if (!response.ok || !type.startsWith("application/x-ndjson") || !response.body) {
        const body = await readJsonLimited(response);
        if (current === request.current) setNotice(preflightMessage(body));
        return;
      }
      const outcome = await readStream(response.body, (next) => {
        if (current === request.current) setProgress(next);
      });
      if (current !== request.current) return;
      if (outcome.kind === "result") {
        setResult(outcome.result);
        setSaveOffer(outcome.saveOffer);
      }
      else setNotice("生成连接中断或数据不完整，本次没有结果；可以手动重新生成。");
    } catch {
      if (current === request.current) {
        setNotice("暂时无法连接生成服务，请稍后手动重试。");
      }
    } finally {
      if (current === request.current) {
        controller.current = null;
        setRunning(false);
      }
    }
  }

  function cancel() {
    request.current += 1;
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
    setProgress(null);
    setNotice("已取消本次生成。");
  }

  return (
    <section
      className="mt-6 rounded-2xl border border-[#dce8e0] bg-white p-5"
      aria-labelledby="generate-heading"
    >
      <h3 id="generate-heading" className="text-lg font-semibold">
        生成一日安排
      </h3>
      <p className="mt-2 text-sm leading-6 text-[#52665c]">{availability.message}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className={primaryButton}
          disabled={!availability.enabled || running || taskActive}
          onClick={generate}
        >
          {running || taskActive ? "正在生成…" : result || taskId ? "重新生成" : "生成一日安排"}
        </button>
        {running && (
          <button type="button" className={secondaryButton} onClick={cancel}>
            取消生成
          </button>
        )}
      </div>
      <div className="mt-4 text-sm leading-6" role="status" aria-live="polite">
        {running && progress && (
          <p>
            {PHASES[progress.phase]} · 已搜索 {progress.counts.searches} 次 · 已试排 {progress.counts.tries} 次
          </p>
        )}
        {running && !progress && <p>正在开始生成…</p>}
        {notice && <p>{notice}</p>}
      </div>
      {result && <Outcome result={result} saveOffer={saveOffer} />}
      {taskId && <DraftTaskView task={task} onCancel={() => void task.cancel()} />}
    </section>
  );
}
