import { describe, expect, it } from "vitest";

import {
  referenceCases,
  validateCandidatePlan,
  type CandidateValidationInput,
  type PlannedActivity,
  type ReferenceCaseId,
} from "../index";

/**
 * Independent S2.2 tests for edit scope, protected facts and baseline
 * consistency. Expectations come from the S2.2 design sections 3 and 4.
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

function removeActivity(input: MutableInput, activityId: string): void {
  input.candidate.activities = input.candidate.activities.filter(
    (activity) => activity.id !== activityId,
  );
}

function insertActivity(input: MutableInput, afterId: string, activity: PlannedActivity): void {
  const index = input.candidate.activities.findIndex((entry) => entry.id === afterId);
  if (index < 0) throw new Error(`candidate activity ${afterId} is missing`);
  input.candidate.activities = [
    ...input.candidate.activities.slice(0, index + 1),
    activity,
    ...input.candidate.activities.slice(index + 1),
  ];
}

function newActivity(
  id: string,
  startsAt: string,
  endsAt: string,
  overrides: Partial<PlannedActivity> = {},
): PlannedActivity {
  return {
    id,
    placeId: "P-C",
    startsAt,
    endsAt,
    priority: "normal",
    locked: false,
    ...overrides,
  } as PlannedActivity;
}

function resultOf(input: MutableInput) {
  return validateCandidatePlan(input);
}

/**
 * Applies one mutation to a fresh C1 input and asserts the outcome.
 *
 * Cases that share a single branch are grouped into one `it` to keep the suite
 * readable; the label is attached to every assertion so a merged test still
 * reports which case failed.
 */
function expectOutcome(
  label: string,
  mutate: (input: MutableInput) => void,
  expected: {
    verdict?: string;
    notVerdict?: string;
    codes?: string[];
    absentCodes?: string[];
  },
): void {
  const input = mutableFrom("C1");
  mutate(input);
  const result = resultOf(input);
  const codes = result.issues.map((issue) => issue.code);

  if (expected.verdict !== undefined) {
    expect(result.verdict, `${label} → verdict`).toBe(expected.verdict);
  }
  if (expected.notVerdict !== undefined) {
    expect(result.verdict, `${label} → verdict`).not.toBe(expected.notVerdict);
  }
  for (const code of expected.codes ?? []) {
    expect(codes, `${label} → issue codes`).toContain(code);
  }
  for (const code of expected.absentCodes ?? []) {
    expect(codes, `${label} → issue codes`).not.toContain(code);
  }
}

describe("S2.2 scope: selected window", () => {
  it("allows deleting and adding ordinary activities inside the window", () => {
    // C1's window is [15:00, 18:00). Deleting the afternoon leaves a gap the
    // fixed dinner still tolerates.
    const deleted = mutableFrom("C1");
    removeActivity(deleted, "A-AFTERNOON");
    expect(resultOf(deleted).verdict, "delete inside window → verdict").toBe("feasible");

    // Adding a new ordinary activity inside the window is also allowed.
    const added = mutableFrom("C1");
    insertActivity(
      added,
      "A-AFTERNOON",
      newActivity("A-EXTRA", "2026-10-15T16:45:00+08:00", "2026-10-15T17:00:00+08:00"),
    );
    expect(resultOf(added).verdict, "add inside window → verdict").toBe("feasible");
  });

  it("rejects deleting or adding an activity outside the window", () => {
    // The morning activity is outside the window and no longer completed, so
    // removing it is an out-of-scope change rather than a protected fact.
    expectOutcome(
      "delete outside window",
      (input) => {
        input.state.completedActivityIds = [];
        removeActivity(input, "A-MORNING");
      },
      { verdict: "known_violation", codes: ["outside_scope_change"] },
    );

    // Adding a new activity after the window closes is out of scope too.
    expectOutcome(
      "add outside window",
      (input) => {
        insertActivity(
          input,
          "A-DINNER",
          newActivity("A-EXTRA", "2026-10-15T19:30:00+08:00", "2026-10-15T19:45:00+08:00", {
            placeId: "P-D",
          }),
        );
      },
      { verdict: "known_violation", codes: ["outside_scope_change"] },
    );
  });

  it("does not let an outside activity gain edit rights by moving into the window", () => {
    const input = mutableFrom("C1");
    const morning = activityIn(input, "A-MORNING");
    // Move the morning activity into the editable window, keeping the candidate
    // in time order so the input stays structurally valid.
    morning.startsAt = "2026-10-15T16:40:00+08:00";
    morning.endsAt = "2026-10-15T16:50:00+08:00";
    input.candidate.activities = [
      activityIn(input, "A-LUNCH"),
      activityIn(input, "A-AFTERNOON"),
      morning,
      activityIn(input, "A-DINNER"),
    ];

    const result = resultOf(input);

    expect(result.verdict).toBe("known_violation");
    expect(result.issues.map((issue) => issue.code)).toContain("outside_scope_change");
  });

  it("applies the half-open window boundary at both ends", () => {
    // [15:00, 18:00) is half-open: an activity occupying [16:00, 18:00) ends
    // exactly at the boundary and is still inside.
    expectOutcome(
      "ending exactly at the window end",
      (input) => {
        const afternoon = activityIn(input, "A-AFTERNOON");
        afternoon.startsAt = "2026-10-15T16:00:00+08:00";
        afternoon.endsAt = "2026-10-15T18:00:00+08:00";
      },
      { absentCodes: ["outside_scope_change"] },
    );

    // Starting exactly at the boundary is outside.
    expectOutcome(
      "starting exactly at the window end",
      (input) => {
        const afternoon = activityIn(input, "A-AFTERNOON");
        afternoon.startsAt = "2026-10-15T18:00:00+08:00";
        afternoon.endsAt = "2026-10-15T18:30:00+08:00";
        input.candidate.activities = [
          activityIn(input, "A-MORNING"),
          activityIn(input, "A-LUNCH"),
          activityIn(input, "A-DINNER"),
          afternoon,
        ];
      },
      { verdict: "known_violation", codes: ["outside_scope_change"] },
    );
  });

  it("rejects a new activity that claims a protected status", () => {
    expectOutcome(
      "new activity claiming to be locked",
      (input) => {
        insertActivity(
          input,
          "A-AFTERNOON",
          newActivity("A-EXTRA", "2026-10-15T16:45:00+08:00", "2026-10-15T17:00:00+08:00", {
            locked: true,
          }),
        );
      },
      { verdict: "known_violation", codes: ["unauthorized_metadata_change"] },
    );

    expectOutcome(
      "new activity claiming a reservation link",
      (input) => {
        insertActivity(
          input,
          "A-AFTERNOON",
          newActivity("A-EXTRA", "2026-10-15T16:45:00+08:00", "2026-10-15T17:00:00+08:00", {
            reservationId: "R-DINNER",
          }),
        );
      },
      { verdict: "known_violation", codes: ["unauthorized_metadata_change"] },
    );
  });
});

