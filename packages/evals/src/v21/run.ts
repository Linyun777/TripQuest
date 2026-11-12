import { evalChatRouter } from "../v293/chat-router";
import { randomUUID } from "node:crypto";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { createDayPlanningProblem, type DayDraft, type DayPlanningResult } from "@tripquest/application/day-planning";
import { withParking } from "@tripquest/application/leg-choice";
import { withEarlyStart } from "@tripquest/application/planning";
import {
  confirmationInput,
  fingerprintRequirements,
  type DayDraftConfirmationSnapshot,
} from "@tripquest/application/day-confirmation";
import { createChatRunner, type ChatDecisionModel } from "@tripquest/agent/chat";
import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { sameDayPlace, validateDayDraft, type DayRoute, type DaySchedule } from "@tripquest/domain";
import type { IntakeCase, IntakeTurnOutcome } from "./intake-dataset";
import { scoreIntent, type IntentScore } from "./intent-dataset";
import type { PlanCase } from "./plan-dataset";
import { FORECASTS, locatedDraft, V21_NOW, V21World, worldPlace } from "./world";
import { FakeWeb, INFO_WEB } from "./info-dataset";
import { FakeKnowledge, KNOWLEDGE_ON } from "./knowledge-dataset";

export type Policy = "scripted" | "live";

export interface IntakeRow {
  readonly suite: "intake";
  readonly caseId: string;
  readonly policy: "live" | "test";
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly modelRequests: number;
  readonly searches: number;
  readonly replies: readonly string[];
  /** 记录聊天实际发出的联网搜索；纯规划对话预期不应搜索。 */
  readonly webQueries?: readonly string[];
  /** V2.9：失败轮次的提示码（只有代码，没有内容），便于查原因。 */
  readonly failures?: readonly string[];
  /** V2.10：没通过时的卡片摘要（时间窗和兴趣原话、时段），便于查原因。 */
  readonly card?: { readonly window: string; readonly interests: readonly string[] };
}

/** 按多轮顺序调用产品聊天 runner，让后一轮使用前轮更新后的真实需求草案。 */
export async function runIntakeCase(item: IntakeCase, model: () => ChatDecisionModel, signal?: AbortSignal): Promise<IntakeRow> {
  const world = new V21World(FORECASTS[item.forecast]);
  const web = new FakeWeb();
  let draft: RequirementsDraft = locatedDraft();
  const history: { role: "user" | "assistant"; text: string }[] = [];
  const turns: IntakeTurnOutcome[] = [];
  let modelRequests = 0;
  const failures: string[] = [];
  for (const text of item.turns) {
    const result = await createChatRunner({
    ...evalChatRouter(),
    cities: world,
      model: model(),
      places: world,
      weather: world,
      ...(INFO_WEB ? { web } : {}),
      ...(KNOWLEDGE_ON ? { knowledge: new FakeKnowledge() } : {}),
    }).run(
      { draft, history, userText: text, nowMs: item.nowMs ?? V21_NOW },
      { signal: signal ?? new AbortController().signal },
    );
    modelRequests += result.counts.model;
    history.push({ role: "user", text });
    if (result.status === "completed") {
      draft = result.draft;
      history.push({ role: "assistant", text: result.reply.text });
      if (result.draftChanged) history.push({ role: "assistant", text: "（已更新需求卡片）" });
      turns.push({ reply: result.reply.text, asking: result.reply.asking, failed: result.reply.fallback });
    } else {
      turns.push({ reply: "", asking: false, failed: true });
      failures.push(`${result.code}: ${result.hints.join(", ")}`);
    }
  }
  const checks = item.checks.map((check) => ({ name: check.name, passed: check.test(draft, turns) }));
  return {
    suite: "intake",
    caseId: item.id,
    policy: "live",
    checks,
    passed: checks.every((check) => check.passed),
    modelRequests,
    searches: world.searches.length,
    replies: turns.map((turn) => turn.reply),
    webQueries: web.queries,
    ...(failures.length ? { failures } : {}),
    ...(checks.every((check) => check.passed) ? {} : {
      card: {
        window: `${draft.startsAt ?? "?"}-${draft.endsAt ?? "?"}`,
        interests: draft.interests.map((item) => `${item.text}${item.when ? `@${item.when}` : ""}`),
      },
    }),
  };
}

