import "server-only";
import { requireOwner } from "../../auth/owner";
import { randomUUID } from "node:crypto";
import {
  dayDraftConfirmationSnapshotSchema,
} from "@tripquest/application/day-confirmation";
import {
  dayPlanningResultSchema,
  type DayPlanningProblem,
} from "@tripquest/application/day-planning";
import {
  replanResultSchema,
  type DayReplanProblem,
} from "@tripquest/application/day-replan";
import {
  planningTaskViewSchema,
  type PlanningTaskRepository,
  type PlanningTaskView,
  type StoredPlanningTask,
} from "@tripquest/application/planning-task";
import { fingerprint } from "@tripquest/application/fingerprint";
import { PLANNING_FIXTURE_VERSION } from "@tripquest/providers/planning-fixture";
import { getSharedJourneyDatabase, PgPlanningTaskRepository } from "@tripquest/db";
import { createDraftSaveOffer } from "../../planning/new/draft-receipt";

/** 持久化任务仅运行本地模拟数据与脚本策略（D-045），不把真实地点快照写入恢复检查点。 */
export function tasksEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.PLANNING_TASKS_ENABLED === "true";
}

export function readRequestKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key") ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    ? key.toLowerCase()
    : null;
}

export function createTaskService(options: {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  tasks?: () => PlanningTaskRepository;
  /** V2.12：当前用户；只看、只建、只取消这个用户的任务。 */
  userId?: string;
} = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const tasks = () => options.tasks?.() ??
    new PgPlanningTaskRepository(getSharedJourneyDatabase().pool, { userId: owner() });

  /** 页面只接收状态、进度、结果和凭据；任务输入与租约令牌留在服务端。 */
  async function view(task: StoredPlanningTask): Promise<PlanningTaskView> {
    const base = {
      taskId: task.id,
      status: task.status,
      stopReason: task.stopReason,
      cancelRequested: task.cancelRequestedAt !== null,
      deadlineAt: task.deadlineAt.toISOString(),
    };
    if (task.kind === "day_draft") {
      const stored = task.result as { outcome: unknown; snapshot: unknown } | null;
      const result = stored ? dayPlanningResultSchema.parse(stored.outcome) : null;
      let offer = task.offer;
      if (!offer && task.status === "completed" && result?.status === "completed" && result.outcome === "draft") {
        const snapshot = stored?.snapshot ? dayDraftConfirmationSnapshotSchema.parse(stored.snapshot) : null;
        // 首次读取时签发并保留同一凭据，之后轮询不能重新延长确认有效期。
        offer = await tasks().setOffer(task.id, await createDraftSaveOffer(snapshot, result, {
          environment: environment(),
          now: now(),
        }));
      }
      return planningTaskViewSchema.parse({
        ...base,
        kind: "day_draft",
        progress: task.progress ?? null,
        result,
        offer: offer ?? null,
      });
    }
    // V3.6：途中重排已删除，不再建这类任务、不再签发确认凭据；以前留下的照原样读出来。
    const result = task.result ? replanResultSchema.parse(task.result) : null;
    const problem = task.input as DayReplanProblem;
    return planningTaskViewSchema.parse({
      ...base,
      kind: "day_replan",
      journeyId: task.journeyId,
      base: { planVersion: problem.basePlanVersion, observationVersion: problem.baseObservationVersion },
      progress: task.progress ?? null,
      result,
      offer: task.offer ?? null,
    });
  }

  return {
    async createDraft(problem: DayPlanningProblem, requestKey: string) {
      return tasks().createTask({
        id: randomUUID(),
        kind: "day_draft",
        journeyId: null,
        requestKey,
        // 每次构造的 runId 可不同，页面意图仍按相同需求与数据版本比较，避免重试重复创建任务。
        intentFingerprint: fingerprint({
          kind: "day_draft",
          requirementsFingerprint: problem.requirementsFingerprint,
          datasetVersion: PLANNING_FIXTURE_VERSION,
        }),
        input: problem,
        createdAt: new Date(now()),
      });
    },
    async read(taskId: string): Promise<PlanningTaskView | null> {
      const task = await tasks().findTask(taskId);
      return task ? view(task) : null;
    },
    async cancel(taskId: string): Promise<PlanningTaskView | null> {
      const task = await tasks().requestCancel(taskId, new Date(now()));
      return task ? view(task) : null;
    },
  };
}

export function taskJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
