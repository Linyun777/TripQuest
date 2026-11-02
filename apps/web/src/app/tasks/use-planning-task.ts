"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TASK_VIEW_BYTES,
  isTerminalTask,
  planningTaskViewSchema,
  type PlanningTaskView,
} from "@tripquest/application/planning-task";

const FAST_MS = 1_000;
const SLOW_MS = 2_000;
const FAST_PERIOD_MS = 10_000;
const UNREACHABLE_MS = 30_000;
const OVERDUE_GRACE_MS = 15_000;

export interface PlanningTaskState {
  readonly view: PlanningTaskView | null;
  /** 一段时间未收到合法响应，提示暂时不可达，后台仍继续轮询原任务。 */
  readonly unreachable: boolean;
  /** 超过服务端截止时间与宽限期，但尚未读到终态；不是客户端自行宣布任务失败。 */
  readonly overdue: boolean;
  readonly missing: boolean;
  readonly cancel: () => Promise<void>;
}

async function readView(response: Response): Promise<PlanningTaskView | null> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > TASK_VIEW_BYTES) return null;
  try {
    const parsed = planningTaskViewSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 持续观察一个持久化任务，任务本身由服务端执行。
 * 离页、刷新或断网只中断观察，不重新创建任务；恢复页面后沿用同一任务 ID。
 */
export function usePlanningTask(taskId: string | null): PlanningTaskState {
  const [snapshot, setSnapshot] = useState<{
    taskId: string | null;
    view: PlanningTaskView | null;
    unreachable: boolean;
    overdue: boolean;
    missing: boolean;
  }>({ taskId: null, view: null, unreachable: false, overdue: false, missing: false });

  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let lastAnswer = Date.now();
    const update = (changes: Partial<typeof snapshot>) =>
      setSnapshot((current) => current.taskId === taskId
        ? { ...current, ...changes }
        : { taskId, view: null, unreachable: false, overdue: false, missing: false, ...changes });
    const tick = async () => {
      let next: PlanningTaskView | null = null;
      try {
        const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (stopped) return;
        if (response.status === 404) {
          update({ missing: true });
          return;
        }
        if (response.ok) next = await readView(response);
      } catch {
        // 网络失败计入下方不可达时长，不立刻丢弃上次有效状态。
      }
      if (stopped) return;
      if (next) {
        lastAnswer = Date.now();
        const done = isTerminalTask(next.status);
        update({
          view: next,
          unreachable: false,
          overdue: !done && Date.now() > Date.parse(next.deadlineAt) + OVERDUE_GRACE_MS,
        });
        if (done) return;
      } else if (Date.now() - lastAnswer > UNREACHABLE_MS) {
        update({ unreachable: true });
      }
      // 一次轮询结束后才约下一次，避免慢请求重叠；断网只是暂时不可达，继续观察原任务，
      // 不能自行创建新任务，否则刷新或重连就可能重复规划。
      timer = setTimeout(tick, Date.now() - started < FAST_PERIOD_MS ? FAST_MS : SLOW_MS);
    };
    void tick();
    return () => {
      // 切换任务或卸载只停止观察，并挡住旧请求的迟到响应；服务端任务继续由 Worker 执行。
      stopped = true;
      clearTimeout(timer);
    };
  }, [taskId]);

  const cancel = useCallback(async () => {
    if (!taskId) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const next = response.ok ? await readView(response) : null;
      if (next) {
        setSnapshot((current) => current.taskId === taskId ? { ...current, view: next } : current);
      }
    } catch {
      // 取消请求丢失时可重试；最终是否取消以轮询读到的服务端状态为准。
    }
  }, [taskId]);

  // 切换 taskId 的首帧也不显示旧任务快照，避免短暂展示另一次规划结果。
  const current = snapshot.taskId === taskId && taskId !== null
    ? snapshot
    : { view: null, unreachable: false, overdue: false, missing: false };
  return {
    view: current.view,
    unreachable: current.unreachable,
    overdue: current.overdue,
    missing: current.missing,
    cancel,
  };
}

/** 把任务 ID 保留在地址，刷新、返回或重新打开页面时继续观察同一任务。 */
export function rememberTask(taskId: string | null): void {
  const url = new URL(window.location.href);
  if (taskId) url.searchParams.set("task", taskId);
  else url.searchParams.delete("task");
  window.history.replaceState(window.history.state, "", url);
}
