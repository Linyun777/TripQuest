import type { RunThread } from "@tripquest/agent/day-planning";
import {
  createDayPlanningRunner,
  createDayScriptedModel,
} from "@tripquest/agent/day-planning";
import type { DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import type { DayPlanningProblem } from "@tripquest/application/day-planning";
import {
  PLANNING_TASK_LIMITS,
  type ClaimedPlanningTask,
  type PlanningTaskRepository,
} from "@tripquest/application/planning-task";
import type { MobilityProvider } from "@tripquest/providers";
import { PlanningFixtureProvider } from "@tripquest/providers/planning-fixture";

export interface ExecuteDependencies {
  readonly repository: PlanningTaskRepository;
  readonly checkpointer: RunThread["checkpointer"];
  readonly now?: () => number;
  /** 可注入延迟或失败的提供方测试恢复；默认执行本地模拟链路。 */
  readonly provider?: MobilityProvider;
  /** 可注入脚本决策验证边界；默认策略仅依据公开输入生成决策。 */
  readonly draftModel?: Parameters<typeof createDayPlanningRunner>[0]["model"];
  readonly heartbeatMs?: number;
  /** 进程关闭时终止运行并保留恢复状态，让后续 Worker 接管。 */
  readonly shutdown?: AbortSignal;
}

/** 草案任务结果同时带运行结论与签发确认凭据所需的快照。 */
export interface DraftTaskResult {
  readonly outcome: unknown;
  readonly snapshot: DayDraftConfirmationSnapshot | null;
}

const PROGRESS_INTERVAL_MS = 400;

/**
 * 执行一个已领取任务，最后通过带租约令牌的条件写入落终态。
 * abandoned 表示失去租约或进程关闭，本次不写终态，检查点交给后续接管者。
 */
export async function executeTask(
  task: ClaimedPlanningTask,
  dependencies: ExecuteDependencies,
): Promise<"completed" | "failed" | "cancelled" | "abandoned"> {
  const { repository, checkpointer } = dependencies;
  const now = dependencies.now ?? Date.now;
  // V3.6：途中重排（replan Agent）已删除，不再建这类任务；以前排着的直接记为失败，不运行。
  if (task.kind !== "day_draft") {
    const written = await repository.finish(task.id, task.leaseToken, { status: "failed", result: null }, new Date(now()));
    return written ? "failed" : "abandoned";
  }
  const controller = new AbortController();
  let lost = false;
  let cancelled = task.cancelRequestedAt !== null;
  let overdue = false;
  const stop = () => controller.abort();
  dependencies.shutdown?.addEventListener("abort", stop, { once: true });
  if (dependencies.shutdown?.aborted) stop();
  const deadline = setTimeout(() => {
    overdue = true;
    stop();
  }, Math.max(0, task.deadlineAt.getTime() - now()));
  const heartbeat = setInterval(() => {
    void repository.heartbeat(task.id, task.leaseToken, new Date(now())).then((reply) => {
      if (!reply) {
        lost = true;
        stop();
      } else if (reply.cancelRequested) {
        cancelled = true;
        stop();
      }
    }).catch(() => {
      // 一次续租失败留待下次心跳重试；真正写入仍依靠租约令牌检查隔离旧进程。
    });
  }, dependencies.heartbeatMs ?? PLANNING_TASK_LIMITS.heartbeatMs);
  let lastProgress = 0;
  // 进度只是供页面观察，按时间节流且写入失败不打断求解；最终结果另走受租约保护的终态写入。
  const onProgress = (progress: unknown) => {
    const at = now();
    if (at - lastProgress < PROGRESS_INTERVAL_MS) return;
    lastProgress = at;
    void repository.saveProgress(task.id, task.leaseToken, progress).catch(() => {});
  };
  // 任务行记录排队、租约和终态，LangGraph 检查点记录运行到哪一步；两者职责不同。
  // 复用任务 ID 作为 thread_id，接管者才能续接原图，而不是从头再消耗工具与模型预算。
  const thread = { checkpointer, threadId: task.id };
  const provider = dependencies.provider ?? new PlanningFixtureProvider(now);
  if (cancelled) stop();
  let result: unknown;
  try {
    let snapshot: DayDraftConfirmationSnapshot | null = null;
    const outcome = await createDayPlanningRunner({
      provider,
      model: dependencies.draftModel ?? createDayScriptedModel(),
      now,
      thread,
    }).run(task.input as DayPlanningProblem, {
      signal: controller.signal,
      onProgress,
      onDraftReady(next) {
        snapshot = next;
      },
    });
    result = { outcome, snapshot } satisfies DraftTaskResult;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    dependencies.shutdown?.removeEventListener("abort", stop);
  }
  // 失去租约或正常关闭时保留检查点，不把进程退出误写成业务失败。
  if (lost || (dependencies.shutdown?.aborted && !cancelled && !overdue)) return "abandoned";
  const outcome = (result as DraftTaskResult).outcome;
  const runStatus = (outcome as { status: string }).status;
  // 用户取消和整体截止时间优先于图返回的状态，避免恰好完成时把已取消任务重新显示为成功。
  const status = cancelled ? "cancelled" as const
    : overdue ? "failed" as const
      : runStatus === "completed" ? "completed" as const
        : runStatus === "cancelled" ? "cancelled" as const : "failed" as const;
  const written = await repository.finish(task.id, task.leaseToken, {
    status,
    result,
    ...(cancelled ? { stopReason: "cancelled" as const } : overdue ? { stopReason: "deadline" as const } : {}),
  }, new Date(now()));
  // 即便刚才的心跳成功，写终态前仍可能被接管；以带令牌的写入结果为准，
  // 未写成时不能删检查点，否则会破坏新 Worker 的恢复进度。
  if (!written) return "abandoned";
  // 终态写入成功后才不再需要恢复检查点；清理失败可由后续任务清扫补做。
  await checkpointer.deleteThread(task.id).catch(() => {});
  return status;
}
