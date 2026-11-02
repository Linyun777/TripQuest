import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import type { BaselinePlanningInput } from "@tripquest/domain";
import { createInvestigation, createScriptedModel } from "../index";
import {
  canonicalJson,
  e08Input,
  e13Input,
  e13Route,
  withUnknownLocation,
} from "./s43-independent-fixtures";

/**
 * S4.3 independent tests for the caller-owned location clarification. The
 * arithmetic and the new-snapshot shape come from the S4.3 design §4/§5; the
 * fingerprint is recomputed here with a separate implementation.
 */

const plan = generateBaselineCandidate;
const catalog = [
  { id: "P-B", name: "可信地点 B" },
  { id: "P-C", name: "可信地点 C" },
  { id: "P-C", name: "重复条目 C" },
  { id: "P-D", name: "可信地点 D" },
];
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Hand arithmetic: departure at the end of the previous activity plus travel and buffer. */
const arrival = (endsAt: string, legMinutes: number, buffer: number) =>
  Date.parse(endsAt) + (legMinutes + buffer) * 60_000;

function sessionFor(input: BaselinePlanningInput, model = createScriptedModel()) {
  const route = vi.fn(async (from: string, to: string) => e13Route(from, to));
  const session = createInvestigation(input, {
    places: catalog,
    model,
    lookupRoute: route,
    plan,
    decisionPolicy: "feedback_once",
  });
  return { session, route };
}

