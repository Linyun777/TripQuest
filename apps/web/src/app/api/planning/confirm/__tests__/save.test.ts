import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createJourney, getJourney, previewJourneyAdjustment, confirmJourneyAdjustment } from "@tripquest/application";
import { createDayPlanningProblem, dayStreamEventSchema, type DaySaveOffer } from "@tripquest/application/day-planning";
import { dayDraftSemanticFingerprint, assertDaySnapshotIntegrity, fingerprintRequirements, dayDraftConfirmationSnapshotSchema } from "@tripquest/application/day-confirmation";
import { type GeneratedDayRepository, type InitialGeneratedDayDraft, storedDayPlanDetailsSchema } from "@tripquest/application/generated-day";
import { planningFixturePlaces, planningFixtureEvidence } from "@tripquest/providers/planning-fixture";
import { createJourneyDatabase, DrizzleJourneyRepository, requireSafeTestDatabaseUrl, migrateJourneyDatabase, type JourneyDatabaseClient } from "@tripquest/db";
import { createDraftHandler } from "../../draft/draft-handler";
import { createConfirmDayHandler } from "../confirm-handler";
import { createGenerationService } from "../../../../planning/new/generation-service";
import { createDraftSaveOffer, readDraftSaveConfig, verifyDraftReceipt, DRAFT_RECEIPT_TTL } from "../../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../../planning/new/place-token";
import { asTestUser, ownerId } from "../../../../../test-support/users";