export interface PlanRow {
  readonly suite: "plan";
  readonly caseId: string;
  readonly policy: Policy;
  readonly outcome: "draft" | "no_plan" | "failed" | "cancelled";
  readonly expectedOutcome: PlanCase["expect"];
  readonly outcomeMatched: boolean;
  /** 至少有一个已选地点满足对应兴趣的数量，避免只按模型贴的兴趣标签算覆盖。 */
  readonly covered: number;
  readonly interests: number;
  /** 雨天新发现活动中室内项所占比例，分母只含发现项，不把用户原本指定地点混进来。 */
  readonly wetIndoor: { readonly indoor: number; readonly discovered: number } | null;
  readonly reasons: { readonly withReason: number; readonly discovered: number };
  readonly violations: readonly string[];
  readonly modelRequests: number;
  readonly searches: readonly string[];
  readonly totalWalkingMinutes: number | null;
  /** 步行负担仅计步行路段和公交内的步行，不能把全部交通时长当作步行。 */
  readonly walkingMinutes: number | null;
  readonly fareYuan: number | null;
  readonly legModes: readonly string[];
  readonly routeRequests: number;
  readonly stops: readonly string[];
  /** V4.2：方案里各站的地点编号、没排进去的“想去”地点和原因（规划可靠性题判分用）。 */
  readonly chosen?: readonly string[];
  readonly omitted?: readonly { readonly externalId: string; readonly reason: string }[];
  readonly fallback: boolean;
  readonly failureCode?: string;
  /** 以人工预设意图核对每个兴趣的站数和时段，不由解析后的需求反推标准答案。 */
  readonly intent?: IntentScore;
  /** 记录失败运行结束前被确定性工具拒绝的代码，不保留调用内容。 */
  readonly hints?: readonly string[];
  /** 报告展示已选活动的开始时间，格式为 HH:mm。 */
  readonly times?: readonly string[];
  /** 同时记录结束时间，便于发现固定事项被不当移动。 */
  readonly ends?: readonly string[];
  /** V2.10：每站停留分钟数（按地点编号），以及方案里带户外天气提示的地点编号。 */
  readonly stays?: Readonly<Record<string, number>>;
  readonly alerted?: readonly string[];
  /** V2.11：方案里的说明（假设与未核实项），用来看缩短了估计停留时有没有写明。 */
  readonly assumptions?: readonly string[];
}

