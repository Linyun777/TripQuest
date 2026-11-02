import { describe, expect, it } from "vitest";

import {
  previewJourneyAdjustment,
  type PreviewJourneyCommand,
  type StoredJourney,
} from "../index";
import type { JourneyRepository } from "../contracts";

// Expectations are hand derived from the S3.3 design contract: a read-only
// preview over the current aggregate, a server fixed window, a directed travel
// estimate that must never silently become zero, and the exact 18:00 / 18:01
// arrival boundary. Nothing is read back from the implementation.
const IDS = {
  journey: "50000000-0000-4000-8000-000000000001",
  museum: "50000000-0000-4000-8000-000000000002",
  museumPlace: "50000000-0000-4000-8000-000000000003",
  afternoon: "50000000-0000-4000-8000-000000000004",
  afternoonPlace: "50000000-0000-4000-8000-000000000005",
  dinner: "50000000-0000-4000-8000-000000000006",
  dinnerPlace: "50000000-0000-4000-8000-000000000007",
  reservation: "50000000-0000-4000-8000-000000000008",
} as const;

const DATE = "2026-10-15";
const at = (hhmm: string): `${string}+08:00` => `${DATE}T${hhmm}:00+08:00`;

/** The design's recommended three-item journey. */
function storedJourney(overrides: Partial<StoredJourney> = {}): StoredJourney {
  return {
    currentObservationVersion: 0,
    creationKind: "manual",
    journeyId: IDS.journey,
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
        { id: IDS.afternoon, placeId: IDS.afternoonPlace, startsAt: at("15:00"), endsAt: at("16:00"), priority: "normal", locked: false },
        { id: IDS.dinner, placeId: IDS.dinnerPlace, startsAt: at("18:00"), endsAt: at("19:00"), priority: "high", locked: true, reservationId: IDS.reservation },
      ],
    },
    activitySnapshots: [
      { activityId: IDS.museum, position: 0, placeName: "博物馆" },
      { activityId: IDS.afternoon, position: 1, placeName: "下午馆" },
      { activityId: IDS.dinner, position: 2, placeName: "固定晚餐" },
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
    ...overrides,
  };
}

function command(overrides: Partial<PreviewJourneyCommand> = {}): PreviewJourneyCommand {
  return {
    journeyId: IDS.journey,
    basePlanVersion: 1,
    observedAt: "14:30",
    earliestResumeAt: "15:30",
    completedActivityIds: [IDS.museum],
    noCurrentActivity: true,
    locationAtTarget: true,
    travelMinutes: 40,
    ...overrides,
  };
}

interface Harness {
  readonly repository: Pick<JourneyRepository, "findCurrentJourney">;
  readonly counts: { writes: number; integrityReports: number };
}

function harness(stored: StoredJourney | null | Error): Harness {
  const counts = { writes: 0, integrityReports: 0 };
  return {
    counts,
    repository: {
      async findCurrentJourney() {
        if (stored instanceof Error) throw stored;
        return stored;
      },
      // A write method is deliberately present so a leak would be observable.
      async createInitialJourney() {
        counts.writes += 1;
      },
    } as unknown as Pick<JourneyRepository, "findCurrentJourney">,
  };
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `preview-request-${requestCounter}`;
}

async function run(
  input: unknown,
  stored: StoredJourney | null | Error = storedJourney(),
): Promise<{ outcome: Awaited<ReturnType<typeof previewJourneyAdjustment>>; harness: Harness }> {
  const testHarness = harness(stored);
  const outcome = await previewJourneyAdjustment(
    input,
    testHarness.repository,
    nextRequestId,
    () => {
      testHarness.counts.integrityReports += 1;
    },
  );
  return { outcome, harness: testHarness };
}

