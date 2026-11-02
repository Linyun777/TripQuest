import { describe, expect, it } from "vitest";

import { referenceCases, type ReferenceCase, type ReferenceCaseId } from "../index";

const EXPECTED_IDS: readonly ReferenceCaseId[] = ["C1", "C2", "C3", "C4", "C5"];

function caseById(id: ReferenceCaseId): ReferenceCase {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`reference case ${id} is missing`);
  return found;
}

describe("S2.1 reference case coverage", () => {
  it("publishes exactly the five designed cases, in order and without duplicates", () => {
    expect(referenceCases.map((entry) => entry.id)).toEqual(EXPECTED_IDS);
    expect(new Set(referenceCases.map((entry) => entry.id)).size).toBe(5);
  });

  it("marks every case and its travel data as hand-authored fiction", () => {
    for (const entry of referenceCases) {
      expect(entry.provenance).toBe("fictional_hand_authored");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.expected.reasoning.length).toBeGreaterThan(0);
      for (const leg of entry.input.travelLegs) {
        if (leg.duration.kind === "known") {
          expect(leg.duration.source).toBe("hand_authored_fixture");
        }
      }
    }
  });

  it("covers the three verdict categories the design asks for", () => {
    const verdicts = referenceCases.map((entry) => entry.expected.kind);

    expect(verdicts.filter((kind) => kind === "feasible")).toHaveLength(1);
    expect(verdicts.filter((kind) => kind === "known_violation")).toHaveLength(3);
    expect(verdicts.filter((kind) => kind === "insufficient_information")).toHaveLength(1);
    expect(caseById("C1").expected.kind).toBe("feasible");
    expect(caseById("C5").expected.kind).toBe("insufficient_information");
  });
});

