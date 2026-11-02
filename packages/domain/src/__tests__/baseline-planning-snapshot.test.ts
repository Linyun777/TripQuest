import { describe, expect, it } from "vitest";
import {
  generateBaselineCandidate,
  referenceCases,
  validateCandidatePlan,
  type BaselinePlanningInput,
  type BaselinePlanningResult,
  type BaselineStrategy,
  type CandidatePlan,
  type ChinaDateTime,
  type PlannedActivity,
} from "../index";

// Only C1's input is used. The schedule and arrivals below are hand calculated:
// 15:30 + 60 = 16:30; + 40 + 10 = 17:20; 15:40 + 60 = 16:40;
// + 40 + 10 = 17:30. With 45-minute travel, 16:30 + 45 + 10 = 17:25.
function scenario(): BaselinePlanningInput {
  return JSON.parse(JSON.stringify(referenceCases[0].input)) as BaselinePlanningInput;
}

function at(time: string): ChinaDateTime {
  return `2026-10-15T${time}:00+08:00`;
}

function resumeAt(input: BaselinePlanningInput, time: string): BaselinePlanningInput {
  return {
    ...input,
    request: {
      ...input.request,
      delay: { ...input.request.delay, earliestResumeAt: at(time) },
    },
  };
}

function dinnerTravelAt(input: BaselinePlanningInput, minutes: number): BaselinePlanningInput {
  return {
    ...input,
    travelLegs: input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? { ...leg, duration: { ...leg.duration, kind: "known" as const, minutes } }
        : leg,
    ),
  };
}

function candidateFor(result: BaselinePlanningResult, strategy: BaselineStrategy): CandidatePlan {
  const attempt = result.attempts.find((item) => item.strategy === strategy);
  if (attempt?.outcome !== "checked") throw new Error(`${strategy} was not checked`);
  return attempt.candidate;
}

function selected(result: BaselinePlanningResult, strategy: BaselineStrategy): CandidatePlan {
  expect(result.status).toBe("candidate_found");
  if (result.status !== "candidate_found") throw new Error("no selected candidate");
  expect(result.selected.strategy).toBe(strategy);
  expect(result.selected.validation.verdict).toBe("feasible");
  return result.selected.candidate;
}

function activity(candidate: CandidatePlan, id: string): PlannedActivity {
  const found = candidate.activities.find((item) => item.id === id);
  if (!found) throw new Error(`${id} missing`);
  return found;
}

describe("S2.4 baseline output snapshots", () => {
  it("uses the full facts and proposed schedule in a stable opaque candidate identity", () => {
    const input = scenario();
    const before = JSON.stringify(input);
    const first = generateBaselineCandidate(input);
    const repeated = generateBaselineCandidate(input);
    const jsonCopy = generateBaselineCandidate(JSON.parse(before) as BaselinePlanningInput);
    const reordered = generateBaselineCandidate({
      transferBufferMinutes: input.transferBufferMinutes,
      travelLegs: input.travelLegs,
      reservations: input.reservations,
      request: input.request,
      state: input.state,
      plan: input.plan,
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(repeated).toEqual(first);
    expect(jsonCopy).toEqual(first);
    expect(reordered).toEqual(first);

    const baseShift = selected(first, "shift");
    const laterInput = resumeAt(scenario(), "15:40");
    const later = generateBaselineCandidate(laterInput);
    const laterShift = selected(later, "shift");
    expect(activity(baseShift, "A-AFTERNOON")).toMatchObject({ startsAt: at("15:30"), endsAt: at("16:30") });
    expect(activity(laterShift, "A-AFTERNOON")).toMatchObject({ startsAt: at("15:40"), endsAt: at("16:40") });
    expect(baseShift.id).not.toBe(laterShift.id);

    const slowerInput = dinnerTravelAt(scenario(), 45);
    const slower = generateBaselineCandidate(slowerInput);
    const slowerShift = selected(slower, "shift");
    expect(slowerShift.activities).toEqual(baseShift.activities);
    expect(slowerShift.id).not.toBe(baseShift.id);

    for (const [checkedInput, result, arrival] of [
      [input, first, "17:20"],
      [laterInput, later, "17:30"],
      [slowerInput, slower, "17:25"],
    ] as const) {
      const chosen = selected(result, "shift");
      const checked = validateCandidatePlan({ ...checkedInput, candidate: chosen });
      expect(checked.verdict).toBe("feasible");
      expect(checked.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"))
        .toMatchObject({ earliestArrivalAt: at(arrival), nextStartsAt: at("18:00") });
    }

    const ids = first.attempts.filter((item) => item.outcome === "checked").map((item) => item.candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^baseline-v1\/(keep|shift|omit)\/[0-9a-f]{16}$/);
      expect(id).not.toContain(input.request.id);
      expect(id).not.toContain(input.state.location.kind === "known" ? input.state.location.placeId : "P-C");
    }
  });

  it.each([
    ["keep", "14:45", ["keep"]],
    ["shift", "15:30", ["keep", "shift"]],
    ["omit", "17:10", ["keep", "omit"]],
  ] as const)("owns every %s candidate's array and activity objects", (strategy, time, checkedStrategies) => {
    const input = resumeAt(scenario(), time);
    const pristine = JSON.parse(JSON.stringify(input)) as BaselinePlanningInput;
    const result = generateBaselineCandidate(input);
    const chosen = selected(result, strategy);
    const checked = checkedStrategies.map((item) => candidateFor(result, item));

    for (const candidate of checked) {
      expect(candidate.activities).not.toBe(input.plan.activities);
      for (const item of candidate.activities) {
        const original = input.plan.activities.find((source) => source.id === item.id);
        expect(item).not.toBe(original);
      }
    }
    for (let i = 0; i < checked.length; i += 1) {
      for (let j = i + 1; j < checked.length; j += 1) {
        expect(checked[i].activities).not.toBe(checked[j].activities);
        for (const item of checked[i].activities) {
          expect(item).not.toBe(checked[j].activities.find((other) => other.id === item.id));
        }
      }
    }

    const originalInput = JSON.stringify(input);
    for (const candidate of checked) {
      const others = checked.filter((item) => item !== candidate);
      const otherSnapshots = others.map((item) => JSON.stringify(item));
      (activity(candidate, "A-DINNER") as { startsAt: ChinaDateTime }).startsAt = at("19:00");
      (candidate.activities as PlannedActivity[]).push({
        id: "LOCAL-EDIT", placeId: "P-X", startsAt: at("20:00"), endsAt: at("20:15"),
        priority: "low", locked: false,
      });
      expect(JSON.stringify(input)).toBe(originalInput);
      expect(others.map((item) => JSON.stringify(item))).toEqual(otherSnapshots);
    }

    const snapshot = JSON.stringify(result);
    const inputItem = input.plan.activities.find((item) => item.id === "A-DINNER");
    if (!inputItem) throw new Error("fixture has no dinner");
    (inputItem as { startsAt: ChinaDateTime }).startsAt = at("18:30");
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(input.plan.activities).toHaveLength(pristine.plan.activities.length);
    expect(inputItem.startsAt).toBe(at("18:30"));

    const rerun = generateBaselineCandidate(pristine);
    expect(selected(rerun, strategy).id).toBe(chosen.id);
    expect(activity(selected(rerun, strategy), "A-DINNER").startsAt).toBe(at("18:00"));
  });
});
