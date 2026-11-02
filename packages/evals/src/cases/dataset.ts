import type { BaselinePlanningInput, ChinaDateTime, PlannedActivity } from "@tripquest/domain";
import type { ProviderEvidence, RouteResult } from "@tripquest/providers";
import type { Dataset, EvaluationCase, HumanExpectation, RouteWorldEntry } from "../contracts";

export const DATASET_VERSION = "s4.1-hand-authored-v1";
export const at = (time: string): ChinaDateTime => `2026-10-15T${time}:00+08:00`;
export const FIXTURE_EVIDENCE: ProviderEvidence = {
  provider: "tripquest-eval-fixture", sourceKind: "fixture", retrievedAt: at("14:30"),
  attribution: "TripQuest 人工离线评估数据，全部虚构", datasetVersion: DATASET_VERSION,
};
export function syntheticRoute(seconds: number): RouteResult {
  return { status: "ok", routes: [{ mode: "walking", durationSeconds: seconds, distanceMeters: 3200 }], evidence: { ...FIXTURE_EVIDENCE } };
}
function activity(id: string, placeId: string, start: string, end: string): PlannedActivity {
  return { id, placeId, startsAt: at(start), endsAt: at(end), priority: "normal", locked: false };
}
/** Own objects, written independently of domain referenceCases and the tested generator. */
export function baseInput(resume = "15:30"): BaselinePlanningInput {
  return {
    plan: { journeyId: "eval-fiction", version: 1, date: "2026-10-15", timeZone: "Asia/Shanghai", activities: [
      activity("A", "P-A", "09:00", "10:00"), activity("B", "P-B", "12:00", "13:00"),
      activity("C", "P-C", "15:00", "16:00"),
      { ...activity("D", "P-D", "18:00", "19:00"), priority: "high", locked: true, reservationId: "R-D" },
    ] },
    state: { journeyId: "eval-fiction", version: 1, completedActivityIds: ["A", "B"], skippedActivityIds: [], currentActivityId: null, observedAt: at("14:30"), location: { kind: "known", placeId: "P-C" } },
    request: { id: "eval-request", journeyId: "eval-fiction", basePlanVersion: 1, baseStateVersion: 1, delay: { observedAt: at("14:30"), earliestResumeAt: at(resume) }, scope: { kind: "selected_window", window: { startsAt: at("15:00"), endsAt: at("18:00") } } },
    reservations: [{ id: "R-D", placeId: "P-D", startsAt: at("18:00"), endsAt: at("19:00"), confirmation: { status: "confirmed", recordedAt: at("08:00"), source: { kind: "fixture", reference: "人工预约" } } }],
    travelLegs: [{ fromPlaceId: "P-C", toPlaceId: "P-D", duration: { kind: "known", minutes: 40 } }],
    transferBufferMinutes: 10,
  };
}
// Human schedules: constants here are the oracle, not generated planner output.
function schedule(strategy: "keep" | "shift" | "omit"): readonly PlannedActivity[] {
  const entries = baseInput().plan.activities;
  return entries.filter((a) => strategy !== "omit" || a.id !== "C").map((a) =>
    a.id === "C" && strategy === "shift" ? { ...a, startsAt: at("15:30"), endsAt: at("16:30") } : { ...a });
}
function found(strategy: "keep" | "shift" | "omit", arrival: string, reasoning: string, calls = 0): HumanExpectation {
  return { status: "candidate_found", strategy, activities: schedule(strategy), arrival: { activityId: "D", at: at(arrival) }, calls, requiredIssues: [], reasoning };
}
function noCandidate(status: HumanExpectation["status"], issue: HumanExpectation["requiredIssues"][number], reasoning: string, calls = 0): HumanExpectation {
  return { status, requiredIssues: [issue], calls, reasoning };
}
function entry(id: string, title: string, input: BaselinePlanningInput, rules: HumanExpectation, fixed = rules, world: readonly RouteWorldEntry[] = []): EvaluationCase {
  return { id, title, source: "hand_authored_fiction", input, world, expected: { rules_only: structuredClone(rules), fixed_workflow: structuredClone(fixed) } };
}
const unknownInput = (): BaselinePlanningInput => ({ ...baseInput(), travelLegs: [] });
const missing = (reasoning: string, calls = 0) => noCandidate("needs_information", "unknown_travel_duration", reasoning, calls);
const world = (result: RouteResult): RouteWorldEntry[] => [{ fromPlaceId: "P-C", toPlaceId: "P-D", result }];
const e08 = baseInput();
const e09 = baseInput();
const e10 = baseInput();
const e11 = baseInput();
const e12 = baseInput("17:10");
export const dataset: Dataset = {
  version: DATASET_VERSION,
  cases: [
    entry("E01", "原计划已可行", baseInput("14:30"), found("keep", "16:50", "观察点已在 P-C；C 保持 15:00–16:00；16:00 + 40 分交通 + 10 分缓冲 = 16:50 ≤ 18:00。A/B 已完成，D 不动。")),
    entry("E02", "15:30 延误后顺延", baseInput(), found("shift", "17:20", "keep 早于恢复时间；C 顺延到 15:30–16:30，16:30 + 40 + 10 = 17:20 ≤ 18:00。优先保留 C。")),
    entry("E03", "省略后恰好 18:00", baseInput("17:10"), found("omit", "18:00", "C 持续一小时，顺延到 18:10 越出范围；normal 可省略。观察点 P-C 17:10 + 40 + 10 = 18:00，恰好赶上 D。")),
    entry("E04", "省略后仍迟到一分钟", baseInput("17:11"), noCandidate("no_feasible_candidate", "travel_conflict", "shift 到 18:11 越界；omit 后 17:11 + 40 + 10 = 18:01 > 18:00。仅证明 keep/shift/omit 受限策略无候选。")),
    entry("E05", "补查未知交通后顺延", unknownInput(), missing("C→D 未知，shift 和从观察点直接 omit 都依赖 C→D，不能证明可行。"), found("shift", "17:20", "工具 2400 秒 = 40 分；16:30 + 40 + 10 = 17:20。仅补路线，没有模型决策。", 1), world(syntheticRoute(2400))),
    entry("E06", "超时不能补零", unknownInput(), missing("C→D 未知，两个可行策略都依赖它。"), missing("合成 timeout 未提供分钟；shift/omit 仍未知，不重试、不补零。", 1), world({ status: "failure", failure: { code: "timeout", retry: "after_backoff", safeMessage: "合成超时，没有真实等待。" }, evidence: { ...FIXTURE_EVIDENCE } })),
    entry("E07", "无路线且反向不可借用", { ...unknownInput(), travelLegs: [{ fromPlaceId: "P-D", toPlaceId: "P-C", duration: { kind: "known", minutes: 40 } }] }, missing("只知道 D→C，不能倒用为 C→D；shift/omit 缺信息。"), missing("C→D 返回 no_path，仍未知；D→C 的 known 保留但不能逆用。", 1), world({ status: "no_route", reason: "no_path", evidence: { ...FIXTURE_EVIDENCE } })),
    entry("E08", "观察位置未知", { ...e08, state: { ...e08.state, location: { kind: "unknown", reason: "未报告" } } }, noCandidate("needs_information", "unknown_location", "不知道从哪里出发；路线工具不能回答用户位置，零查询。")),
    entry("E09", "预约未确认", { ...e09, reservations: e09.reservations.map((r) => ({ ...r, confirmation: { ...r.confirmation, status: "pending" as const } })) }, noCandidate("needs_information", "reservation_unverified", "pending 预约不是 confirmed；路线不能确认预约，零查询。")),
    entry("E10", "过期基础版本", { ...e10, request: { ...e10.request, basePlanVersion: 2 } }, noCandidate("request_not_current", "stale_base", "当前计划 v1，请求绑定 v2，版本不一致；不查询、不改版本。")),
    entry("E11", "两项活动超出内核能力", { ...e11, plan: { ...e11.plan, activities: [...e11.plan.activities.slice(0, 3), activity("C2", "P-C", "16:00", "17:00"), e11.plan.activities[3]] } }, noCandidate("unsupported_scenario", "delay_conflict", "keep 在 15:00 开始早于 15:30；范围内有 C/C2 两项可改活动，内核只支持一项。")),
    entry("E12", "高优先级不可省略", { ...e12, plan: { ...e12.plan, activities: e12.plan.activities.map((a) => a.id === "C" ? { ...a, priority: "high" as const } : a) } }, noCandidate("no_feasible_candidate", "delay_conflict", "keep 早于 17:10，shift 结束 18:10 越界；C 为 high 不可 omit。不能删它凑出候选。")),
  ],
};
