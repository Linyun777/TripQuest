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

/**
 * S6.1 independent tests. The developer's suite already covers the happy path,
 * repository-level fencing and a checkpointed resume; these cases target the
 * remaining safety edges: an abandoned in-flight worker, the running-task
 * deadline, a cancelled expired lease, concurrent claims over a backlog,
 * post-completion idempotency, and resumed-vs-uninterrupted equivalence.
 */

const t0 = Date.parse("2026-10-15T01:00:00Z");
const places = planningFixturePlaces();
const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(t0) });
const problem = () => createDayPlanningProblem({
  runId: randomUUID(),
  requirementsFingerprint: "d".repeat(64),
  nowMs: t0,
  requirements: {
    schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai",
    travelMode: "walking", date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: selection(0), endPlace: selection(4), interests: ["culture", "nature"],
    pace: "standard", visits: [],
  },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** A public-input policy that can hold its first decision until released or aborted. */
function holdingModel() {
  const gate = deferred();
  const contexts: DayDecisionContext[] = [];
  const decision: DayPlanningDecisionModel = {
    mode: "scripted",
    provider: "independent",
    model: "holding-policy",
    async decide(context, { signal }) {
      contexts.push(context);
      if (contexts.length === 1) {
        await Promise.race([
          gate.promise,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
      }
      return { decision: chooseDayAction(context), usage: null };
    },
  };
  return { decision, contexts, release: gate.resolve };
}

const canonical = (value: unknown): string => {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("S6.1 durable tasks: independent safety edges", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: PgPlanningTaskRepository;
  let checkpointer: PostgresSaver;
  let clock = t0;
  const now = () => clock;
  const at = () => new Date(clock);
  const create = (options: {
    key?: string; input?: unknown; fingerprint?: string; createdAtOffsetMs?: number;
  } = {}) => repository.createTask({
    id: randomUUID(),
    kind: "day_draft",
    journeyId: null,
    requestKey: options.key ?? randomUUID(),
    intentFingerprint: options.fingerprint ?? "e".repeat(64),
    input: options.input ?? problem(),
    createdAt: new Date(t0 + (options.createdAtOffsetMs ?? 0)),
  });
  const row = async (id: string) => (await client.pool.query(
    `SELECT status, attempts, stop_reason, lease_token, lease_expires_at, cancel_requested_at,
            result, finished_at
       FROM planning_tasks WHERE id = $1`,
    [id],
  )).rows[0];
  const expireLease = (id: string) => client.pool.query(
    "UPDATE planning_tasks SET lease_expires_at = $2 WHERE id = $1",
    [id, new Date(clock - 1)],
  );
  const checkpointCount = async (threadId: string) => (await client.pool.query(
    "SELECT count(*)::int AS n FROM langgraph.checkpoints WHERE thread_id = $1",
    [threadId],
  )).rows[0].n as number;

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s61_independent_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s61_independent_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s61_independent_test";
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
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s61_independent_test WITH (FORCE)");
    await admin?.close();
  });
  beforeEach(async () => {
    clock = t0;
    await client.pool.query("TRUNCATE planning_tasks");
  });

  it("writes nothing when the lease is taken over while the run is still in flight", async () => {
    const created = await create();
    if (created.status !== "created") throw new Error("setup");
    const first = (await repository.claimNext("worker-a", at()))!;
    const held = holdingModel();
    const running = executeTask(first, { repository, checkpointer, now, draftModel: held.decision });
    while (!held.contexts.length) await new Promise((settle) => setTimeout(settle, 10));
    expect(await checkpointCount(first.id), "the in-flight run is checkpointed").toBeGreaterThan(0);

    await expireLease(first.id);
    const second = (await repository.claimNext("worker-b", at()))!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    held.release(); // The abandoned worker still finishes its reasoning loop.

    expect(await running, "the superseded worker reports abandoned").toBe("abandoned");
    expect(await row(first.id), "nothing may be written by the superseded worker").toMatchObject({
      status: "running",
      lease_token: second.leaseToken,
      finished_at: null,
      result: null,
    });
    expect(await checkpointCount(first.id), "the checkpoint is kept for the new worker").toBeGreaterThan(0);
  }, 30_000);

  it("ends a running task at its deadline as failed/deadline with a stored result", async () => {
    // Created 180s before the observed clock, so the deadline fires almost immediately.
    // Two whole seconds of headroom: the timestamp columns keep second precision.
    const created = await create({ createdAtOffsetMs: -178_000 });
    if (created.status !== "created") throw new Error("setup");
    expect(created.task.deadlineAt.getTime()).toBeGreaterThan(clock);
    const task = (await repository.claimNext("worker-a", at()))!;
    const held = holdingModel();
    const status = await executeTask(task, { repository, checkpointer, now, draftModel: held.decision });
    expect(status, "the deadline aborts the run and ends the task").toBe("failed");
    const stored = await row(task.id);
    expect(stored).toMatchObject({ status: "failed", stop_reason: "deadline" });
    expect(stored.result, "a terminal row keeps a result").not.toBeNull();
    expect(stored.lease_token, "the lease is released").toBeNull();
    expect(stored.finished_at).not.toBeNull();
    expect(await checkpointCount(task.id), "a finished task drops its checkpoint").toBe(0);
  }, 30_000);

  it("does not resume an expired lease that was cancelled, and ends it cancelled", async () => {
    const created = await create();
    if (created.status !== "created") throw new Error("setup");
    const task = (await repository.claimNext("worker-a", at()))!;
    await expireLease(task.id);
    await repository.requestCancel(task.id, at());
    expect((await row(task.id)).status, "a running task only records the request").toBe("running");
    expect(await repository.claimNext("worker-b", at()), "cancelled work is never resumed").toBeNull();
    expect(await repository.sweep(at())).toBe(1);
    expect(await row(task.id)).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
      lease_token: null,
    });
  });

  it("leases each queued task of a backlog to exactly one worker", async () => {
    for (let index = 0; index < 3; index += 1) await create();
    const claims = await Promise.all([
      repository.claimNext("w1", at()),
      repository.claimNext("w2", at()),
      repository.claimNext("w3", at()),
    ]);
    const claimed = claims.filter((task) => task !== null);
    expect(claimed, "three workers, three distinct tasks").toHaveLength(3);
    expect(new Set(claimed.map((task) => task.id)).size).toBe(3);
    expect(new Set(claimed.map((task) => task.leaseToken)).size).toBe(3);
    expect(claimed.every((task) => task.attempts === 1)).toBe(true);
    const stored = await client.pool.query(
      "SELECT count(*)::int AS n FROM planning_tasks WHERE status = 'running'",
    );
    expect(stored.rows[0].n).toBe(3);
  });

  it("joins the finished task for a repeated intent and never reopens it", async () => {
    const key = randomUUID();
    const created = await create({ key });
    if (created.status !== "created") throw new Error("setup");
    const task = (await repository.claimNext("worker-a", at()))!;
    expect(await executeTask(task, { repository, checkpointer, now })).toBe("completed");
    const finished = (await repository.findTask(task.id))!;

    const retry = await repository.createTask({
      id: randomUUID(), kind: "day_draft", journeyId: null, requestKey: key,
      intentFingerprint: "e".repeat(64), input: problem(), createdAt: new Date(t0),
    });
    expect(retry, "a network retry after the run joins the same row").toMatchObject({
      status: "existing",
    });
    if (retry.status === "intent_conflict") throw new Error("unexpected conflict");
    expect(retry.task.id).toBe(task.id);
    expect(retry.task.status).toBe("completed");
    expect(retry.task.result).toEqual(finished.result);
    expect((await client.pool.query("SELECT count(*)::int AS n FROM planning_tasks")).rows[0].n).toBe(1);

    const after = await repository.requestCancel(task.id, new Date(t0 + 60_000));
    expect(after, "a finished task keeps its outcome").toMatchObject({
      status: "completed",
      cancelRequestedAt: null,
    });
  }, 30_000);

  it("produces the same draft and the same recorded counts after an interrupted resume", async () => {
    const input = problem();
    await create({ input });
    const reference = (await repository.claimNext("ref", at()))!;
    expect(await executeTask(reference, { repository, checkpointer, now })).toBe("completed");
    const expected = ((await repository.findTask(reference.id))!.result as DraftTaskResult).outcome as {
      counts: unknown; draft: unknown;
    };
    await client.pool.query("TRUNCATE planning_tasks");

    await create({ input });
    const task = (await repository.claimNext("worker-a", at()))!;
    const held = holdingModel();
    const shutdown = new AbortController();
    const running = executeTask(task, {
      repository, checkpointer, now, draftModel: held.decision, shutdown: shutdown.signal,
    });
    while (!held.contexts.length) await new Promise((settle) => setTimeout(settle, 10));
    shutdown.abort();
    expect(await running).toBe("abandoned");
    expect((await row(task.id)).status).toBe("running");

    await expireLease(task.id);
    const resumed = (await repository.claimNext("worker-b", at()))!;
    expect(resumed.attempts).toBe(2);
    expect(await executeTask(resumed, { repository, checkpointer, now })).toBe("completed");
    const outcome = ((await repository.findTask(task.id))!.result as DraftTaskResult).outcome as {
      counts: unknown; draft: unknown;
    };
    expect(canonical(outcome.draft), "the resumed draft equals the uninterrupted one").toBe(
      canonical(expected.draft),
    );
    expect(outcome.counts, "recorded work is not double counted").toEqual(expected.counts);
  }, 60_000);
});
