import { describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import { LIMITS, runAgent } from "../index";
import { serializeContext } from "../prompt";
import { DecisionModelError } from "../contracts";
import type { DecisionContext, DecisionModel, RouteReply } from "../contracts";
import type { RouteResult } from "@tripquest/providers";
import { at, diagnosticInput, evidence, finish, lookup, scriptedModel, walking } from "./independent-fixtures";

/**
 * Independent graph tests. They deliberately cover the rejection and failure
 * paths the design §8 asks for (deliberately wrong actions, termination
 * sequences, abort and late results), not a second copy of the happy path.
 */

const plan = generateBaselineCandidate;
const e13 = () => diagnosticInput("15:30");
const diagnosticRoute = (from: string, to: string): RouteResult =>
  walking(from === "P-B" && to === "P-C" ? 600 : from === "P-C" && to === "P-D" ? 1200 : 3000);

describe("budget and termination boundaries", () => {
  it.each([[1, 1], [59, 1], [60, 1], [600, 10], [601, 11]])(
    "rounds %i route seconds up to %i minutes",
    async (seconds, minutes) => {
      const result = await runAgent(e13(), {
        model: scriptedModel([lookup("P-B", "P-C"), finish("cannot_resolve")]),
        plan,
        lookupRoute: async () => walking(seconds),
      });
      expect(result.travelLegs).toEqual([
        { fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known", minutes } },
      ]);
    },
  );

  it("stops when the shared tool gateway refuses the request", async () => {
    const model = scriptedModel([lookup("P-B", "P-C")]);
    const decide = vi.spyOn(model, "decide");
    const result = await runAgent(e13(), {
      model,
      plan,
      lookupRoute: async () => ({ status: "budget_exhausted" }),
    });
    expect(result.executionStatus).toBe("budget_exhausted");
    expect(result.routeRequests).toBe(1);
    expect(result.observations).toEqual([{ edge: ["P-B", "P-C"], status: "budget_exhausted" }]);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("never needs a fourth decision once three routes have been accepted", async () => {
    const model = scriptedModel([
      lookup("P-B", "P-D"),
      lookup("P-B", "P-C"),
      lookup("P-C", "P-D"),
      finish("cannot_resolve"),
    ]);
    const decide = vi.spyOn(model, "decide");
    const result = await runAgent(e13(), {
      model,
      plan,
      lookupRoute: async (from, to) => diagnosticRoute(from, to),
    });
    expect(result.executionStatus).toBe("completed");
    expect(result.routeRequests).toBe(3);
    expect(result.modelRequests).toBe(3);
    expect(decide).toHaveBeenCalledTimes(3);
    expect(result.planningCalls).toBe(4);
  });

  it("finishes inside the production recursion bound but reports engine_limit one step short", async () => {
    const run = (recursionLimit: number) =>
      runAgent(e13(), {
        model: scriptedModel([lookup("P-B", "P-D"), lookup("P-B", "P-C"), lookup("P-C", "P-D")]),
        plan,
        lookupRoute: async (from, to) => diagnosticRoute(from, to),
        recursionLimit,
      });
    const short = await run(13);
    expect(short.executionStatus).toBe("engine_limit");
    expect(short.error).toBe("engine_limit");
    expect(short.routeRequests).toBe(3);
    const enough = await run(14);
    expect(enough.executionStatus).toBe("completed");
    expect(LIMITS.recursion).toBeGreaterThan(14);
  });

  it("counts a failed lookup as spent budget and still allows another direction", async () => {
    const calls: string[] = [];
    const result = await runAgent(e13(), {
      model: scriptedModel([
        lookup("P-B", "P-C"),
        lookup("P-C", "P-D"),
        finish("cannot_resolve"),
      ]),
      plan,
      lookupRoute: async (from, to): Promise<RouteReply> => {
        calls.push(`${from}->${to}`);
        if (from === "P-B" && to === "P-C") {
          return {
            status: "failure",
            failure: { code: "timeout", retry: "after_backoff", safeMessage: "synthetic" },
            evidence: { ...evidence },
          };
        }
        return walking(1200);
      },
    });
    expect(calls).toEqual(["P-B->P-C", "P-C->P-D"]);
    expect(result.routeRequests).toBe(2);
    expect(result.executionStatus).toBe("model_stopped");
    expect(result.travelLegs).toEqual([
      { fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known", minutes: 20 } },
    ]);
    expect(result.observations).toEqual([
      { edge: ["P-B", "P-C"], status: "failure", failureCode: "timeout" },
      { edge: ["P-C", "P-D"], status: "ok" },
    ]);
  });
});

describe("abort, late results and cancellation", () => {
  it("aborts a hanging lookup, keeps the edge unknown and ignores the late settlement", async () => {
    let release!: (reply: RouteReply) => void;
    const tool = vi.fn(() => new Promise<RouteReply>((resolve) => { release = resolve; }));
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C")]),
      plan,
      lookupRoute: tool,
      totalMs: 25,
    });
    expect(tool).toHaveBeenCalledTimes(1);
    expect(result.routeRequests).toBe(1);
    expect(result.travelLegs).toEqual([]);
    expect(result.result.status).toBe("needs_information");
    expect(result.executionStatus).toBe("model_error");
    // The run deadline is reported as a timeout, matching the model path: the
    // recompute guard overwrites the route-level code once the controller aborts.
    expect(result.error).toBe("timeout");
    const settled = structuredClone(result);
    release(walking(600));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result).toEqual(settled);
  });

  it("reports a thrown lookup as a route failure and keeps the edge unknown", async () => {
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C")]),
      plan,
      lookupRoute: async () => { throw new Error("synthetic tool crash"); },
    });
    expect(result.executionStatus).toBe("model_error");
    expect(result.error).toBe("route_failure");
    expect(result.routeRequests).toBe(1);
    expect(result.travelLegs).toEqual([]);
  });

  it("honours an already-aborted external signal without calling the model or a tool", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([lookup("P-B", "P-C")]);
    const decide = vi.spyOn(model, "decide");
    const tool = vi.fn(async () => walking(600));
    const result = await runAgent(e13(), {
      model,
      plan,
      lookupRoute: tool,
      signal: controller.signal,
    });
    expect(result.executionStatus).toBe("cancelled");
    expect(result.modelRequests).toBe(0);
    expect(result.routeRequests).toBe(0);
    expect(decide).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
  });

  it("tears the model signal down once the run has already returned", async () => {
    const box: { signal?: AbortSignal } = {};
    const result = await runAgent(e13(), {
      model: {
        ...scriptedModel([]),
        async decide(_context, options) {
          box.signal = options.signal;
          return { decision: finish("cannot_resolve"), usage: null };
        },
      },
      plan,
      lookupRoute: async () => walking(600),
    });
    expect(result.executionStatus).toBe("model_stopped");
    expect(box.signal, "the graph handed a signal to the model").toBeDefined();
    expect(box.signal?.aborted, "a late transport cannot outlive the run").toBe(true);
  });

  it("cancels mid-request without recording a fabricated fact", async () => {
    const controller = new AbortController();
    const model: DecisionModel = {
      ...scriptedModel([]),
      async decide(_context, options) {
        controller.abort();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DecisionModelError("timeout")), {
            once: true,
          });
        });
      },
    };
    const result = await runAgent(e13(), {
      model,
      plan,
      lookupRoute: async () => walking(600),
      signal: controller.signal,
    });
    expect(result.executionStatus).toBe("cancelled");
    expect(result.travelLegs).toEqual([]);
    expect(result.routeRequests).toBe(0);
  });
});