describe("S2.2 scope: rest of day", () => {
  it("treats everything from the given time to midnight as editable", () => {
    // No change at all is feasible under rest_of_day.
    const untouched = mutableFrom("C1");
    untouched.request.scope = { kind: "rest_of_day", from: "2026-10-15T15:00:00+08:00" };
    expect(resultOf(untouched).verdict, "rest_of_day unchanged → verdict").toBe("feasible");

    // A new activity late in the evening is still inside the scope.
    const added = mutableFrom("C1");
    added.request.scope = { kind: "rest_of_day", from: "2026-10-15T15:00:00+08:00" };
    insertActivity(
      added,
      "A-DINNER",
      newActivity("A-EXTRA", "2026-10-15T20:00:00+08:00", "2026-10-15T20:30:00+08:00", {
        placeId: "P-D",
      }),
    );

    const result = resultOf(added);

    expect(result.verdict, "rest_of_day new evening activity → verdict").toBe("feasible");
    expect(
      result.checkedTransitions.map((transition) => transition.toActivityId),
      "rest_of_day new evening activity → evidence",
    ).toContain("A-EXTRA");
  });

  it("still protects activities before the rest-of-day start", () => {
    const input = mutableFrom("C1");
    input.request.scope = { kind: "rest_of_day", from: "2026-10-15T15:00:00+08:00" };
    const lunch = activityIn(input, "A-LUNCH");
    lunch.startsAt = "2026-10-15T15:05:00+08:00";
    lunch.endsAt = "2026-10-15T15:20:00+08:00";

    const result = resultOf(input);

    expect(result.verdict).toBe("known_violation");
    expect(result.issues.map((issue) => issue.code)).toContain("outside_scope_change");
  });
});

