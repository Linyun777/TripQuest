import { describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate, type BaselinePlanningInput } from "@tripquest/domain";
import { createInvestigation, snapshotFingerprint } from "../session";
import { runAgent } from "../graph";
import { createScriptedModel } from "../scripted";
import { DecisionModelError, type DecisionContext, type DecisionModel } from "../contracts";
import { diagnosticInput, walking, lookup } from "./independent-fixtures";

const e13 = () => diagnosticInput("15:30");
const diagnosticRoute = (from: string, to: string) =>
  walking(from === "P-B" && to === "P-C" ? 600 : from === "P-C" && to === "P-D" ? 1200 : 3000);

const places = ["A", "B", "C", "D"].map((id) => ({ id: `P-${id}`, name: `虚构 ${id}` }));
function unknown(): BaselinePlanningInput {
  const input = e13();
  return { ...input, state: { ...input.state, location: { kind: "unknown" } } };
}
function setup(input = unknown(), model = createScriptedModel()) {
  const route = vi.fn(async (from: string, to: string) => diagnosticRoute(from, to));
  const plan = vi.fn(generateBaselineCandidate);
  const session = createInvestigation(input, {
    places, model, lookupRoute: route, plan, decisionPolicy: "feedback_once",
  });
  const question = session.snapshot().question!;
  const answer = { questionId: question?.questionId, snapshotFingerprint: question?.snapshotFingerprint, choice: "P-B" };
  return { session, answer, route, plan, input };
}
function sequence(actions: readonly unknown[]) {
  let index = 0;
  const contexts: DecisionContext[] = [];
  const fallback = createScriptedModel();
  const model: DecisionModel = {
    ...fallback,
    async decide(context, options) {
      contexts.push(structuredClone(context));
      if (index < actions.length) {
        const value = actions[index++];
        if (value instanceof Error) throw value;
        return { decision: value, usage: null };
      }
      return fallback.decide(context, options);
    },
  };
  return { model, contexts };
}
const invalid = lookup("P-D", "P-B");
describe("explicit bounded feedback", () => {
  it.each([
    [[invalid], 3, 2, 1, "completed", "edge_not_allowed"],
    [[lookup("P-B", "P-C"), lookup("P-B", "P-C")], 3, 2, 1, "completed", "known_edge"],
    [[invalid, invalid], 2, 0, 2, "invalid_decision", "edge_not_allowed"],
  ] as const)("repairs once without extra tool/planning work: %j", async (actions, models, routes, rejects, status, code) => {
    const { model, contexts } = sequence(actions);
    const result = await runAgent(e13(), {
      model, plan: generateBaselineCandidate, lookupRoute: async (from, to) => diagnosticRoute(from, to),
      decisionPolicy: "feedback_once",
    });
    expect(result).toMatchObject({ modelRequests: models, routeRequests: routes, rejectedActions: rejects, executionStatus: status, repairAttempts: 1 });
    expect(result.planningCalls).toBe(routes + 1);
    expect(result.feedbackEvents?.[0].code).toBe(code);
    expect(contexts.filter((context) => context.feedback)).toHaveLength(1);
    expect(result.feedbackEvents?.[0].remaining.models).toBe(4 - result.feedbackEvents![0].sequence);
  });
  it.each([{ ...invalid, extra: true }, "not json", new DecisionModelError("timeout")])("does not repair parsing/transport failures", async (action) => {
    const { model } = sequence([action]);
    const result = await runAgent(e13(), {
      model, plan: generateBaselineCandidate, lookupRoute: vi.fn(), decisionPolicy: "feedback_once",
    });
    expect(result.modelRequests).toBe(1);
    expect(result.repairAttempts).toBe(0);
    expect(result.routeRequests).toBe(0);
  });
  it("spends all four decisions and three routes within the same budget", async () => {
    const { model } = sequence([
      invalid,
      lookup("P-B", "P-D"),
      lookup("P-B", "P-C"),
      lookup("P-C", "P-D"),
    ]);
    const result = await runAgent(e13(), {
      model, plan: generateBaselineCandidate,
      lookupRoute: async (from, to) => diagnosticRoute(from, to),
      decisionPolicy: "feedback_once",
    });
    expect(result).toMatchObject({
      executionStatus: "completed", modelRequests: 4, routeRequests: 3,
      planningCalls: 4, repairAttempts: 1, rejectedActions: 1,
    });
  });
  it("classifies a repeated failed edge without calling it twice", async () => {
    const { model } = sequence([
      lookup("P-B", "P-C"), lookup("P-B", "P-C"),
      { action: "finish", reasonCode: "cannot_resolve" },
    ]);
    const result = await runAgent(e13(), {
      model, plan: generateBaselineCandidate,
      lookupRoute: async () => ({
        status: "no_route", reason: "no_path",
        evidence: diagnosticRoute("P-B", "P-C").evidence,
      }),
      decisionPolicy: "feedback_once",
    });
    expect(result.feedbackEvents?.[0].code).toBe("already_requested");
    expect(result.routeRequests).toBe(1);
    expect(result.executionStatus).toBe("model_stopped");
  });
  it("keeps old fail-fast protocol and context unchanged", async () => {
    const { model, contexts } = sequence([invalid]);
    const result = await runAgent(e13(), { model, plan: generateBaselineCandidate, lookupRoute: vi.fn() });
    expect(result.executionStatus).toBe("invalid_decision");
    expect(result).not.toHaveProperty("repairAttempts");
    expect(contexts[0]).not.toHaveProperty("protocolVersion");
  });
  it("cancels an uncooperative repair request and ignores its late reply", async () => {
    const abort = new AbortController();
    let settle!: (value: { decision: unknown; usage: null }) => void;
    let requests = 0;
    const model: DecisionModel = {
      ...createScriptedModel(),
      async decide() {
        if (++requests === 1) return { decision: invalid, usage: null };
        queueMicrotask(() => abort.abort());
        return new Promise((resolve) => { settle = resolve; });
      },
    };
    const result = await runAgent(e13(), {
      model, plan: generateBaselineCandidate, lookupRoute: vi.fn(),
      decisionPolicy: "feedback_once", signal: abort.signal,
    });
    settle({ decision: lookup("P-B", "P-C"), usage: null });
    await Promise.resolve();
    expect(result.executionStatus).toBe("cancelled");
    expect(result.routeRequests).toBe(0);
  });
});
describe("caller-owned clarification sessions", () => {
  it("waits with zero model/routes then creates an isolated new version", async () => {
    const setupValue = setup();
    const { session, answer, route, plan, input } = setupValue;
    const original = structuredClone(input);
    expect((await session.start()).status).toBe("awaiting_user");
    expect(route).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledTimes(1);
    const result = await session.answer(answer, input);
    expect(result.followup?.state.version).toBe(input.state.version + 1);
    expect(result.followup?.request.baseStateVersion).toBe(input.state.version + 1);
    expect(result.followup?.request.id).not.toBe(input.request.id);
    expect(result.followup?.plan).toEqual(input.plan);
    expect(result.followup?.reservations).toEqual(input.reservations);
    expect(result.followup?.state.observedAt).toBe(input.state.observedAt);
    expect(input).toEqual(original);
    expect(result.output?.result.selected?.strategy).toBe("shift");
    expect(result.planningCalls).toBe(4);
    expect(result.followupFingerprint).toBe(snapshotFingerprint(result.followup!));
    expect(route).toHaveBeenCalledTimes(2);
  });
  it.each(["cannot_answer", "cancel"])("does not invent location on %s", async (choice) => {
    const { session, answer, input, route } = setup();
    const result = choice === "cancel" ? session.cancel() : await session.answer({ ...answer, choice }, input);
    expect(result.followup).toBeNull();
    expect(result.output).toBeNull();
    expect(route).not.toHaveBeenCalled();
    await expect(session.answer(answer, input)).rejects.toThrow();
  });
  it.each(["unknown", "wrong-question", "wrong-fingerprint", "extra"])("rejects %s without consuming legitimate answer", async (kind) => {
    const { session, answer, input, route } = setup();
    const bad = kind === "unknown" ? { ...answer, choice: "P-X" }
      : kind === "wrong-question" ? { ...answer, questionId: "wrong" }
      : kind === "wrong-fingerprint" ? { ...answer, snapshotFingerprint: "wrong" }
      : { ...answer, unexpected: true };
    await expect(session.answer(bad, input)).rejects.toThrow("invalid_answer");
    expect(route).not.toHaveBeenCalled();
    expect((await session.answer(answer, input)).status).toBe("finished");
  });
  it("atomically consumes concurrent and duplicate submissions", async () => {
    const { session, answer, input, route } = setup();
    const results = await Promise.allSettled([session.answer(answer, input), session.answer(answer, input)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(route).toHaveBeenCalledTimes(2);
    await expect(session.answer(answer, input)).rejects.toThrow("question_consumed");
  });
  it.each(["version", "observation", "fact"])("invalidates stale %s snapshots permanently", async (kind) => {
    const { session, answer, input, route } = setup();
    const changed = structuredClone(input);
    const current = kind === "version" ? { ...changed, state: { ...changed.state, version: 2 } }
      : kind === "observation" ? { ...changed, state: { ...changed.state, observedAt: "2026-10-15T14:31:00+08:00" as const } }
      : { ...changed, transferBufferMinutes: 11 };
    await expect(session.answer(answer, current)).rejects.toThrow("stale_snapshot");
    await expect(session.answer(answer, input)).rejects.toThrow("question_consumed");
    expect(route).not.toHaveBeenCalled();
  });
  it.each(["pending", "stale", "multiple", "overflow"])("does not bypass %s with a location question", async (kind) => {
    const base = unknown();
    const input = kind === "pending" ? { ...base, reservations: base.reservations.map((entry) => ({ ...entry, confirmation: { ...entry.confirmation, status: "pending" as const } })) }
      : kind === "stale" ? { ...base, request: { ...base.request, baseStateVersion: 8 } }
      : kind === "overflow" ? { ...base, state: { ...base.state, version: Number.MAX_SAFE_INTEGER }, request: { ...base.request, baseStateVersion: Number.MAX_SAFE_INTEGER } }
      : { ...base, plan: { ...base.plan, activities: [...base.plan.activities.slice(0, 3), { ...base.plan.activities[2], id: "C2" }, base.plan.activities[3]] } };
    const { session, route } = setup(input);
    const result = await session.start();
    expect(result.question).toBeNull();
    expect(route).not.toHaveBeenCalled();
  });
});