describe("strict actions, failure propagation and no hidden fallback", () => {
  it.each([
    ["unknown lookup reason code", { ...lookup("P-B", "P-C"), reasonCode: "guess" }],
    ["finish without a reason code", { action: "finish" }],
    ["finish with an extra field", { ...finish("cannot_resolve"), force: true }],
    ["null decision", null],
    ["numeric decision", 7],
    ["over-long place id", { action: "lookup_route", fromPlaceId: "P-B", toPlaceId: "x".repeat(129) }],
    ["nested action object", { action: "lookup_route", fromPlaceId: "P-B", toPlaceId: { id: "P-C" } }],
  ])("rejects %s before any tool runs", async (_label, action) => {
    const tool = vi.fn(async () => walking(600));
    const result = await runAgent(e13(), { model: scriptedModel([action]), plan, lookupRoute: tool });
    expect(result.executionStatus).toBe("invalid_decision");
    expect(result.error).toBe("invalid_action");
    expect(result.rejectedActions).toBe(1);
    expect(result.routeRequests).toBe(0);
    expect(result.observations).toEqual([]);
    expect(tool).not.toHaveBeenCalled();
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({ accepted: false, error: "invalid_action", action: null });
  });

  it("accepts the optional lookup reason code and records the accepted action", async () => {
    const result = await runAgent(e13(), {
      model: scriptedModel([
        { ...lookup("P-B", "P-C"), reasonCode: "check_retention" },
        finish("sufficient_information"),
      ]),
      plan,
      lookupRoute: async () => walking(600),
    });
    expect(result.executionStatus).toBe("model_stopped");
    expect(result.decisions[0]).toMatchObject({
      sequence: 1,
      accepted: true,
      error: null,
      action: { action: "lookup_route", fromPlaceId: "P-B", toPlaceId: "P-C", reasonCode: "check_retention" },
    });
    expect(result.rejectedActions).toBe(0);
  });

  it("rejects a well-formed action that names a direction outside the allowed set", async () => {
    const tool = vi.fn(async () => walking(600));
    // P-C -> P-B is a legal place pair but not one of the three topology edges.
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-C", "P-B")]),
      plan,
      lookupRoute: tool,
    });
    expect(result.executionStatus).toBe("invalid_decision");
    expect(result.error).toBe("invalid_action");
    expect(result.rejectedActions).toBe(1);
    expect(result.routeRequests).toBe(0);
    expect(tool, "a semantic rejection must not reach the gateway").not.toHaveBeenCalled();
    // The rejected action is kept for diagnosis; it must be the one that was asked for.
    expect(result.decisions[0]).toMatchObject({
      accepted: false,
      error: "invalid_action",
      action: { action: "lookup_route", fromPlaceId: "P-C", toPlaceId: "P-B" },
    });
  });

  it("rejects a direction it already asked for instead of querying it twice", async () => {
    const tool = vi.fn(async () => walking(600));
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C"), lookup("P-B", "P-C")]),
      plan,
      lookupRoute: tool,
    });
    expect(result.executionStatus).toBe("invalid_decision");
    expect(result.error).toBe("invalid_action");
    expect(tool).toHaveBeenCalledTimes(1);
    expect(result.routeRequests).toBe(1);
    expect(result.observations).toEqual([{ edge: ["P-B", "P-C"], status: "ok" }]);
  });

  it("enforces the per-request deadline while the overall deadline is far away", async () => {
    const started = performance.now();
    const result = await runAgent(e13(), {
      model: {
        ...scriptedModel([]),
        decide: (_context, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new DecisionModelError("timeout")), {
              once: true,
            });
          }),
      },
      plan,
      lookupRoute: async () => walking(600),
      requestMs: 20,
      totalMs: 3_000,
    });
    const elapsed = performance.now() - started;
    expect(result.executionStatus).toBe("model_error");
    expect(result.error).toBe("timeout");
    expect(result.modelRequests).toBe(1);
    expect(result.routeRequests).toBe(0);
    expect(elapsed, "the 20ms request deadline fired, not the 3s run deadline").toBeLessThan(1_000);
  });

  it("propagates every declared model failure code without inventing a candidate", async () => {
    for (const code of ["timeout", "auth", "quota", "rate_limit", "transport", "invalid_output", "context_limit"] as const) {
      const tool = vi.fn(async () => walking(600));
      const result = await runAgent(e13(), {
        model: { ...scriptedModel([]), async decide() { throw new DecisionModelError(code); } },
        plan,
        lookupRoute: tool,
      });
      expect(result.executionStatus, `${code} status`).toBe("model_error");
      expect(result.error, `${code} code`).toBe(code);
      expect(result.result.status, `${code} business result`).toBe("needs_information");
      expect(result.travelLegs, `${code} facts`).toEqual([]);
      expect(tool, `${code} tool`).not.toHaveBeenCalled();
    }
  });

  it("treats a non-typed model exception as a transport failure", async () => {
    const result = await runAgent(e13(), {
      model: { ...scriptedModel([]), async decide() { throw new Error("synthetic"); } },
      plan,
      lookupRoute: async () => walking(600),
    });
    expect(result.executionStatus).toBe("model_error");
    expect(result.error).toBe("transport");
  });

  it("keeps usage and model metadata attached to a failed decision", async () => {
    const result = await runAgent(e13(), {
      model: {
        ...scriptedModel([]),
        async decide() {
          throw new DecisionModelError("invalid_output", {
            usage: {
              inputTokens: 5,
              outputTokens: 0,
              totalTokens: 5,
              cacheHitTokens: null,
              cacheMissTokens: null,
            },
            returnedModel: "returned-x",
            requestId: "req-1",
          });
        },
      },
      plan,
      lookupRoute: async () => walking(600),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      accepted: false,
      error: "invalid_output",
      returnedModel: "returned-x",
      requestId: "req-1",
    });
    expect(result.decisions[0].usage?.totalTokens).toBe(5);
  });

  const ambiguousReplies: readonly [string, RouteResult][] = [
    ["two options", {
      status: "ok",
      routes: [
        { mode: "walking", durationSeconds: 600, distanceMeters: 1 },
        { mode: "walking", durationSeconds: 700, distanceMeters: 2 },
      ],
      evidence: { ...evidence },
    }],
    ["a non-walking option", {
      status: "ok",
      routes: [{ mode: "transit", durationSeconds: 600, distanceMeters: 1 }],
      evidence: { ...evidence },
    }],
  ];
  it.each(ambiguousReplies)("refuses to select a route automatically when the tool returns %s", async (_label, reply) => {
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C")]),
      plan,
      lookupRoute: async () => reply,
    });
    expect(result.executionStatus).toBe("model_error");
    expect(result.error).toBe("route_failure");
    expect(result.travelLegs).toEqual([]);
    expect(result.result.status).toBe("needs_information");
  });

  it.each(["authorization_failed", "quota_exceeded"] as const)(
    "stops the whole run on route %s",
    async (code) => {
      const model = scriptedModel([lookup("P-B", "P-C"), finish("cannot_resolve")]);
      const decide = vi.spyOn(model, "decide");
      const result = await runAgent(e13(), {
        model,
        plan,
        lookupRoute: async () => ({
          status: "failure",
          failure: { code, retry: "never", safeMessage: "synthetic" },
          evidence: { ...evidence },
        }),
      });
      expect(result.executionStatus).toBe("model_error");
      expect(result.error).toBe(code === "authorization_failed" ? "auth" : "quota");
      expect(decide).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates a first planning failure but degrades a later one to a model error", async () => {
    const boom = () => { throw new Error("synthetic first plan failure"); };
    await expect(runAgent(e13(), {
      model: scriptedModel([]),
      plan: boom,
      lookupRoute: async () => walking(600),
    })).rejects.toThrow("synthetic first plan failure");

    let calls = 0;
    const later = (input: Parameters<typeof generateBaselineCandidate>[0]) => {
      calls += 1;
      if (calls > 1) throw new Error("synthetic later plan failure");
      return generateBaselineCandidate(input);
    };
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C")]),
      plan: later,
      lookupRoute: async () => walking(600),
    });
    expect(result.executionStatus).toBe("model_error");
    expect(result.error).toBe("transport");
    expect(result.routeRequests).toBe(1);
  });
});

