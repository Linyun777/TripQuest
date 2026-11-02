import { DecisionModelError, createScriptedModel, type DecisionModel } from "@tripquest/agent";
import { datasetV2 } from "../v2/dataset";

export const sourceCase = (id: string) => {
  const value = datasetV2.cases.find((entry) => entry.id === id);
  if (!value) throw new Error("Unknown case");
  return structuredClone(value);
};
// Fictional display names, supplied by the caller; the domain has only place IDs.
export const places = ["A", "B", "C", "D"].map((id) => ({
  id: `P-${id}`,
  name: `虚构地点 ${id}`,
}));
export function clarificationCase(id: string) {
  const c = sourceCase(id === "C01" ? "E08" : "E13");
  return {
    ...c,
    input: {
      ...c.input,
      state: { ...c.input.state, location: { kind: "unknown" as const, reason: "未报告" } },
    },
  };
}
export const lookup = (from: string, to: string) => ({
  action: "lookup_route", fromPlaceId: from, toPlaceId: to,
});
export const invalidEdge = lookup("P-D", "P-B");
export const mechanisms = [
  { id: "F01", actions: [invalidEdge], models: 3, routes: 2, rejects: 1, repairs: 1, execution: "completed" },
  { id: "F02", actions: [lookup("P-B", "P-C"), lookup("P-B", "P-C")], models: 3, routes: 2, rejects: 1, repairs: 1, execution: "completed" },
  { id: "F03", actions: [invalidEdge, invalidEdge], models: 2, routes: 0, rejects: 2, repairs: 1, execution: "invalid_decision" },
  { id: "F04-schema", actions: [{ ...invalidEdge, extra: true }], models: 1, routes: 0, rejects: 1, repairs: 0, execution: "invalid_decision" },
  { id: "F04-json", actions: [new DecisionModelError("invalid_output")], models: 1, routes: 0, rejects: 0, repairs: 0, execution: "model_error" },
  { id: "F04-timeout", actions: [new DecisionModelError("timeout")], models: 1, routes: 0, rejects: 0, repairs: 0, execution: "model_error" },
] as const;

/** Injection only lives in evals. The graph still counts every synthetic decision. */
export function injectedModel(actions: readonly unknown[], delegate = createScriptedModel()): DecisionModel {
  let index = 0;
  return {
    ...delegate,
    getRequestCount: () => delegate.getRequestCount?.() ?? 0,
    async decide(context, options) {
      if (index < actions.length) {
        const action = actions[index++];
        if (action instanceof DecisionModelError) throw action;
        return { decision: structuredClone(action), usage: null };
      }
      return delegate.decide(context, options);
    },
  };
}
