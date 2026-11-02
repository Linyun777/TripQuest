import { describe, expect, it } from "vitest";

import { confirmJourneyAdjustment } from "../index";
import type { ConfirmedAdjustmentDraft, ConfirmationJourneyRepository, StoredConfirmation, StoredJourney } from "../contracts";
import { evaluateJourneyAdjustment } from "../preview-journey";

// Expectations are hand derived from the S3.4 design contract: the confirmation
// must re-derive everything from the current aggregate, must be idempotent per
// key, must never accept a stale or changed preview, and must not write when it
// refuses. The correct strategy/fingerprint pair is obtained by running the real
// preview evaluator as *setup*; every assertion then tests a differential
// against it, so tampering is always observable.
const IDS = {
  journey: "60000000-0000-4000-8000-000000000001",
  museum: "60000000-0000-4000-8000-000000000002",
  museumPlace: "60000000-0000-4000-8000-000000000003",
  afternoon: "60000000-0000-4000-8000-000000000004",
  afternoonPlace: "60000000-0000-4000-8000-000000000005",
  cafe: "60000000-0000-4000-8000-000000000009",
  cafePlace: "60000000-0000-4000-8000-00000000000a",
  dinner: "60000000-0000-4000-8000-000000000006",
  dinnerPlace: "60000000-0000-4000-8000-000000000007",
  reservation: "60000000-0000-4000-8000-000000000008",
} as const;

const KEY_A = "60000000-0000-4000-8000-0000000000a1";
const DATE = "2026-10-15";
const at = (hhmm: string): `${string}+08:00` => `${DATE}T${hhmm}:00+08:00`;

function storedJourney(observationVersion = 0): StoredJourney {
  return {
    journeyId: IDS.journey,
    currentObservationVersion: observationVersion,
    creationKind: "manual",
    title: "虚构市一日行程",
    createdAt: at("00:05"),
    updatedAt: at("00:05"),
    currentPlan: {
      journeyId: IDS.journey,
      date: DATE,
      timeZone: "Asia/Shanghai",
      version: 1,
      changeReason: "initial_creation",
      activities: [
        { id: IDS.museum, placeId: IDS.museumPlace, startsAt: at("09:00"), endsAt: at("10:00"), priority: "normal", locked: false },
        { id: IDS.cafe, placeId: IDS.cafePlace, startsAt: at("11:00"), endsAt: at("12:00"), priority: "normal", locked: false },
        { id: IDS.afternoon, placeId: IDS.afternoonPlace, startsAt: at("15:00"), endsAt: at("16:00"), priority: "normal", locked: false },
        { id: IDS.dinner, placeId: IDS.dinnerPlace, startsAt: at("18:00"), endsAt: at("19:00"), priority: "high", locked: true, reservationId: IDS.reservation },
      ],
    },
    activitySnapshots: [
      { activityId: IDS.museum, position: 0, placeName: "博物馆" },
      { activityId: IDS.cafe, position: 1, placeName: "咖啡店" },
      { activityId: IDS.afternoon, position: 2, placeName: "下午馆" },
      { activityId: IDS.dinner, position: 3, placeName: "固定晚餐" },
    ],
    reservations: [
      {
        placeName: "固定晚餐",
        reservation: {
          id: IDS.reservation,
          placeId: IDS.dinnerPlace,
          startsAt: at("18:00"),
          endsAt: at("19:00"),
          confirmation: { status: "confirmed", source: { kind: "user_reported" }, recordedAt: at("00:05") },
        },
      },
    ],
  };
}

interface Harness {
  readonly repository: ConfirmationJourneyRepository;
  readonly counts: { commits: number; initialWrites: number };
  readonly drafts: ConfirmedAdjustmentDraft[];
}

function harness(options: {
  stored?: StoredJourney | null | Error;
  prior?: StoredConfirmation | null;
  commitResult?: { status: "committed" | "already_committed"; planVersion: number; observationVersion: number } | { status: "stale" | "preview_changed" | "idempotency_conflict" };
} = {}): Harness {
  const counts = { commits: 0, initialWrites: 0 };
  const drafts: ConfirmedAdjustmentDraft[] = [];
  const stored = options.stored === undefined ? storedJourney() : options.stored;
  return {
    counts,
    drafts,
    repository: {
      async findCurrentJourney() {
        if (stored instanceof Error) throw stored;
        return stored;
      },
      async findConfirmation() {
        return options.prior ?? null;
      },
      async commitConfirmedAdjustment(draft) {
        counts.commits += 1;
        drafts.push(draft);
        return options.commitResult ?? { status: "committed", planVersion: 2, observationVersion: 1 };
      },
      async createInitialJourney() {
        counts.initialWrites += 1;
      },
    },
  };
}