describe("S2.2 protection: facts that must not change", () => {
  it("protects completed, skipped, locked and reservation-linked activities", () => {
    // A-MORNING is completed in C1's state snapshot.
    expectOutcome(
      "completed activity moved",
      (input) => {
        activityIn(input, "A-MORNING").startsAt = "2026-10-15T09:30:00+08:00";
        activityIn(input, "A-MORNING").endsAt = "2026-10-15T10:30:00+08:00";
      },
      { codes: ["protected_activity_changed"] },
    );

    // A-AFTERNOON becomes skipped in this snapshot.
    expectOutcome(
      "skipped activity moved",
      (input) => {
        input.state.skippedActivityIds = ["A-AFTERNOON"];
        activityIn(input, "A-AFTERNOON").startsAt = "2026-10-15T16:00:00+08:00";
        activityIn(input, "A-AFTERNOON").endsAt = "2026-10-15T17:00:00+08:00";
      },
      { codes: ["protected_activity_changed"] },
    );

    // A-DINNER is locked.
    expectOutcome(
      "locked activity moved",
      (input) => {
        activityIn(input, "A-DINNER").startsAt = "2026-10-15T18:10:00+08:00";
      },
      { codes: ["protected_activity_changed"] },
    );

    // A-DINNER is also linked to a confirmed reservation.
    expectOutcome(
      "reservation-linked activity moved",
      (input) => {
        activityIn(input, "A-DINNER").placeId = "P-C";
      },
      { codes: ["protected_activity_changed"] },
    );
  });

  it("rejects deleting or re-identifying a protected activity", () => {
    expectOutcome(
      "protected activity deleted",
      (input) => {
        removeActivity(input, "A-DINNER");
      },
      { verdict: "known_violation", codes: ["protected_activity_changed"] },
    );

    expectOutcome(
      "protected activity given a fresh identifier",
      (input) => {
        activityIn(input, "A-MORNING").id = "A-MORNING-COPY";
      },
      { verdict: "known_violation", codes: ["protected_activity_changed"] },
    );
  });
});

describe("S2.2 protection: metadata tampering", () => {
  it("rejects metadata-only edits that do not move the activity", () => {
    expectOutcome(
      "priority changed on an ordinary activity",
      (input) => {
        activityIn(input, "A-AFTERNOON").priority = "high";
      },
      { verdict: "known_violation", codes: ["unauthorized_metadata_change"] },
    );

    expectOutcome(
      "locked activity unlocked in place",
      (input) => {
        activityIn(input, "A-DINNER").locked = false;
      },
      { codes: ["unauthorized_metadata_change"] },
    );

    expectOutcome(
      "reservation link dropped in place",
      (input) => {
        const dinner = activityIn(input, "A-DINNER");
        delete (dinner as { reservationId?: string }).reservationId;
      },
      { codes: ["unauthorized_metadata_change"] },
    );
  });
});

describe("S2.2 protection: candidate overlap and ordering", () => {
  it("applies half-open semantics to candidate overlap", () => {
    // Overlapping the locked dinner is a known conflict.
    expectOutcome(
      "candidate activities overlapping",
      (input) => {
        const afternoon = activityIn(input, "A-AFTERNOON");
        afternoon.startsAt = "2026-10-15T17:30:00+08:00";
        afternoon.endsAt = "2026-10-15T18:30:00+08:00";
      },
      { verdict: "known_violation", codes: ["activity_overlap"] },
    );

    // Touching endpoints do not overlap.
    expectOutcome(
      "candidate activities touching exactly",
      (input) => {
        insertActivity(
          input,
          "A-AFTERNOON",
          newActivity("A-EXTRA", "2026-10-15T16:30:00+08:00", "2026-10-15T17:00:00+08:00"),
        );
      },
      { absentCodes: ["activity_overlap"] },
    );
  });
});

