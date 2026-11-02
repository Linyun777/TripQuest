import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type {
  PlanningTaskRepository,
  StoredPlanningTask,
} from "@tripquest/application/planning-task";
import { createTaskService } from "../task-service";

/**
 * S6.1 independent tests for the client-facing task view. The developer's suite
 * exercises this through real routes and PostgreSQL; these cases pin the
 * exposure boundary itself (nothing internal may reach the page) and the
 * status mapping, without touching a database.
 */

const CANARY = "s61-independent-canary-must-not-leak";
const t0 = Date.parse("2026-10-15T01:00:00Z");

function stored(patch: Partial<StoredPlanningTask> = {}): StoredPlanningTask {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    kind: "day_draft",
    journeyId: null,
    requestKey: randomUUID(),
    intentFingerprint: CANARY,
    input: { journeyId: CANARY, secret: CANARY },
    status: "queued",
    progress: null,
    result: null,
    offer: null,
    stopReason: null,
    attempts: 0,
    cancelRequestedAt: null,
    deadlineAt: new Date(t0 + 180_000),
    createdAt: new Date(t0),
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

function service(task: StoredPlanningTask | null) {
  const repository = {
    findTask: async (id: string) => (task && task.id === id ? task : null),
  } as unknown as PlanningTaskRepository;
  return createTaskService({
    environment: { NODE_ENV: "test" },
    now: () => t0,
    tasks: () => repository,
    journeys: () => ({}) as never,
  });
}

describe("S6.1 task view boundary", () => {
  it("never exposes task input, intent fingerprint or lease fields", async () => {
    const draft = stored({ status: "running" });
    const draftView = await service(draft).read(draft.id);
    expect(draftView, "a running draft is readable").not.toBeNull();
    expect(Object.keys(draftView!).sort(), "draft view keys are the public contract").toEqual([
      "cancelRequested",
      "deadlineAt",
      "kind",
      "offer",
      "progress",
      "result",
      "status",
      "stopReason",
      "taskId",
    ]);
    expect(JSON.stringify(draftView), "no canary from input/fingerprint leaks").not.toContain(CANARY);

    const journeyId = randomUUID();
    const replan = stored({
      kind: "day_replan",
      journeyId,
      status: "running",
      input: {
        journeyId,
        basePlanVersion: 2,
        baseObservationVersion: 3,
        canary: CANARY,
      },
    });
    const replanView = await service(replan).read(replan.id);
    expect(Object.keys(replanView!).sort(), "replan view adds only its own facts").toEqual([
      "base",
      "cancelRequested",
      "deadlineAt",
      "journeyId",
      "kind",
      "offer",
      "progress",
      "result",
      "status",
      "stopReason",
      "taskId",
    ]);
    expect(replanView).toMatchObject({ base: { planVersion: 2, observationVersion: 3 } });
    expect(JSON.stringify(replanView), "no canary from the stored problem leaks").not.toContain(CANARY);
  });

  it("maps waiting, cancelled and terminal states without inventing a result", async () => {
    const queued = stored({ status: "queued" });
    expect(await service(queued).read(queued.id), "queued has no result yet").toMatchObject({
      status: "queued",
      cancelRequested: false,
      stopReason: null,
      result: null,
      offer: null,
      progress: null,
      deadlineAt: new Date(t0 + 180_000).toISOString(),
    });

    const cancelled = stored({ status: "cancelled", cancelRequestedAt: new Date(t0), stopReason: "cancelled", finishedAt: new Date(t0) });
    expect(await service(cancelled).read(cancelled.id)).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      stopReason: "cancelled",
      result: null,
    });

    const running = stored({ status: "running", cancelRequestedAt: new Date(t0) });
    expect(await service(running).read(running.id)).toMatchObject({
      status: "running",
      cancelRequested: true,
      result: null,
    });

    expect(await service(null).read(randomUUID()), "an unknown task is not found").toBeNull();
  });
});
