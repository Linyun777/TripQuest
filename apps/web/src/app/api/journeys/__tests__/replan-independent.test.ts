import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import { currentDayState, type DayProgressCommand } from "@tripquest/application/day-progress";
import { replanStreamEventSchema, type ReplanStreamEvent } from "@tripquest/application/day-replan";
import { createReplanScriptedModel } from "@tripquest/agent/replanning";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createDraftSaveOffer } from "../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { createReplanHandlers } from "../replan-handlers";
import { asTestUser, ownerId } from "../../../../test-support/users";

const now = Date.parse("2026-10-16T01:00:00Z");
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "s533-independent-test-place-secret-0123456789abcdef",
  PLANNING_DRAFT_RECEIPT_SECRET: "s533-independent-test-save-secret-0123456789abcdef",
};
const post = (path: string, body: unknown) => new Request(`http://localhost:3390/api/${path}`, {
  method: "POST",
  headers: {
    origin: "http://localhost:3390",
    host: "localhost:3390",
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.3 independent business scenarios", () => {
  let admin: JourneyDatabaseClient;
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;
  let journeyId: string;
  const handlers = (overrides: Parameters<typeof createReplanHandlers>[0] = {}) => createReplanHandlers({
    environment,
    now: () => now,
    repository: () => repository,
    ...overrides,
  });
  const current = async () => (await repository.findCurrentJourney(journeyId))!;
  const totals = async () => (await client.pool.query(`SELECT
    (SELECT count(*)::int FROM plan_versions) AS plans,
    (SELECT count(*)::int FROM generated_day_progress) AS reports,
    (SELECT count(*)::int FROM generated_day_replan_confirmations) AS confirmations,
    (SELECT current_observation_version FROM journeys LIMIT 1) AS observation
  `)).rows[0];

  beforeAll(async () => {
    const safe = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    admin = createJourneyDatabase(safe, { maxConnections: 1 });
    await admin.pool.query("CREATE DATABASE tripquest_s533_independent_test");
    const url = new URL(safe);
    url.pathname = "/tripquest_s533_independent_test";
    client = createJourneyDatabase(requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL));
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  afterAll(async () => {
    await client?.close();
    await admin?.pool.query("DROP DATABASE IF EXISTS tripquest_s533_independent_test WITH (FORCE)");
    await admin?.close();
  });
  beforeEach(async () => {
    await client.pool.query("TRUNCATE journeys CASCADE");
    const places = planningFixturePlaces();
    const token = (index: number) => issuePlaceToken({
      place: places[index], evidence: planningFixtureEvidence(now),
    }, environment.PLANNING_PLACE_TOKEN_SECRET!, "fixture", now);
    const generate = createDraftHandler(
      () => createGenerationService({ environment, now: () => now }),
      (snapshot, result) => createDraftSaveOffer(snapshot, result, { environment, now }),
      undefined,
      asTestUser,
    );
    const response = await generate(post("planning/draft", {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: "2026-10-16",
      window: { startsAt: "09:00", endsAt: "18:00" },
      startPlace: token(0), endPlace: token(4), interests: ["nature"], pace: "standard",
      visits: [
        { token: token(1), role: "required", stayMinutes: 60 },
        { token: token(5), role: "fixed", startsAt: "13:00", endsAt: "14:00" },
        { token: token(2), role: "optional", stayMinutes: 60 },
        { token: token(3), role: "optional", stayMinutes: 30 },
      ],
    }));
    const terminal = dayStreamEventSchema.parse(JSON.parse((await response.text()).trim().split("\n").at(-1)!));
    if (terminal.type !== "result" || terminal.saveOffer?.status !== "available") {
      throw new Error("Independent scenario could not create its fixture plan");
    }
    const saved = await createConfirmDayHandler({ user: asTestUser, environment, now: () => now, repository: () => repository })(
      post("planning/confirm", { receipt: terminal.saveOffer.receipt, title: "独立测试虚构行程", acknowledgeUnknowns: true }),
    );
    expect(saved.status).toBe(201);
    journeyId = (await saved.json()).journeyId;
  });

  async function report(overrides: Partial<DayProgressCommand> = {}, service = handlers()) {
    const stored = await current();
    const command: DayProgressCommand = {
      reportId: randomUUID(), basePlanVersion: stored.currentPlan.version,
      baseObservationVersion: stored.currentObservationVersion,
      completedActivityIds: [], skippedActivityIds: [],
      observedAt: "2026-10-16T11:00+08:00", earliestResumeAt: "2026-10-16T11:00+08:00",
      location: { kind: "unknown" }, noCurrentActivity: true,
      ...overrides,
    };
    const response = await service.progress(post(`journeys/${journeyId}/progress`, command), journeyId);
    return { command, status: response.status, body: await response.json() };
  }
  async function run(
    service = handlers(),
    scope: "rest_of_day" | "until_next_fixed" = "rest_of_day",
    goal: "keep_as_much" | "relaxed" = "keep_as_much",
  ) {
    const stored = await current();
    const response = await service.replan(post(`journeys/${journeyId}/replan`, {
      basePlanVersion: stored.currentPlan.version,
      baseObservationVersion: stored.currentObservationVersion,
      scope, goal,
    }), journeyId);
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n")
      .map((line) => replanStreamEventSchema.parse(JSON.parse(line)));
    const terminal = events.at(-1);
    if (terminal?.type !== "result") throw new Error("No terminal result");
    return terminal as Extract<ReplanStreamEvent, { type: "result" }>;
  }
  async function confirm(receipt: string, service = handlers()) {
    const response = await service.confirm(post(`journeys/${journeyId}/replan/confirm`, {
      receipt, acknowledgeUnknowns: true,
    }), journeyId);
    return { status: response.status, body: await response.json() };
  }
  async function startReportedDay() {
    const stored = await current();
    const required = stored.currentPlan.activities[0];
    expect((await report({
      completedActivityIds: [required.id], location: { kind: "known", placeId: required.placeId },
    })).status).toBe(201);
    return required;
  }

  it("writes simultaneous identical reports once and replays after later facts and a disabled switch", async () => {
    const stored = await current();
    const command: DayProgressCommand = {
      reportId: randomUUID(), basePlanVersion: 1, baseObservationVersion: 0,
      completedActivityIds: [stored.currentPlan.activities[0].id, stored.currentPlan.activities[2].id],
      skippedActivityIds: [], observedAt: "2026-10-16T11:00+08:00",
      earliestResumeAt: "2026-10-16T11:20+08:00",
      location: { kind: "known", placeId: stored.currentPlan.activities[2].placeId }, noCurrentActivity: true,
    };
    const send = async (service: ReturnType<typeof handlers>, body = command) => {
      const response = await service.progress(post(`journeys/${journeyId}/progress`, body), journeyId);
      return response.json();
    };
    const results = await Promise.all([send(handlers()), send(handlers())]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_saved", "saved"]);
    expect(await totals()).toEqual({ plans: 1, reports: 1, confirmations: 0, observation: 1 });
    expect((await report({
      completedActivityIds: command.completedActivityIds,
      observedAt: "2026-10-16T11:30+08:00", earliestResumeAt: "2026-10-16T11:30+08:00",
      location: command.location,
    })).status).toBe(201);
    const replay = await send(handlers({ environment: { ...environment, PLANNING_SAVE_ENABLED: "false" } }), {
      ...command, completedActivityIds: [...command.completedActivityIds].reverse(),
    });
    expect(replay).toEqual({ status: "already_saved", observationVersion: 1 });
    expect((await current()).currentObservationVersion).toBe(2);
  });

  it("rolls back an inserted report when the root update fails, then accepts the same intent", async () => {
    await client.pool.query(`CREATE FUNCTION s533_it_fail_report() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.current_observation_version > OLD.current_observation_version THEN
      RAISE EXCEPTION 'independent report failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER s533_it_report_failure BEFORE UPDATE ON journeys
      FOR EACH ROW EXECUTE FUNCTION s533_it_fail_report()`);
    let command: DayProgressCommand;
    try {
      const attempted = await report();
      command = attempted.command;
      expect(attempted).toMatchObject({ status: 503, body: { status: "temporarily_unavailable" } });
      expect(await totals()).toEqual({ plans: 1, reports: 0, confirmations: 0, observation: 0 });
    } finally {
      await client.pool.query("DROP TRIGGER s533_it_report_failure ON journeys; DROP FUNCTION s533_it_fail_report()");
    }
    const retry = await handlers().progress(post(`journeys/${journeyId}/progress`, command!), journeyId);
    expect(retry.status).toBe(201);
    expect(await totals()).toEqual({ plans: 1, reports: 1, confirmations: 0, observation: 1 });
  });

  it("keeps later ordinary slots frozen after a non-prefix completion removes an intervening stop", async () => {
    const initial = await current();
    const [required, fixed, intervening, later] = initial.currentPlan.activities;
    expect(fixed.locked).toBe(true);
    expect((await report({
      completedActivityIds: [required.id, intervening.id],
      location: { kind: "known", placeId: intervening.placeId },
      observedAt: "2026-10-16T12:00+08:00", earliestResumeAt: "2026-10-16T12:00+08:00",
    })).status).toBe(201);
    const before = await totals();
    const terminal = await run(handlers(), "until_next_fixed");
    expect(await totals()).toEqual(before);
    // The fixed booking and later slot are feasible with waiting; neither may move.
    expect(terminal.result).toMatchObject({ status: "completed", outcome: "candidate" });
    if (terminal.result.status !== "completed" || terminal.result.outcome !== "candidate") return;
    const frozen = terminal.result.candidate.activities.filter((item) => item.frozen);
    expect(frozen.map((item) => item.key)).toEqual([fixed.id, later.id]);
    const at = (value: string) => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
    expect(frozen.map((item) => [item.startsAt, item.endsAt])).toEqual([
      [at(fixed.startsAt), at(fixed.endsAt)], [at(later.startsAt), at(later.endsAt)],
    ]);
    expect(terminal.offer?.status).toBe("available");
    if (terminal.offer?.status !== "available") return;
    expect((await confirm(terminal.offer.receipt)).status).toBe(201);
    const saved = await current();
    expect(saved.currentPlan.version).toBe(2);
    expect(saved.currentPlan.activities.map((item) => [item.startsAt, item.endsAt])).toEqual([
      [fixed.startsAt, fixed.endsAt], [later.startsAt, later.endsAt],
    ]);
    expect(currentDayState(saved).future.find((item) =>
      item.record.activity.activityId === later.id)?.record.activity.role).toBe("optional");
    expect((await getJourney(journeyId, repository)).status).toBe("found");
    expect((await getJourney(journeyId, repository, 1)).status).toBe("found");
    expect((await run(handlers(), "until_next_fixed")).result).toMatchObject({
      status: "completed", outcome: "unchanged",
    });
  });

  it("does not issue a receipt when a new report arrives during model execution", async () => {
    const required = await startReportedDay();
    const model = {
      ...createReplanScriptedModel(),
      async decide() {
        expect((await report({
          completedActivityIds: [required.id], location: { kind: "known", placeId: required.placeId },
          observedAt: "2026-10-16T11:30+08:00", earliestResumeAt: "2026-10-16T11:45+08:00",
        })).status).toBe(201);
        return { decision: { action: "finish", attemptId: "baseline" }, usage: null };
      },
    };
    const terminal = await run(handlers({ model }));
    expect(terminal.result).toMatchObject({ status: "completed", outcome: "candidate" });
    expect(terminal.offer).toEqual({ status: "unavailable", reason: "stale" });
    expect(await totals()).toEqual({ plans: 1, reports: 2, confirmations: 0, observation: 2 });
  });

  it("caches missing directed routes and stops honestly when a required route remains unknown", async () => {
    const first = (await current()).currentPlan.activities[0];
    const startPlaceId = currentDayState(await current()).context.startPlaceId;
    expect((await report({
      observedAt: "2026-10-16T09:00+08:00", earliestResumeAt: "2026-10-16T09:00+08:00",
      location: { kind: "known", placeId: startPlaceId },
    })).status).toBe(201);
    const provider = new PlanningFixtureProvider(() => now);
    const find = provider.findRoutes.bind(provider);
    const keys: string[] = [];
    provider.findRoutes = async (request, options) => {
      keys.push(`${request.origin.place.externalId}>${request.destination.place.externalId}`);
      if (request.destination.place.externalId === "DEMO-MUSEUM-A") return {
        status: "failure", evidence: planningFixtureEvidence(now),
        failure: { code: "invalid_request", retry: "never", safeMessage: "独立测试：无可用路线。" },
      };
      return find(request, options);
    };
    const terminal = await run(handlers({ provider }));
    expect(terminal.result).toMatchObject({
      status: "completed", outcome: "bounded_no_candidate", reason: "insufficient_information",
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(terminal.offer).toBeUndefined();
    const stored = await current();
    expect(stored.currentPlan.activities.some((item) => item.id === first.id)).toBe(true);
    expect(await totals()).toEqual({ plans: 1, reports: 1, confirmations: 0, observation: 1 });
  });

  it("shows a new final leg when all activities are archived but the location or resume time changes", async () => {
    const initial = await current();
    const state = currentDayState(initial);
    const ids = initial.currentPlan.activities.map((item) => item.id);
    const last = initial.currentPlan.activities.at(-1)!;
    expect((await report({
      completedActivityIds: ids, location: { kind: "known", placeId: last.placeId },
      observedAt: "2026-10-16T16:00+08:00", earliestResumeAt: "2026-10-16T16:00+08:00",
    })).status).toBe(201);
    const first = await run(handlers(), "rest_of_day", "relaxed");
    if (first.offer?.status !== "available") throw new Error("Expected direct-to-end offer");
    expect((await confirm(first.offer.receipt)).status).toBe(201);
    const saved = await current();
    if (saved.dayDetails?.schemaVersion !== "stored-day-plan.v3") throw new Error("Expected v3 details");
    expect(saved.currentPlan.activities).toHaveLength(0);
    expect((await report({
      completedActivityIds: ids, location: { kind: "known", placeId: state.context.startPlaceId },
      observedAt: "2026-10-16T16:20+08:00", earliestResumeAt: "2026-10-16T16:20+08:00",
    })).status).toBe(201);
    const second = await run(handlers(), "rest_of_day", "relaxed");
    // Empty activity arrays do not make a changed location/departure/final route unchanged.
    expect(second.result).toMatchObject({ status: "completed", outcome: "candidate" });
    if (second.result.status !== "completed" || second.result.outcome !== "candidate") return;
    expect(second.result.candidate.activities).toHaveLength(0);
    expect(second.result.candidate.resume.key).toBe(state.context.startPlaceId);
    expect(second.result.candidate.metrics.endArrival).not.toBe(saved.dayDetails.future.schedule.endArrival);
    expect(second.offer?.status).toBe("available");
    if (second.offer?.status !== "available") return;
    expect((await confirm(second.offer.receipt)).body.planVersion).toBe(3);
    const read = await getJourney(journeyId, repository);
    expect(read.status).toBe("found");
    if (read.status !== "found" || read.journey.dayDetails?.schemaVersion !== "stored-day-plan.v3") {
      throw new Error("Expected saved direct-to-end v3");
    }
    expect(read.journey.activities).toHaveLength(0);
    expect(read.journey.dayDetails.archived).toHaveLength(ids.length);
    expect(read.journey.dayDetails.future.resumePlaceId).toBe(state.context.startPlaceId);
    expect(read.journey.dayDetails.future.schedule.endArrival).toBe(second.result.candidate.metrics.endArrival);
    expect((await run()).result).toMatchObject({ status: "completed", outcome: "unchanged" });
    expect((await report({
      completedActivityIds: ids,
      location: { kind: "known", placeId: state.context.startPlaceId },
      observedAt: "2026-10-16T16:40+08:00", earliestResumeAt: "2026-10-16T16:40+08:00",
    })).status).toBe(201);
    const timeOnly = await run();
    expect(timeOnly.result).toMatchObject({ status: "completed", outcome: "candidate" });
    if (timeOnly.result.status === "completed" && timeOnly.result.outcome === "candidate") {
      expect(timeOnly.result.candidate.resume.startsAt).toBe(1000);
      expect(timeOnly.result.candidate.metrics.endArrival).toBe(second.result.candidate.metrics.endArrival + 20);
    }
  });

  it("confirms one run once and replays its original version after later reports, plans and expiry", async () => {
    const required = await startReportedDay();
    const original = await repository.findJourneyVersion(journeyId, 1);
    const first = await run(handlers(), "rest_of_day", "relaxed");
    if (first.offer?.status !== "available") throw new Error("Expected first offer");
    const replies = await Promise.all([confirm(first.offer.receipt), confirm(first.offer.receipt)]);
    expect(replies.map((reply) => reply.body.status).sort()).toEqual(["already_saved", "saved"]);
    expect(replies.map((reply) => reply.body.planVersion)).toEqual([2, 2]);
    expect((await report({
      completedActivityIds: [required.id], location: { kind: "known", placeId: required.placeId },
      observedAt: "2026-10-16T11:30+08:00", earliestResumeAt: "2026-10-16T11:45+08:00",
    })).status).toBe(201);
    const second = await run(handlers(), "rest_of_day", "relaxed");
    if (second.offer?.status !== "available") throw new Error("Expected second offer");
    expect((await confirm(second.offer.receipt)).body.planVersion).toBe(3);
    const replay = await confirm(first.offer.receipt, handlers({
      now: () => now + 16 * 60_000,
      environment: { ...environment, PLANNING_SAVE_ENABLED: "false" },
    }));
    expect(replay).toMatchObject({ status: 200, body: { status: "already_saved", planVersion: 2 } });
    const stored = await current();
    expect(stored.currentPlan.version).toBe(3);
    expect(stored.currentObservationVersion).toBe(2);
    expect(stored.reservations).toEqual(original!.reservations);
    expect((await repository.findJourneyVersion(journeyId, 1))!.dayDetails).toEqual(original!.dayDetails);
    expect(await totals()).toEqual({ plans: 3, reports: 2, confirmations: 2, observation: 2 });
  });
});
