import { scheduleDay, validateDayDraft, type DayRoute } from "@tripquest/domain";
import { describe, expect, it } from "vitest";
import {
  buildDayDraft,
  createDayPlanningProblem,
  type DayPlanningProblem,
} from "../day-planning";
import type { PlanningPlace, PlanningRequirements } from "../planning-requirements";

const nowMs = Date.parse("2026-10-08T09:00:00+08:00");
const retrievedAt = new Date(nowMs - 60_000).toISOString();

function place(externalId: string, name = `虚构 ${externalId}`, longitude = 120.1): PlanningPlace {
  return {
    place: {
      ref: { provider: "synthetic", externalId },
      name,
      cityAdcode: "330100",
      location: { longitude, latitude: 30.2, coordinateSystem: "gcj02" },
    },
    evidence: {
      provider: "synthetic",
      sourceKind: "fixture",
      retrievedAt,
      attribution: "手写虚构",
    },
  };
}

function problem(
  visits: PlanningRequirements["visits"],
  options: Partial<Pick<PlanningRequirements, "pace" | "window">> = {},
): DayPlanningProblem {
  return createDayPlanningProblem({
    runId: "run-1",
    requirementsFingerprint: "f".repeat(64),
    nowMs,
    requirements: {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: "2026-10-15",
      window: options.window ?? { startsAt: "10:00", endsAt: "18:00" },
      startPlace: place("A"),
      endPlace: place("A"),
      interests: ["culture"],
      pace: options.pace ?? "relaxed",
      visits,
    },
  });
}

describe("S5.2 day planning application boundary", () => {
  it("maps requirements to a frozen problem without inventing places, stays or opening facts", () => {
    const mapped = problem([
      { place: place("A"), role: "optional", stayMinutes: 30 },
      { place: place("B"), role: "required", stayMinutes: 75 },
      { place: place("C"), role: "fixed", startsAt: "14:00", endsAt: "15:30" },
    ]);
    expect(mapped.input.places.map((p) => p.placeId)).toEqual(["p1", "p2", "p3"]);
    expect([mapped.input.startPlaceId, mapped.input.endPlaceId]).toEqual(["p1", "p1"]);
    expect(mapped.input.window).toEqual({ startsAt: 600, endsAt: 1080 });
    expect(mapped.input.bufferMinutes).toBe(10);
    expect(mapped.input.activities).toEqual([
      expect.objectContaining({ activityId: "a1", placeId: "p1", role: "optional", stayMinutes: 30 }),
      expect.objectContaining({ activityId: "a2", placeId: "p2", role: "required", stayMinutes: 75 }),
      expect.objectContaining({
        activityId: "a3",
        role: "fixed",
        stayMinutes: 90,
        fixed: { startsAt: 840, endsAt: 930 },
      }),
    ]);
    expect(mapped.input.activities.every((a) =>
      a.staySource === "user" && a.opening.status === "unknown" && a.tickets === "unknown",
    )).toBe(true);
    expect(Object.isFrozen(mapped.input.activities[2].fixed)).toBe(true);
    expect(problem([], { pace: "standard" }).input.bufferMinutes).toBe(5);
    expect(() =>
      problem([{ place: place("A", "改名后的同一编号"), role: "optional", stayMinutes: 30 }]),
    ).toThrow("conflicting_place_snapshot");
  });

  it("builds a draft only from an unrejected check, with same-place, meal and omission notes", () => {
    const mapped = problem(
      [
        { place: place("A"), role: "optional", stayMinutes: 60 },
        { place: place("B", "虚构 B", 120.11), role: "required", stayMinutes: 60 },
        { place: place("D", "虚构 D", 120.12), role: "optional", stayMinutes: 45 },
      ],
      { window: { startsAt: "09:00", endsAt: "17:00" } },
    );
    const known = (from: string, to: string, durationSeconds: number): DayRoute => ({
      fromPlaceId: from,
      toPlaceId: to,
      status: "known",
      durationSeconds,
      distanceMeters: durationSeconds,
      provider: "synthetic",
      sourceKind: "fixture",
      retrievedAt,
    });
    const routes: DayRoute[] = [
      { fromPlaceId: "p1", toPlaceId: "p1", status: "same_place_assumption" },
      known("p1", "p2", 600),
      known("p2", "p1", 660),
    ];
    const scheduled = scheduleDay(mapped.input, ["a1", "a2"], routes);
    if (scheduled.status !== "scheduled") throw new Error(JSON.stringify(scheduled));
    const validation = validateDayDraft(mapped.input, scheduled.schedule, routes);
    const draft = buildDayDraft({
      problem: mapped,
      places: mapped.places,
      activities: mapped.activities,
      schedule: scheduled.schedule,
      validation,
      routeEvidence: new Map([[JSON.stringify(["p1", "p2"]), place("B").evidence]]),
      createdAt: new Date(nowMs).toISOString(),
    });

    // 09:00 same place, 60 min; +10 walk +10 buffer; 60 min; +11 walk +10 buffer.
    expect(draft.activities.map((a) => [a.startsAt, a.endsAt])).toEqual([[540, 600], [620, 680]]);
    expect(draft.endArrival).toBe(701);
    expect(draft.verification).toBe("pending");
    expect(draft.legs[0]).toMatchObject({ source: "same_place_assumption", travelMinutes: 0, bufferMinutes: 0 });
    expect(draft.legs[1].evidence?.provider).toBe("synthetic");
    expect(draft.omittedOptional.map((item) => [item.activityId, item.name])).toEqual([["a3", "虚构 D"]]);
    expect(draft.assumptions).toEqual(expect.arrayContaining([
      expect.stringContaining("10 分钟缓冲"),
      expect.stringContaining("同一地点"),
      "餐饮/休息未单独安排。",
    ]));
    expect(() =>
      buildDayDraft({
        problem: mapped,
        places: mapped.places,
        activities: mapped.activities,
        schedule: scheduled.schedule,
        validation: { verdict: "rejected", issues: [] },
        routeEvidence: new Map(),
        createdAt: new Date(nowMs).toISOString(),
      }),
    ).toThrow("unverified_draft");
  });
});
