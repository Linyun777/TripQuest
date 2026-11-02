import { describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import { LIMITS, runAgent, type RouteReply } from "../index";
import {
  e13Input,
  e13Route,
  lookup,
  sequenceModel,
  withoutRoute,
} from "./s43-independent-fixtures";

/**
 * S4.3 independent tests for the one-shot action feedback. Expectations are
 * derived from the S4.3 design §3/§5 (counters and budget behaviour), never
 * from the implementation's own output.
 */

const plan = generateBaselineCandidate;
const rejectEdge = lookup("P-D", "P-B");

describe("bounded action feedback", () => {
  it("counts the repair inside the same four-model budget and stops a second rejection", async () => {
    // Two accepted routes leave one model and one route; the third decision is
    // the first (and only) rejection, so the repair is the fourth model call.
    const repair = sequenceModel([lookup("P-B", "P-C"), lookup("P-B", "P-D"), rejectEdge]);
    const recovered = await runAgent(e13Input(), {
      model: repair.model,
      plan,
      lookupRoute: async (from, to) => e13Route(from, to),
      decisionPolicy: "feedback_once",
    });
    expect(recovered.executionStatus, "recovered run ends by completing").toBe("completed");
    expect(recovered.modelRequests, "repair shares the four-model budget").toBe(LIMITS.models);
    expect(recovered.routeRequests, "third route is the repair").toBe(LIMITS.routes);
    expect(recovered.planningCalls, "one plan per route plus the initial").toBe(LIMITS.routes + 1);
    expect(recovered.rejectedActions, "one recorded rejection").toBe(1);
    expect(recovered.repairAttempts).toBe(1);
    expect(recovered.feedbackEvents).toHaveLength(1);
    expect(recovered.feedbackEvents?.[0].remaining, "honest remaining budget").toEqual({
      models: 1,
      routes: 1,
    });
    const selected = recovered.result.status === "candidate_found" ? recovered.result.selected : null;
    expect(selected?.strategy, "keeps C instead of dropping it").toBe("shift");
    expect(selected?.candidate.activities.find((item) => item.id === "C")?.startsAt)
      .toBe("2026-10-15T15:50:00+08:00");

    const twice = sequenceModel([
      lookup("P-B", "P-C"),
      lookup("P-B", "P-D"),
      rejectEdge,
      rejectEdge,
    ]);
    const failed = await runAgent(e13Input(), {
      model: twice.model,
      plan,
      lookupRoute: async (from, to) => e13Route(from, to),
      decisionPolicy: "feedback_once",
    });
    expect(failed.executionStatus, "second rejection terminates").toBe("invalid_decision");
    expect(failed.modelRequests, "no fifth decision").toBe(LIMITS.models);
    expect(failed.rejectedActions).toBe(2);
    expect(failed.repairAttempts, "still only one repair attempt").toBe(1);
  });

  it("returns only the whitelisted rejection summary, with no answer or hidden route", async () => {
    const { model, contexts } = sequenceModel([
      lookup("P-B", "P-C"),
      lookup("P-B", "P-D"),
      rejectEdge,
    ]);
    await runAgent(e13Input(), {
      model,
      plan,
      lookupRoute: async (from, to) => e13Route(from, to),
      decisionPolicy: "feedback_once",
    });
    const withFeedback = contexts.filter((context) => context.feedback);
    expect(withFeedback, "feedback reaches exactly the next decision").toHaveLength(1);
    const feedback = withFeedback[0].feedback!;
    expect(Object.keys(feedback).sort(), "feedback keys are fixed").toEqual([
      "allowedEdges",
      "code",
      "remaining",
      "sequence",
      "version",
    ]);
    expect(feedback.version).toBe("action-feedback-v1");
    expect(feedback.code).toBe("edge_not_allowed");
    expect(feedback.sequence, "points at the rejected decision").toBe(3);
    expect(withFeedback[0].protocolVersion).toBe("route-investigation-feedback-v1");
    const rejectedKey = JSON.stringify(["P-D", "P-B"]);
    expect(
      feedback.allowedEdges.map((edge) => JSON.stringify(edge)),
      "the rejected direction is not handed back as a hint",
    ).not.toContain(rejectedKey);
    expect(
      feedback.allowedEdges.map((edge) => JSON.stringify(edge)).sort(),
      "only unrequested allowedEdges remain",
    ).toEqual([JSON.stringify(["P-C", "P-D"])]);
  });

  it("executes no tool, changes no fact and adds no planning call when rejecting", async () => {
    const finish = { action: "finish", reasonCode: "cannot_resolve" } as const;
    const sideEffects = async (
      actions: readonly unknown[],
      tool: (from: string, to: string) => Promise<RouteReply>,
    ) => {
      const { model } = sequenceModel(actions);
      const calls = vi.fn(tool);
      const result = await runAgent(e13Input(), {
        model,
        plan,
        lookupRoute: calls,
        decisionPolicy: "feedback_once",
      });
      return { result, calls, edges: calls.mock.calls.map(([from, to]) => `${from}->${to}`) };
    };

    const notAllowed = await sideEffects([rejectEdge, finish], async () => withoutRoute);
    expect(notAllowed.result.feedbackEvents?.[0].code, "edge_not_allowed").toBe("edge_not_allowed");
    expect(notAllowed.edges, "a rejected direction never reaches the tool").toEqual([]);
    expect(notAllowed.result.travelLegs, "facts untouched by a rejection").toEqual([]);
    expect(notAllowed.result.planningCalls, "no extra planning for a rejection").toBe(1);
    const rejectedEvent = notAllowed.result.decisions[0];
    expect(rejectedEvent.accepted, "structured rejection stays in the report").toBe(false);
    expect(rejectedEvent.error).toBe("invalid_action");
    expect(rejectedEvent.action, "the rejected action is kept for diagnosis").toEqual(rejectEdge);

    const requested = await sideEffects(
      [lookup("P-B", "P-C"), lookup("P-B", "P-C"), finish],
      async () => withoutRoute,
    );
    expect(requested.result.feedbackEvents?.[0].code, "already_requested").toBe("already_requested");
    expect(requested.edges, "the repeat never reaches the tool").toEqual(["P-B->P-C"]);
    expect(requested.result.routeRequests).toBe(1);
    expect(requested.result.travelLegs, "a failed route stays unknown").toEqual([]);
    expect(requested.result.planningCalls, "one plan per executed route plus the initial").toBe(2);

    const known = await sideEffects(
      [lookup("P-B", "P-C"), lookup("P-B", "P-C"), finish],
      async (from, to) => e13Route(from, to),
    );
    expect(known.result.feedbackEvents?.[0].code, "known_edge wins over already_requested").toBe("known_edge");
    expect(known.edges, "the repeat never reaches the tool").toEqual(["P-B->P-C"]);
    expect(known.result.travelLegs, "only the successful lookup became a fact").toEqual([
      { fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known", minutes: 10 } },
    ]);
    expect(known.result.planningCalls, "one plan per executed route plus the initial").toBe(2);
  });

  it("clears the feedback as soon as an accepted action follows it", async () => {
    const { model, contexts } = sequenceModel([
      lookup("P-B", "P-D"),
      rejectEdge,
      lookup("P-B", "P-C"),
    ]);
    const result = await runAgent(e13Input(), {
      model,
      plan,
      lookupRoute: async (from, to) => e13Route(from, to),
      decisionPolicy: "feedback_once",
    });
    expect(result.executionStatus).toBe("completed");
    expect(contexts, "decision 2 rejects, decision 3 repairs, decision 4 continues").toHaveLength(4);
    expect(
      contexts.map((context) => context.feedback?.sequence ?? null),
      "feedback is handed to exactly the next decision and then dropped",
    ).toEqual([null, null, 2, null]);
    expect(contexts[2].feedback?.code).toBe("edge_not_allowed");
    expect(result.feedbackEvents, "the event record survives for the report").toHaveLength(1);
    expect(result.rejectedActions).toBe(1);
  });
});