/** Runs the real preview evaluator to obtain the strategy/fingerprint the user saw. */
async function observedPreview(stored: StoredJourney, observedAt: string, earliestResumeAt: string, travelMinutes: number | null, completed: readonly string[] = [IDS.museum, IDS.cafe]) {
  const evaluated = await evaluateJourneyAdjustment(
    { journeyId: IDS.journey, basePlanVersion: 1, observedAt, earliestResumeAt, completedActivityIds: completed, noCurrentActivity: true, locationAtTarget: true, travelMinutes },
    { findCurrentJourney: async () => stored },
    () => "preview-request",
  );
  if (evaluated.outcome.status !== "candidate_found") throw new Error(`fixture is not confirmable: ${evaluated.outcome.status}`);
  return { strategy: evaluated.outcome.strategy, semanticFingerprint: evaluated.outcome.semanticFingerprint };
}

async function confirmCommand(overrides: Record<string, unknown> = {}) {
  const stored = storedJourney();
  const seen = await observedPreview(stored, "14:30", "15:30", 40);
  return {
    stored,
    command: {
      journeyId: IDS.journey,
      basePlanVersion: 1,
      baseObservationVersion: 0,
      observedAt: "14:30",
      earliestResumeAt: "15:30",
      completedActivityIds: [IDS.museum, IDS.cafe],
      noCurrentActivity: true,
      locationAtTarget: true,
      travelMinutes: 40,
      strategy: seen.strategy,
      semanticFingerprint: seen.semanticFingerprint,
      idempotencyKey: KEY_A,
      ...overrides,
    },
  };
}

async function run(input: unknown, h: Harness) {
  return confirmJourneyAdjustment(input, h.repository, { now: () => new Date("2026-10-15T02:00:00.000Z") }, () => "confirm-request");
}