/** 用独立事实重新查路线、运行领域校验并核对用户必去项，判分不依赖规划器自评。 */
export async function independentViolations(
  item: PlanCase,
  result: Extract<DayPlanningResult, { outcome: "draft" }>,
  snapshot: DayDraftConfirmationSnapshot | undefined,
): Promise<string[]> {
  if (!snapshot) return ["draft_without_snapshot"];
  const { draft } = result;
  const input = confirmationInput(snapshot, V21_NOW);
  const place = (id: string) => snapshot.places.find((entry) => entry.placeId === id)!.selection.place;
  // 重建一份独立的固定世界并重查路线，不能信任草稿自带的“校验通过”或模型填的分钟数。
  // 评分仍复用产品领域校验器，并另按手写真值检查必去和固定时间，避免只检查输出形状。
  const world = new V21World();
  const routes: DayRoute[] = [];
  for (const leg of draft.legs) {
    const from = input.places.find((entry) => entry.placeId === leg.fromPlaceId)!;
    const to = input.places.find((entry) => entry.placeId === leg.toPlaceId)!;
    if (sameDayPlace(from, to)) {
      routes.push({ fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId, status: "same_place_assumption" });
      continue;
    }
    // 按草案声明的交通方式重新查证，并沿用产品的停车耗时规则，保证比较口径一致。
    const reply = await world.findRoutes({
      origin: { place: place(leg.fromPlaceId).ref, location: place(leg.fromPlaceId).location },
      destination: { place: place(leg.toPlaceId).ref, location: place(leg.toPlaceId).location },
      mode: leg.mode ?? "walking",
      cityAdcode: "330100",
      departureAt: "2026-10-16T00:00:00+08:00",
    });
    if (reply.status !== "ok") {
      routes.push({ fromPlaceId: leg.fromPlaceId, toPlaceId: leg.toPlaceId, status: "unknown", reason: "no_route" });
      continue;
    }
    const route = withParking(reply.routes[0]);
    routes.push({
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      status: "known",
      durationSeconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
      provider: reply.evidence.provider,
      sourceKind: reply.evidence.sourceKind,
      retrievedAt: reply.evidence.retrievedAt,
    });
  }
  const schedule: DaySchedule = {
    activities: draft.activities.map((activity) => ({
      activityId: activity.activityId,
      placeId: activity.placeId,
      arrivesAt: activity.arrivesAt,
      startsAt: activity.startsAt,
      endsAt: activity.endsAt,
      waitMinutes: activity.waitMinutes,
    })),
    legs: draft.legs.map((leg) => ({
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      departsAt: leg.departsAt,
      arrivesAt: leg.arrivesAt,
      travelMinutes: leg.travelMinutes,
      bufferMinutes: leg.bufferMinutes,
      distanceMeters: leg.distanceMeters,
      source: leg.source,
    })),
    endArrival: draft.endArrival,
    totalWalkingMinutes: draft.totalWalkingMinutes,
    longestWalkingMinutes: draft.longestWalkingMinutes,
  };
  const found: string[] = validateDayDraft(input, schedule, routes).issues
    .filter((issue) => issue.kind === "violation" || issue.code === "day_route_unknown")
    .map((issue) => issue.code);
  const external = (placeId: string) => place(placeId).ref.externalId;
  for (const visit of item.requirements.visits) {
    if (visit.role === "optional") continue;
    const scheduled = draft.activities.find((activity) => external(activity.placeId) === visit.place.place.ref.externalId);
    if (!scheduled) found.push(`missing_${visit.role}`);
    else if (visit.role === "fixed") {
      const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
      if (scheduled.startsAt !== minutes(visit.startsAt) || scheduled.endsAt !== minutes(visit.endsAt)) found.push("fixed_time_changed");
    }
  }
  return found;
}

