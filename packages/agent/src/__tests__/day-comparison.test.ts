import { describe, expect, it, vi } from "vitest";
import {
  createDayPlanningProblem,
  type DayPlanningProblem,
  type DayPlanningResult,
} from "@tripquest/application/day-planning";
import type { PlanningRequirements } from "@tripquest/application/planning";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import type { MobilityProvider } from "@tripquest/providers";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import type { DayAction, DayPlanningDecisionModel } from "../day-contracts";

/**
 * Design §9 small same-condition record: one fictional catalogue, one tool executor,
 * one scheduler/validator and the same budgets for every path. "Fixed workflow" is the
 * public-input heuristic; "scripted mechanism" is a developer-written action sequence.
 * Neither says anything about real-model quality.
 */
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const selection = (index: number) => ({
  place: places[index],
  evidence: planningFixtureEvidence(now()),
});

function problem(
  visits: PlanningRequirements["visits"],
  interests: PlanningRequirements["interests"],
): DayPlanningProblem {
  return createDayPlanningProblem({
    runId: "comparison-run",
    requirementsFingerprint: "c".repeat(64),
    nowMs: now(),
    requirements: {
      schemaVersion: "planning-requirements.v1",
      cityAdcode: "330100",
      timeZone: "Asia/Shanghai",
      travelMode: "walking",
      date: "2026-10-15",
      window: { startsAt: "10:00", endsAt: "18:00" },
      startPlace: selection(0),
      endPlace: selection(4),
      interests,
      pace: "standard",
      visits,
    },
  });
}

function withoutStartToMuseum(): MobilityProvider {
  const provider = new PlanningFixtureProvider(now);
  const actual = provider.findRoutes.bind(provider);
  vi.spyOn(provider, "findRoutes").mockImplementation(async (request, options) =>
    request.origin.place.externalId === "DEMO-START" &&
    request.destination.place.externalId === "DEMO-MUSEUM-A"
      ? { status: "no_route", reason: "no_path", evidence: planningFixtureEvidence(now()) }
      : actual(request, options),
  );
  return provider;
}

function scripted(sequence: DayAction[]): DayPlanningDecisionModel {
  let index = 0;
  return createDayScriptedModel(() => sequence[index++]);
}

async function run(
  input: DayPlanningProblem,
  model: DayPlanningDecisionModel = createDayScriptedModel(),
  provider: MobilityProvider = new PlanningFixtureProvider(now),
) {
  return createDayPlanningRunner({ provider, model, now }).run(input, {
    signal: new AbortController().signal,
    onProgress: () => {},
  });
}

function summary(result: DayPlanningResult) {
  const outcome = result.status === "completed" ? result.outcome : result.status;
  return {
    outcome,
    verification: result.status === "completed" && result.outcome === "draft"
      ? result.draft.verification
      : null,
    activities: result.status === "completed" && result.outcome === "draft"
      ? result.draft.activities.length
      : 0,
    counts: result.counts,
  };
}

const required = (index: number, stayMinutes: number) => ({
  place: selection(index),
  role: "required" as const,
  stayMinutes,
});
const optional = (index: number) => ({
  place: selection(index),
  role: "optional" as const,
  stayMinutes: 60,
});

describe("S5.2 same-condition comparison record", () => {
  it("records the fixed workflow on the four design scenarios", async () => {
    const empty = await run(problem([], ["culture", "nature", "food"]));
    const fixedFirst = await run(problem([
      required(1, 90),
      { place: selection(2), role: "fixed", startsAt: "10:30", endsAt: "11:00" },
    ], []));
    const routeMissing = await run(
      problem([optional(1), optional(2), optional(3)], []),
      createDayScriptedModel(),
      withoutStartToMuseum(),
    );
    const openingUnknown = await run(problem([required(1, 60)], []));

    expect(summary(empty)).toEqual({
      outcome: "draft",
      verification: "pending",
      activities: 4,
      counts: { model: 4, searches: 2, tries: 1, routes: 5, semanticRepairs: 0 },
    });
    expect(summary(fixedFirst)).toEqual({
      outcome: "draft",
      verification: "pending",
      activities: 2,
      counts: { model: 3, searches: 0, tries: 2, routes: 6, semanticRepairs: 0 },
    });
    // It drops the last soft visit each time, so the blocked first leg is never removed.
    expect(summary(routeMissing)).toEqual({
      outcome: "no_plan",
      verification: null,
      activities: 0,
      counts: { model: 4, searches: 0, tries: 3, routes: 6, semanticRepairs: 0 },
    });
    expect(routeMissing).toMatchObject({ reason: "insufficient_information" });
    expect(summary(openingUnknown)).toMatchObject({ outcome: "draft", verification: "pending" });
    if (openingUnknown.status !== "completed" || openingUnknown.outcome !== "draft") {
      throw new Error("expected a pending draft");
    }
    expect(openingUnknown.draft.checks.map((check) => check.code).sort()).toEqual([
      "day_opening_unknown",
      "day_tickets_unknown",
    ]);
  });

  it("shows the scripted mechanism using route feedback to drop the blocked visit", async () => {
    const result = await run(
      problem([optional(1), optional(2), optional(3)], []),
      scripted([
        { action: "try_itinerary", orderedActivityIds: ["a1", "a2", "a3"] },
        { action: "try_itinerary", orderedActivityIds: ["a2", "a3"] },
        { action: "finish", attemptId: "attempt-2" },
      ]),
      withoutStartToMuseum(),
    );
    // Attempt 2 needs only start→a2; the other two legs are reused from attempt 1.
    expect(summary(result)).toEqual({
      outcome: "draft",
      verification: "pending",
      activities: 2,
      counts: { model: 3, searches: 0, tries: 2, routes: 5, semanticRepairs: 0 },
    });
  });
});