describe("S2.2 protection: versions and journey identity", () => {
  it("rejects a request bound to a different plan version", () => {
    // 2 is a valid positive version but not the supplied plan's version.
    expectOutcome(
      "request bound to plan version 2",
      (input) => {
        input.request.basePlanVersion = 2;
      },
      { codes: ["stale_base"] },
    );
  });

  it("rejects a version that is not a positive integer as malformed input", () => {
    expectOutcome(
      "request base version 0",
      (input) => {
        (input.request as { basePlanVersion: number }).basePlanVersion = 0;
      },
      { verdict: "invalid_input", codes: ["invalid_number"] },
    );
  });

  it("rejects a candidate bound to an older state version", () => {
    expectOutcome(
      "candidate bound to state version 2",
      (input) => {
        input.candidate.baseStateVersion = 2;
      },
      { codes: ["stale_base"] },
    );
  });

  it("rejects a request or candidate for another journey", () => {
    expectOutcome(
      "request for another journey",
      (input) => {
        input.request.journeyId = "J-OTHER";
      },
      { codes: ["journey_mismatch"] },
    );

    expectOutcome(
      "candidate for another journey",
      (input) => {
        input.candidate.journeyId = "J-OTHER";
      },
      { codes: ["journey_mismatch"] },
    );
  });

  it("treats a plan and state from different journeys as an invalid baseline", () => {
    expectOutcome(
      "state journey disagrees with the plan",
      (input) => {
        input.state.journeyId = "J-OTHER";
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });
});

describe("S2.2 protection: reservation facts", () => {
  it("keeps an unconfirmed or absent referenced booking as missing information", () => {
    expectOutcome(
      "referenced booking still pending",
      (input) => {
        input.reservations[0].confirmation.status = "pending";
      },
      { verdict: "insufficient_information", codes: ["reservation_unverified"] },
    );

    expectOutcome(
      "referenced booking of unknown status",
      (input) => {
        input.reservations[0].confirmation.status = "unknown";
      },
      { codes: ["reservation_unverified"] },
    );

    expectOutcome(
      "referenced booking absent from the input",
      (input) => {
        input.reservations = [];
      },
      { verdict: "insufficient_information", codes: ["reservation_unverified"] },
    );
  });

  it("treats a plan that still references a cancelled booking as an invalid baseline", () => {
    expectOutcome(
      "referenced booking cancelled",
      (input) => {
        input.reservations[0].confirmation.status = "cancelled";
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("rejects a booking whose relationship to the plan is inconsistent", () => {
    // A confirmed booking that no plan activity references.
    expectOutcome(
      "confirmed booking with no referencing activity",
      (input) => {
        input.reservations = [
          ...input.reservations,
          {
            id: "R-ORPHAN",
            placeId: "P-A",
            startsAt: "2026-10-15T20:00:00+08:00",
            endsAt: "2026-10-15T21:00:00+08:00",
            confirmation: {
              status: "confirmed",
              source: { kind: "fixture" },
              recordedAt: "2026-10-15T08:00:00+08:00",
            },
          },
        ];
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );

    // A booking whose place disagrees with the activity that references it.
    expectOutcome(
      "booking place disagrees with the referencing activity",
      (input) => {
        input.reservations[0].placeId = "P-A";
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("rejects two activities claiming the same confirmed booking", () => {
    expectOutcome(
      "two activities claiming R-DINNER",
      (input) => {
        (input.plan.activities[1] as { reservationId?: string }).reservationId = "R-DINNER";
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("reports a candidate that moves the booked dinner as a reservation conflict", () => {
    expectOutcome(
      "candidate moves the booked dinner",
      (input) => {
        const dinner = activityIn(input, "A-DINNER");
        dinner.startsAt = "2026-10-15T18:30:00+08:00";
        dinner.endsAt = "2026-10-15T19:30:00+08:00";
      },
      { verdict: "known_violation", codes: ["reservation_conflict"] },
    );
  });

  it("does not turn an unreferenced pending booking into a constraint", () => {
    const input = mutableFrom("C1");
    input.reservations = [
      ...input.reservations,
      {
        id: "R-LOOSE",
        placeId: "P-A",
        startsAt: "2026-10-15T20:00:00+08:00",
        endsAt: "2026-10-15T21:00:00+08:00",
        confirmation: {
          status: "pending",
          source: { kind: "fixture" },
          recordedAt: "2026-10-15T08:00:00+08:00",
        },
      },
    ];

    const result = resultOf(input);

    expect(result.verdict).toBe("feasible");
    expect(result.issues.map((issue) => issue.code)).not.toContain("reservation_unverified");
  });
});

describe("S2.2 protection: duplicate identifiers and baseline contradictions", () => {
  it("rejects duplicate identifiers in the plan, candidate and reservations", () => {
    expectOutcome(
      "duplicate plan activity identifiers",
      (input) => {
        (input.plan.activities[1] as { id: string }).id = input.plan.activities[0].id;
      },
      { verdict: "invalid_input", codes: ["duplicate_id"] },
    );

    expectOutcome(
      "duplicate candidate activity identifiers",
      (input) => {
        (input.candidate.activities[1] as { id: string }).id = input.candidate.activities[0].id;
      },
      { verdict: "invalid_input", codes: ["duplicate_id"] },
    );

    expectOutcome(
      "duplicate reservation identifiers",
      (input) => {
        input.reservations = [...input.reservations, clone(input.reservations[0])];
      },
      { verdict: "invalid_input", codes: ["duplicate_id"] },
    );
  });

  it("rejects a state snapshot that contradicts the plan", () => {
    expectOutcome(
      "completed activity that is not in the plan",
      (input) => {
        input.state.completedActivityIds = [...input.state.completedActivityIds, "A-NOPE"];
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );

    expectOutcome(
      "activity both completed and skipped",
      (input) => {
        input.state.skippedActivityIds = ["A-MORNING"];
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("rejects a parent version that is not older than the plan version", () => {
    expectOutcome(
      "parent version equal to the plan version",
      (input) => {
        (input.plan as { parentVersion?: number }).parentVersion = 1;
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("rejects a plan whose activities overlap", () => {
    expectOutcome(
      "plan activities overlapping",
      (input) => {
        (input.plan.activities[2] as { startsAt: string }).startsAt = "2026-10-15T12:30:00+08:00";
      },
      { verdict: "invalid_input", codes: ["inconsistent_baseline"] },
    );
  });

  it("rejects a version that is not a positive integer", () => {
    expectOutcome(
      "plan version 0",
      (input) => {
        (input.plan as { version: number }).version = 0;
      },
      { verdict: "invalid_input", codes: ["invalid_number"] },
    );
  });
});