/** 通过产品规划器执行一次，再与用例单独保存的事实和预期比较。 */
export async function runPlanCase(
  item: PlanCase,
  policy: Policy,
  model?: () => DayPlanningDecisionModel,
  signal?: AbortSignal,
): Promise<PlanRow> {
  const world = new V21World(FORECASTS[item.forecast]);
  const forecast = FORECASTS[item.forecast].find((day) => day.date === item.date);
  // V4.2：同产品的日常规划，早上的固定事项来不及过去时提前出门。
  const requirements = withEarlyStart(item.requirements);
  const problem = createDayPlanningProblem({
    requirements,
    runId: randomUUID(),
    requirementsFingerprint: fingerprintRequirements(requirements),
    nowMs: V21_NOW,
    // 沿用对话规划器的延后离开策略，避免评测与实际产品使用不同排程参数。
    leaveLate: true,
    ...(forecast ? {
      weather: {
        dayWeather: forecast.dayWeather,
        nightWeather: forecast.nightWeather,
        highCelsius: forecast.highCelsius,
        lowCelsius: forecast.lowCelsius,
        wet: forecast.wet,
      },
    } : {}),
  });
  let snapshot: DayDraftConfirmationSnapshot | undefined;
  const decisionModel = policy === "live" && model ? model() : createDayScriptedModel();
  const result = await createDayPlanningRunner({ provider: world, model: decisionModel, now: () => V21_NOW }).run(problem, {
    signal: signal ?? new AbortController().signal,
    onProgress: () => {},
    onDraftReady: (ready) => (snapshot = ready),
  });
  const outcome = result.status === "completed" ? result.outcome : result.status;
  const interests = Object.keys(item.satisfiedBy).length;
  const base = {
    suite: "plan" as const,
    caseId: item.id,
    policy,
    outcome,
    expectedOutcome: item.expect,
    outcomeMatched: outcome === item.expect,
    interests,
    modelRequests: result.counts.model,
    searches: world.searches,
    ...(result.status === "failed" ? { failureCode: result.code, ...(result.hints?.length ? { hints: result.hints } : {}) } : {}),
  };
  if (result.status !== "completed" || result.outcome !== "draft") {
    return {
      ...base,
      covered: 0,
      wetIndoor: null,
      reasons: { withReason: 0, discovered: 0 },
      violations: [],
      totalWalkingMinutes: null,
      walkingMinutes: null,
      fareYuan: null,
      legModes: [],
      routeRequests: world.routes,
      stops: [],
      fallback: false,
    };
  }
  const externalOf = (placeId: string) => snapshot?.places.find((entry) => entry.placeId === placeId)?.selection.place.ref.externalId ?? "";
  const chosen = result.draft.activities.map((activity) => externalOf(activity.placeId));
  // 兴趣是否满足按手写的地点真值统计，不采用规划器自己给地点贴的兴趣标签。
  // 推荐质量、硬约束违反和请求成本分别记录；只生成了草稿不等于这一题做对。
  const covered = Object.values(item.satisfiedBy).filter((ids) => ids.some((id) => chosen.includes(id))).length;
  const discovered = result.draft.activities.filter((activity) => activity.role === "discovered");
  const wet = problem.weather?.wet ?? false;
  return {
    ...base,
    covered,
    wetIndoor: wet
      ? { indoor: discovered.filter((activity) => worldPlace(externalOf(activity.placeId)).indoor).length, discovered: discovered.length }
      : null,
    reasons: { withReason: discovered.filter((activity) => activity.reason).length, discovered: discovered.length },
    violations: await independentViolations(item, result, snapshot),
    totalWalkingMinutes: result.draft.totalWalkingMinutes,
    walkingMinutes: onFoot(result.draft),
    fareYuan: Math.round(result.draft.legs.reduce((total, leg) => total + (leg.fareYuan ?? 0), 0) * 10) / 10,
    legModes: result.draft.legs.map((leg) => leg.mode ?? "walking"),
    routeRequests: world.routes,
    stops: chosen.map((id) => worldPlace(id).name),
    chosen,
    omitted: result.draft.omittedOptional.map((item) => ({
      externalId: externalOf(snapshot?.activities.find((record) => record.activity.activityId === item.activityId)?.activity.placeId ?? ""),
      reason: item.reason,
    })),
    fallback: result.explanation.includes("没能给出最终确认"),
    ...(item.intents ? {
      intent: scoreIntent(item, result.draft.activities.map((activity) => ({
        externalId: externalOf(activity.placeId),
        startsAt: activity.startsAt,
        endsAt: activity.endsAt,
        waitMinutes: activity.waitMinutes,
      }))),
    } : {}),
    times: result.draft.activities.map((activity) => clock(activity.startsAt)),
    ends: result.draft.activities.map((activity) => clock(activity.endsAt)),
    stays: Object.fromEntries(result.draft.activities.map((activity) => [externalOf(activity.placeId), activity.endsAt - activity.startsAt])),
    // V2.10 起方案带 alerts（户外天气提示，按活动）；之前的产品没有这个字段。
    alerted: ((result.draft as { alerts?: readonly { activityId: string }[] }).alerts ?? []).map((alert) =>
      externalOf(result.draft.activities.find((activity) => activity.activityId === alert.activityId)?.placeId ?? "")),
    assumptions: result.draft.assumptions,
  };
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 步行分钟数包含纯步行路段，以及按约 80 米/分钟折算的公交内步行。 */
function onFoot(draft: DayDraft): number {
  return draft.legs.reduce((total, leg) => {
    if (!leg.mode || leg.mode === "walking") return total + (leg.travelMinutes ?? 0);
    if (leg.mode === "transit") return total + Math.ceil((leg.walkingMeters ?? 0) / 80);
    return total;
  }, 0);
}
