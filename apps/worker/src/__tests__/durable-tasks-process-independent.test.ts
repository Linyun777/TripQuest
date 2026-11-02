import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import {
  createJourneyDatabase,
  migrateJourneyDatabase,
  PgPlanningTaskRepository,
  requireSafeTestDatabaseUrl,
  type JourneyDatabaseClient,
} from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { ownerAndWorkerTasks } from "./task-scopes";

/**
 * S6.1 acceptance asks for a real process check (design §7): an isolated
 * database, the packaged worker running as its own OS process, a `kill -9`
 * in the middle of a run, and a second worker finishing the same task from its
 * checkpoint. The developer did this in a browser; this is the same claim
 * verified against the worker binary and SQL only.
 */

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
/** Drops wall-clock and per-run fields so two runs of the same problem can be compared. */
const stable = (value: unknown): string => {
  const VOLATILE = new Set(["runId", "createdAt", "elapsedMs", "retrievedAt"]);
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(strip);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, item]) => [key, strip(item)]));
    }
    return entry;
  };
  return canonical(strip(value));
};

const t0 = Date.parse("2026-10-15T01:00:00Z");
const workerJs = resolve(process.cwd(), "dist/worker.js");

describe.skipIf(!process.env.TEST_DATABASE_URL)("S6.1 durable tasks in real processes", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: PgPlanningTaskRepository;
  let databaseUrl: string;

  const problem = () => {
    const places = planningFixturePlaces();
    const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(t0) });
    return createDayPlanningProblem({
      runId: randomUUID(), requirementsFingerprint: "a".repeat(64), nowMs: t0,
      requirements: {
        schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai",
        travelMode: "walking", date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
        startPlace: selection(0), endPlace: selection(4), interests: ["culture", "nature"],
        pace: "standard", visits: [],
      },
    });
  };
  const create = async () => {
    const created = await repository.createTask({
      id: randomUUID(), kind: "day_draft", journeyId: null, requestKey: randomUUID(),
      intentFingerprint: "a".repeat(64), input: problem(), createdAt: new Date(),
    });
    if (created.status !== "created") throw new Error("setup");
    return created.task.id;
  };
  const row = async (id: string) => (await client.pool.query(
    "SELECT status, attempts, stop_reason, lease_token, progress, result FROM planning_tasks WHERE id = $1",
    [id],
  )).rows[0];
  const checkpoints = async (id: string) => (await client.pool.query(
    "SELECT count(*)::int AS n FROM langgraph.checkpoints WHERE thread_id = $1", [id],
  )).rows[0].n as number;
  const startWorker = () => spawn(process.execPath, [workerJs], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      WORKER_CONCURRENCY: "1",
      WORKER_FIXTURE_DELAY_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, ms = 40_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (ready(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((settle) => setTimeout(settle, 150));
    }
  };

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s61_process_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s61_process_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s61_process_test";
    databaseUrl = requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL);
    client = createJourneyDatabase(databaseUrl);
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    const checkpointer = new PostgresSaver(client.pool, undefined, { schema: "langgraph" });
    await checkpointer.setup();
    repository = await ownerAndWorkerTasks(client.pool);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s61_process_test WITH (FORCE)");
    await admin?.close();
  });

  it("runs a queued task to completion in a separate worker process", async () => {
    expect(existsSync(workerJs), "build the worker first: pnpm --filter @tripquest/worker build").toBe(true);
    const id = await create();
    const worker = startWorker();
    try {
      const finished = await waitFor(() => row(id), (value) => value?.status === "completed", "completion");
      expect(finished.result, "the terminal row carries the result").not.toBeNull();
      expect(finished.lease_token, "the lease is released").toBeNull();
      expect(finished.progress, "progress was written while running").not.toBeNull();
      expect(await checkpoints(id), "a finished task drops its checkpoint").toBe(0);
    } finally {
      worker.kill("SIGKILL");
    }
  }, 60_000);

  it("resumes the same task in a second process after kill -9", async () => {
    expect(existsSync(workerJs), "build the worker first: pnpm --filter @tripquest/worker build").toBe(true);
    // Uninterrupted reference result for the identical problem.
    const reference = await create();
    const firstWorker = startWorker();
    const expected = await waitFor(
      async () => (await row(reference))?.result,
      (value) => value !== null && value !== undefined,
      "reference result",
    );
    firstWorker.kill("SIGKILL");

    const id = await create();
    const doomed = startWorker();
    const claimed = await waitFor(() => row(id), (value) => value?.status === "running", "the task to start");
    expect(claimed.attempts, "first attempt").toBe(1);
    expect(await checkpoints(id), "an in-flight task has a checkpoint").toBeGreaterThan(0);
    doomed.kill("SIGKILL");
    await new Promise((settle) => setTimeout(settle, 300));

    const interrupted = await row(id);
    expect(interrupted.status, "a killed worker leaves the task running").toBe("running");
    expect(interrupted.lease_token, "with its lease still held").not.toBeNull();

    // Real deployments wait the 30s lease out; the wait is shortened here so the check stays cheap.
    await client.pool.query("UPDATE planning_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    const second = startWorker();
    try {
      const resumed = await waitFor(() => row(id), (value) => value?.status === "completed", "the takeover to finish");
      expect(resumed.attempts, "the second process took the task over").toBe(2);
      expect(stable(resumed.result), "the resumed result equals the uninterrupted run").toBe(stable(expected));
      expect(await checkpoints(id), "the takeover drops the checkpoint").toBe(0);
    } finally {
      second.kill("SIGKILL");
    }
  }, 90_000);
});
