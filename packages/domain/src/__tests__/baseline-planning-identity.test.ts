import { describe, expect, it } from "vitest";
import {
  generateBaselineCandidate,
  referenceCases,
  validateCandidatePlan,
  type BaselineAttempt,
  type BaselinePlanningInput,
  type BaselinePlanningResult,
  type BaselineStrategy,
  type CandidatePlan,
  type CandidateValidationResult,
  type ChinaDateTime,
  type PlannedActivity,
} from "../index";

// Expectations here are hand derived from the S2.4 design contract (candidate
// identity covers the whole input snapshot; each checked candidate owns its own
// activity objects) plus the accepted S2.2/S2.3 semantics. Nothing is read back
// from the generator's output, and C1's candidate/expected are never used.
function scenario(): BaselinePlanningInput {
  return JSON.parse(JSON.stringify(referenceCases[0].input)) as BaselinePlanningInput;
}

function at(time: string): ChinaDateTime {
  return `2026-10-15T${time}:00+08:00`;
}

function resumeAt(input: BaselinePlanningInput, time: string): BaselinePlanningInput {
  return {
    ...input,
    request: { ...input.request, delay: { ...input.request.delay, earliestResumeAt: at(time) } },
  };
}

function withBuffer(input: BaselinePlanningInput, minutes: number): BaselinePlanningInput {
  return { ...input, transferBufferMinutes: minutes };
}

function unknownDinnerTravel(input: BaselinePlanningInput): BaselinePlanningInput {
  return {
    ...input,
    travelLegs: input.travelLegs.map((leg) =>
      leg.fromPlaceId === "P-C" && leg.toPlaceId === "P-D"
        ? { fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId, duration: { kind: "unknown" as const, reason: "not_provided" } }
        : leg,
    ),
  };
}

function withReservationNote(input: BaselinePlanningInput, note: string): BaselinePlanningInput {
  return {
    ...input,
    reservations: input.reservations.map((reservation) => ({
      ...reservation,
      confirmation: {
        ...reservation.confirmation,
        source: { ...reservation.confirmation.source, reference: note },
      },
    })),
  };
}

function withObservationAt(input: BaselinePlanningInput, time: string): BaselinePlanningInput {
  return {
    ...input,
    state: { ...input.state, observedAt: at(time) },
    request: { ...input.request, delay: { ...input.request.delay, observedAt: at(time) } },
  };
}

/** Rebuilds every object with its keys in reverse order, keeping the same JSON value. */
function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, item]) => [key, reorderKeysDeep(item)]),
    );
  }
  return value;
}

function checkedAttempt(result: BaselinePlanningResult, strategy: BaselineStrategy) {
  const attempt = result.attempts.find(
    (item): item is Extract<BaselineAttempt, { outcome: "checked" }> =>
      item.strategy === strategy && item.outcome === "checked",
  );
  if (attempt === undefined) throw new Error(`${strategy} was not checked`);
  return attempt;
}

function checkedIds(result: BaselinePlanningResult): string[] {
  return result.attempts
    .filter((item) => item.outcome === "checked")
    .map((item) => item.candidate.id);
}

function selectedOf(result: BaselinePlanningResult): {
  strategy: BaselineStrategy;
  candidate: CandidatePlan;
  validation: CandidateValidationResult;
} {
  expect(result.status).toBe("candidate_found");
  if (result.status !== "candidate_found") throw new Error("no selected candidate");
  return result.selected;
}

