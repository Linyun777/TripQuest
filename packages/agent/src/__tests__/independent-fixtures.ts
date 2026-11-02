import type { BaselinePlanningInput, ChinaDateTime, PlannedActivity } from "@tripquest/domain";
import type { RouteResult } from "@tripquest/providers";
import type { DecisionModel } from "../contracts";

/**
 * Independent fixtures for the S4.2 agent tests. They are rebuilt from the
 * design text (E13/E14 numbers and the accepted single-future-activity
 * topology) rather than reusing the developer's `fixtures.ts`, so that a
 * mistake in one shared helper cannot hide on both sides of the comparison.
 */

export const at = (time: string): ChinaDateTime => `2026-10-15T${time}:00+08:00`;

export function activity(
  id: string,
  placeId: string,
  start: string,
  end: string,
  extra: Partial<PlannedActivity> = {},
): PlannedActivity {
  return {
    id,
    placeId,
    startsAt: at(start),
    endsAt: at(end),
    priority: "normal",
    locked: false,
    ...extra,
  };
}

/** Design §6: observation point P-B, only the resume time changes, all edges unknown. */
export function diagnosticInput(resume: string): BaselinePlanningInput {
  return {
    plan: {
      journeyId: "independent",
      version: 1,
      date: "2026-10-15",
      timeZone: "Asia/Shanghai",
      activities: [
        activity("A", "P-A", "09:00", "10:00"),
        activity("B", "P-B", "12:00", "13:00"),
        activity("C", "P-C", "15:00", "16:00"),
        activity("D", "P-D", "18:00", "19:00", {
          priority: "high",
          locked: true,
          reservationId: "R-D",
        }),
      ],
    },
    state: {
      journeyId: "independent",
      version: 1,
      completedActivityIds: ["A", "B"],
      skippedActivityIds: [],
      currentActivityId: null,
      observedAt: at("14:30"),
      location: { kind: "known", placeId: "P-B" },
    },
    request: {
      id: "independent-request",
      journeyId: "independent",
      basePlanVersion: 1,
      baseStateVersion: 1,
      delay: { observedAt: at("14:30"), earliestResumeAt: at(resume) },
      scope: { kind: "selected_window", window: { startsAt: at("15:00"), endsAt: at("18:00") } },
    },
    reservations: [{
      id: "R-D",
      placeId: "P-D",
      startsAt: at("18:00"),
      endsAt: at("19:00"),
      confirmation: { status: "confirmed", recordedAt: at("08:00"), source: { kind: "fixture" } },
    }],
    travelLegs: [],
    transferBufferMinutes: 10,
  };
}

export const evidence = {
  provider: "independent-fixture",
  sourceKind: "fixture" as const,
  retrievedAt: at("14:30"),
  attribution: "TripQuest 独立测试虚构数据",
};

export function walking(seconds: number): RouteResult {
  return {
    status: "ok",
    routes: [{ mode: "walking", durationSeconds: seconds, distanceMeters: 1000 }],
    evidence: { ...evidence },
  };
}

/** Design §6 route durations in seconds, keyed by directed edge. */
export const DIAGNOSTIC_WORLD: Readonly<Record<string, number>> = {
  [JSON.stringify(["P-B", "P-C"])]: 600,
  [JSON.stringify(["P-C", "P-D"])]: 1200,
  [JSON.stringify(["P-B", "P-D"])]: 3000,
};

export const lookup = (from: string, to: string) => ({
  action: "lookup_route",
  fromPlaceId: from,
  toPlaceId: to,
});

export const finish = (reasonCode: "sufficient_information" | "cannot_resolve") => ({
  action: "finish",
  reasonCode,
});

/** Returns the next canned reply; extra calls get `undefined` on purpose. */
export function scriptedModel(actions: readonly unknown[]): DecisionModel {
  let index = 0;
  return {
    mode: "scripted",
    provider: "independent-script",
    model: "independent-script-v1",
    async decide() {
      return { decision: actions[index++], usage: null };
    },
  };
}
