import type { BaselinePlanningInput, ChinaDateTime } from "@tripquest/domain";
import type { RouteResult } from "@tripquest/providers";
import type { DecisionModel } from "../contracts";
const at = (time: string): ChinaDateTime => `2026-10-15T${time}:00+08:00`;
export function input(): BaselinePlanningInput {
  return {
    plan: {
      journeyId: "fixture", version: 1, date: "2026-10-15", timeZone: "Asia/Shanghai",
      activities: [
        { id: "C", placeId: "P-C", startsAt: at("15:00"), endsAt: at("16:00"), locked: false, priority: "normal" },
        { id: "D", placeId: "P-D", startsAt: at("18:00"), endsAt: at("19:00"), locked: true, priority: "high", reservationId: "R" },
      ],
    },
    state: {
      journeyId: "fixture", version: 1, observedAt: at("14:30"),
      completedActivityIds: [], skippedActivityIds: [], currentActivityId: null,
      location: { kind: "known", placeId: "P-B" },
    },
    request: {
      id: "request", journeyId: "fixture", basePlanVersion: 1, baseStateVersion: 1,
      delay: { observedAt: at("14:30"), earliestResumeAt: at("15:30") },
      scope: { kind: "selected_window", window: { startsAt: at("15:00"), endsAt: at("18:00") } },
    },
    reservations: [{
      id: "R", placeId: "P-D", startsAt: at("18:00"), endsAt: at("19:00"),
      confirmation: { status: "confirmed", recordedAt: at("08:00"), source: { kind: "fixture" } },
    }],
    travelLegs: [], transferBufferMinutes: 10,
  };
}
export function route(seconds = 600): RouteResult {
  return {
    status: "ok",
    routes: [{ mode: "walking", durationSeconds: seconds, distanceMeters: 1000 }],
    evidence: { provider: "fixture", sourceKind: "fixture", retrievedAt: at("14:30"), attribution: "fiction" },
  };
}
export function scripted(actions: readonly unknown[]): DecisionModel {
  let index = 0;
  return {
    mode: "scripted", provider: "test", model: "script",
    async decide() { return { decision: actions[index++], usage: null }; },
  };
}
export const lookup = (from: string, to: string) => ({
  action: "lookup_route", fromPlaceId: from, toPlaceId: to,
});
