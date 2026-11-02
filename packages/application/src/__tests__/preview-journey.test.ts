import { describe, expect, it } from "vitest";
import { previewJourneyAdjustment, type JourneyRepository, type StoredJourney } from "../index";

const ids = {
  journey: "00000000-0000-4000-8000-000000000001",
  morning: "00000000-0000-4000-8000-000000000002",
  afternoon: "00000000-0000-4000-8000-000000000003",
  dinner: "00000000-0000-4000-8000-000000000004",
  morningPlace: "00000000-0000-4000-8000-000000000005",
  afternoonPlace: "00000000-0000-4000-8000-000000000006",
  dinnerPlace: "00000000-0000-4000-8000-000000000007",
  reservation: "00000000-0000-4000-8000-000000000008",
};
const at = (hhmm: string): `${string}+08:00` => `2026-10-15T${hhmm}:00+08:00`;
const stored: StoredJourney = {
  creationKind: "manual",
  currentObservationVersion: 0,
  journeyId: ids.journey, title: "虚构市一日", createdAt: at("08:00"), updatedAt: at("08:00"),
  currentPlan: { journeyId: ids.journey, date: "2026-10-15", timeZone: "Asia/Shanghai", version: 1, activities: [
    { id: ids.morning, placeId: ids.morningPlace, startsAt: at("09:00"), endsAt: at("10:00"), priority: "normal", locked: false },
    { id: ids.afternoon, placeId: ids.afternoonPlace, startsAt: at("15:00"), endsAt: at("16:00"), priority: "normal", locked: false },
    { id: ids.dinner, placeId: ids.dinnerPlace, startsAt: at("18:00"), endsAt: at("19:00"), priority: "high", locked: true, reservationId: ids.reservation },
  ] },
  activitySnapshots: [
    { activityId: ids.morning, position: 0, placeName: "博物馆" },
    { activityId: ids.afternoon, position: 1, placeName: "下午馆" },
    { activityId: ids.dinner, position: 2, placeName: "晚餐" },
  ],
  reservations: [{ placeName: "晚餐", reservation: { id: ids.reservation, placeId: ids.dinnerPlace, startsAt: at("18:00"), endsAt: at("19:00"), confirmation: { status: "confirmed", source: { kind: "user_reported" }, recordedAt: at("08:00") } } }],
};

function fake(value: StoredJourney | null = stored) {
  let reads = 0;
  let writes = 0;
  const repo: JourneyRepository = {
    async findCurrentJourney() { reads++; return value; },
    async createInitialJourney() { writes++; throw new Error("preview wrote to repository"); },
  };
  return { repo, counts: () => ({ reads, writes }) };
}
const command = {
  journeyId: ids.journey, basePlanVersion: 1, observedAt: "14:30", earliestResumeAt: "15:30",
  completedActivityIds: [ids.morning], noCurrentActivity: true, locationAtTarget: true, travelMinutes: 40,
};
const requestId = () => "preview-test-request";