const envFile = resolve(process.cwd(), "../../.env");
// Only the test database address: the developer's own feature switches must not leak in.
if (existsSync(envFile)) {
  process.env.TEST_DATABASE_URL ??= parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL;
}
const t0 = Date.parse("2026-10-09T05:00:00Z");
const secret = "fixture-save-tests-receipt-secret-0123456789abcdef";
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_PLACE_TOKEN_SECRET: "fixture-save-tests-place-secret-0123456789abcdef",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_DRAFT_RECEIPT_SECRET: secret,
};
const directory = planningFixturePlaces();
const request = (body: unknown, path = "confirm", extra: Record<string, string> = {}) =>
  new Request(`http://localhost:3353/api/planning/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3353",
      host: "localhost:3353",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });

function submission(maximum = false, activityCount = 0) {
  const token = (index: number) => issuePlaceToken({
    place: directory[index],
    evidence: planningFixtureEvidence(t0),
  }, environment.PLANNING_PLACE_TOKEN_SECRET!, "fixture", t0);
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-15",
    window: { startsAt: "08:00", endsAt: "23:00" },
    startPlace: token(0),
    endPlace: token(4),
    interests: [],
    pace: "relaxed",
    visits: activityCount
      ? directory.slice(0, activityCount).map((_, index) => ({
          token: token(index),
          role: "required",
          stayMinutes: 15,
        }))
      : maximum
      ? directory.map((_, index) => ({
          token: token(index),
          role: index < 6 ? "required" : "optional",
          stayMinutes: 15,
        }))
      : [
          { token: token(1), role: "required", stayMinutes: 60 },
          { token: token(4), role: "fixed", startsAt: "12:00", endsAt: "13:00" },
          { token: token(3), role: "optional", stayMinutes: 30 },
        ],
  };
}

async function generate(
  maximum = false,
  options: NodeJS.ProcessEnv = environment,
  activityCount = 0,
) {
  const handler = createDraftHandler(
    () => createGenerationService({ environment: options, now: () => t0 }),
    (snapshot, result) => createDraftSaveOffer(snapshot, result, { environment: options, now: t0 }),
    undefined,
    asTestUser,
  );
  const response = await handler(request(submission(maximum, activityCount), "draft"));
  expect(response.status).toBe(200);
  const events = (await response.text()).trim().split("\n").map((line) =>
    dayStreamEventSchema.parse(JSON.parse(line)));
  const terminal = events.at(-1)!;
  if (
    terminal.type !== "result" ||
    terminal.result.status !== "completed" ||
    terminal.result.outcome !== "draft"
  ) {
    throw new Error("Expected actual generated draft");
  }
  return { result: terminal.result, offer: terminal.saveOffer };
}

function available(offer: DaySaveOffer | undefined) {
  if (offer?.status !== "available") {
    throw new Error("Save offer unavailable");
  }
  return offer;
}
function resign(payload: unknown) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}
const command = (receipt: string, title = "演示保存验证") =>
  ({ receipt, title, acknowledgeUnknowns: true });

describe("S5.3.1 generation handoff and receipt boundary (no database)", () => {
  it("signs the actual final callback snapshot, fits 1–6 activities and max input, and binds the stream", async () => {
    for (const count of [1, 2, 3, 4, 5, 6, 0]) {
      const { result, offer } = await generate(count === 0, environment, count);
      const saved = available(offer);
      const payload = verifyDraftReceipt(saved.receipt, secret, t0);
      assertDaySnapshotIntegrity(payload.snapshot);
      expect(payload.snapshot.draft).toEqual(result.draft);
      expect(payload.snapshot.selectedOrder).toEqual(result.draft.activities.map((item) => item.activityId));
      expect(Buffer.from(saved.receipt.split(".")[0], "base64url").byteLength).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(saved.receipt)).toBeLessThanOrEqual(49152);
      expect(result.draft.activities).toHaveLength(count || 6);
      expect(dayStreamEventSchema.safeParse({
        type: "result",
        sequence: 1,
        runId: result.runId,
        result,
        saveOffer: { ...saved, runId: "70000000-0000-4000-8000-000000000099" },
      }).success).toBe(false);
    }
  });

  it("keeps generation readonly when saving is off or its independent secret is invalid", async () => {
    for (const options of [
      { ...environment, PLANNING_SAVE_ENABLED: "false" },
      { ...environment, PLANNING_DRAFT_RECEIPT_SECRET: "" },
      { ...environment, PLANNING_DRAFT_RECEIPT_SECRET: environment.PLANNING_PLACE_TOKEN_SECRET },
      { ...environment, NODE_ENV: "production" },
    ] satisfies NodeJS.ProcessEnv[]) {
      const { offer } = await generate(false, options);
      expect(offer?.status).toBe(options.NODE_ENV === "production" ? "available" : "unavailable");
    }
    expect(readDraftSaveConfig({ ...environment, PLANNING_PLACE_SOURCE: "amap" }).enabled).toBe(false);
  });

  it("hands off no snapshot on cancellation and preserves a valid draft if an offer exceeds limits", async () => {
    const service = createGenerationService({ environment, now: () => t0 });
    const prepared = await service.prepare(submission());
    if (prepared.status !== "ready") throw new Error("Expected prepared run");
    const abort = new AbortController();
    abort.abort();
    const callback = vi.fn();
    expect((await prepared.runner.run(prepared.problem, {
      signal: abort.signal,
      onProgress: () => {},
      onDraftReady: callback,
    })).status).toBe("cancelled");
    expect(callback).not.toHaveBeenCalled();
    const handler = createDraftHandler(() => service, async (snapshot, result) => ({
      ...available(await createDraftSaveOffer(snapshot, result, { environment, now: t0 })),
      receipt: "oversized".repeat(17000),
    }), undefined, asTestUser);
    const reply = await handler(request(submission(), "draft"));
    const terminal = (await reply.text()).trim().split("\n").map((line) =>
      dayStreamEventSchema.parse(JSON.parse(line))).at(-1)!;
    expect(terminal.type === "result" && terminal.result.status).toBe("completed");
    expect(terminal.type === "result" && terminal.saveOffer?.status).toBe("unavailable");
  });

  it("rejects signed structural/source/time tampering before opening a repository", async () => {
    const { offer } = await generate();
    const saved = available(offer);
    const payload = verifyDraftReceipt(saved.receipt, secret, t0);
    const variants = [
      { ...payload, purpose: "planning-place.v1" },
      { ...payload, extra: "unsupported" },
      { ...payload, issuedAt: t0 + 1, expiresAt: t0 + DRAFT_RECEIPT_TTL + 1 },
      { ...payload, expiresAt: t0 + DRAFT_RECEIPT_TTL + 1 },
      { ...payload, runId: "70000000-0000-4000-8000-000000000099" },
      { ...payload, draftFingerprint: "0".repeat(64) },
    ];
    const mixed = structuredClone(payload);
    mixed.snapshot.places[0].selection.evidence = {
      ...mixed.snapshot.places[0].selection.evidence, sourceKind: "live",
    };
    mixed.draftFingerprint = dayDraftSemanticFingerprint(mixed.snapshot);
    variants.push(mixed);
    const repository = vi.fn(() => { throw new Error("Must not access database"); });
    const handler = createConfirmDayHandler({ user: asTestUser, environment, now: () => t0, repository });
    for (const value of variants) {
      expect((await handler(request(command(resign(value))))).status).toBe(403);
    }
    expect((await handler(request(command(saved.receipt.slice(0, -1) + "!")))).status).toBe(403);
    expect((await handler(request({ ...command(saved.receipt), activities: [] }))).status).toBe(400);
    expect((await handler(request(command(saved.receipt), "confirm", { origin: "http://untrusted.test" }))).status).toBe(403);
    expect((await handler(request("中".repeat(23000)))).status).toBe(413);
    expect(repository).not.toHaveBeenCalled();
  });

  it("fingerprints semantic changes but ignores refreshed evidence and object/set order", async () => {
    const { offer } = await generate();
    const snapshot = verifyDraftReceipt(available(offer).receipt, secret, t0).snapshot;
    const original = dayDraftSemanticFingerprint(snapshot);
    // Lock this fictional case as well as the independently derived times below.
    expect(original).toBe("455e5734b51c4665d6ad1393d796c46759fe283477c0131b7d41b4921e8b9c38");
    const changed = structuredClone(snapshot);
    changed.draft.createdAt = new Date(t0 + 1000).toISOString();
    changed.places.reverse();
    changed.draft.places.reverse();
    changed.draft.checks.reverse();
    changed.routes.forEach((item) => {
      if (item.status === "known") item.retrievedAt = new Date(t0 + 60000).toISOString();
    });
    expect(dayDraftSemanticFingerprint(changed)).toBe(original);
    changed.draft.activities[0].stayMinutes += 1;
    expect(dayDraftSemanticFingerprint(changed)).not.toBe(original);
    // Explicit hand-derived schedule: 08:00 + 7 walking + 10 buffer => 08:17.
    expect(snapshot.draft.activities[0]).toMatchObject({ startsAt: 497, endsAt: 557, role: "required" });
    expect(snapshot.draft.activities[1]).toMatchObject({ startsAt: 720, endsAt: 780, role: "fixed" });
    expect(snapshot.draft.activities[2]).toMatchObject({ startsAt: 798, endsAt: 828, role: "optional" });
    expect(snapshot.draft.endArrival).toBe(845);
    expect(snapshot.draft.verification).toBe("pending");
  });
});

// Optional only for a normal unit-test invocation; the task card records a real run with this env.
describe.skipIf(!process.env.TEST_DATABASE_URL)("S5.3.1 full handler → PostgreSQL → reopen", () => {
  let client: JourneyDatabaseClient;
  let repository: DrizzleJourneyRepository;
  beforeAll(async () => {
    const url = requireSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    client = createJourneyDatabase(url, { applicationName: "tripquest-s531-test", maxConnections: 4 });
    await migrateJourneyDatabase(client.database, {
      migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
    });
    repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
  });
  beforeEach(async () => {
    await client.pool.query("TRUNCATE journeys CASCADE");
  });
  afterAll(async () => {
    if (client) {
      await client.pool.query("TRUNCATE journeys CASCADE");
      await client.close();
    }
  });
  const handler = (now = t0, port: GeneratedDayRepository = repository, options = environment) =>
    createConfirmDayHandler({ user: asTestUser, environment: options, now: () => now, repository: () => port });
  const counts = async () => {
    const result = await client.pool.query(`SELECT
      (SELECT count(*)::int FROM journeys) AS roots,
      (SELECT count(*)::int FROM plan_versions) AS versions,
      (SELECT count(*)::int FROM plan_activities) AS activities,
      (SELECT count(*)::int FROM reservations) AS reservations,
      (SELECT count(*)::int FROM day_plan_details) AS details,
      (SELECT count(*)::int FROM journey_observations) AS observations`);
    return result.rows[0];
  };

  it("requires acknowledgment, saves the same checked draft atomically and reopens without external calls", async () => {
    const { result, offer } = await generate();
    const body = command(available(offer).receipt, "  我的演示行程  ");
    const post = handler(t0 + 6 * 60000); // Beyond the domain's 5-minute evidence window.
    expect((await post(request({ ...body, acknowledgeUnknowns: false }))).status).toBe(422);
    expect((await counts()).roots).toBe(0);
    const response = await post(request(body));
    expect(response.status).toBe(201);
    const saved = await response.json();
    const reopened = await getJourney(saved.journeyId, repository);
    if (reopened.status !== "found") throw new Error("Expected saved journey");
    const details = storedDayPlanDetailsSchema.parse(reopened.journey.dayDetails);
    expect(reopened.journey.creationKind).toBe("generated_day");
    expect(reopened.journey.title).toBe("我的演示行程");
    expect(reopened.journey.version).toBe(1);
    expect(details.planning.draft.activities).toEqual(result.draft.activities);
    expect(details.planning.draft.checks).toEqual(result.draft.checks);
    expect(details.recheckedAt).toBe(new Date(t0 + 6 * 60000).toISOString());
    expect(reopened.journey.activities.map((item) => [item.priority, item.locked])).toEqual([
      ["high", false], ["high", true], ["normal", false],
    ]);
    expect(reopened.journey.activities[1].reservation).toMatchObject({
      confirmationStatus: "unknown", sourceKind: "user_reported",
    });
    expect(details.placeBindings.find((item) => item.draftPlaceId === details.planning.draft.endPlace.placeId)?.placeId)
      .toBe(reopened.journey.activities[1].placeId);
    expect(await counts()).toEqual({ roots: 1, versions: 1, activities: 3, reservations: 1, details: 1, observations: 0 });
    expect(JSON.stringify(details)).not.toContain(body.receipt);
    expect((await post(request(body))).status).toBe(200);
    expect((await post(request({ ...body, title: "另一个标题" }))).status).toBe(409);
    expect(await handler(t0 + DRAFT_RECEIPT_TTL + 1, repository, { ...environment, PLANNING_SAVE_ENABLED: "false" })(request(body))
      .then((reply) => reply.json())).toMatchObject({ status: "already_saved", journeyId: saved.journeyId, planVersion: 1 });
    // Raw legacy APIs must reject a generated plan, even if a client bypasses the page.
    const legacy = {
      journeyId: saved.journeyId, basePlanVersion: 1,
      observedAt: "08:00", earliestResumeAt: "08:30", completedActivityIds: [],
      noCurrentActivity: true, locationAtTarget: true, travelMinutes: 5,
    };
    expect((await previewJourneyAdjustment(legacy, repository, () => crypto.randomUUID())).status).toBe("unsupported_scenario");
    expect((await confirmJourneyAdjustment({
      ...legacy, baseObservationVersion: 0, strategy: "shift",
      semanticFingerprint: "f".repeat(64), idempotencyKey: crypto.randomUUID(),
    }, repository, { now: () => new Date(t0) }, () => crypto.randomUUID())).status).toBe("not_confirmable");
  });

  it("concurrent identical runs have one creation; competing titles never overwrite the winner", async () => {
    for (const titles of [["同一标题", "同一标题"], ["标题 A", "标题 B"]]) {
      await client.pool.query("TRUNCATE journeys CASCADE");
      const { offer } = await generate(titles[0] === titles[1]);
      let arrivals = 0;
      let release!: () => void;
      const both = new Promise<void>((resolve) => { release = resolve; });
      const port: GeneratedDayRepository = {
        async findGeneratedDayCreation(runId) {
          const prior = await repository.findGeneratedDayCreation(runId);
          arrivals += 1;
          if (arrivals === 2) release();
          await both;
          return prior;
        },
        createGeneratedDay: (draft) => repository.createGeneratedDay(draft),
      };
      const post = handler(t0, port);
      const responses = await Promise.all(titles.map((title) =>
        post(request(command(available(offer).receipt, title)))));
      expect(responses.map((response) => response.status).sort())
        .toEqual(titles[0] === titles[1] ? [200, 201] : [201, 409]);
      expect((await counts()).roots).toBe(1);
      expect((await counts()).details).toBe(1);
      if (titles[0] === titles[1]) {
        const winner = await responses.find((reply) => reply.status === 201)!.json();
        const reopened = await getJourney(winner.journeyId, repository);
        if (reopened.status !== "found") throw new Error("Expected saved maximum draft");
        const sameNames = reopened.journey.activities.filter((item) => item.placeName === "演示博物馆");
        expect(sameNames).toHaveLength(2);
        expect(sameNames[0].placeId).not.toBe(sameNames[1].placeId);
      }
    }
  });

  it("reads the committed winner after the last serialization failure", async () => {
    const { offer } = await generate();
    let initial!: InitialGeneratedDayDraft;
    const port: GeneratedDayRepository = {
      findGeneratedDayCreation: (runId) => repository.findGeneratedDayCreation(runId),
      async createGeneratedDay(draft) {
        initial = draft;
        return repository.createGeneratedDay(draft);
      },
    };
    const saved = await handler(t0, port)(request(command(available(offer).receipt)));
    expect(saved.status).toBe(201);
    const { journeyId } = await saved.json();

    const transaction = vi.spyOn(client.database, "transaction")
      .mockRejectedValue(Object.assign(new Error("serialization failure"), { code: "40001" }));
    const lookup = vi.spyOn(repository, "findGeneratedDayCreation")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    try {
      expect(await repository.createGeneratedDay(initial)).toEqual({
        status: "already_saved",
        journeyId,
        planVersion: 1,
      });
      expect(transaction).toHaveBeenCalledTimes(3);
      expect((await counts()).roots).toBe(1);
    } finally {
      transaction.mockRestore();
      lookup.mockRestore();
    }
  });

  it("recovers a committed response loss with the same receipt/intent, even after expiry", async () => {
    const { offer } = await generate();
    const body = command(available(offer).receipt);
    const port: GeneratedDayRepository = {
      findGeneratedDayCreation: (runId) => repository.findGeneratedDayCreation(runId),
      async createGeneratedDay(draft) {
        await repository.createGeneratedDay(draft);
        throw new Error("simulated response loss after commit");
      },
    };
    expect((await handler(t0, port)(request(body))).status).toBe(503);
    expect((await counts()).roots).toBe(1);
    expect((await handler(t0 + DRAFT_RECEIPT_TTL + 1)(request(body))).status).toBe(200);
  });

  it("refuses expired, changed fixture directory and changed facts with zero writes", async () => {
    const { offer } = await generate();
    const saved = available(offer);
    expect((await handler(t0 + DRAFT_RECEIPT_TTL)(request(command(saved.receipt)))).status).toBe(410);
    const payload = verifyDraftReceipt(saved.receipt, secret, t0);
    const changedDirectory = structuredClone(payload);
    const requirements = changedDirectory.snapshot.problem.requirements;
    requirements.startPlace.place = { ...requirements.startPlace.place, location: {
      ...requirements.startPlace.place.location,
      longitude: requirements.startPlace.place.location.longitude + 0.1,
    } };
    const originalProblem = changedDirectory.snapshot.problem;
    const rebuilt = createDayPlanningProblem({
      requirements, runId: originalProblem.runId, nowMs: originalProblem.input.nowMs,
      requirementsFingerprint: fingerprintRequirements(requirements),
    });
    changedDirectory.snapshot.problem = dayDraftConfirmationSnapshotSchema.shape.problem.parse(rebuilt);
    changedDirectory.snapshot.places[0] = changedDirectory.snapshot.problem.places[0];
    changedDirectory.requirementsFingerprint = rebuilt.requirementsFingerprint;
    changedDirectory.snapshot.draft.requirementsFingerprint = rebuilt.requirementsFingerprint;
    changedDirectory.draftFingerprint = dayDraftSemanticFingerprint(changedDirectory.snapshot);
    expect((await handler()(request(command(resign(changedDirectory))))).status).toBe(409);
    const obsolete = JSON.parse(JSON.stringify(payload).replaceAll("planning-fixture.v2", "planning-fixture.v0")) as typeof payload;
    obsolete.requirementsFingerprint = fingerprintRequirements(obsolete.snapshot.problem.requirements);
    obsolete.snapshot.problem.requirementsFingerprint = obsolete.requirementsFingerprint;
    obsolete.snapshot.draft.requirementsFingerprint = obsolete.requirementsFingerprint;
    obsolete.draftFingerprint = dayDraftSemanticFingerprint(obsolete.snapshot);
    expect((await handler()(request(command(resign(obsolete))))).status).toBe(409);
    for (const mutate of [
      (p: typeof payload) => {
        const selection = p.snapshot.places[0].selection;
        selection.place = { ...selection.place, location: {
          ...selection.place.location, longitude: selection.place.location.longitude + 0.1,
        } };
      },
      (p: typeof payload) => { p.snapshot.draft.activities[0].startsAt += 1; },
      (p: typeof payload) => { p.snapshot.routes[0] = { ...p.snapshot.routes[0], durationSeconds: 1 } as typeof p.snapshot.routes[0]; },
    ]) {
      const changed = structuredClone(payload);
      mutate(changed);
      changed.draftFingerprint = dayDraftSemanticFingerprint(changed.snapshot);
      const reply = await handler()(request(command(resign(changed))));
      expect([403, 409]).toContain(reply.status);
    }
    expect((await counts()).roots).toBe(0);
  });

  it("rolls back activity/details insert faults and permits a later same-receipt retry", async () => {
    const { offer } = await generate();
    const body = command(available(offer).receipt);
    for (const table of ["plan_activities", "day_plan_details"]) {
      await client.pool.query(`CREATE FUNCTION s531_fail_insert() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'injected save fault'; END; $$`);
      await client.pool.query(`CREATE TRIGGER s531_fail BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION s531_fail_insert()`);
      try {
        expect((await handler()(request(body))).status).toBe(503);
        expect(await counts()).toEqual({ roots: 0, versions: 0, activities: 0, reservations: 0, details: 0, observations: 0 });
      } finally {
        await client.pool.query(`DROP TRIGGER s531_fail ON ${table}`);
        await client.pool.query("DROP FUNCTION s531_fail_insert()");
      }
    }
    expect((await handler()(request(body))).status).toBe(201);
  });

  it("fails closed on corrupted/missing details and repository-level legacy bypass", async () => {
    const { offer } = await generate();
    const saved = await handler()(request(command(available(offer).receipt))).then((reply) => reply.json());
    const stored = (await repository.findCurrentJourney(saved.journeyId))!;
    expect(await repository.commitConfirmedAdjustment({
      journeyId: saved.journeyId, idempotencyKey: crypto.randomUUID(), intentFingerprint: "f".repeat(64),
      basePlanVersion: 1, baseObservationVersion: 0, expectedJourney: stored, strategy: "shift",
      previewFingerprint: "f".repeat(64), confirmedAt: "2026-10-09T13:00:00+08:00",
      command: { observedAt: "08:00", earliestResumeAt: "08:30", completedActivityIds: [],
        noCurrentActivity: true, locationAtTarget: true, travelMinutes: 5 },
      candidateActivities: stored.currentPlan.activities,
    })).toEqual({ status: "preview_changed" });
    expect(storedDayPlanDetailsSchema.safeParse({ ...stored.dayDetails, planVersion: 2 }).success).toBe(false);
    await client.pool.query("UPDATE day_plan_details SET details = jsonb_set(details, '{planning,draft,activities,0,startsAt}', '1') WHERE journey_id = $1", [saved.journeyId]);
    await expect(getJourney(saved.journeyId, repository)).rejects.toThrow();
    await client.pool.query("DELETE FROM day_plan_details WHERE journey_id = $1", [saved.journeyId]);
    await expect(getJourney(saved.journeyId, repository)).rejects.toThrow();
    expect((await counts()).versions).toBe(1);
  });

  it("keeps the manual creation/read path with the default creation kind", async () => {
    const created = await createJourney({
      title: "手动兼容", date: "2026-10-15", timeZone: "Asia/Shanghai",
      activities: [{ placeName: "虚构手动地点", startsAt: "09:00", endsAt: "10:00", priority: "normal", kind: "activity" }],
    }, { repository, idGenerator: { next: () => crypto.randomUUID() }, clock: { now: () => new Date(t0) } });
    if (created.status !== "created") throw new Error("Manual creation failed");
    const reopened = await getJourney(created.journeyId, repository);
    expect(reopened.status === "found" && reopened.journey.creationKind).toBe("manual");
    expect((await counts()).details).toBe(0);
  });
});
