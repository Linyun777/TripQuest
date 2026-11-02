import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { executeTask } from "../execute";
import { ownerAndWorkerTasks } from "./task-scopes";

/**
 * S6.1 independent test for checkpoint hygiene. The design keeps a checkpoint only
 * while a task can still resume (§4.4) and cleans finished work up (§4.5); a task that
 * ends through `sweep` instead of a finishing worker must not leave its thread behind.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("S6.1 checkpoint hygiene", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: PgPlanningTaskRepository;
  let checkpointer: PostgresSaver;
  const t0 = Date.parse("2026-10-15T01:00:00Z");
  const now = () => t0;

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s61_probe_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s61_probe_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s61_probe_test";
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
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s61_probe_test WITH (FORCE)");
    await admin?.close();
  });

  it("drops the checkpoint of a task that ends without a finishing worker", async () => {
    const places = planningFixturePlaces();
    const selection = (index: number) => ({ place: places[index], evidence: planningFixtureEvidence(t0) });
    const problem = createDayPlanningProblem({
      runId: randomUUID(), requirementsFingerprint: "f".repeat(64), nowMs: t0,
      requirements: {
        schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai",
        travelMode: "walking", date: "2026-10-15", window: { startsAt: "10:00", endsAt: "18:00" },
        startPlace: selection(0), endPlace: selection(4), interests: ["culture"], pace: "standard", visits: [],
      },
    });
    const created = await repository.createTask({
      id: randomUUID(), kind: "day_draft", journeyId: null, requestKey: randomUUID(),
      intentFingerprint: "f".repeat(64), input: problem, createdAt: new Date(t0),
    });
    if (created.status !== "created") throw new Error("setup");
    const task = (await repository.claimNext("probe-a", new Date(t0)))!;

    let released = false;
    const contexts: DayDecisionContext[] = [];
    const decision: DayPlanningDecisionModel = {
      mode: "scripted", provider: "probe", model: "held",
      async decide(context, { signal }) {
        contexts.push(context);
        if (contexts.length === 1 && !released) {
          await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { decision: chooseDayAction(context), usage: null };
      },
    };
    const shutdown = new AbortController();
    const running = executeTask(task, { repository, checkpointer, now, draftModel: decision, shutdown: shutdown.signal });
    while (!contexts.length) await new Promise((settle) => setTimeout(settle, 10));
    released = true;
    shutdown.abort();
    const first = await running;

    const count = async () => (await client.pool.query(
      "SELECT count(*)::int AS n FROM langgraph.checkpoints WHERE thread_id = $1", [task.id],
    )).rows[0].n as number;
    const afterAbandon = await count();
    await client.pool.query("UPDATE planning_tasks SET attempts = 3, lease_expires_at = $2 WHERE id = $1", [
      task.id, new Date(t0 - 1),
    ]);
    const swept = await repository.sweep(new Date(t0));
    const stored = (await repository.findTask(task.id))!;
    const afterSweep = await count();
    await repository.purge(new Date(t0 + 10 * 60 * 60 * 1000));
    const afterPurge = await count();
    expect(first, "the abandoned worker wrote nothing").toBe("abandoned");
    expect(afterAbandon, "a resumable task keeps its checkpoint").toBeGreaterThan(0);
    expect(swept, "the exhausted task is swept").toBe(1);
    expect(stored.status, "the swept task is terminal").toBe("failed");
    expect(stored.stopReason).toBe("worker_lost");
    expect(afterSweep, "a terminal task must not keep its thread").toBe(0);
    expect(afterPurge, "and nothing may resurrect it later").toBe(0);
  }, 30_000);
});