function candidateActivity(candidate: CandidatePlan, id: string): PlannedActivity {
  const found = candidate.activities.find((item) => item.id === id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
}

function dinnerArrival(result: BaselinePlanningResult): ChinaDateTime {
  const { validation } = selectedOf(result);
  const transition = validation.checkedTransitions.find((item) => item.toActivityId === "A-DINNER");
  if (transition === undefined) throw new Error("no dinner transition");
  return transition.earliestArrivalAt;
}

function strategyOrder(result: BaselinePlanningResult): string[] {
  return result.attempts.map((item) => item.strategy);
}

/** Fails the current test if the generator throws instead of returning a result. */
function callWithoutThrowing(value: unknown, label: string): BaselinePlanningResult {
  let captured: BaselinePlanningResult | undefined;
  let thrown: unknown;
  try {
    captured = generateBaselineCandidate(value as BaselinePlanningInput);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${label} does not throw`).toBeUndefined();
  if (captured === undefined) throw new Error(`${label} produced no result`);
  return captured;
}

describe("S2.4 candidate identity and output ownership", () => {
  it("changes the id when the snapshot changes even though the schedule and evidence do not", () => {
    const base = scenario();
    const baseResult = generateBaselineCandidate(base);
    const baseSelection = selectedOf(baseResult);

    expect(baseSelection.strategy, "base strategy").toBe("shift");
    expect(candidateActivity(baseSelection.candidate, "A-AFTERNOON"), "base schedule").toMatchObject({
      startsAt: at("15:30"),
      endsAt: at("16:30"),
    });
    expect(dinnerArrival(baseResult), "base arrival").toBe(at("17:20"));

    const variants: ReadonlyArray<readonly [string, BaselinePlanningInput, string]> = [
      ["buffer 10 to 11", withBuffer(base, 11), "17:21"],
      ["reservation note changed", withReservationNote(base, "a different fictional note"), "17:20"],
      ["plan gains a change reason", { ...base, plan: { ...base.plan, changeReason: "resume delayed" } }, "17:20"],
      ["observation time 14:30 to 14:25", withObservationAt(base, "14:25"), "17:20"],
      // Reordering completed ids is semantically identical (the checks use sets),
      // so the schedule and evidence are unchanged while the snapshot is not.
      ["completed ids reordered", { ...base, state: { ...base.state, completedActivityIds: [...base.state.completedActivityIds].reverse() } }, "17:20"],
    ];

    for (const [label, input, arrival] of variants) {
      const result = generateBaselineCandidate(input);
      const selection = selectedOf(result);

      expect(selection.strategy, `${label} strategy`).toBe("shift");
      expect(selection.candidate.activities, `${label} keeps the same schedule`).toEqual(
        baseSelection.candidate.activities,
      );
      expect(dinnerArrival(result), `${label} arrival`).toBe(at(arrival));
      expect(selection.candidate.id, `${label} id`).not.toBe(baseSelection.candidate.id);
    }
  });

  it("derives the same ids from a JSON equivalent copy whose nested key order is reversed", () => {
    const input = scenario();
    const reversed = reorderKeysDeep(input) as BaselinePlanningInput;
    const original = generateBaselineCandidate(input);
    const reordered = generateBaselineCandidate(reversed);

    expect(JSON.stringify(reversed), "the copy really is in a different key order").not.toBe(
      JSON.stringify(input),
    );
    expect(checkedIds(original).length, "there is something to compare").toBeGreaterThan(0);
    expect(checkedIds(reordered), "ids survive a nested key reorder").toEqual(checkedIds(original));
    expect(reordered, "the whole result survives a nested key reorder").toEqual(original);
  });

  it("keeps journey, place, activity and reservation identifiers out of the visible id", () => {
    const input = scenario();
    const result = generateBaselineCandidate(input);
    const forbidden = [
      input.plan.journeyId,
      input.request.id,
      input.state.location.kind === "known" ? input.state.location.placeId : "",
      ...input.plan.activities.flatMap((activity) => [activity.id, activity.placeId]),
      ...input.reservations.flatMap((reservation) => [reservation.id, reservation.placeId]),
    ].filter((token) => token.length > 0);

    const ids = checkedIds(result);
    expect(ids.length, "checked candidates").toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, "documented format").toMatch(/^baseline-v1\/(keep|shift|omit)\/[0-9a-f]{16}$/);
      for (const token of forbidden) {
        expect(id.includes(token), `${id} must not expose ${token}`).toBe(false);
      }
    }
  });

  it("keeps all three checked candidates independent of each other and of the input", () => {
    const input = unknownDinnerTravel(scenario());
    const pristine = JSON.parse(JSON.stringify(input)) as BaselinePlanningInput;
    const result = generateBaselineCandidate(input);

    expect(result.status, "status").toBe("needs_information");
    expect(strategyOrder(result), "attempt order").toEqual(["keep", "shift", "omit"]);

    const strategies: BaselineStrategy[] = ["keep", "shift", "omit"];
    const candidates = strategies.map((strategy) => checkedAttempt(result, strategy).candidate);

    for (let i = 0; i < candidates.length; i += 1) {
      expect(candidates[i].activities, `candidate ${i} owns its array`).not.toBe(input.plan.activities);
      for (const activity of candidates[i].activities) {
        const original = input.plan.activities.find((source) => source.id === activity.id);
        expect(activity, `candidate ${i} owns ${activity.id}`).not.toBe(original);
      }
    }
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        expect(candidates[i].activities, `${strategies[i]} vs ${strategies[j]} array`).not.toBe(
          candidates[j].activities,
        );
        for (const activity of candidates[i].activities) {
          expect(
            activity,
            `${strategies[i]} vs ${strategies[j]} object ${activity.id}`,
          ).not.toBe(candidates[j].activities.find((other) => other.id === activity.id));
        }
      }
    }

    // Editing the middle candidate must not reach the input or its siblings.
    const inputSnapshot = JSON.stringify(input);
    const siblingSnapshots = [candidates[0], candidates[2]].map((item) => JSON.stringify(item));
    (candidateActivity(candidates[1], "A-DINNER") as { startsAt: ChinaDateTime }).startsAt = at("20:00");
    (candidates[1].activities as PlannedActivity[]).push({
      id: "LOCAL-EDIT",
      placeId: "P-X",
      startsAt: at("21:00"),
      endsAt: at("21:15"),
      priority: "low",
      locked: false,
    });
    expect(JSON.stringify(input), "input untouched").toBe(inputSnapshot);
    expect([candidates[0], candidates[2]].map((item) => JSON.stringify(item)), "siblings untouched").toEqual(
      siblingSnapshots,
    );

    const rerun = generateBaselineCandidate(pristine);
    expect(checkedIds(rerun), "ids reproduced from the pristine input").toEqual(checkedIds(result));
    expect(candidateActivity(checkedAttempt(rerun, "keep").candidate, "A-DINNER").startsAt, "dinner intact").toBe(
      at("18:00"),
    );
  });

  it("lets the selected candidate be the very object of its checked attempt", () => {
    const cases: ReadonlyArray<readonly [string, BaselinePlanningInput, BaselineStrategy]> = [
      ["keep", resumeAt(scenario(), "14:45"), "keep"],
      ["shift", scenario(), "shift"],
      ["omit", resumeAt(scenario(), "17:10"), "omit"],
    ];

    for (const [label, input, strategy] of cases) {
      const result = generateBaselineCandidate(input);
      const selection = selectedOf(result);
      const attempt = checkedAttempt(result, strategy);

      expect(selection.strategy, `${label} strategy`).toBe(strategy);
      expect(selection.candidate, `${label} candidate identity`).toBe(attempt.candidate);
      expect(selection.validation, `${label} validation value`).toEqual(attempt.validation);
    }
  });

  it("distinguishes an unreadable request from a present but invalid request id", () => {
    const base = scenario();
    const unreadable: ReadonlyArray<readonly [string, unknown]> = [
      ["request removed", { ...base, request: undefined } as unknown],
      ["request null", { ...base, request: null } as unknown],
      ["request empty object", { ...base, request: {} } as unknown],
    ];

    for (const [label, value] of unreadable) {
      const result = callWithoutThrowing(value, label);
      expect(result.status, `${label} status`).toBe("invalid_input");
      expect(strategyOrder(result), `${label} records no attempt`).toEqual([]);
      expect(result.issues.length > 0, `${label} keeps the evidence`).toBe(true);
    }

    const blank = callWithoutThrowing({ ...base, request: { id: "" } }, "blank request id");
    expect(blank.status, "blank status").toBe("invalid_input");
    expect(strategyOrder(blank), "blank is readable enough for keep").toEqual(["keep"]);
    expect(
      blank.issues.some((issue) => issue.code === "invalid_shape" && issue.fieldPath === "request.id"),
      "blank names the field",
    ).toBe(true);
  });

  it("re-validates the selected keep and omit candidates through the public validator", () => {
    const keepInput = resumeAt(scenario(), "14:45");
    const keepSelection = selectedOf(generateBaselineCandidate(keepInput));
    expect(keepSelection.strategy, "keep strategy").toBe("keep");
    const keepChecked = validateCandidatePlan({ ...keepInput, candidate: keepSelection.candidate });
    expect(keepChecked.verdict, "keep re-validated").toBe("feasible");
    expect(
      keepChecked.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"),
      "keep dinner 16:00 + 40 + 10 = 16:50",
    ).toMatchObject({
      departsAt: at("16:00"),
      travelMinutes: 40,
      bufferMinutes: 10,
      earliestArrivalAt: at("16:50"),
    });

    const omitInput = resumeAt(scenario(), "17:10");
    const omitSelection = selectedOf(generateBaselineCandidate(omitInput));
    expect(omitSelection.strategy, "omit strategy").toBe("omit");
    expect(
      omitSelection.candidate.activities.map((item) => item.id),
      "afternoon removed",
    ).toEqual(["A-MORNING", "A-LUNCH", "A-DINNER"]);
    const omitChecked = validateCandidatePlan({ ...omitInput, candidate: omitSelection.candidate });
    expect(omitChecked.verdict, "omit re-validated").toBe("feasible");
    expect(
      omitChecked.checkedTransitions.find((item) => item.toActivityId === "A-DINNER"),
      "omit dinner 17:10 + 40 + 10 = 18:00 exactly",
    ).toMatchObject({
      departsAt: at("17:10"),
      travelMinutes: 40,
      bufferMinutes: 10,
      earliestArrivalAt: at("18:00"),
      nextStartsAt: at("18:00"),
    });
  });
});
