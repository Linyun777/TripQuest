import { describe, expect, it } from "vitest";

import {
  referenceCases,
  validateCandidatePlan,
  type CandidateValidationInput,
  type ReferenceCaseId,
} from "../index";

/**
 * Independent S2.2 contract tests.
 *
 * Written from the S2.2 design only. The developer's own file
 * `candidate-validation.test.ts` covers the reference cases and several
 * boundaries; this file targets purity, exception safety and verdict
 * precedence instead.
 */

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T[K] extends object
      ? DeepMutable<T[K]>
      : T[K];
};

type MutableInput = DeepMutable<CandidateValidationInput>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function caseById(id: ReferenceCaseId) {
  const found = referenceCases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`reference case ${id} is missing`);
  return found;
}

/** Builds a validation input from a reference case without touching the exported fixtures. */
function inputFrom(id: ReferenceCaseId): CandidateValidationInput {
  const example = caseById(id);
  return {
    plan: clone(example.input.plan),
    state: clone(example.input.state),
    request: clone(example.input.request),
    candidate: clone(example.candidate),
    reservations: clone(example.input.reservations),
    travelLegs: clone(example.input.travelLegs),
    transferBufferMinutes: example.input.transferBufferMinutes,
  };
}

function mutableFrom(id: ReferenceCaseId): MutableInput {
  return clone(inputFrom(id)) as unknown as MutableInput;
}

function activityIn(input: MutableInput, activityId: string) {
  const found = input.candidate.activities.find((activity) => activity.id === activityId);
  if (found === undefined) throw new Error(`candidate activity ${activityId} is missing`);
  return found;
}

