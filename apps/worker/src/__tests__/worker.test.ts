import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  chooseDayAction,
  type DayDecisionContext,
  type DayPlanningDecisionModel,
} from "@tripquest/agent/day-planning";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import {
  createJourneyDatabase,
  migrateJourneyDatabase,
  PgPlanningTaskRepository,
  requireSafeTestDatabaseUrl,
  type JourneyDatabaseClient,
} from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { executeTask, type DraftTaskResult } from "../execute";
import { ownerAndWorkerTasks } from "./task-scopes";

const t0 = Date.parse("2026-10-15T01:00:00Z");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(t0) });
const problem = () => createDayPlanningProblem({
  runId: randomUUID(),
  requirementsFingerprint: "a".repeat(64),
  nowMs: t0,
  requirements: {
    schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai",
    travelMode: "walking", date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: selection(0), endPlace: selection(4), interests: ["culture", "nature"],
    pace: "standard", visits: [],
  },
});

/** Public-input policy that can be held on a given call to simulate a crash mid-request. */
function model(options: { holdOn?: number; release?: Promise<void> } = {}) {
  const contexts: DayDecisionContext[] = [];
  const decision: DayPlanningDecisionModel = {
    mode: "scripted",
    provider: "test",
    model: "held-policy",
    async decide(context, { signal }) {
      contexts.push(context);
      if (contexts.length === options.holdOn) {
        await Promise.race([
          options.release ?? new Promise<never>(() => {}),
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
        ]);
      }
      return { decision: chooseDayAction(context), usage: null };
    },
  };
  return { decision, contexts };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("S6.1 durable tasks on PostgreSQL", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: PgPlanningTaskRepository;
  let checkpointer: PostgresSaver;
  const now = () => t0;
  const create = (key = randomUUID(), input: unknown = problem(), fingerprint = "b".repeat(64)) =>
    repository.createTask({
      id: randomUUID(), kind: "day_draft", journeyId: null, requestKey: key,
      intentFingerprint: fingerprint, input, createdAt: new Date(t0),
    });
  const row = async (id: string) => (await client.pool.query(
    "SELECT status, attempts, stop_reason, lease_token FROM planning_tasks WHERE id = $1", [id],
  )).rows[0];
  const expireLease = (id: string) => client.pool.query(
    "UPDATE planning_tasks SET lease_expires_at = $2 WHERE id = $1", [id, new Date(t0 - 1)],
  );

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s61_worker_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s61_worker_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s61_worker_test";
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    checkpointer = new PostgresSaver(client.pool, undefined, { schema: "langgraph" });
    await checkpointer.setup();
    repository = await ownerAndWorkerTasks(client.pool);
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s61_worker_test WITH (FORCE)");
    await admin?.close();
  });
  beforeEach(async () => {
    await client.pool.query("TRUNCATE planning_tasks");
  });

  it("creates one task per intent and leases it to exactly one worker", async () => {
    const key = randomUUID();
    const first = await create(key);
    expect(first.status).toBe("created");
    expect(await create(key), "same key and intent").toMatchObject({ status: "existing" });
    expect(await create(key, problem(), "c".repeat(64)), "same key, other intent").toEqual({ status: "intent_conflict" });
    const [a, b] = await Promise.all([
      repository.claimNext("worker-a", new Date(t0)),
      repository.claimNext("worker-b", new Date(t0)),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("runs a draft to one fenced terminal write and removes its checkpoint", async () => {
    await create();
    const task = (await repository.claimNext("worker-a", new Date(t0)))!;
    expect(await executeTask(task, { repository, checkpointer, now })).toBe("completed");
    const stored = (await repository.findTask(task.id))!;
    const result = stored.result as DraftTaskResult;
    expect(stored).toMatchObject({ status: "completed", attempts: 1, stopReason: null });
    expect(result.outcome).toMatchObject({ status: "completed", outcome: "draft" });
    expect(result.snapshot, "save offer input kept").not.toBeNull();
    expect(await checkpointer.getTuple({ configurable: { thread_id: task.id } })).toBeUndefined();
    // A late write with the old lease changes nothing.
    expect(await repository.finish(task.id, task.leaseToken, { status: "failed", result: null }, new Date(t0))).toBe(false);
  });

  it("resumes a crashed run from its checkpoint without repeating finished decisions", async () => {
    // Reference: the same problem uninterrupted.
    const input = problem();
    await create(randomUUID(), input);
    const reference = (await repository.claimNext("ref", new Date(t0)))!;
    await executeTask(reference, { repository, checkpointer, now });
    const expected = ((await repository.findTask(reference.id))!.result as DraftTaskResult).outcome as {
      counts: { model: number }; draft: unknown;
    };
    await client.pool.query("TRUNCATE planning_tasks");

    await create(randomUUID(), input);
    const task = (await repository.claimNext("worker-a", new Date(t0)))!;
    const a = model({ holdOn: 3 });
    const crash = new AbortController();
    const running = executeTask(task, { repository, checkpointer, now, draftModel: a.decision, shutdown: crash.signal });
    while (a.contexts.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    crash.abort(); // The process dies while the third decision is in flight.
    expect(await running).toBe("abandoned");
    expect(await row(task.id)).toMatchObject({ status: "running", attempts: 1 });
    await expireLease(task.id);

    const resumed = (await repository.claimNext("worker-b", new Date(t0)))!;
    expect(resumed.attempts).toBe(2);
    const b = model();
    expect(await executeTask(resumed, { repository, checkpointer, now, draftModel: b.decision })).toBe("completed");
    // Two finished decisions were restored, so worker B starts at the interrupted third one.
    expect(b.contexts[0].remaining.model).toBe(8);
    expect(b.contexts[0].searches.length).toBeGreaterThan(0);
    expect(a.contexts.length + b.contexts.length - 1).toBe(expected.counts.model);
    const outcome = ((await repository.findTask(task.id))!.result as DraftTaskResult).outcome as typeof expected;
    expect(outcome.counts.model).toBe(expected.counts.model);
    expect(outcome.draft).toMatchObject({ activities: (expected.draft as { activities: unknown[] }).activities.map(() => expect.anything()) });
  });

  it("rejects writes from a worker whose lease was taken over", async () => {
    await create();
    const first = (await repository.claimNext("worker-a", new Date(t0)))!;
    await expireLease(first.id);
    const second = (await repository.claimNext("worker-b", new Date(t0)))!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await repository.heartbeat(first.id, first.leaseToken, new Date(t0))).toBeNull();
    expect(await repository.saveProgress(first.id, first.leaseToken, { phase: "x" })).toBe(false);
    expect(await repository.finish(first.id, first.leaseToken, { status: "completed", result: {} }, new Date(t0))).toBe(false);
    expect(await row(first.id)).toMatchObject({ status: "running", lease_token: second.leaseToken });
  });

  it("cancels queued and running tasks, ends overdue and exhausted ones, and purges old results", async () => {
    const queued = await create();
    if (queued.status !== "created") throw new Error("setup");
    expect(await repository.requestCancel(queued.task.id, new Date(t0))).toMatchObject({ status: "cancelled", stopReason: "cancelled" });

    await create();
    const task = (await repository.claimNext("worker-a", new Date(t0)))!;
    const held = model({ holdOn: 1 });
    const running = executeTask(task, { repository, checkpointer, now, draftModel: held.decision, heartbeatMs: 20 });
    while (!held.contexts.length) await new Promise((resolve) => setTimeout(resolve, 10));
    await repository.requestCancel(task.id, new Date(t0));
    expect(await running).toBe("cancelled");
    expect(await repository.findTask(task.id)).toMatchObject({ status: "cancelled", stopReason: "cancelled" });

    const late = await create();
    if (late.status !== "created") throw new Error("setup");
    const overdue = new Date(t0 + 181_000);
    await repository.sweep(overdue);
    expect(await row(late.task.id)).toMatchObject({ status: "failed", stop_reason: "deadline" });

    await create();
    const exhausted = (await repository.claimNext("worker-a", new Date(t0)))!;
    await client.pool.query("UPDATE planning_tasks SET attempts = 3 WHERE id = $1", [exhausted.id]);
    await expireLease(exhausted.id);
    expect(await repository.claimNext("worker-b", new Date(t0)), "no fourth attempt").toBeNull();
    await repository.sweep(new Date(t0));
    expect(await row(exhausted.id)).toMatchObject({ status: "failed", stop_reason: "worker_lost" });

    expect(await repository.purge(new Date(t0 + 200_000))).toBe(4);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM planning_tasks")).rows[0].n).toBe(0);
  });
});