describe("decision context isolation", () => {
  it("exposes only the six declared fields and none of the hidden world values", async () => {
    const contexts: DecisionContext[] = [];
    const serialized: string[] = [];
    const model: DecisionModel = {
      ...scriptedModel([]),
      async decide(context) {
        contexts.push(structuredClone(context));
        serialized.push(serializeContext(context));
        const edge = context.observations.length ? ["P-C", "P-D"] : ["P-B", "P-C"];
        return { decision: lookup(edge[0], edge[1]), usage: null };
      },
    };
    const result = await runAgent(e13(), {
      model,
      plan,
      lookupRoute: async (from, to) => diagnosticRoute(from, to),
    });
    expect(result.executionStatus).toBe("completed");
    expect(contexts).toHaveLength(2);

    type DeclaredKeys = keyof DecisionContext;
    const keyGuard: DeclaredKeys extends
      | "initial" | "travelLegs" | "currentResult" | "observations" | "allowedEdges" | "remaining"
      | "protocolVersion" | "feedback"
      ? true
      : never = true;
    expect(keyGuard).toBe(true);
    expect(Object.keys(contexts[0]).sort()).toEqual([
      "allowedEdges", "currentResult", "initial", "observations", "remaining", "travelLegs",
    ]);

    expect(contexts[0].remaining).toEqual({ routes: 3, models: 4 });
    expect(contexts[1].remaining).toEqual({ routes: 2, models: 3 });
    expect(contexts[0].allowedEdges).toEqual([
      ["P-B", "P-C"], ["P-B", "P-D"], ["P-C", "P-D"],
    ]);
    expect(contexts[1].observations).toHaveLength(1);
    expect(contexts[1].travelLegs).toEqual([
      { fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known", minutes: 10 } },
    ]);

    for (const payload of serialized) {
      for (const hidden of ["600", "1200", "3000", "3200"]) {
        expect(payload, `hidden world value ${hidden}`).not.toContain(hidden);
      }
      for (const forbidden of ["expected", "caseId", "E13", "E14", "world", "score", "apiKey"]) {
        expect(payload, `forbidden key ${forbidden}`).not.toContain(forbidden);
      }
    }
    expect(serialized[0]).toContain("allowedEdges");
  });

  it("never mutates the caller's input and keeps the plan port isolated", async () => {
    const source = e13();
    const before = structuredClone(source);
    const seen: string[] = [];
    await runAgent(source, {
      model: scriptedModel([lookup("P-B", "P-C"), lookup("P-C", "P-D")]),
      plan: (input) => { seen.push(JSON.stringify(input.travelLegs)); return generateBaselineCandidate(input); },
      lookupRoute: async (from, to) => diagnosticRoute(from, to),
    });
    expect(source).toEqual(before);
    expect(seen).toHaveLength(3);
  });
});

describe("E13 retention arithmetic and E14 stopping point", () => {
  it("reaches the hand-computed 15:50-16:50 / 17:20 schedule after two proven edges", async () => {
    const result = await runAgent(e13(), {
      model: scriptedModel([lookup("P-B", "P-C"), lookup("P-C", "P-D")]),
      plan,
      lookupRoute: async (from, to) => diagnosticRoute(from, to),
    });
    expect(result.executionStatus).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.routeRequests).toBe(2);
    expect(result.planningCalls).toBe(3);
    if (result.result.status !== "candidate_found") throw new Error("expected a candidate");
    expect(result.result.selected.strategy).toBe("shift");
    const c = result.result.selected.candidate.activities.find((a) => a.id === "C");
    expect(c).toMatchObject({ startsAt: at("15:50"), endsAt: at("16:50") });
    const transitions = result.result.selected.validation.checkedTransitions;
    expect(transitions.map((t) => t.earliestArrivalAt)).toEqual([at("15:50"), at("17:20")]);
    expect(transitions.at(-1)?.travelMinutes).toBe(20);
  });

  it("cannot turn an unknown plan into a candidate by finishing early", async () => {
    const result = await runAgent(e13(), {
      model: scriptedModel([finish("sufficient_information")]),
      plan,
      lookupRoute: async () => walking(600),
    });
    expect(result.executionStatus).toBe("model_stopped");
    expect(result.result.status).toBe("needs_information");
    expect(result.travelLegs).toEqual([]);
  });

  it("accepts a direct route to the reservation on E14 and omits the activity", async () => {
    const e14 = diagnosticInput("17:10");
    const result = await runAgent(e14, {
      model: scriptedModel([lookup("P-B", "P-D")]),
      plan,
      lookupRoute: async () => walking(2400),
    });
    expect(result.executionStatus).toBe("completed");
    expect(result.modelRequests).toBe(1);
    expect(result.routeRequests).toBe(1);
    if (result.result.status !== "candidate_found") throw new Error("expected a candidate");
    expect(result.result.selected.strategy).toBe("omit");
    expect(result.result.selected.candidate.activities.map((a) => a.id)).toEqual(["A", "B", "D"]);
    expect(result.result.selected.validation.checkedTransitions.at(-1)?.earliestArrivalAt).toBe(at("18:00"));
  });
});
