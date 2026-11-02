import { z } from "zod";
import {
  dayPlanningResultSchema,
  dayProgressSchema,
  daySaveOfferSchema,
} from "./day-planning";
import {
  replanOfferSchema,
  replanProgressSchema,
  replanResultSchema,
} from "./day-replan-contract";

/**
 * S6.1 durable planning tasks. Client-safe: schemas, limits and the repository port only.
 */
export const PLANNING_TASK_LIMITS = {
  leaseMs: 30_000,
  heartbeatMs: 5_000,
  attempts: 3,
  deadlineMs: 180_000,
  retainMs: 24 * 60 * 60 * 1000,
} as const;

export type PlanningTaskKind = "day_draft" | "day_replan";
export type PlanningTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
/** Why a task ended without (or before) a runner result. */
export type PlanningTaskStopReason = "cancelled" | "deadline" | "worker_lost";

export interface StoredPlanningTask {
  readonly id: string;
  /** V2.12：任务属于谁；Worker 按它读写行程。 */
  readonly userId: string;
  readonly kind: PlanningTaskKind;
  readonly journeyId: string | null;
  readonly requestKey: string;
  readonly intentFingerprint: string;
  readonly input: unknown;
  readonly status: PlanningTaskStatus;
  readonly progress: unknown;
  readonly result: unknown;
  readonly offer: unknown;
  readonly stopReason: PlanningTaskStopReason | null;
  readonly attempts: number;
  readonly cancelRequestedAt: Date | null;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}
export interface ClaimedPlanningTask extends StoredPlanningTask {
  readonly leaseToken: string;
}
export interface NewPlanningTask {
  readonly id: string;
  readonly kind: PlanningTaskKind;
  readonly journeyId: string | null;
  readonly requestKey: string;
  readonly intentFingerprint: string;
  readonly input: unknown;
  readonly createdAt: Date;
}
export type CreatePlanningTaskOutcome =
  | { readonly status: "created" | "existing"; readonly task: StoredPlanningTask }
  | { readonly status: "intent_conflict" };

export interface PlanningTaskRepository {
  /** Idempotent by request key: same fingerprint returns the existing task. */
  createTask(task: NewPlanningTask): Promise<CreatePlanningTaskOutcome>;
  findTask(id: string): Promise<StoredPlanningTask | null>;
  /** Queued tasks end at once; running tasks are flagged for the worker. */
  requestCancel(id: string, now: Date): Promise<StoredPlanningTask | null>;
  /** Ends expired leases that cannot resume, overdue and flagged tasks. */
  sweep(now: Date): Promise<number>;
  /** Atomically leases the oldest runnable task (SKIP LOCKED). */
  claimNext(owner: string, now: Date): Promise<ClaimedPlanningTask | null>;
  /** Fenced lease renewal; null means the lease was lost and nothing may be written. */
  heartbeat(id: string, leaseToken: string, now: Date): Promise<{ cancelRequested: boolean } | null>;
  saveProgress(id: string, leaseToken: string, progress: unknown): Promise<boolean>;
  /** Fenced, once-only terminal write. */
  finish(
    id: string,
    leaseToken: string,
    outcome: {
      status: "completed" | "failed" | "cancelled";
      result: unknown;
      stopReason?: PlanningTaskStopReason;
    },
    now: Date,
  ): Promise<boolean>;
  /** Stores the first issued offer of a completed task and returns whichever is stored. */
  setOffer(id: string, offer: unknown): Promise<unknown>;
  purge(finishedBefore: Date): Promise<number>;
}

const common = {
  taskId: z.uuid(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  stopReason: z.enum(["cancelled", "deadline", "worker_lost"]).nullable(),
  cancelRequested: z.boolean(),
  deadlineAt: z.iso.datetime({ offset: true }),
};
/** What `GET /api/tasks/[taskId]` returns; never the input or lease fields. */
export const planningTaskViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("day_draft"),
    progress: dayProgressSchema.nullable(),
    result: dayPlanningResultSchema.nullable(),
    offer: daySaveOfferSchema.nullable(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("day_replan"),
    journeyId: z.uuid(),
    /** The versions the candidate was built on; a page ignores tasks for older versions. */
    base: z.strictObject({
      planVersion: z.number().int().positive(),
      observationVersion: z.number().int().nonnegative(),
    }),
    progress: replanProgressSchema.nullable(),
    result: replanResultSchema.nullable(),
    offer: replanOfferSchema.nullable(),
  }),
]);
export type PlanningTaskView = z.infer<typeof planningTaskViewSchema>;
export const TASK_VIEW_BYTES = 256 * 1024;

export function isTerminalTask(status: PlanningTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
