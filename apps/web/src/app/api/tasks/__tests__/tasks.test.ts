import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DayProgressCommand } from "@tripquest/application/day-progress";
import { planningTaskViewSchema, type PlanningTaskView } from "@tripquest/application/planning-task";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, PgPlanningTaskRepository, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createPostgresCheckpointer } from "@tripquest/worker/checkpointer";
import { executeTask } from "@tripquest/worker/execute";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { createReplanHandlers } from "../../journeys/replan-handlers";
import { createTaskService } from "../task-service";
import { asTestUser, ownerAndWorkerTasks, ownerId } from "../../../../test-support/users";

const t0 = Date.parse("2026-10-16T01:00:00Z");
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_TASKS_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "s61-development-place-secret-0123456789abcdef",
  PLANNING_DRAFT_RECEIPT_SECRET: "s61-development-receipt-secret-0123456789abcdef",
};
const directory = planningFixturePlaces();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3361/api/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3361",
      host: "localhost:3361",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const token = (index: number) => issuePlaceToken(
  { place: directory[index], evidence: planningFixtureEvidence(t0) },
  environment.PLANNING_PLACE_TOKEN_SECRET!,
  "fixture",
  t0,
);
const requirements = () => ({
  schemaVersion: "planning-requirements.v1",
  cityAdcode: "330100",
  timeZone: "Asia/Shanghai",
  travelMode: "walking",
  date: "2026-10-16",
  window: { startsAt: "09:00", endsAt: "17:00" },
  startPlace: token(0),
  endPlace: token(4),
  interests: ["nature"],
  pace: "relaxed",
  visits: [
    { token: token(1), role: "required", stayMinutes: 60 },
    { token: token(5), role: "fixed", startsAt: "13:00", endsAt: "14:00" },
  ],
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("S6.1 durable draft/replan tasks through the web routes", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let journeys: DrizzleJourneyRepository;
  let tasks: PgPlanningTaskRepository;
  let checkpointer: Awaited<ReturnType<typeof createPostgresCheckpointer>>;
  const now = () => t0;
  const service = () => createTaskService({ environment, now, tasks: () => tasks, journeys: () => journeys });
  const draftRoute = () => createDraftHandler(
    () => createGenerationService({ environment, now }),
    undefined,
    service,
    asTestUser,
  );
  const replanRoutes = () => createReplanHandlers({
    environment, now, repository: () => journeys, tasks: service,
  });
  const view = async (taskId: string): Promise<PlanningTaskView> =>
    planningTaskViewSchema.parse(await service().read(taskId));
  /** One worker pass over whatever is queued. */
  const work = async () => {
    const task = await tasks.claimNext("test-worker", new Date(t0));
    if (!task) throw new Error("nothing to claim");
    return executeTask(task, { repository: tasks, checkpointer, now });
  };

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("DROP DATABASE IF EXISTS tripquest_s61_web_test WITH (FORCE)");
    await admin.pool.query("CREATE DATABASE tripquest_s61_web_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s61_web_test";
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    journeys = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
    tasks = await ownerAndWorkerTasks(client.pool, (scope) => new PgPlanningTaskRepository(client.pool, scope));
    checkpointer = await createPostgresCheckpointer(client.pool);
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s61_web_test WITH (FORCE)");
    await admin?.close();
  });
  beforeEach(async () => {
    await client.pool.query("TRUNCATE journeys, planning_tasks CASCADE");
  });

  async function savedJourney(): Promise<string> {
    const key = randomUUID();
    const created = await draftRoute()(post("planning/draft", requirements(), { "idempotency-key": key }));
    const { taskId } = await created.json();
    await work();
    const done = await view(taskId);
    if (done.kind !== "day_draft" || done.offer?.status !== "available") throw new Error("draft task failed");
    const saved = await createConfirmDayHandler({ user: asTestUser, environment, now, repository: () => journeys })(
      post("planning/confirm", { receipt: done.offer.receipt, title: "S6.1 任务自检", acknowledgeUnknowns: true }),
    );
    expect(saved.status).toBe(201);
    return (await saved.json()).journeyId;
  }

  it("turns a fixture draft into one durable task whose result and save offer survive re-reads", async () => {
    const route = draftRoute();
    expect((await route(post("planning/draft", requirements()))).status, "key required").toBe(400);
    const key = randomUUID();
    const first = await route(post("planning/draft", requirements(), { "idempotency-key": key }));
    expect(first.status).toBe(202);
    const { taskId } = await first.json();
    const again = await route(post("planning/draft", requirements(), { "idempotency-key": key }));
    expect(again.status, "network retry joins the same task").toBe(200);
    expect((await again.json()).taskId).toBe(taskId);
    const other = { ...requirements(), window: { startsAt: "09:00", endsAt: "16:00" } };
    expect((await route(post("planning/draft", other, { "idempotency-key": key }))).status).toBe(409);
    expect(await view(taskId)).toMatchObject({ kind: "day_draft", status: "queued", result: null });

    expect(await work()).toBe("completed");
    const done = await view(taskId);
    expect(done).toMatchObject({ status: "completed", result: { status: "completed", outcome: "draft" } });
    if (done.kind !== "day_draft" || done.offer?.status !== "available") throw new Error("offer");
    // The offer is issued once and kept: every later read shows the same receipt.
    const later = await view(taskId);
    expect(later.offer).toEqual(done.offer);
    const saved = await createConfirmDayHandler({ user: asTestUser, environment, now, repository: () => journeys })(
      post("planning/confirm", { receipt: done.offer.receipt, title: "S6.1 任务自检", acknowledgeUnknowns: true }),
    );
    expect(saved.status).toBe(201);
  });

  it("runs a replan as a task, keeps version protection at confirmation, and cancels a running task", async () => {
    const journeyId = await savedJourney();
    const stored = (await journeys.findCurrentJourney(journeyId))!;
    const [museum] = stored.currentPlan.activities;
    const report: DayProgressCommand = {
      reportId: randomUUID(), basePlanVersion: 1, baseObservationVersion: 0,
      completedActivityIds: [museum.id], skippedActivityIds: [],
      observedAt: "2026-10-16T10:30+08:00", earliestResumeAt: "2026-10-16T10:40+08:00",
      location: { kind: "known", placeId: museum.placeId }, noCurrentActivity: true,
    };
    const routes = replanRoutes();
    expect((await routes.progress(post(`journeys/${journeyId}/progress`, report), journeyId)).status).toBe(201);
    const command = { basePlanVersion: 1, baseObservationVersion: 1, scope: "rest_of_day", goal: "keep_as_much" };
    const created = await routes.replan(
      post(`journeys/${journeyId}/replan`, command, { "idempotency-key": randomUUID() }),
      journeyId,
    );
    expect(created.status).toBe(202);
    const { taskId } = await created.json();
    expect(await work()).toBe("completed");
    const done = await view(taskId);
    expect(done).toMatchObject({
      kind: "day_replan", journeyId, base: { planVersion: 1, observationVersion: 1 },
      result: { outcome: "candidate" }, offer: { status: "available" },
    });
    if (done.offer?.status !== "available") throw new Error("offer");

    // A newer report after the offer: the stored receipt can no longer overwrite the new state.
    expect((await routes.progress(post(`journeys/${journeyId}/progress`, {
      ...report, reportId: randomUUID(), baseObservationVersion: 1, observedAt: "2026-10-16T10:50+08:00",
      earliestResumeAt: "2026-10-16T10:55+08:00",
    }), journeyId)).status).toBe(201);
    const stale = await routes.confirm(
      post(`journeys/${journeyId}/replan/confirm`, { receipt: done.offer.receipt, acknowledgeUnknowns: true }),
      journeyId,
    );
    expect(stale.status).toBe(409);

    // Cancel while running: the worker stops and the task ends cancelled.
    const second = await routes.replan(post(`journeys/${journeyId}/replan`, {
      ...command, baseObservationVersion: 2,
    }, { "idempotency-key": randomUUID() }), journeyId);
    const { taskId: running } = await second.json();
    const claimed = (await tasks.claimNext("test-worker", new Date(t0)))!;
    expect((await service().cancel(running))?.cancelRequested).toBe(true);
    expect(await executeTask(claimed, { repository: tasks, checkpointer, now, heartbeatMs: 10 })).toBe("cancelled");
    expect(await view(running)).toMatchObject({ status: "cancelled", stopReason: "cancelled", offer: null });
    expect((await service().read(randomUUID()))).toBeNull();
  });
});