describe("S3.4 confirmation boundaries", () => {
  it("commits a fresh confirmation and hands the current aggregate to the repository", async () => {
    const { command, stored } = await confirmCommand();
    const h = harness({ stored });
    const outcome = await run(command, h);

    expect(outcome, "committed").toEqual({ status: "committed", journeyId: IDS.journey, planVersion: 2, observationVersion: 1 });
    expect(h.counts.commits, "exactly one commit").toBe(1);
    const draft = h.drafts[0];
    expect(draft, "draft captured").toBeDefined();
    expect(draft?.basePlanVersion).toBe(1);
    expect(draft?.baseObservationVersion).toBe(0);
    expect(draft?.strategy, "strategy came from the recomputed preview").toBe("shift");
    expect(draft?.expectedJourney, "server passed the aggregate it verified").toBe(stored);
    expect(draft?.candidateActivities, "a full candidate is submitted, not a diff").toHaveLength(4);
    expect(draft?.candidateActivities.map((item) => item.id)).toEqual([IDS.museum, IDS.cafe, IDS.afternoon, IDS.dinner]);
    expect(draft?.candidateActivities[2], "afternoon shifted").toMatchObject({ startsAt: at("15:30"), endsAt: at("16:30") });
    expect(draft?.confirmedAt, "clock is injected").toBe("2026-10-15T10:00:00+08:00");
  });

  it("returns the original result for an identical retry without writing again", async () => {
    const { command } = await confirmCommand();
    const h = harness({
      prior: { intentFingerprint: "x".repeat(64), resultPlanVersion: 2, resultObservationVersion: 1 },
      commitResult: { status: "already_committed", planVersion: 2, observationVersion: 1 },
    });
    // Make the stored intent match what this command produces by confirming once first.
    const fresh = harness();
    await run(command, fresh);
    const matching = harness({ prior: { intentFingerprint: await intentOf(command, fresh), resultPlanVersion: 2, resultObservationVersion: 1 } });
    const outcome = await run(command, matching);

    expect(outcome, "idempotent retry reports the saved version").toEqual({
      status: "already_committed", journeyId: IDS.journey, planVersion: 2, observationVersion: 1,
    });
    expect(matching.counts.commits, "a retry writes nothing").toBe(0);
    expect(h.counts.commits, "unused harness").toBe(0);
  });

  it("treats a reordered completed list as the same intent but different input as a conflict", async () => {
    const { command } = await confirmCommand();
    const fresh = harness();
    await run(command, fresh);
    const intent = await intentOf(command, fresh);

    // Two early activities listed in the other order are still the same intent.
    const reordered = harness({ prior: { intentFingerprint: intent, resultPlanVersion: 2, resultObservationVersion: 1 } });
    const retry = await run({ ...command, completedActivityIds: [IDS.cafe, IDS.museum] }, reordered);
    expect(retry.status, "reordering the same set is not a new intent").toBe("already_committed");
    expect(reordered.counts.commits, "retry writes nothing").toBe(0);

    // Different facts under the same key -> conflict, and no write.
    const conflicting = harness({ prior: { intentFingerprint: intent, resultPlanVersion: 2, resultObservationVersion: 1 } });
    const conflict = await run({ ...command, earliestResumeAt: "16:00" }, conflicting);
    expect(conflict.status, "same key with different facts conflicts").toBe("idempotency_conflict");
    expect(conflicting.counts.commits, "a conflict writes nothing").toBe(0);
  });

  it("refuses when either base version is no longer current", async () => {
    const { command, stored } = await confirmCommand();

    const planStale = harness({ stored: { ...stored, currentPlan: { ...stored.currentPlan, version: 2 } } });
    expect((await run(command, planStale)).status, "plan version moved").toBe("stale");
    expect(planStale.counts.commits, "stale writes nothing").toBe(0);

    const observationStale = harness({ stored: { ...stored, currentObservationVersion: 3 } });
    expect((await run(command, observationStale)).status, "observation version moved").toBe("stale");
    expect(observationStale.counts.commits, "stale writes nothing").toBe(0);

    const wrongBase = harness({ stored });
    expect((await run({ ...command, baseObservationVersion: 7 }, wrongBase)).status, "client claimed another base").toBe("stale");
    expect(wrongBase.counts.commits).toBe(0);
  });

  it("refuses a preview that no longer matches what the server recomputes", async () => {
    const { command, stored } = await confirmCommand();

    const tamperedFingerprint = harness({ stored });
    const tamper = await run({ ...command, semanticFingerprint: "a".repeat(64) }, tamperedFingerprint);
    expect(tamper.status, "tampered fingerprint").toBe("preview_changed");
    expect(tamperedFingerprint.counts.commits, "tampered fingerprint writes nothing").toBe(0);

    const wrongStrategy = harness({ stored });
    const mismatch = await run({ ...command, strategy: "omit" }, wrongStrategy);
    expect(mismatch.status, "strategy the server did not choose").toBe("preview_changed");
    expect(wrongStrategy.counts.commits).toBe(0);
  });

  it("refuses to confirm anything the preview did not call a candidate", async () => {
    const { command, stored } = await confirmCommand();

    // Missing travel estimate -> the preview is needs_information, never confirmable.
    const noTravel = harness({ stored });
    expect((await run({ ...command, travelMinutes: null }, noTravel)).status, "unknown travel").toBe("not_confirmable");
    expect(noTravel.counts.commits, "nothing written").toBe(0);

    // A different observation time changes the shape of the answer.
    const late = harness({ stored });
    expect((await run({ ...command, observedAt: "10:00", earliestResumeAt: "15:30" }, late)).status, "earlier progress unreported").toBe("not_confirmable");
    expect(late.counts.commits).toBe(0);
  });

  it("rejects malformed, forged and out-of-range confirmation input", async () => {
    const { command } = await confirmCommand();
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["unknown field", { ...command, planVersion: { forged: true } }],
      ["forged plan", { ...command, plan: { version: 2 } }],
      ["forged reservation", { ...command, reservation: { id: IDS.reservation } }],
      ["keep strategy", { ...command, strategy: "keep" }],
      ["short fingerprint", { ...command, semanticFingerprint: "abc" }],
      ["non-hex fingerprint", { ...command, semanticFingerprint: "z".repeat(64) }],
      ["idempotency key not a uuid", { ...command, idempotencyKey: "not-a-uuid" }],
      ["duplicate completed ids", { ...command, completedActivityIds: [IDS.museum, IDS.museum] }],
      ["resume before observation", { ...command, observedAt: "15:00", earliestResumeAt: "14:00" }],
      ["travel below range", { ...command, travelMinutes: 0 }],
      ["travel above range", { ...command, travelMinutes: 241 }],
      ["negative observation version", { ...command, baseObservationVersion: -1 }],
      ["fractional observation version", { ...command, baseObservationVersion: 0.5 }],
      ["zero plan version", { ...command, basePlanVersion: 0 }],
      ["missing field", { journeyId: IDS.journey }],
    ];

    for (const [label, input] of cases) {
      const h = harness();
      const outcome = await run(input, h);
      expect(outcome.status, `${label} rejected`).toBe("invalid_input");
      expect(h.counts.commits, `${label} wrote nothing`).toBe(0);
      expect(h.counts.initialWrites, `${label} used no other write path`).toBe(0);
    }
  });

  it("maps a missing journey and a failing database onto their own statuses", async () => {
    const { command } = await confirmCommand();
    const missing = harness({ stored: null });
    expect((await run(command, missing)).status, "journey missing").toBe("not_found");
    expect(missing.counts.commits).toBe(0);

    const broken = harness({ stored: new Error("connection refused") });
    expect((await run(command, broken)).status, "database unavailable").toBe("temporarily_unavailable");
    expect(broken.counts.commits).toBe(0);
  });

  it("propagates a commit-side stale or conflict without inventing a success", async () => {
    const { command, stored } = await confirmCommand();
    for (const status of ["stale", "preview_changed", "idempotency_conflict"] as const) {
      const h = harness({ stored, commitResult: { status } });
      expect((await run(command, h)).status, `commit-side ${status} is surfaced`).toBe(status);
      expect(h.counts.commits, `${status} attempted exactly one commit`).toBe(1);
    }
  });
});

/** Reads back the intent fingerprint the implementation computed for a command. */
async function intentOf(command: Record<string, unknown>, h: Harness): Promise<string> {
  const draft = h.drafts[0];
  if (draft === undefined) throw new Error("no commit was attempted, so no intent fingerprint is available");
  return draft.intentFingerprint;
}
