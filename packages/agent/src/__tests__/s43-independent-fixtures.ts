import type { BaselinePlanningInput, ChinaDateTime, PlannedActivity } from "@tripquest/domain";
import type { RouteResult } from "@tripquest/providers";
import { createScriptedModel } from "../scripted";
import type { DecisionContext, DecisionModel } from "../contracts";

/**
 * S4.3 independent fixtures. The numbers come from the S4.3 design §5 table
 * (E13 and E08/C01), not from the evals v3 fixtures, so a mistake in one
 * shared helper cannot hide on both sides of the comparison.
 */

export const at = (time: string): ChinaDateTime => `2026-10-15T${time}:00+08:00`;

function act(
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

/** E13: observation point P-B, resume 15:30, all three directed edges unknown. */
export function e13Input(resume = "15:30"): BaselinePlanningInput {
  return {
    plan: {
      journeyId: "s43-independent",
      version: 1,
      date: "2026-10-15",
      timeZone: "Asia/Shanghai",
      activities: [
        act("A", "P-A", "09:00", "10:00"),
        act("B", "P-B", "12:00", "13:00"),
        act("C", "P-C", "15:00", "16:00"),
        act("D", "P-D", "18:00", "19:00", {
          priority: "high",
          locked: true,
          reservationId: "R-D",
        }),
      ],
    },
    state: {
      journeyId: "s43-independent",
      version: 1,
      completedActivityIds: ["A", "B"],
      skippedActivityIds: [],
      currentActivityId: null,
      observedAt: at("14:30"),
      location: { kind: "known", placeId: "P-B" },
    },
    request: {
      id: "s43-independent-request",
      journeyId: "s43-independent",
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

/** E08 shape: same plan, unknown location, but C->D is already a known 40 minutes. */
export function e08Input(): BaselinePlanningInput {
  const base = e13Input();
  return {
    ...base,
    state: { ...base.state, location: { kind: "unknown", reason: "未报告" } },
    travelLegs: [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known", minutes: 40 } }],
  };
}

export function withUnknownLocation(input: BaselinePlanningInput): BaselinePlanningInput {
  return { ...input, state: { ...input.state, location: { kind: "unknown", reason: "未报告" } } };
}

export const evidence = {
  provider: "s43-independent-fixture",
  sourceKind: "fixture" as const,
  retrievedAt: at("14:30"),
  attribution: "TripQuest S4.3 独立测试虚构数据",
};

function walking(seconds: number, distanceMeters = 1000): RouteResult {
  return {
    status: "ok",
    routes: [{ mode: "walking", durationSeconds: seconds, distanceMeters }],
    evidence: { ...evidence },
  };
}

/** Design §5 world for E13: B->C 600s, C->D 1200s, B->D 3000s. */
export function e13Route(from: string, to: string): RouteResult {
  if (from === "P-B" && to === "P-C") return walking(600);
  if (from === "P-C" && to === "P-D") return walking(1200);
  if (from === "P-B" && to === "P-D") return walking(3000);
  return {
    status: "no_route",
    reason: "no_path",
    evidence: { ...evidence },
  };
}

export const withoutRoute: RouteResult = {
  status: "no_route",
  reason: "no_path",
  evidence: { ...evidence },
};

export const lookup = (from: string, to: string) => ({
  action: "lookup_route",
  fromPlaceId: from,
  toPlaceId: to,
});

/** A model that replays canned actions, then falls back to the scripted policy. */
export function sequenceModel(actions: readonly unknown[]) {
  const contexts: DecisionContext[] = [];
  let index = 0;
  const fallback = createScriptedModel();
  const model: DecisionModel = {
    ...fallback,
    async decide(context, options) {
      contexts.push(structuredClone(context));
      if (index < actions.length) {
        const value = actions[index++];
        if (value instanceof Error) throw value;
        return { decision: structuredClone(value), usage: null };
      }
      return fallback.decide(context, options);
    },
  };
  return { model, contexts };
}

/** Independent implementation of the documented normalization for fingerprints. */
export function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}
