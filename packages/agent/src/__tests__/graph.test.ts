import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import { runAgent } from "../graph";
import { createScriptedModel } from "../scripted";
import { input, route, scripted, lookup } from "./fixtures";
import { decisionSchema } from "../schema";
import type { DecisionContext, DecisionModel, ModelReply } from "../contracts";
import { DecisionModelError } from "../contracts";

afterEach(() => vi.unstubAllEnvs());
const plan = generateBaselineCandidate;
const finish = { action: "finish", reasonCode: "cannot_resolve" };

describe("bounded graph", () => {
  it("passes new tool observations to the next decision, retains C and isolates inputs", async () => {
    const contexts: DecisionContext[] = [];
    const model: DecisionModel = {
      ...createScriptedModel(),
      async decide(context) {
        contexts.push(structuredClone(context));
        const edge = context.observations.length ? ["P-C", "P-D"] : ["P-B", "P-C"];
        Reflect.set(context.initial, "transferBufferMinutes", 999);
        return { decision: lookup(edge[0], edge[1]), usage: null };
      },
    };
    const original = input();
    const result = await runAgent(original, {
      model, plan,
      lookupRoute: async (from) => route(from === "P-B" ? 600 : 1200),
    });
    expect(result.executionStatus).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.planningCalls).toBe(3);
    expect(contexts[1].observations).toHaveLength(1);
    expect(contexts[1].travelLegs[0].duration).toEqual({ kind: "known", minutes: 10 });
    expect(Object.keys(contexts[0]).sort()).toEqual([
      "allowedEdges", "currentResult", "initial", "observations", "remaining", "travelLegs",
    ]);
    expect(original.transferBufferMinutes).toBe(10);
    expect(result.result.status === "candidate_found" && result.result.selected.strategy).toBe("shift");
  });
  it.each([
    [lookup("P-X", "P-C")],
    [lookup("P-C", "P-B")],
    [lookup("P-C", "P-C")],
    [{ ...lookup("P-B", "P-C"), minutes: 0 }],
    [[lookup("P-B", "P-C"), lookup("P-C", "P-D")]],
    ["not JSON"],
    [{ action: "finish", reasonCode: "make_feasible" }],
  ])("rejects illegal output before tools: %j", async (action) => {
    const tool = vi.fn(async () => route());
    const result = await runAgent(input(), { model: scripted([action]), plan, lookupRoute: tool });
    expect(result.executionStatus).toBe("invalid_decision");
    expect(result.rejectedActions).toBe(1);
    expect(tool).not.toHaveBeenCalled();
  });
  it("rejects repeats and known-route replacement", async () => {
    const first = lookup("P-B", "P-C");
    const tool = vi.fn(async () => route());
    const repeated = await runAgent(input(), { model: scripted([first, first]), plan, lookupRoute: tool });
    expect(repeated.executionStatus).toBe("invalid_decision");
    expect(tool).toHaveBeenCalledTimes(1);
    const original = input();
    const known = { ...original, travelLegs: [{ fromPlaceId: "P-B", toPlaceId: "P-C", duration: { kind: "known" as const, minutes: 30 } }] };
    const rejected = await runAgent(known, { model: scripted([first]), plan, lookupRoute: tool });
    expect(rejected.rejectedActions).toBe(1);
    expect(rejected.travelLegs).toEqual(known.travelLegs);
    expect(tool).toHaveBeenCalledTimes(1);
  });
  it("does not treat a safe omit as the retention optimum", async () => {
    const result = await runAgent(input(), {
      model: scripted([lookup("P-B", "P-D"), finish]), plan,
      lookupRoute: async () => route(3000),
    });
    expect(result.executionStatus).toBe("model_stopped");
    expect(result.modelRequests).toBe(2);
    expect(result.result.status === "candidate_found" && result.result.selected.strategy).toBe("omit");
  });
  it("honors all three requests without recursion-limit false positives", async () => {
    const result = await runAgent(input(), {
      model: scripted([lookup("P-B", "P-D"), lookup("P-B", "P-C"), lookup("P-C", "P-D")]),
      plan, lookupRoute: async () => route(600),
    });
    expect(result.routeRequests).toBe(3);
    expect(result.planningCalls).toBe(4);
    expect(result.executionStatus).toBe("completed");
  });
  it("allows one last finish after three routes when appropriate and never makes a fourth tool call", async () => {
    const tool = vi.fn(async () => ({
      status: "no_route" as const, reason: "no_path" as const, evidence: route().evidence,
    }));
    const result = await runAgent(input(), { model: createScriptedModel(), plan, lookupRoute: tool });
    expect(tool).toHaveBeenCalledTimes(3);
    expect(result.modelRequests).toBeLessThanOrEqual(4);
    expect(result.planningCalls).toBe(4);
    expect(result.travelLegs).toEqual([]);
  });
  it.each(["authorization_failed", "quota_exceeded"] as const)("stops on route %s", async (code) => {
    const model = createScriptedModel();
    const decide = vi.spyOn(model, "decide");
    const result = await runAgent(input(), {
      model, plan,
      lookupRoute: async () => ({
        status: "failure", failure: { code, retry: "never", safeMessage: "synthetic" },
        evidence: route().evidence,
      }),
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result.executionStatus).toBe("model_error");
    expect(result.planningCalls).toBe(2);
  });
  it("aborts the request on timeout and ignores late results", async () => {
    let complete!: (reply: ModelReply) => void;
    let signal: AbortSignal | undefined;
    const model: DecisionModel = {
      ...createScriptedModel(),
      decide(_context, options) {
        signal = options.signal;
        return new Promise((resolve) => { complete = resolve; });
      },
    };
    const tool = vi.fn(async () => route());
    const result = await runAgent(input(), { model, plan, lookupRoute: tool, requestMs: 10 });
    expect(result.error).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    const before = structuredClone(result);
    complete({ decision: lookup("P-B", "P-C"), usage: null });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result).toEqual(before);
    expect(tool).not.toHaveBeenCalled();
  });
  it("handles explicit cancellation and total deadline", async () => {
    for (const cancelled of [true, false]) {
      const controller = new AbortController();
      const model: DecisionModel = {
        ...createScriptedModel(),
        async decide(_context, { signal }) {
          if (cancelled) controller.abort();
          return new Promise((_resolve, reject) => {
            if (signal.aborted) reject(new DecisionModelError("timeout"));
            signal.addEventListener("abort", () => reject(new DecisionModelError("timeout")), { once: true });
          });
        },
      };
      const result = await runAgent(input(), {
        model, plan, lookupRoute: async () => route(), signal: controller.signal, totalMs: 10,
      });
      expect(result.executionStatus).toBe(cancelled ? "cancelled" : "model_error");
      expect(result.routeRequests).toBe(0);
    }
  });
  it("records recursion fallback without dropping the last safe business result", async () => {
    const result = await runAgent(input(), {
      model: createScriptedModel(), plan, lookupRoute: async () => route(), recursionLimit: 1,
    });
    expect(result.executionStatus).toBe("engine_limit");
    expect(result.planningCalls).toBe(1);
  });
  it("rejects oversized context before model invocation and stops non-route gaps", async () => {
    const original = input();
    const model = createScriptedModel();
    const decide = vi.spyOn(model, "decide");
    const large = { ...original, request: { ...original.request, id: "x".repeat(13000) } };
    const oversized = await runAgent(large, { model, plan, lookupRoute: async () => route() });
    expect(oversized.error).toBe("context_limit");
    expect(oversized.modelRequests).toBe(0);
    const unknown = { ...original, state: { ...original.state, location: { kind: "unknown" as const } } };
    const gap = await runAgent(unknown, { model, plan, lookupRoute: async () => route() });
    expect(gap.modelRequests).toBe(0);
    expect(decide).not.toHaveBeenCalled();
  });
  it("refuses environment-driven external tracing", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    await expect(runAgent(input(), {
      model: createScriptedModel(), plan, lookupRoute: async () => route(),
    })).rejects.toThrow("tracing");
  });
  it("uses a strict action schema", () => {
    expect(decisionSchema.safeParse({ ...finish, apiKey: "not-allowed" }).success).toBe(false);
  });
});