function makeLegUnknown(input: MutableInput, fromPlaceId: string, toPlaceId: string): void {
  input.travelLegs = input.travelLegs.map((leg) =>
    leg.fromPlaceId === fromPlaceId && leg.toPlaceId === toPlaceId
      ? { ...leg, duration: { kind: "unknown", reason: "not_provided" } }
      : leg,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe("S2.2 validator contract: purity and determinism", () => {
  it("does not mutate the input it is given", () => {
    const input = inputFrom("C1");
    const before = JSON.stringify(input);

    validateCandidatePlan(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  it("still returns the business verdict when the input is deeply frozen", () => {
    // A mutation attempt on a frozen object throws in strict mode, which would
    // surface as invalid_input instead of the business verdict.
    const input = deepFreeze(inputFrom("C1"));

    expect(validateCandidatePlan(input).verdict).toBe("feasible");
  });

  it("is deterministic across repeated calls and structurally equal inputs", () => {
    const repeated = inputFrom("C2");
    expect(
      JSON.stringify(validateCandidatePlan(repeated)),
      "C2 repeated call → identical result",
    ).toBe(JSON.stringify(validateCandidatePlan(repeated)));

    const issueInput = inputFrom("C3");
    const firstCodes = validateCandidatePlan(issueInput).issues.map((issue) => issue.code);
    const secondCodes = validateCandidatePlan(issueInput).issues.map((issue) => issue.code);
    expect(secondCodes, "C3 repeated call → stable issue order").toEqual(firstCodes);
    expect(firstCodes.length, "C3 has reasons to report").toBeGreaterThan(0);

    expect(
      validateCandidatePlan(inputFrom("C1")),
      "two structurally equal inputs → equal results",
    ).toEqual(validateCandidatePlan(inputFrom("C1")));
  });

  it("reports every wall-clock time with the +08:00 offset", () => {
    const result = validateCandidatePlan(inputFrom("C1"));

    for (const transition of result.checkedTransitions) {
      expect(transition.departsAt.endsWith("+08:00")).toBe(true);
      expect(transition.earliestArrivalAt.endsWith("+08:00")).toBe(true);
      expect(transition.nextStartsAt.endsWith("+08:00")).toBe(true);
    }
  });
});

describe("S2.2 validator contract: exception safety", () => {
  it("never throws on hostile, primitive or incomplete input", () => {
    // A throwing getter must not escape as an unhandled exception.
    const hostile = {
      get plan(): never {
        throw new Error("hostile getter");
      },
    } as unknown as CandidateValidationInput;
    expect(() => validateCandidatePlan(hostile), "throwing getter → no throw").not.toThrow();
    expect(validateCandidatePlan(hostile).verdict, "throwing getter → verdict").toBe(
      "invalid_input",
    );

    // Non-objects and empty objects are all malformed, never feasible.
    const hostileValues = [null, undefined, 0, "", "text", true, [], {}, [[]], [1, 2, 3]];
    for (const value of hostileValues) {
      const asInput = value as unknown as CandidateValidationInput;
      expect(() => validateCandidatePlan(asInput), `${String(value)} → no throw`).not.toThrow();

      const result = validateCandidatePlan(asInput);
      expect(result.verdict, `${String(value)} → verdict`).toBe("invalid_input");
      expect(result.issues.length, `${String(value)} → has reasons`).toBeGreaterThan(0);
      expect(
        result.issues.every((issue) => issue.category === "invalid_input"),
        `${String(value)} → only invalid_input reasons`,
      ).toBe(true);
    }

    // Members present but empty: nothing nested to read.
    const partial = {
      plan: {},
      state: {},
      request: {},
      candidate: {},
    } as unknown as CandidateValidationInput;
    expect(() => validateCandidatePlan(partial), "empty members → no throw").not.toThrow();
    expect(validateCandidatePlan(partial).verdict, "empty members → verdict").toBe("invalid_input");
  });

  it("reports a malformed shape with a machine code and a field path", () => {
    const result = validateCandidatePlan({} as unknown as CandidateValidationInput);

    expect(result.verdict).toBe("invalid_input");
    expect(result.issues[0]?.code).toBe("invalid_shape");
    expect(result.issues[0]?.fieldPath).toBeDefined();
  });
});

describe("S2.2 validator contract: verdict precedence", () => {
  it("returns feasible with no issues and with travel evidence for the passing case", () => {
    const result = validateCandidatePlan(inputFrom("C1"));

    expect(result.verdict).toBe("feasible");
    expect(result.issues).toEqual([]);
    expect(result.checkedTransitions.length).toBeGreaterThan(0);
  });

  it("orders the four verdicts by severity", () => {
    // Control: this tampering alone is a known violation, so the case below
    // really exercises precedence rather than a single failing check.
    const control = mutableFrom("C1");
    activityIn(control, "A-DINNER").endsAt = "2026-10-15T19:30:00+08:00";
    expect(validateCandidatePlan(control).verdict, "tampering alone → verdict").toBe(
      "known_violation",
    );

    // invalid_input outranks a known violation present in the same input.
    const bothBad = mutableFrom("C1");
    // The state snapshot and the request now disagree: an inconsistent baseline.
    bothBad.state.observedAt = "2026-10-15T14:31:00+08:00";
    // The locked dinner is also tampered with, so a known violation exists too.
    activityIn(bothBad, "A-DINNER").endsAt = "2026-10-15T19:30:00+08:00";
    const bothBadResult = validateCandidatePlan(bothBad);
    expect(bothBadResult.verdict, "invalid + violation → verdict").toBe("invalid_input");
    expect(bothBadResult.issues.length, "invalid + violation → has reasons").toBeGreaterThan(0);
    expect(
      bothBadResult.issues.every((issue) => issue.category === "invalid_input"),
      "invalid + violation → only invalid_input reasons",
    ).toBe(true);

    // A known violation outranks missing information, and both reasons survive.
    const mixed = mutableFrom("C4");
    makeLegUnknown(mixed, "P-C", "P-D");
    const mixedResult = validateCandidatePlan(mixed);
    const mixedCodes = mixedResult.issues.map((issue) => issue.code);
    expect(mixedResult.verdict, "violation + unknown → verdict").toBe("known_violation");
    expect(mixedCodes, "violation + unknown → violation kept").toContain(
      "protected_activity_changed",
    );
    expect(mixedCodes, "violation + unknown → gap kept").toContain("unknown_travel_duration");

    // Missing information is the verdict only when nothing is known to be violated.
    const unknownOnly = validateCandidatePlan(inputFrom("C5"));
    expect(unknownOnly.verdict, "unknown only → verdict").toBe("insufficient_information");
    expect(
      unknownOnly.issues.some((issue) => issue.category === "known_violation"),
      "unknown only → no violation reported",
    ).toBe(false);
    expect(unknownOnly.issues.map((issue) => issue.code), "unknown only → gap named").toContain(
      "unknown_travel_duration",
    );

    // A stale base is a business conflict, not malformed input.
    const stale = mutableFrom("C1");
    stale.request.basePlanVersion = 99;
    stale.candidate.basePlanVersion = 99;
    const staleResult = validateCandidatePlan(stale);
    expect(staleResult.verdict, "stale base → verdict").toBe("known_violation");
    expect(staleResult.issues.map((issue) => issue.code), "stale base → issue codes").toContain(
      "stale_base",
    );
  });

  it("emits no verified travel evidence when the input is invalid", () => {
    const input = mutableFrom("C1");
    input.transferBufferMinutes = -1;

    const result = validateCandidatePlan(input);

    expect(result.verdict).toBe("invalid_input");
    expect(result.checkedTransitions).toEqual([]);
  });
});

describe("S2.2 validator contract: reference case verdicts", () => {
  it("returns the verdict and the specific conflict the design assigns to C1-C5", () => {
    expect(validateCandidatePlan(inputFrom("C1")).verdict, "C1").toBe("feasible");
    expect(validateCandidatePlan(inputFrom("C2")).verdict, "C2").toBe("known_violation");
    expect(validateCandidatePlan(inputFrom("C3")).verdict, "C3").toBe("known_violation");
    expect(validateCandidatePlan(inputFrom("C4")).verdict, "C4").toBe("known_violation");
    expect(validateCandidatePlan(inputFrom("C5")).verdict, "C5").toBe("insufficient_information");

    // C2 must name the travel conflict rather than fail generically.
    expect(
      validateCandidatePlan(inputFrom("C2")).issues.map((issue) => issue.code),
      "C2 → issue codes",
    ).toContain("travel_conflict");

    // C3 and C4 must name the protected fact that was changed.
    expect(
      validateCandidatePlan(inputFrom("C3")).issues.map((issue) => issue.code),
      "C3 → issue codes",
    ).toContain("protected_activity_changed");
    expect(
      validateCandidatePlan(inputFrom("C4")).issues.map((issue) => issue.code),
      "C4 → issue codes",
    ).toContain("protected_activity_changed");

    // C5 must stay free of any proven dinner arrival.
    expect(
      validateCandidatePlan(inputFrom("C5")).checkedTransitions.some(
        (transition) => transition.toActivityId === "A-DINNER",
      ),
      "C5 → no proven dinner arrival",
    ).toBe(false);
  });
});