describe("S3.3 preview boundaries", () => {
  it("shifts the adjustable activity when the earliest resume leaves slack", async () => {
    const { outcome, harness: h } = await run(command({ earliestResumeAt: "15:30" }));

    expect(outcome.status, "candidate found").toBe("candidate_found");
    if (outcome.status !== "candidate_found") return;
    expect(outcome.strategy, "shift").toBe("shift");
    expect(outcome.basePlanVersion).toBe(1);
    expect(outcome.travelSource).toBe("user_estimate");
    expect(outcome.transferBufferMinutes).toBe(10);

    const byId = new Map(outcome.differences.map((item) => [item.activityId, item]));
    expect(byId.get(IDS.museum), "museum kept").toMatchObject({ change: "keep" });
    expect(byId.get(IDS.afternoon), "afternoon shifted to 15:30-16:30").toMatchObject({
      change: "shift",
      before: { startsAt: at("15:00"), endsAt: at("16:00") },
      after: { startsAt: at("15:30"), endsAt: at("16:30") },
    });
    expect(byId.get(IDS.dinner), "reservation untouched").toMatchObject({
      change: "keep",
      kind: "reservation",
      before: { startsAt: at("18:00"), endsAt: at("19:00") },
    });
    expect(outcome.transition, "arrival evidence").toMatchObject({
      travelMinutes: 40,
      bufferMinutes: 10,
      nextStartsAt: at("18:00"),
    });
    expect(h.counts.writes, "no write attempted").toBe(0);
  });

  it("accepts an arrival exactly at the reservation and rejects one minute later", async () => {
    // 17:10 + 40 + 10 = 18:00 exactly, which the fixed reservation start allows.
    const exact = await run(command({ earliestResumeAt: "17:10" }));
    expect(exact.outcome.status, "17:10 arrives exactly on time").toBe("candidate_found");
    if (exact.outcome.status === "candidate_found") {
      expect(exact.outcome.strategy, "omit the adjustable activity").toBe("omit");
      const afternoon = exact.outcome.differences.find((item) => item.activityId === IDS.afternoon);
      expect(afternoon, "afternoon omitted").toMatchObject({ change: "omit" });
      expect(afternoon?.after, "no new window for an omitted item").toBeUndefined();
      expect(exact.outcome.transition, "still lands on 18:00").toMatchObject({ nextStartsAt: at("18:00") });
    }

    // 17:11 + 40 + 10 = 18:01, one minute too late.
    const late = await run(command({ earliestResumeAt: "17:11" }));
    expect(late.outcome.status, "18:01 cannot make it").toBe("no_feasible_candidate");
    if (late.outcome.status === "no_feasible_candidate") {
      expect(late.outcome.issueCodes.length, "a reason is reported").toBeGreaterThan(0);
    }
  });

  it("never turns a missing travel estimate into zero minutes", async () => {
    const unknown = await run(command({ travelMinutes: null }));
    expect(unknown.outcome.status, "information needed, not feasibility").toBe("needs_information");
    if (unknown.outcome.status === "needs_information") {
      expect(unknown.outcome.issueCodes, "travel flagged unknown").toContain("unknown_travel_estimate");
    }

    const known = await run(command({ travelMinutes: 40 }));
    expect(known.outcome.status, "the same input with an estimate proceeds").toBe("candidate_found");
  });

  it("reports each missing declaration separately", async () => {
    const cases: ReadonlyArray<readonly [string, Partial<PreviewJourneyCommand>, string]> = [
      ["earlier progress unreported", { completedActivityIds: [] }, "prior_progress_unreported"],
      ["current activity not denied", { noCurrentActivity: false }, "current_activity_unreported"],
      ["observed location unknown", { locationAtTarget: false }, "unknown_observed_location"],
      ["travel estimate missing", { travelMinutes: null }, "unknown_travel_estimate"],
    ];

    for (const [label, overrides, code] of cases) {
      const { outcome } = await run(command(overrides));
      expect(outcome.status, `${label} needs information`).toBe("needs_information");
      if (outcome.status !== "needs_information") continue;
      expect(outcome.issueCodes, `${label} code`).toContain(code);
    }

    const all = await run(
      command({ completedActivityIds: [], noCurrentActivity: false, locationAtTarget: false, travelMinutes: null }),
    );
    if (all.outcome.status === "needs_information") {
      expect(all.outcome.issueCodes, "all four reported").toEqual(
        expect.arrayContaining([
          "prior_progress_unreported",
          "current_activity_unreported",
          "unknown_observed_location",
          "unknown_travel_estimate",
        ]),
      );
    }
  });

  it("treats a same-place transfer as zero minutes without demanding an estimate", async () => {
    const samePlace = storedJourney({
      currentPlan: {
        ...storedJourney().currentPlan,
        activities: [
          storedJourney().currentPlan.activities[0]!,
          { ...storedJourney().currentPlan.activities[1]!, placeId: IDS.dinnerPlace },
          storedJourney().currentPlan.activities[2]!,
        ],
      },
    });
    const { outcome } = await run(command({ travelMinutes: null }), samePlace);

    expect(outcome.status, "no estimate needed for the same place").toBe("candidate_found");
    if (outcome.status !== "candidate_found") return;
    expect(outcome.travelSource, "same place source").toBe("same_place");
    expect(outcome.transition, "zero travel and zero buffer").toMatchObject({ travelMinutes: 0, bufferMinutes: 0 });
  });

  it("refuses journey shapes the baseline cannot plan", async () => {
    const base = storedJourney();
    const [museum, afternoon, dinner] = base.currentPlan.activities;

    const variants: ReadonlyArray<readonly [string, StoredJourney]> = [
      [
        "an activity straddles the observation time",
        {
          ...base,
          currentPlan: {
            ...base.currentPlan,
            activities: [museum!, { ...afternoon!, startsAt: at("14:00"), endsAt: at("15:00") }, dinner!],
          },
        },
      ],
      [
        "three future activities",
        {
          ...base,
          currentPlan: {
            ...base.currentPlan,
            activities: [
              museum!,
              afternoon!,
              { ...dinner!, id: "50000000-0000-4000-8000-000000000009", placeId: IDS.museumPlace, startsAt: at("16:30"), endsAt: at("17:00"), locked: false, reservationId: undefined, priority: "normal" },
            ],
          },
        },
      ],
      ["the adjustable activity is locked", { ...base, currentPlan: { ...base.currentPlan, activities: [museum!, { ...afternoon!, locked: true }, dinner!] } }],
      ["the adjustable activity carries a reservation", { ...base, currentPlan: { ...base.currentPlan, activities: [museum!, { ...afternoon!, reservationId: IDS.reservation }, dinner!] } }],
      ["the fixed activity is not locked", { ...base, currentPlan: { ...base.currentPlan, activities: [museum!, afternoon!, { ...dinner!, locked: false }] } }],
      ["the fixed activity has no reservation", { ...base, currentPlan: { ...base.currentPlan, activities: [museum!, afternoon!, { ...dinner!, reservationId: undefined }] } }],
      [
        "the adjustable activity overlaps the reservation",
        { ...base, currentPlan: { ...base.currentPlan, activities: [museum!, { ...afternoon!, startsAt: at("15:00"), endsAt: at("18:30") }, dinner!] } },
      ],
      [
        "an unconfirmed reservation",
        {
          ...base,
          reservations: [
            { ...base.reservations[0]!, reservation: { ...base.reservations[0]!.reservation, confirmation: { ...base.reservations[0]!.reservation.confirmation, status: "pending" } } },
          ],
        },
      ],
      ["an unsupported time zone", { ...base, currentPlan: { ...base.currentPlan, timeZone: "UTC" as never } }],
    ];

    for (const [label, stored] of variants) {
      const { outcome } = await run(command(), stored);
      expect(outcome.status, `${label} unsupported`).toBe("unsupported_scenario");
      if (outcome.status === "unsupported_scenario") {
        expect(outcome.issueCodes, `${label} code`).toContain("unsupported_shape");
      }
    }
  });

  it("rejects malformed, forged and out-of-range input on the server", async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["unknown field", { ...command(), plan: { forged: true } }],
      ["forged candidate", { ...command(), candidate: { id: "forged" } }],
      ["forged scope", { ...command(), scope: { kind: "selected_window" } }],
      ["duplicate completed ids", command({ completedActivityIds: [IDS.museum, IDS.museum] })],
      ["a future activity reported complete", command({ completedActivityIds: [IDS.museum, IDS.afternoon] })],
      ["resume before observation", command({ observedAt: "15:00", earliestResumeAt: "14:00" })],
      ["travel below range", command({ travelMinutes: 0 })],
      ["travel above range", command({ travelMinutes: 241 })],
      ["fractional travel", command({ travelMinutes: 40.5 })],
      ["zero base version", command({ basePlanVersion: 0 })],
      ["sloppy time", command({ observedAt: "9:00" })],
      ["impossible minute", command({ earliestResumeAt: "17:60" })],
      ["journey id is not a uuid", command({ journeyId: "not-a-uuid" })],
      ["missing field", { journeyId: IDS.journey, basePlanVersion: 1 }],
    ];

    for (const [label, input] of cases) {
      const { outcome, harness: h } = await run(input);
      expect(outcome.status, `${label} rejected`).toBe("invalid_input");
      expect(h.counts.writes, `${label} wrote nothing`).toBe(0);
    }
  });

  it("reports a stale base version instead of planning on old facts", async () => {
    const { outcome } = await run(command({ basePlanVersion: 2 }));
    expect(outcome.status, "stale").toBe("stale");
    if (outcome.status === "stale") {
      expect(outcome.currentPlanVersion, "current version reported").toBe(1);
    }
  });

  it("separates a missing journey from an unavailable database", async () => {
    await expect(run(command(), null).then((r) => r.outcome.status)).resolves.toBe("not_found");
    await expect(run(command(), new Error("connection refused")).then((r) => r.outcome.status)).resolves.toBe("unavailable");
  });

  it("refuses to plan when the stored aggregate disagrees with the request", async () => {
    const foreign = storedJourney({ journeyId: "50000000-0000-4000-8000-0000000000ff" });
    const { outcome, harness: h } = await run(command(), foreign);
    expect(outcome.status, "integrity failure is not shown as a result").toBe("unavailable");
    expect(h.counts.integrityReports, "integrity failure is reported internally").toBe(1);
  });

  it("refuses to plan when the stored snapshot order is inconsistent", async () => {
    const base = storedJourney();
    const broken = storedJourney({
      activitySnapshots: [
        { ...base.activitySnapshots[0]!, position: 2 },
        base.activitySnapshots[1]!,
        base.activitySnapshots[2]!,
      ],
    });
    const { outcome, harness: h } = await run(command(), broken);
    expect(outcome.status, "unexpected candidate is not displayed as success").toBe("unavailable");
    expect(h.counts.integrityReports).toBe(1);
  });
});
