import type { BaselinePlanningInput } from "@tripquest/domain";
import type { HumanExpectation, RouteWorldEntry } from "../contracts";
import { dataset, baseInput, at, syntheticRoute } from "../cases/dataset";

export const V2_DATASET_VERSION = "s4.2-hand-authored-v2";

export const V2_IDS = ["rules_only", "fixed_workflow", "adaptive_workflow", "model_agent"] as const;
export type V2PlannerId = typeof V2_IDS[number];
export type BusinessExpectation = Omit<HumanExpectation, "calls">;
export interface V2Case {
  readonly id: string;
  readonly title: string;
  readonly input: BaselinePlanningInput;
  readonly world: readonly RouteWorldEntry[];
  readonly expected: Readonly<Record<V2PlannerId, BusinessExpectation>>;
  readonly execution: { readonly requireZeroTools: boolean };
}
const business = ({ calls, ...expected }: HumanExpectation): BusinessExpectation => {
  void calls;
  return structuredClone(expected);
};
const inherited: V2Case[] = dataset.cases.map((c) => ({
  id: c.id,
  title: c.title,
  input: structuredClone(c.input),
  world: structuredClone(c.world),
  expected: {
    rules_only: business(c.expected.rules_only),
    fixed_workflow: business(c.expected.fixed_workflow),
    adaptive_workflow: business(c.expected.fixed_workflow),
    model_agent: business(c.expected.fixed_workflow),
  },
  execution: { requireZeroTools: c.expected.fixed_workflow.calls === 0 },
}));

function diagnosticRoute(seconds: number) {
  const result = syntheticRoute(seconds);
  return {
    ...result,
    evidence: { ...result.evidence, datasetVersion: V2_DATASET_VERSION },
  };
}

function diagnostic(id: "E13" | "E14"): V2Case {
  const base = baseInput(id === "E13" ? "15:30" : "17:10");
  const input: BaselinePlanningInput = {
    ...base,
    state: { ...base.state, location: { kind: "known", placeId: "P-B" } },
    travelLegs: [],
  };
  const improved: BusinessExpectation = id === "E13" ? {
    status: "candidate_found",
    strategy: "shift",
    activities: base.plan.activities.map((a) => a.id === "C"
      ? { ...a, startsAt: at("15:50"), endsAt: at("16:50") }
      : { ...a }),
    arrival: { activityId: "D", at: at("17:20") },
    requiredIssues: [],
    reasoning: "15:30 + B→C 10 分 + 缓冲 10 分 = 15:50；保留 C 一小时至 16:50；再 20+10 分 = 17:20。先查直达后 omit 虽安全，但未达到保留 C 的目标。",
  } : {
    status: "candidate_found",
    strategy: "omit",
    activities: base.plan.activities.filter((a) => a.id !== "C"),
    arrival: { activityId: "D", at: at("18:00") },
    requiredIssues: [],
    reasoning: "17:10 + 一小时即超出 18:00 范围，保留 C 已不可能；只查 B→D 40 分，加 10 分缓冲，18:00 恰好可达。",
  };
  return {
    id,
    title: id === "E13" ? "优先保留活动而非抢先省略" : "保留已不可能时只查直达",
    input,
    world: [
      { fromPlaceId: "P-B", toPlaceId: "P-C", result: diagnosticRoute(600) },
      { fromPlaceId: "P-C", toPlaceId: "P-D", result: diagnosticRoute(1200) },
      { fromPlaceId: "P-B", toPlaceId: "P-D", result: diagnosticRoute(id === "E13" ? 3000 : 2400) },
    ],
    expected: {
      rules_only: {
        status: "needs_information",
        requiredIssues: ["unknown_travel_duration"],
        reasoning: "所有可能到达晚餐的路径含未知边，不能证明候选可行。",
      },
      fixed_workflow: structuredClone(improved),
      adaptive_workflow: structuredClone(improved),
      model_agent: structuredClone(improved),
    },
    execution: { requireZeroTools: false },
  };
}
export const datasetV2 = {
  version: V2_DATASET_VERSION,
  sourceVersion: dataset.version,
  cases: [...inherited, diagnostic("E13"), diagnostic("E14")],
};
