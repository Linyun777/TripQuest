import type { CandidateContext, CandidateDecisionModel } from "./short-candidates";

/**
 * Rules policy (tests and the evaluation baseline): search with the user's own words, offer the
 * three nearest. A function replaces it for scripted tests.
 */
export function createShortScriptedModel(decide?: (context: CandidateContext) => unknown): CandidateDecisionModel {
  return {
    mode: "scripted",
    provider: "tripquest",
    model: "short-rules",
    async decide(context) {
      if (decide) return { decision: decide(context), usage: null };
      if (context.stage === "queries") return { decision: { queries: [context.interest.text.slice(0, 20)] }, usage: null };
      const picks = (context.found ?? []).slice(0, 3).map((item) => ({
        id: item.id, reason: context.anchor.isStart ? "离你最近" : "离上一站最近", stayMinutes: 60,
      }));
      return { decision: { picks }, usage: null };
    },
  };
}