describe("S3.3 read-only preview of current aggregate", () => {
  it("uses a stable fingerprint independent of request IDs and object key order", async () => {
    const first = await previewJourneyAdjustment(command, fake().repo, () => "request-one");
    const reordered = { travelMinutes: 40, locationAtTarget: true, noCurrentActivity: true, completedActivityIds: [ids.morning], earliestResumeAt: "15:30", observedAt: "14:30", basePlanVersion: 1, journeyId: ids.journey };
    const second = await previewJourneyAdjustment(reordered, fake().repo, () => "request-two");
    expect(first.status).toBe("candidate_found");
    expect(second.status).toBe("candidate_found");
    if (first.status !== "candidate_found" || second.status !== "candidate_found") return;
    expect(first.semanticFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.semanticFingerprint).toBe(first.semanticFingerprint);
    expect(first.baseObservationVersion).toBe(0);
    const changedReservation = fake({ ...stored, reservations: [{ ...stored.reservations[0], placeName: "变更后的预约快照" }] });
    const changed = await previewJourneyAdjustment(command, changedReservation.repo, () => "request-three");
    if (changed.status === "candidate_found") expect(changed.semanticFingerprint).not.toBe(first.semanticFingerprint);
    const extraId = "00000000-0000-4000-8000-000000000009";
    const twoEarlier = { ...stored, currentPlan: { ...stored.currentPlan, activities: [stored.currentPlan.activities[0], { id: extraId, placeId: "00000000-0000-4000-8000-000000000010", startsAt: at("11:00"), endsAt: at("12:00"), priority: "normal" as const, locked: false }, ...stored.currentPlan.activities.slice(1)] }, activitySnapshots: [{ activityId: ids.morning, position: 0, placeName: "博物馆" }, { activityId: extraId, position: 1, placeName: "上午第二站" }, { activityId: ids.afternoon, position: 2, placeName: "下午馆" }, { activityId: ids.dinner, position: 3, placeName: "晚餐" }] };
    const forward = await previewJourneyAdjustment({ ...command, completedActivityIds: [ids.morning, extraId] }, fake(twoEarlier).repo, () => "a");
    const reversed = await previewJourneyAdjustment({ ...command, completedActivityIds: [extraId, ids.morning] }, fake(twoEarlier).repo, () => "b");
    expect(forward.status).toBe("candidate_found");
    expect(reversed.status).toBe("candidate_found");
    if (forward.status === "candidate_found" && reversed.status === "candidate_found") expect(reversed.semanticFingerprint).toBe(forward.semanticFingerprint);
  });
  it("shifts the afternoon visit and aligns the ID diff and arrival evidence", async () => {
    const source = fake();
    const outcome = await previewJourneyAdjustment(command, source.repo, requestId);
    expect(outcome.status).toBe("candidate_found");
    if (outcome.status !== "candidate_found") return;
    expect(outcome.strategy).toBe("shift");
    expect(outcome.differences.map((item) => [item.activityId, item.change])).toEqual([[ids.morning, "keep"], [ids.afternoon, "shift"], [ids.dinner, "keep"]]);
    expect(outcome.differences[1].after).toEqual({ startsAt: at("15:30"), endsAt: at("16:30") });
    expect(outcome.transition).toMatchObject({ departsAt: at("16:30"), earliestArrivalAt: at("17:20"), nextStartsAt: at("18:00"), travelMinutes: 40, bufferMinutes: 10 });
    expect(source.counts()).toEqual({ reads: 1, writes: 0 });
    expect(stored.currentPlan.activities[1].startsAt).toBe(at("15:00"));
  });

  it("omits at the exact boundary and fails one minute later", async () => {
    const source = fake();
    const at1710 = await previewJourneyAdjustment({ ...command, earliestResumeAt: "17:10" }, source.repo, requestId);
    expect(at1710.status).toBe("candidate_found");
    if (at1710.status === "candidate_found") {
      expect(at1710.strategy).toBe("omit");
      expect(at1710.differences[1]).toMatchObject({ change: "omit", activityId: ids.afternoon });
      expect(at1710.transition.earliestArrivalAt).toBe(at("18:00"));
    }
    const at1711 = await previewJourneyAdjustment({ ...command, earliestResumeAt: "17:11" }, source.repo, requestId);
    expect(at1711.status).toBe("no_feasible_candidate");
    expect(source.counts()).toEqual({ reads: 2, writes: 0 });
  });

  it("does not invent location, travel or earlier progress", async () => {
    const source = fake();
    const result = await previewJourneyAdjustment({ ...command, completedActivityIds: [], locationAtTarget: false, travelMinutes: null, noCurrentActivity: false }, source.repo, requestId);
    expect(result).toMatchObject({ status: "needs_information", issueCodes: ["prior_progress_unreported", "current_activity_unreported", "unknown_observed_location", "unknown_travel_estimate"] });
    expect(source.counts()).toEqual({ reads: 1, writes: 0 });
  });

  it("uses zero travel when the two stored activities share a place", async () => {
    const samePlace = fake({ ...stored, currentPlan: { ...stored.currentPlan, activities: stored.currentPlan.activities.map((item) => item.id === ids.dinner ? { ...item, placeId: ids.afternoonPlace } : item) }, reservations: stored.reservations.map((item) => ({ ...item, reservation: { ...item.reservation, placeId: ids.afternoonPlace } })) });
    const outcome = await previewJourneyAdjustment({ ...command, travelMinutes: null }, samePlace.repo, requestId);
    expect(outcome.status).toBe("candidate_found");
    if (outcome.status === "candidate_found") expect(outcome).toMatchObject({ travelSource: "same_place", transition: { travelMinutes: 0, bufferMinutes: 0 } });
    expect(samePlace.counts()).toEqual({ reads: 1, writes: 0 });
  });

  it("rejects stale versions, forged IDs, extra fields, and unsupported shapes", async () => {
    const source = fake();
    expect(await previewJourneyAdjustment({ ...command, basePlanVersion: 2 }, source.repo, requestId)).toMatchObject({ status: "stale", currentPlanVersion: 1 });
    expect((await previewJourneyAdjustment({ ...command, completedActivityIds: [ids.dinner] }, source.repo, requestId)).status).toBe("invalid_input");
    expect((await previewJourneyAdjustment({ ...command, placeId: ids.afternoonPlace }, source.repo, requestId)).status).toBe("invalid_input");
    expect((await previewJourneyAdjustment({ ...command, travelMinutes: 0 }, source.repo, requestId)).status).toBe("invalid_input");
    const extra = fake({ ...stored, currentPlan: { ...stored.currentPlan, activities: [...stored.currentPlan.activities, { id: "extra", placeId: "other", startsAt: at("20:00"), endsAt: at("21:00"), priority: "normal", locked: false }] } });
    expect((await previewJourneyAdjustment(command, extra.repo, requestId)).status).toBe("unsupported_scenario");
    expect(source.counts().writes).toBe(0);
  });

  it("returns a safe unavailable result and reports a corrupt repository aggregate", async () => {
    const source = fake({ ...stored, journeyId: "00000000-0000-4000-8000-000000000099" });
    let reports = 0;
    const outcome = await previewJourneyAdjustment(command, source.repo, requestId, () => { reports++; });
    expect(outcome).toEqual({ status: "unavailable" });
    expect(reports).toBe(1);
    expect(source.counts()).toEqual({ reads: 1, writes: 0 });
  });
});
