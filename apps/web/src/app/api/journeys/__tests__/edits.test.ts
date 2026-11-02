import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getJourney } from "@tripquest/application";
import { dayStreamEventSchema } from "@tripquest/application/day-planning";
import type {
  DayEditChange,
  DayEditPreviewReply,
  DayEditConfirmReply,
} from "@tripquest/application/saved-day";
import type { ConfirmedDayEdit } from "@tripquest/application/day-edit";
import { createJourneyDatabase, DrizzleJourneyRepository, migrateJourneyDatabase, requireSafeTestDatabaseUrl, type JourneyDatabaseClient } from "@tripquest/db";
import { planningFixturePlaces, planningFixtureEvidence } from "@tripquest/providers/planning-fixture";
import { createDraftHandler } from "../../planning/draft/draft-handler";
import { createConfirmDayHandler } from "../../planning/confirm/confirm-handler";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createDraftSaveOffer, DRAFT_RECEIPT_TTL } from "../../../planning/new/draft-receipt";
import { issuePlaceToken } from "../../../planning/new/place-token";
import { EDIT_RECEIPT_TTL, verifyEditReceipt } from "../../../journeys/edit-receipt";
import { createDayEditHandlers } from "../edit-handlers";
import { asTestUser, ownerId } from "../../../../test-support/users";

