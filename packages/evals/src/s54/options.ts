import { S54_CASES } from "./dataset";
import { S54_LIVE_ROUNDS, type S54LiveRound } from "./budget";
import type { Policy } from "./run";

export interface PlanningOptions {
  readonly policy: Policy;
  readonly caseIds: readonly string[];
  readonly round?: S54LiveRound;
}

/** --policy scripted|live, --case D01,R03, --live-round developer|test; each at most once. */
export function parsePlanningOptions(input: readonly string[]): PlanningOptions {
  // `pnpm eval:planning -- …` forwards the separator itself.
  const argv = input[0] === "--" ? input.slice(1) : input;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--policy", "--case", "--live-round"].includes(flag) || !value || values.has(flag)) {
      throw new Error("Usage: --policy scripted|live [--case D01,R03] [--live-round developer|test]");
    }
    values.set(flag, value);
  }
  const policy = values.get("--policy") ?? "scripted";
  if (policy !== "scripted" && policy !== "live") throw new Error("Unknown policy");
  const caseIds = values.has("--case") ? values.get("--case")!.split(",") : S54_CASES.map((item) => item.id);
  if (new Set(caseIds).size !== caseIds.length || caseIds.some((id) => !S54_CASES.some((item) => item.id === id))) {
    throw new Error("Unknown or repeated case");
  }
  const round = values.get("--live-round");
  if (policy === "live" && !S54_LIVE_ROUNDS.includes(round as S54LiveRound)) {
    throw new Error("Live runs need --live-round developer|test");
  }
  if (policy === "scripted" && round) throw new Error("--live-round is only for live runs");
  return { policy, caseIds, ...(round ? { round: round as S54LiveRound } : {}) };
}