describe("S2.1 reference case consistency", () => {
  it("shares one baseline across all five cases, so only the intended variable changes", () => {
    const baseline = JSON.stringify({
      plan: referenceCases[0].input.plan,
      reservations: referenceCases[0].input.reservations,
      state: referenceCases[0].input.state,
      request: referenceCases[0].input.request,
      transferBufferMinutes: referenceCases[0].input.transferBufferMinutes,
    });

    for (const entry of referenceCases) {
      const current = JSON.stringify({
        plan: entry.input.plan,
        reservations: entry.input.reservations,
        state: entry.input.state,
        request: entry.input.request,
        transferBufferMinutes: entry.input.transferBufferMinutes,
      });
      expect(current).toBe(baseline);
    }
  });

  it("uses the same fictional scenario baseline the design specifies", () => {
    const { plan, reservations, state, request } = referenceCases[0].input;

    expect(plan.date).toBe("2026-10-15");
    expect(plan.timeZone).toBe("Asia/Shanghai");
    expect(plan.activities.map((activity) => activity.id)).toEqual([
      "A-MORNING",
      "A-LUNCH",
      "A-AFTERNOON",
      "A-DINNER",
    ]);
    expect(plan.activities.map((activity) => [activity.startsAt, activity.endsAt])).toEqual([
      ["2026-10-15T09:00:00+08:00", "2026-10-15T10:00:00+08:00"],
      ["2026-10-15T12:00:00+08:00", "2026-10-15T13:00:00+08:00"],
      ["2026-10-15T15:00:00+08:00", "2026-10-15T16:00:00+08:00"],
      ["2026-10-15T18:00:00+08:00", "2026-10-15T19:00:00+08:00"],
    ]);

    const locked = plan.activities.filter((activity) => activity.locked);
    expect(locked.map((activity) => activity.id)).toEqual(["A-DINNER"]);
    expect(locked[0].reservationId).toBe("R-DINNER");

    expect(reservations.map((reservation) => reservation.id)).toEqual(["R-DINNER"]);
    expect(reservations[0].confirmation.status).toBe("confirmed");

    expect(state.completedActivityIds).toEqual(["A-MORNING", "A-LUNCH"]);
    expect(state.skippedActivityIds).toEqual([]);
    expect(state.currentActivityId).toBeNull();

    expect(request.scope).toEqual({
      kind: "selected_window",
      window: { startsAt: "2026-10-15T15:00:00+08:00", endsAt: "2026-10-15T18:00:00+08:00" },
    });
    expect(request.delay).toEqual({
      observedAt: "2026-10-15T14:30:00+08:00",
      earliestResumeAt: "2026-10-15T15:30:00+08:00",
    });

    for (const entry of referenceCases) {
      expect(entry.input.transferBufferMinutes).toBe(10);
    }
  });

  it("links the locked dinner activity to the reservation fact by id", () => {
    for (const entry of referenceCases) {
      const { plan, reservations } = entry.input;
      const referenced = plan.activities
        .filter((activity) => activity.reservationId !== undefined)
        .map((activity) => activity.reservationId);

      expect(referenced).toEqual(["R-DINNER"]);

      for (const reservationId of referenced) {
        const reservation = reservations.find((candidate) => candidate.id === reservationId);
        expect(reservation).toBeDefined();
      }
    }
  });

  it("keeps a reservation's place in agreement with the activity that references it", () => {
    for (const entry of referenceCases) {
      for (const activity of entry.input.plan.activities) {
        if (activity.reservationId === undefined) continue;
        const reservation = entry.input.reservations.find(
          (candidate) => candidate.id === activity.reservationId,
        );
        expect(reservation?.placeId).toBe(activity.placeId);
      }
    }
  });

  it("starts the reservation fact in agreement with the planned dinner window", () => {
    const { plan, reservations } = referenceCases[0].input;
    const dinner = plan.activities.find((activity) => activity.id === "A-DINNER");
    const reservation = reservations[0];

    expect([dinner?.startsAt, dinner?.endsAt]).toEqual([
      reservation.startsAt,
      reservation.endsAt,
    ]);
  });

  it("keeps the reservation fact unchanged even when a candidate moves the dinner", () => {
    const { reservations } = caseById("C3").input;
    const dinner = caseById("C3").candidate.activities.find(
      (activity) => activity.id === "A-DINNER",
    );

    expect([dinner?.startsAt, dinner?.endsAt]).toEqual([
      "2026-10-15T18:30:00+08:00",
      "2026-10-15T19:30:00+08:00",
    ]);
    expect([reservations[0].startsAt, reservations[0].endsAt]).toEqual([
      "2026-10-15T18:00:00+08:00",
      "2026-10-15T19:00:00+08:00",
    ]);
  });

  it("binds the request and the candidate to the same base versions", () => {
    for (const entry of referenceCases) {
      const { plan, state, request } = entry.input;

      expect(request.basePlanVersion).toBe(plan.version);
      expect(request.baseStateVersion).toBe(state.version);
      expect(entry.candidate.basePlanVersion).toBe(request.basePlanVersion);
      expect(entry.candidate.baseStateVersion).toBe(request.baseStateVersion);
      expect(entry.candidate.journeyId).toBe(plan.journeyId);
      expect(entry.candidate.journeyId).toBe(state.journeyId);
      expect(entry.candidate.journeyId).toBe(request.journeyId);
      expect(entry.candidate.id.length).toBeGreaterThan(0);
      expect(request.id.length).toBeGreaterThan(0);
    }
  });

  it("refers only to activities that exist in the base plan", () => {
    for (const entry of referenceCases) {
      const planIds = new Set(entry.input.plan.activities.map((activity) => activity.id));
      const referenced = [
        ...entry.input.state.completedActivityIds,
        ...entry.input.state.skippedActivityIds,
      ];
      if (entry.input.state.currentActivityId !== null) {
        referenced.push(entry.input.state.currentActivityId);
      }

      expect(referenced.filter((id) => !planIds.has(id))).toEqual([]);
    }
  });

  it("keeps the candidate a complete schedule with the same activities in the same order", () => {
    for (const entry of referenceCases) {
      expect(entry.candidate.activities.map((activity) => activity.id)).toEqual(
        entry.input.plan.activities.map((activity) => activity.id),
      );
      for (const activity of entry.candidate.activities) {
        expect(activity.id.length).toBeGreaterThan(0);
        expect(activity.placeId.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares each travel leg once and never from a place to itself", () => {
    for (const entry of referenceCases) {
      const pairs = entry.input.travelLegs.map((leg) => `${leg.fromPlaceId}->${leg.toPlaceId}`);

      expect(new Set(pairs).size).toBe(pairs.length);
      expect(pairs.filter((pair) => pair.split("->")[0] === pair.split("->")[1])).toEqual([]);
    }
  });

  it("only uses fictional place identifiers", () => {
    for (const entry of referenceCases) {
      const places = [
        ...entry.input.plan.activities.map((activity) => activity.placeId),
        ...entry.input.reservations.map((reservation) => reservation.placeId),
        ...entry.input.travelLegs.flatMap((leg) => [leg.fromPlaceId, leg.toPlaceId]),
      ];

      expect(places.filter((place) => !/^P-[A-Z]$/.test(place))).toEqual([]);
    }
  });
});