describe("caller-owned location clarification", () => {
  it("offers only plan places that exist in the trusted catalog, and asks once", async () => {
    const input = withUnknownLocation(e13Input());
    const { session, route } = sessionFor(input);
    const snapshot = await session.start();

    expect(snapshot.status).toBe("awaiting_user");
    expect(snapshot.output, "waiting runs no agent").toBeNull();
    expect(snapshot.planningCalls, "only the pre-question domain probe ran").toBe(1);
    expect(route).not.toHaveBeenCalled();
    const question = snapshot.question!;
    expect(question.field).toBe("current_location");
    expect(question.planVersion).toBe(input.plan.version);
    expect(question.stateVersion).toBe(input.state.version);
    expect(question.sessionId).toBe(snapshot.sessionId);
    expect(new Set([question.sessionId, question.questionId]).size, "opaque ids differ").toBe(2);
    expect(question.snapshotFingerprint, "fingerprint recomputed independently").toBe(hash(input));
    expect(
      question.options.map((option) => option.id),
      "trusted catalog ∩ plan references, deduped, with an explicit cannot_answer",
    ).toEqual(["P-B", "P-C", "P-D", "cannot_answer"]);
    expect(question.options.find((option) => option.id === "P-C")?.name, "first trusted name wins").toBe(
      "可信地点 C",
    );
    expect(
      question.options.some((option) => option.id === "P-A"),
      "a plan place missing from the trusted catalog is not offered",
    ).toBe(false);

    await expect(session.start(), "a session asks at most once").rejects.toThrow("session_consumed");
    await expect(
      session.answer({
        questionId: question.questionId,
        snapshotFingerprint: question.snapshotFingerprint,
        choice: "P-A",
      }, input),
      "an unoffered place id is rejected even though the plan references it",
    ).rejects.toThrow("invalid_answer");

    const known = sessionFor(e13Input());
    const knownSnapshot = await known.session.start();
    expect(knownSnapshot.question, "a known location is never asked about").toBeNull();
    expect(knownSnapshot.status).toBe("finished");
  });

  it("changes only the observation version, the location and the request identity", async () => {
    const input = withUnknownLocation(e13Input());
    const original = structuredClone(input);
    const { session } = sessionFor(input);
    await session.start();
    const question = session.snapshot().question!;
    const result = await session.answer({
      questionId: question.questionId,
      snapshotFingerprint: question.snapshotFingerprint,
      choice: "P-B",
    }, input);

    const followup = result.followup!;
    expect(result.status).toBe("finished");
    expect(result.initialFingerprint).toBe(hash(input));
    expect(result.followupFingerprint, "the new snapshot has its own summary").toBe(hash(followup));
    expect(result.followupFingerprint).not.toBe(result.initialFingerprint);
    const expected: BaselinePlanningInput = {
      ...structuredClone(input),
      state: {
        ...structuredClone(input.state),
        version: input.state.version + 1,
        location: { kind: "known", placeId: "P-B" },
      },
      request: {
        ...structuredClone(input.request),
        id: followup.request.id,
        baseStateVersion: input.state.version + 1,
      },
    };
    expect(canonicalJson(followup), "nothing outside the documented fields may change").toBe(
      canonicalJson(expected),
    );
    expect(followup.request.id, "the new request is not the old one").not.toBe(input.request.id);
    expect(followup.plan, "the plan version stays the same object content").toEqual(input.plan);
    expect(followup.reservations).toEqual(input.reservations);
    expect(followup.state.observedAt).toBe(input.state.observedAt);
    expect(followup.travelLegs).toEqual(input.travelLegs);
    expect(result.answer).toEqual({
      choice: "P-B",
      provenance: "user_answer",
      parentSessionId: result.sessionId,
      oldStateVersion: input.state.version,
      newStateVersion: input.state.version + 1,
    });
    expect(input, "the original observation is not mutated").toEqual(original);
  });

  it("C01 needs no model or route and lands on the hand-computed 15:30-16:30 / 17:20 plan", async () => {
    const input = e08Input();
    const { session, route } = sessionFor(input);
    await session.start();
    const question = session.snapshot().question!;
    const result = await session.answer({
      questionId: question.questionId,
      snapshotFingerprint: question.snapshotFingerprint,
      choice: "P-C",
    }, input);

    const output = result.output!;
    expect(output.modelRequests, "a known place needs no model decision").toBe(0);
    expect(output.routeRequests, "the C->D estimate was already known").toBe(0);
    expect(route).not.toHaveBeenCalled();
    expect(result.planningCalls, "pre-question probe plus one follow-up plan").toBe(2);
    expect(output.result.status).toBe("candidate_found");
    if (output.result.status !== "candidate_found") throw new Error("expected a found candidate");
    const selected = output.result.selected;
    expect(selected.strategy).toBe("shift");
    const afternoon = selected.candidate.activities.find((item) => item.id === "C")!;
    expect(afternoon.startsAt).toBe("2026-10-15T15:30:00+08:00");
    expect(afternoon.endsAt).toBe("2026-10-15T16:30:00+08:00");
    const leg = output.travelLegs.find((item) => item.fromPlaceId === "P-C" && item.toPlaceId === "P-D")!;
    expect(leg.duration, "the user estimate is preserved, not overwritten").toEqual({
      kind: "known",
      minutes: 40,
    });
    expect(
      arrival(afternoon.endsAt, 40, input.transferBufferMinutes),
      "16:30 + 40 travel + 10 buffer = 17:20",
    ).toBe(Date.parse("2026-10-15T17:20:00+08:00"));
    expect(
      selected.candidate.activities.find((item) => item.id === "D")?.startsAt,
      "the fixed dinner is untouched",
    ).toBe("2026-10-15T18:00:00+08:00");
  });

  it("reruns the new snapshot inside the documented session budget", async () => {
    const input = withUnknownLocation(e13Input());
    const { session, route } = sessionFor(input);
    await session.start();
    const question = session.snapshot().question!;
    const result = await session.answer({
      questionId: question.questionId,
      snapshotFingerprint: question.snapshotFingerprint,
      choice: "P-B",
    }, input);

    const output = result.output!;
    expect(route.mock.calls.map(([from, to]) => `${from}->${to}`), "exactly the two unknown legs").toEqual([
      "P-B->P-C",
      "P-C->P-D",
    ]);
    expect(output.modelRequests, "two scripted decisions").toBe(2);
    expect(output.routeRequests).toBe(2);
    expect(result.planningCalls, "1 pre-question + at most 4 in the new run").toBe(4);
    expect(output.planningCalls).toBe(3);
    expect(result.followup?.state.version, "the answered snapshot is the base").toBe(2);
    expect(result.followup?.request.baseStateVersion).toBe(2);
    expect(output.result.status).toBe("candidate_found");
    if (output.result.status !== "candidate_found") throw new Error("expected a found candidate");
    const selected = output.result.selected;
    expect(selected.strategy).toBe("shift");
    const afternoon = selected.candidate.activities.find((item) => item.id === "C")!;
    expect(afternoon.startsAt, "15:30 + 10 travel + 10 buffer = 15:50").toBe("2026-10-15T15:50:00+08:00");
    expect(afternoon.endsAt).toBe("2026-10-15T16:50:00+08:00");
    expect(
      arrival(afternoon.endsAt, 20, input.transferBufferMinutes),
      "16:50 + 20 travel + 10 buffer = 17:20",
    ).toBe(Date.parse("2026-10-15T17:20:00+08:00"));
  });
});
