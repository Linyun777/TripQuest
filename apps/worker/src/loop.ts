import type { RunThread } from "@tripquest/agent/day-planning";
import {
  PLANNING_TASK_LIMITS,
  type PlanningTaskRepository,
} from "@tripquest/application/planning-task";
import { executeTask, type ExecuteDependencies } from "./execute";

export interface WorkerOptions extends Omit<ExecuteDependencies, "shutdown"> {
  readonly repository: PlanningTaskRepository;
  readonly checkpointer: RunThread["checkpointer"];
  readonly owner: string;
  readonly concurrency?: number;
  readonly idleMs?: number;
  readonly purgeEveryMs?: number;
  readonly log?: (line: string) => void;
}

/**
 * 持续领取可运行任务，并以进程内并发数控制同时执行量。
 * 收到关闭信号后停止领取，通知当前任务退出并等待收尾；可恢复检查点留给下一次接管。
 */
export async function runWorker(options: WorkerOptions, signal: AbortSignal): Promise<void> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const running = new Set<Promise<unknown>>();
  let lastPurge = 0;
  while (!signal.aborted) {
    try {
      // 先结束已无法恢复的任务，再领取仍可运行的任务；清扫不会让超时任务无限重试。
      await options.repository.sweep(new Date(now()));
      if (now() - lastPurge >= (options.purgeEveryMs ?? 10 * 60 * 1000)) {
        lastPurge = now();
        const purged = await options.repository.purge(new Date(now() - PLANNING_TASK_LIMITS.retainMs));
        if (purged) log(`purged ${purged} finished task(s)`);
      }
      while (running.size < (options.concurrency ?? 2) && !signal.aborted) {
        const task = await options.repository.claimNext(options.owner, new Date(now()));
        if (!task) break;
        log(`claimed ${task.kind} ${task.id} attempt ${task.attempts}`);
        const work = executeTask(task, { ...options, shutdown: signal })
          .then((status) => log(`${task.id} ${status}`))
          .catch(() => log(`${task.id} execution error`))
          .finally(() => running.delete(work));
        // 无论成功还是抛错，finally 都释放并发槽；一次任务异常不会永久减少 Worker 的处理能力。
        running.add(work);
      }
    } catch {
      log("database unavailable; retrying");
    }
    await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 500));
  }
  await Promise.allSettled(running);
}
