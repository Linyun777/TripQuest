import type { DecisionModel } from "./contracts";
import { usefulEdges } from "./policy";

/** A deterministic fake model for plumbing only; no case IDs or hidden answers. */
export function createScriptedModel(): DecisionModel {
  return {
    mode: "scripted",
    provider: "local-script",
    model: "adaptive-script-v1",
    async decide(context) {
      const edges = usefulEdges(
        context.currentResult,
        context.allowedEdges,
        context.observations,
      );
      const edge = edges[0];
      return {
        decision: edge ? {
          action: "lookup_route",
          fromPlaceId: edge[0],
          toPlaceId: edge[1],
        } : { action: "finish", reasonCode: "cannot_resolve" },
        usage: null,
      };
    },
  };
}