const envFile = resolve(process.cwd(), "../../.env");
// Only the test database address: the developer's own feature switches must not leak in.
if (existsSync(envFile)) {
  process.env.TEST_DATABASE_URL ??= parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL;
}
const t0 = Date.parse("2026-10-09T06:00:00Z");
const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "s532-development-place-secret-0123456789abcdef",
  PLANNING_DRAFT_RECEIPT_SECRET:
    "s532-development-receipt-secret-0123456789abcdef",
};
const directory = planningFixturePlaces();
const post = (path: string, body: unknown) =>
  new Request(`http://localhost:3354/api/${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3354",
      host: "localhost:3354",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "S5.3.2 actual preview / confirmation / PostgreSQL",
  () => {
    let admin: JourneyDatabaseClient;
    let client: JourneyDatabaseClient;
    let repository: DrizzleJourneyRepository;
    let journeyId: string;
    let initialReceipt: string;
    let initialCommand: {
      receipt: string;
      title: string;
      acknowledgeUnknowns: boolean;
    };

    const handlers = (now = t0, port = repository, options = environment) =>
      createDayEditHandlers({
        environment: options,
        now: () => now,
        repository: () => port,
      });
    const current = async () => {
      const result = await repository.findCurrentJourney(journeyId);
      if (!result) throw new Error("Missing fixture journey");
      return result;
    };
    const activity = async (role: string) => {
      const stored = await current();
      const details = stored.dayDetails;
      if (details?.schemaVersion !== "stored-day-plan.v1")
        throw new Error("Expected initial version");
      const target = details.planning.draft.activities.find(
        (item) => item.role === role,
      )!;
      return details.activityBindings.find(
        (item) => item.draftActivityId === target.activityId,
      )!.activityId;
    };
    const counts = async () =>
      (
        await client.pool.query(`SELECT
    (SELECT count(*)::int FROM plan_versions) AS versions,
    (SELECT count(*)::int FROM plan_activities) AS activities,
    (SELECT count(*)::int FROM day_plan_details) AS details,
    (SELECT count(*)::int FROM generated_day_edit_confirmations) AS confirmations,
    (SELECT count(*)::int FROM plan_versions WHERE is_current) AS current,
    (SELECT count(*)::int FROM reservations) AS reservations,
    (SELECT current_observation_version FROM journeys LIMIT 1) AS observation
  `)
      ).rows[0];
    async function preview(change: DayEditChange, version = 1) {
      const response = await handlers().preview(
        post(`journeys/${journeyId}/edits/preview`, {
          basePlanVersion: version,
          baseObservationVersion: 0,
          change,
        }),
        journeyId,
      );
      const reply: DayEditPreviewReply = await response.json();
      if (reply.status !== "ready")
        throw new Error(`Preview failed: ${reply.status}`);
      return reply;
    }
    const confirm = (
      receipt: string,
      acknowledgeUnknowns = true,
      now = t0,
      port = repository,
      options = environment,
    ) =>
      handlers(now, port, options).confirm(
        post(`journeys/${journeyId}/edits/confirm`, {
          receipt,
          acknowledgeUnknowns,
        }),
        journeyId,
      );

    beforeAll(async () => {
      const safe = requireSafeTestDatabaseUrl(
        process.env.TEST_DATABASE_URL,
        process.env.DATABASE_URL,
      );
      admin = createJourneyDatabase(safe, { maxConnections: 1 });
      await admin.pool.query(
        "DROP DATABASE IF EXISTS tripquest_s532_dev_test WITH (FORCE)",
      );
      await admin.pool.query("CREATE DATABASE tripquest_s532_dev_test");
      const url = new URL(safe);
      url.pathname = "/tripquest_s532_dev_test";
      client = createJourneyDatabase(
        requireSafeTestDatabaseUrl(url.toString(), process.env.DATABASE_URL),
      );
      await migrateJourneyDatabase(client.database, {
        migrationsFolder: resolve(process.cwd(), "../../packages/db/drizzle"),
      });
      repository = new DrizzleJourneyRepository(client.database, await ownerId(client.pool));
    });
    afterAll(async () => {
      await client?.close();
      await admin?.pool.query(
        "DROP DATABASE IF EXISTS tripquest_s532_dev_test WITH (FORCE)",
      );
      await admin?.close();
    });
    beforeEach(async () => {
      await client.pool.query("TRUNCATE journeys CASCADE");
      const token = (index: number) =>
        issuePlaceToken(
          {
            place: directory[index],
            evidence: planningFixtureEvidence(t0),
          },
          environment.PLANNING_PLACE_TOKEN_SECRET!,
          "fixture",
          t0,
        );
      const generate = createDraftHandler(
        () => createGenerationService({ environment, now: () => t0 }),
        (snapshot, result) =>
          createDraftSaveOffer(snapshot, result, { environment, now: t0 }),
        undefined,
        asTestUser,
      );
      const response = await generate(
        post("planning/draft", {
          schemaVersion: "planning-requirements.v1",
          cityAdcode: "330100",
          timeZone: "Asia/Shanghai",
          travelMode: "walking",
          date: "2026-10-16",
          window: { startsAt: "08:00", endsAt: "15:00" },
          startPlace: token(0),
          endPlace: token(4),
          interests: [],
          pace: "standard",
          visits: [
            { token: token(1), role: "required", stayMinutes: 60 },
            {
              token: token(4),
              role: "fixed",
              startsAt: "12:00",
              endsAt: "13:00",
            },
            { token: token(3), role: "optional", stayMinutes: 30 },
          ],
        }),
      );
      const terminal = dayStreamEventSchema.parse(
        JSON.parse((await response.text()).trim().split("\n").at(-1)!),
      );
      if (
        terminal.type !== "result" ||
        terminal.saveOffer?.status !== "available"
      )
        throw new Error("Actual generation failed");
      initialReceipt = terminal.saveOffer.receipt;
      initialCommand = {
        receipt: initialReceipt,
        title: "有限修改开发自检",
        acknowledgeUnknowns: true,
      };
      const saved = await createConfirmDayHandler({ user: asTestUser,
        environment,
        now: () => t0,
        repository: () => repository,
      })(post("planning/confirm", initialCommand));
      expect(saved.status).toBe(201);
      journeyId = (await saved.json()).journeyId;
    });

    it("previews without writing, commits stay / replace / remove, preserves v1 and root identity, and replays original receipts", async () => {
      const first = await current();
      const rootBefore = (
        await client.pool.query(
          "SELECT creation_run_id, creation_intent_fingerprint FROM journeys",
        )
      ).rows[0];
      const target = await activity("optional");
      const before = await counts();
      const change = await preview({
        kind: "change_stay",
        activityId: target,
        stayMinutes: 45,
      });
      expect(await counts()).toEqual(before);
      expect(change.draft.activities.slice(0, 2)).toEqual(
        first.dayDetails!.schemaVersion === "stored-day-plan.v1"
          ? first.dayDetails!.planning.draft.activities.slice(0, 2)
          : [],
      );
      expect(change.draft.legs).toHaveLength(4);
      expect(change.comparison.activities).toHaveLength(1);
      expect(change.comparison.after.endArrival).toBeGreaterThan(
        change.comparison.before.endArrival,
      );
      expect((await confirm(change.receipt, false)).status).toBe(422);
      expect((await confirm(change.receipt)).status).toBe(201);
      const second = await current();
      expect(second.currentPlan.activities.map((item) => item.id)).toEqual(
        first.currentPlan.activities.map((item) => item.id),
      );
      const replacement = await preview(
        {
          kind: "replace",
          activityId: target,
          externalId: directory[2].ref.externalId,
          stayMinutes: 30,
        },
        2,
      );
      expect((await confirm(replacement.receipt)).status).toBe(201);
      const third = await current();
      expect(third.currentPlan.activities[2].id).not.toBe(target);
      expect(third.currentPlan.activities.slice(0, 2)).toEqual(
        first.currentPlan.activities.slice(0, 2),
      );
      expect(third.reservations).toEqual(first.reservations);
      const removal = await preview(
        { kind: "remove", activityId: third.currentPlan.activities[2].id },
        3,
      );
      expect((await confirm(removal.receipt)).status).toBe(201);
      expect((await current()).currentPlan.activities).toHaveLength(2);
      const history = await getJourney(journeyId, repository, 1);
      expect(history.status === "found" && history.journey.currentVersion).toBe(
        4,
      );
      expect(
        (await repository.findJourneyVersion(journeyId, 1))?.dayDetails,
      ).toEqual(first.dayDetails);
      expect(await repository.findJourneyVersion(journeyId, 999)).toBeNull();
      expect(
        (
          await client.pool.query(
            "SELECT creation_run_id, creation_intent_fingerprint FROM journeys",
          )
        ).rows[0],
      ).toEqual(rootBefore);
      expect(await counts()).toMatchObject({
        versions: 4,
        details: 4,
        confirmations: 3,
        current: 1,
        reservations: 1,
        observation: 0,
      });
      expect(
        await (
          await confirm(
            change.receipt,
            true,
            t0 + EDIT_RECEIPT_TTL + 1,
            repository,
            { ...environment, PLANNING_SAVE_ENABLED: "false" },
          )
        ).json(),
      ).toMatchObject({ status: "already_saved", planVersion: 2 });
      expect((await confirm(change.receipt, false)).status).toBe(409);
      const replay = await createConfirmDayHandler({ user: asTestUser,
        environment,
        now: () => t0 + DRAFT_RECEIPT_TTL + 1,
        repository: () => repository,
      })(post("planning/confirm", initialCommand));
      expect(await replay.json()).toMatchObject({
        status: "already_saved",
        planVersion: 1,
      });
      expect((await current()).currentPlan.version).toBe(4);
    });

    it("rejects protected / duplicate / unchanged edits and returns infeasible without business writes", async () => {
      const before = await counts();
      const target = await activity("optional");
      for (const change of [
        { kind: "remove", activityId: await activity("required") },
        {
          kind: "change_stay",
          activityId: await activity("fixed"),
          stayMinutes: 45,
        },
        { kind: "change_stay", activityId: target, stayMinutes: 30 },
        {
          kind: "replace",
          activityId: target,
          externalId: directory[1].ref.externalId,
          stayMinutes: 30,
        },
      ]) {
        const response = await handlers().preview(
          post("preview", {
            basePlanVersion: 1,
            baseObservationVersion: 0,
            change,
          }),
          journeyId,
        );
        expect(response.status).toBe(422);
      }
      const infeasible = await handlers().preview(
        post("preview", {
          basePlanVersion: 1,
          baseObservationVersion: 0,
          change: { kind: "change_stay", activityId: target, stayMinutes: 240 },
        }),
        journeyId,
      );
      expect(await infeasible.json()).toMatchObject({ status: "not_feasible" });
      expect(await counts()).toEqual(before);
    });

    it("commits one version for simultaneous identical confirmations", async () => {
      const candidate = await preview({
        kind: "change_stay",
        activityId: await activity("optional"),
        stayMinutes: 45,
      });
      const outcomes = await Promise.all([
        confirm(candidate.receipt),
        confirm(candidate.receipt),
      ]);
      expect(outcomes.map((item) => item.status).sort()).toEqual([200, 201]);
      expect(await counts()).toMatchObject({
        versions: 2,
        details: 2,
        confirmations: 1,
        current: 1,
        observation: 0,
      });
    });

    it("allows only one of two edits based on the same version and binds receipt purpose / journey", async () => {
      const target = await activity("optional");
      const left = await preview({
        kind: "change_stay",
        activityId: target,
        stayMinutes: 45,
      });
      const right = await preview({
        kind: "change_stay",
        activityId: target,
        stayMinutes: 60,
      });
      expect(Buffer.byteLength(left.receipt)).toBeLessThan(8192);
      expect(() =>
        verifyEditReceipt(
          initialReceipt,
          environment.PLANNING_DRAFT_RECEIPT_SECRET!,
          t0,
        ),
      ).toThrow();
      const foreign = await handlers().confirm(
        post("confirm", { receipt: left.receipt, acknowledgeUnknowns: true }),
        "00000000-0000-4000-8000-000000000099",
      );
      expect(foreign.status).toBe(403);
      const outcomes = await Promise.all([
        confirm(left.receipt),
        confirm(right.receipt),
      ]);
      expect(outcomes.map((item) => item.status).sort()).toEqual([201, 409]);
      expect(await counts()).toMatchObject({
        versions: 2,
        confirmations: 1,
        current: 1,
      });
    });

    it("rolls back a late transaction failure, then retrieves a committed result after a lost response", async () => {
      const candidate = await preview({
        kind: "change_stay",
        activityId: await activity("optional"),
        stayMinutes: 45,
      });
      const before = await counts();
      await client.pool
        .query(`CREATE FUNCTION s532_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'development rollback probe'; END $$;
      CREATE TRIGGER s532_reject_confirmation BEFORE INSERT ON generated_day_edit_confirmations
      FOR EACH ROW EXECUTE FUNCTION s532_reject_confirmation()`);
      try {
        expect((await confirm(candidate.receipt)).status).toBe(503);
        expect(await counts()).toEqual(before);
        expect((await current()).currentPlan.version).toBe(1);
      } finally {
        await client.pool.query(
          "DROP TRIGGER s532_reject_confirmation ON generated_day_edit_confirmations; DROP FUNCTION s532_reject_confirmation()",
        );
      }
      class LostResponse extends DrizzleJourneyRepository {
        async commitDayEdit(
          command: ConfirmedDayEdit,
        ): Promise<DayEditConfirmReply> {
          await super.commitDayEdit(command);
          throw new Error("development response lost after commit");
        }
      }
      expect(
        (
          await confirm(
            candidate.receipt,
            true,
            t0,
            new LostResponse(client.database, await ownerId(client.pool)),
          )
        ).status,
      ).toBe(503);
      expect((await current()).currentPlan.version).toBe(2);
      expect(await (await confirm(candidate.receipt)).json()).toMatchObject({
        status: "already_saved",
        planVersion: 2,
      });
      expect(await counts()).toMatchObject({
        versions: 2,
        details: 2,
        confirmations: 1,
        current: 1,
      });
    });
  },
);
