import "server-only";
import { traced } from "../runs/runs";
import { currentRun } from "@tripquest/agent/runs";
import { requireOwner } from "../auth/owner";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  draftCity,
  draftMissing,
  type ConversationRepository,
  type NewMessage,
  type RequirementsDraft,
} from "@tripquest/application/conversation";
import { createDayPlanningProblem, type DayDraft, type DayPlanningResult, type DayWeather } from "@tripquest/application/day-planning";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { fingerprint } from "@tripquest/application/fingerprint";
import { DEFAULT_TRAVEL, planningRequirementsSchema, type PlanningRequirements } from "@tripquest/application/planning";
import { visitStay } from "@tripquest/application/outing-allocation";
import { createDayPlanningRunner, DayRunError } from "@tripquest/agent/day-planning";
import { createDayLiveModel } from "@tripquest/agent/day-live";
import { createCandidateRunner } from "@tripquest/agent/short";
import { createShortLiveModel } from "@tripquest/agent/short-live";
import { DrizzleConversationRepository, DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { MobilityProvider, PlaceLookupProvider, PlaceSummary, WeatherProvider } from "@tripquest/providers";
import { createDraftSaveOffer } from "../planning/new/draft-receipt";
import { readRealPlaceMode } from "../real-places/real-mode";
import { createUserUsage, meteredAmap, meteredJevPicker } from "../usage/usage";
import { cardView, readChatAvailability } from "./conversation-service";
import { createReviewRequest } from "@tripquest/agent/outing-review-live";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import { createShortService } from "./short-service";
import { createAdjustService } from "./adjust-service";
import { createOutingChangeService, createOutingGeneration, createReviewDecision } from "./outing-service";
import { readDraftSaveConfig, verifyDraftReceipt } from "../planning/new/draft-receipt";
import type { RealDayAdjustRepository } from "@tripquest/application/real-adjust";
import {
  freeTime,
  type ChatMessageView,
  type ChoicesView,
  type LegView,
  type MapPath,
  type MapStop,
  type PlanCardView,
  type ProgressStep,
} from "./view-models";

type Amap = MobilityProvider & PlaceLookupProvider & WeatherProvider;
type Runner = ReturnType<typeof createDayPlanningRunner>;

export interface PlanServiceOptions {
  /** V2.12：当前用户（接口从会话取得）；仓库只读写这个用户的数据。 */
  userId?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  repository?: () => ConversationRepository;
  /** 测试注入提供方与 runner；默认构建的实时依赖先经本地每日用量账本预留额度。 */
  amap?: () => Amap;
  runner?: (amap: Amap) => Promise<Runner>;
  /** 短途候选选择使用实时模型，与规划模型一样记录调用用量。 */
  candidates?: (amap: Amap) => Promise<ReturnType<typeof createCandidateRunner>>;
  /** V3.2：测试注入审查 Agent 的请求。 */
  reviewer?: () => Promise<ReviewRequest | undefined>;
  /** 读取已保存真实行程，供调整链路使用。 */
  journeys?: () => RealDayAdjustRepository;
  workspaceRoot?: string;
}

export type PlanEvent =
  | { type: "step"; step: ProgressStep }
  | {
      type: "done";
      messageCount: number;
      messages: ChatMessageView[];
      plan: PlanCardView | null;
      mapStops: MapStop[];
      mapPaths: MapPath[];
      receipt: { receipt: string; expiresAt: string } | null;
      /** 本轮已回答的短途步骤，返回后在页面原位置更新，避免追加成另一组候选。 */
      updated?: ChoicesView;
    }
  | { type: "refused"; status: "conflict" | "not_found" | "unavailable" | "incomplete"; message: string };

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** 用日期与兴趣生成简短标题，控制长度以适配行程列表。 */
export function planTitle(draft: RequirementsDraft): string {
  const [, month, day] = (draft.date ?? "").split("-").map(Number);
  const theme = draft.interests.slice(0, 2).map((item) => item.text).join("、");
  return `${month}月${day}日 · ${theme || `${draftCity(draft).name.replace(/市$/, "")}一日`}`.slice(0, 80);
}

export function createPlanService(options: PlanServiceOptions = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const root = options.workspaceRoot ?? resolve(process.cwd(), "../..");
  const repository = () => options.repository?.() ??
    new DrizzleConversationRepository(getSharedJourneyDatabase().database, owner());
  const amap = (): Amap => {
    if (options.amap) return options.amap();
    const mode = readRealPlaceMode(environment());
    if (!mode.enabled) throw new Error("real mode disabled");
    return meteredAmap({ key: mode.key, usage: createUserUsage(owner(), now), purpose: "plan", now });
  };

  async function runner(provider: Amap): Promise<Runner> {
    if (options.runner) return options.runner(provider);
    const env = environment();
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
    const config: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    const ledger = createUserUsage(owner(), now);
    const model = createDayLiveModel({
      config,
      profileId: env.AGENT_MODEL_PROFILE ?? "",
      environment: env,
      beforeRequest: async () => {
        try {
          await ledger.reserve("model", "model", "plan");
        } catch {
          throw new DayRunError("live_budget");
        }
      },
    });
    return createDayPlanningRunner({ provider, model, now });
  }

  /** 模型预算不足时，候选选择退回附近排序，仍需后续确定性规划校验。 */
  async function candidates(provider: Amap) {
    if (options.candidates) return options.candidates(provider);
    const env = environment();
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
    const config: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    const ledger = createUserUsage(owner(), now);
    const model = createShortLiveModel({
      config,
      profileId: env.AGENT_MODEL_PROFILE ?? "",
      environment: env,
      beforeRequest: () => ledger.reserve("model", "model", "plan"),
    });
    const picker = meteredJevPicker({ environment: env, usage: ledger });
    return createCandidateRunner({ provider, model, ...(picker ? { picker } : {}) });
  }
  const short = createShortService({ environment, now, repository, amap, candidates });
  const journeys = () => options.journeys?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner());
  const adjustments = createAdjustService({ environment, now, repository, journeys, amap, runner, candidates });
  // V3.2：审查改过的卡片和别处一样带指纹（页面之后的“重排这一天”、编辑按它核对）；出游卡片没有单日天气。
  const reviewedCard = async (draft: RequirementsDraft) => ({ ...cardView(draft, now(), null), fingerprint: fingerprint(draft) });
  // V3.2：出游排完后的审查（OUTING_REVIEW=off 关掉）：审查 Agent 的请求记在模型额度上。
  async function reviewer() {
    if (options.reviewer) return options.reviewer();
    if (options.runner) return undefined;
    const env = environment();
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
    const config: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    const ledger = createUserUsage(owner(), now);
    return createReviewRequest({
      config,
      profileId: env.AGENT_MODEL_PROFILE ?? "",
      environment: env,
      beforeRequest: () => ledger.reserve("model", "model", "outing-review"),
    });
  }
  const outing = createOutingGeneration({
    now, environment, repository, amap, runner, planOutcome, reviewer,
    cardView: reviewedCard,
  });
  // V2.11 跨天改动：重排用规划额度，确认时复查路线用保存额度（同一日的保存）。
  const outingChange = createOutingChangeService({
    now, environment, repository, amap, runner, planOutcome, reviewer,
    journeys: () => new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner()),
    // 测试注入了地图时，确认时复查路线也用它。
    routes: () => {
      if (options.amap) return options.amap();
      const mode = readRealPlaceMode(environment());
      if (!mode.enabled) throw new Error("real mode disabled");
      return meteredAmap({ key: mode.key, usage: createUserUsage(owner(), now), purpose: "save", now });
    },
    verify: (receipt, at) => verifyDraftReceipt(receipt, readDraftSaveConfig(environment()).secret, at),
    saveEnabled: () => readDraftSaveConfig(environment()).enabled,
  });

  /** 按已确认需求卡补查实时地点，再执行规划并推送进度，最后保存最小过程摘要与方案卡。 */
  async function plan(conversationId: string, expectedFingerprint: string, emit: (event: PlanEvent) => void, signal: AbortSignal) {
    const refuse = (status: Extract<PlanEvent, { type: "refused" }>["status"], message: string) =>
      emit({ type: "refused", status, message });
    if (!readChatAvailability(environment()).enabled && !options.runner) {
      return refuse("unavailable", "对话规划暂不可用。");
    }
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return refuse("not_found", "找不到这段对话了。");
    currentRun()?.root.link({ conversationId });
    const { draft } = found.conversation;
    if (fingerprint(draft) !== expectedFingerprint) return refuse("conflict", "需求卡片刚更新过，请看一下最新的卡片再开始。");
    const missing = draftMissing(draft);
    if (missing.length) return refuse("incomplete", `还需要：${missing.join("、")}`);
    // V2.11：出游逐天生成走 /outing（每天一条消息）。
    if (draft.mode === "outing") return refuse("unavailable", "出游请按天生成。");
    // 短途按兴趣逐步选择，不在第一步就代替用户决定全部活动。
    if (draft.mode === "short") return short.start(conversationId, found, emit, signal);

    const provider = amap();
    const steps: { key: string; text: string }[] = [];
    const step = (text: string) => {
      if (steps.at(-1)?.text === text) return;
      const next = { key: `s${steps.length + 1}`, text };
      steps.push(next);
      emit({ type: "step", step: { ...next, state: "active" } });
    };

    step("按地点编号查询最新的地点信息");
    // 卡片只长期保留地点编号与名称，不能直接当规划事实；生成前按编号补查坐标、营业等信息。
    // 真实数据留在这次请求内，演示任务的持久检查点链路不接收这份真实地点快照。
    const built = await buildRequirements(draft, provider, signal, now);
    let result: DayPlanningResult | null = null;
    let snapshot: DayDraftConfirmationSnapshot | null = null;
    // 地图路线只属于本次响应，不写入对话记录（D-046）。
    const paths = new Map<string, readonly (readonly [number, number])[]>();
    let problem: ReturnType<typeof createDayPlanningProblem> | null = null;
    if (built.status === "ok") {
      if (built.weather) step(built.weather.wet ? `当天有${built.weather.dayWeather}，会优先考虑室内` : `当天${built.weather.dayWeather}`);
      problem = createDayPlanningProblem({
        requirements: built.requirements,
        runId: randomUUID(),
        requirementsFingerprint: fingerprintRequirements(built.requirements),
        nowMs: now(),
        weather: built.weather,
        // 优先延后上一站离开时间，减少到下一站门口等待。
        leaveLate: true,
      });
      try {
        result = await (await runner(provider)).run(problem, {
          signal,
          onProgress: (progress) => {
            if (progress.detail) step(progress.detail);
          },
          onDraftReady: (ready) => (snapshot = ready),
          onRoutePath: (from, to, path) => paths.set(`${from}>${to}`, path),
        });
      } catch {
        result = null;
      }
      if (result?.status === "completed" && result.explanation.includes("没能给出最终确认") && environment().NODE_ENV === "development") {
        console.warn("[plan] model did not finish; kept a verified attempt");
      }
      if (result?.status === "failed" && environment().NODE_ENV === "development") {
        // 日志只记录错误代码，不输出需求或地点详情。
        console.warn(`[plan] run failed: ${result.code}; hints ${result.hints?.join(", ") ?? "none"}; counts ${JSON.stringify(result.counts)}`);
      }
    }

    // 保存规划过程的最小摘要，再保存方案或如实说明未生成的原因。
    const messages: NewMessage[] = [];
    let planView: PlanCardView | null = null;
    let mapStops: MapStop[] = [];
    let mapPaths: MapPath[] = [];
    let receipt: { receipt: string; expiresAt: string } | null = null;
    const outcome = result?.status === "completed" ? result.outcome : result?.status === "cancelled" ? "cancelled" : "failed";
    messages.push({ role: "assistant", kind: "planning_progress", body: { steps: steps.slice(-30), outcome } });
    // 确认快照还包含模型本轮新发现的地点，不能只从原需求卡取展示和保存所需信息。
    const ready = snapshot as DayDraftConfirmationSnapshot | null;
    if (result?.status === "completed" && result.outcome === "draft" && ready) {
      const done = await planOutcome({ result, snapshot: ready, title: planTitle(draft), paths, environment: environment(), nowMs: now() });
      ({ planView, mapStops, mapPaths, receipt } = done);
      messages.push({ role: "assistant", kind: "plan_card", body: done.body });
    } else {
      messages.push({ role: "assistant", kind: "notice", body: { text: noPlanText(built, result), tone: "warning" } });
    }

    // 先成功保存对话摘要，再发 done 让页面启用卡片；进度事件只是过程展示，不能代表结果已保存。
    const appended = await store.appendTurn({
      conversationId,
      expectedCount: found.conversation.messageCount,
      messages,
      now: new Date(now()),
      newId: randomUUID,
    });
    if (appended.status !== "appended") return refuse(appended.status, "这段对话在别处有了新消息，请刷新后再试。");
    const reread = await store.findConversation(conversationId);
    const fresh = reread?.messages.slice(found.conversation.messageCount) ?? [];
    emit({
      type: "done",
      messageCount: appended.messageCount,
      messages: fresh.flatMap((message): ChatMessageView[] => {
        if (message.kind === "planning_progress") {
          return [{ id: message.id, role: "assistant", kind: "planning_progress", running: false, steps: message.body.steps.map((item) => ({ ...item, state: "done" as const })) }];
        }
        if (message.kind === "plan_card" && planView) {
          return [{ id: message.id, role: "assistant", kind: "plan_card", plan: planView }];
        }
        if (message.kind === "notice") {
          return [{ id: message.id, role: "assistant", kind: "notice", text: message.body.text, tone: message.body.tone }];
        }
        return [];
      }),
      plan: planView,
      mapStops,
      mapPaths,
      receipt,
    });
  }

  /** 正式确认已保存行程后，再把行程 ID 关联回原对话的方案卡。 */
  async function markSaved(conversationId: string, runId: string, journeyId: string): Promise<"ok" | "not_found"> {
    const journeys = new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner());
    const created = await journeys.findRealDayCreation(runId);
    if (!created || created.journeyId !== journeyId) return "not_found";
    const marked = await repository().markPlanSaved({ conversationId, runId, journeyId, now: new Date(now()) });
    return marked.status === "updated" ? "ok" : "not_found";
  }

  // V3.0：每个入口一个根运行（stages/V3.0.md §3.3）；运行在入口确认对话属于这个用户后再挂上对话。
  const entry = <A extends unknown[], R>(trigger: string, operation: (...args: A) => Promise<R>) =>
    (...args: A) => traced({ trigger, userId: options.userId ?? null }, () => operation(...args));
  return {
    plan: entry("plan", plan),
    markSaved,
    outing: entry("outing_generate", outing),
    outingChange: entry("outing_change", outingChange.plan),
    confirmOutingChange: entry("save", outingChange.confirm),
    choose: entry("short_step", short.choose),
    adjust: entry("adjust", adjustments.adjust),
    confirmAdjust: entry("save", adjustments.confirm),
    decideReview: entry("edit_card", createReviewDecision({ now, repository, cardView: reviewedCard })),
  };
}

/** 一日和短途共用的草案收口：生成页面卡片、最小存储正文、临时地图数据及保存凭据。 */
export async function planOutcome(input: {
  result: Extract<DayPlanningResult, { status: "completed"; outcome: "draft" }>;
  snapshot: DayDraftConfirmationSnapshot;
  title: string;
  paths: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  environment: NodeJS.ProcessEnv;
  nowMs: number;
}) {
  const { result, snapshot, title } = input;
  const places = new Map(snapshot.places.map((item) => [item.placeId, item.selection.place]));
  const mapPaths: MapPath[] = result.draft.legs.flatMap((leg) => {
    const points = input.paths.get(`${leg.fromPlaceId}>${leg.toPlaceId}`);
    return points?.length ? [{ mode: leg.mode ?? "walking", points }] : [];
  });
  const offer = await createDraftSaveOffer(snapshot, result, { environment: input.environment, now: input.nowMs });
  if (offer.status !== "available" && input.environment.NODE_ENV === "development") console.warn(`[plan] no save offer: ${offer.reason}`);
  return {
    planView: toPlanView(result.draft, title),
    body: toPlanBody(result.draft, title, places),
    mapStops: toMapStops(result.draft, places),
    mapPaths,
    receipt: offer.status === "available" ? { receipt: offer.receipt, expiresAt: offer.expiresAt } : null,
  };
}

type Built =
  | { status: "ok"; requirements: PlanningRequirements; weather?: DayWeather }
  | { status: "places_missing"; names: string[] }
  | { status: "unavailable" };

/** 将需求卡转换成排程需求，每个已绑定地点都按 ID 实时补查，不能从持久数据恢复旧坐标。 */
async function buildRequirements(draft: RequirementsDraft, amap: Amap, signal: AbortSignal, now: () => number): Promise<Built> {
  const bound = (place: RequirementsDraft["start"]) => (place?.status === "bound" ? place : null);
  const named = [bound(draft.start)!, bound(draft.end)!, ...draft.visits.map((visit) => bound(visit.place)!)];
  const ids = [...new Set(named.map((place) => place.externalId))];
  const found = new Map<string, PlaceSummary>();
  let retrievedAt = new Date(now()).toISOString();
  for (let index = 0; index < ids.length; index += 10) {
    const reply = await amap.findPlacesById(ids.slice(index, index + 10), { signal });
    if (reply.status !== "ok") return { status: "unavailable" };
    for (const item of reply.data.items) found.set(item.ref.externalId, item);
    retrievedAt = reply.evidence.retrievedAt;
  }
  // 按 ID 查不到的地点不能凭卡片旧名称继续排；明确列出缺失项，让用户重新选择。
  const lost = named.filter((place) => !found.has(place.externalId)).map((place) => place.name);
  if (lost.length) return { status: "places_missing", names: [...new Set(lost)] };
  const selection = (externalId: string) => ({
    place: found.get(externalId)!,
    evidence: { provider: "amap", sourceKind: "live" as const, retrievedAt, attribution: "高德地图" },
  });
  // V2.10：城市和天气都按卡片的主要城市（一天跨出城市时仍按它）。
  const city = draftCity(draft);
  let weather: DayWeather | undefined;
  const forecast = await amap.getWeatherForecast(city.adcode, { signal }).catch(() => null);
  const day = forecast?.status === "ok" ? forecast.data.days.find((item) => item.date === draft.date) : undefined;
  if (day) {
    weather = { dayWeather: day.dayWeather, nightWeather: day.nightWeather, highCelsius: day.highCelsius, lowCelsius: day.lowCelsius, wet: day.wet, ...(day.windy ? { windy: true } : {}) };
  }
  // 地点查询成功后还要过需求的跨字段约束，时间窗、固定事项和兴趣数量才成为排程器可信输入。
  const parsed = planningRequirementsSchema.safeParse({
    schemaVersion: "planning-requirements.v1",
    cityAdcode: city.adcode,
    cityName: city.name,
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: draft.date,
    window: { startsAt: draft.startsAt, endsAt: draft.endsAt },
    startPlace: selection(bound(draft.start)!.externalId),
    endPlace: selection(bound(draft.end)!.externalId),
    interests: [],
    ...(draft.interests.length ? { freeInterests: draft.interests } : {}),
    ...(draft.notes ? { notes: draft.notes } : {}),
    // 用户未主动更改时沿用卡片已展示的推荐交通偏好，避免生成时悄悄切换默认值。
    travel: draft.travel ?? DEFAULT_TRAVEL,
    pace: draft.pace,
    visits: draft.visits.map((visit) => visit.role === "fixed"
      ? { place: selection(bound(visit.place)!.externalId), role: "fixed", startsAt: visit.startsAt, endsAt: visit.endsAt }
      : (() => {
        const place = selection(bound(visit.place)!.externalId);
        // V2.11：卡片上估计的停留排不下时可以缩短（stages/V2.11.md §3.2）；验收复测后没写停留的按类型估计（同出游），
        // 以前一律 60 分钟。
        const stay = visitStay(visit, place.place.categoryCode);
        return {
          place,
          role: visit.role,
          stayMinutes: stay.stayMinutes,
          ...(stay.floor !== undefined ? { staySource: "estimate" as const, ...(stay.kind ? { kind: stay.kind } : {}) } : {}),
        };
      })()),
  });
  return parsed.success ? { status: "ok", requirements: parsed.data, weather } : { status: "unavailable" };
}

function noPlanText(built: Built, result: DayPlanningResult | null): string {
  if (built.status === "places_missing") return `高德上已经查不到：${built.names.join("、")}。可以跟我说换一个地方。`;
  if (built.status === "unavailable") return "暂时查不到地点的最新信息，请稍后再试。";
  if (!result) return "规划服务暂时出错，请稍后再试。";
  if (result.status === "completed" && result.outcome === "no_plan") {
    return result.reason === "constraints_not_met"
      ? "按现在的时间和预约排不开。可以放宽结束时间、减少想去的地方，或者把某个必去改成想去。"
      : result.reason === "no_suitable_places"
        ? "附近没找到合适的地方，可以换个说法描述兴趣，或者告诉我具体想去哪。"
        : "有些路线或信息查不到，暂时给不出可靠的安排，请稍后再试。";
  }
  if (result.status === "failed" && result.code === "live_budget") return "今天的规划次数已用完，明天再来吧。";
  if (result.status === "cancelled") return "这次规划已取消。";
  return "这次没能排出方案，请稍后再试一次。";
}

/** 本次页面的完整计划可以展示实时交通数字，但这个展示对象不直接用于长期存储。 */
function toPlanView(draft: DayDraft, title: string): PlanCardView {
  const name = (placeId: string) => draft.places.find((place) => place.placeId === placeId)?.name ?? "地点";
  const leg = (index: number): LegView | null => {
    const item = draft.legs[index];
    if (!item) return null;
    if (item.source === "same_place_assumption") return { mode: "walking", minutes: 0, samePlace: true };
    return {
      mode: item.mode ?? "walking",
      minutes: item.travelMinutes,
      ...(item.fareYuan !== undefined ? { fareYuan: item.fareYuan } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
    };
  };
  const pending = draft.checks.some((check) => check.kind === "unknown") ? ["营业时间和门票请出发前确认"] : [];
  if (draft.activities.some((activity) => activity.role === "fixed")) pending.push("预约时间以你的预约为准");
  if (draft.legs.some((item) => item.mode && item.mode !== "walking")) pending.push("公交、打车的时间和费用是估计，出发前可再看一眼");
  const priced = draft.legs.filter((item) => item.mode === "transit" || item.mode === "taxi");
  return {
    runId: draft.runId,
    title,
    date: draft.date,
    startName: draft.startPlace.name,
    endName: draft.endPlace.name,
    // 时间窗是允许范围，实际出发可更晚；首站前的空档不算作在地点等待。
    departAt: clock(draft.legs[0]?.departsAt ?? draft.window.startsAt),
    arriveAt: clock(draft.endArrival),
    travelBeforeEnd: leg(draft.legs.length - 1),
    totals: {
      travelMinutes: draft.totalWalkingMinutes,
      fareYuan: Math.round(priced.reduce((sum, item) => sum + (item.fareYuan ?? 0), 0)),
      fareUnknown: priced.some((item) => item.fareYuan === undefined),
    },
    stops: draft.activities.map((activity, index) => ({
      key: activity.activityId,
      startsAt: clock(activity.startsAt),
      endsAt: clock(activity.endsAt),
      name: name(activity.placeId),
      role: activity.role,
      ...(activity.reason ? { reason: activity.reason } : {}),
      ...alertFor(draft, activity.activityId),
      travelBefore: leg(index),
      waitMinutes: activity.waitMinutes,
      ...freeTime(index > 0 ? draft.legs[index].departsAt - draft.activities[index - 1].endsAt : 0),
    })),
    notes: planNotes(draft),
    pending,
    saved: null,
    live: true,
  };
}

/** V2.10：户外的站遇到坏天气时的提示（只在本次实时方案上显示，不进存档）。 */
function alertFor(draft: DayDraft, activityId: string): { alert?: string } {
  const found = draft.alerts?.find((item) => item.activityId === activityId);
  return found ? { alert: `预报${found.weather}，${found.advice}` } : {};
}

function planNotes(draft: DayDraft): string[] {
  const notes: string[] = [];
  if (draft.assumptions.some((item) => item.includes("餐饮"))) notes.push("午饭和休息没有单独安排，可以在途中解决");
  if (draft.omittedOptional.length) notes.push(`没排进去的：${draft.omittedOptional.map((item) => item.name).join("、")}`);
  return notes;
}

/** 长期存储只留下地点编号、名称、自有安排时间与理由；实时交通数字不进入正文（D-046）。 */
function toPlanBody(draft: DayDraft, title: string, places: ReadonlyMap<string, PlaceSummary>) {
  const externalId = (placeId: string) => places.get(placeId)!.ref.externalId;
  const name = (placeId: string) => draft.places.find((place) => place.placeId === placeId)?.name ?? "地点";
  return {
    runId: draft.runId,
    title,
    date: draft.date,
    // 时间窗是允许范围，实际出发可更晚；首站前的空档不算作在地点等待。
    departAt: clock(draft.legs[0]?.departsAt ?? draft.window.startsAt),
    arriveAt: clock(draft.endArrival),
    start: { externalId: externalId(draft.startPlace.placeId), name: draft.startPlace.name.slice(0, 80) },
    end: { externalId: externalId(draft.endPlace.placeId), name: draft.endPlace.name.slice(0, 80) },
    ...(draft.legs.at(-1)?.mode && draft.legs.at(-1)!.mode !== "walking" ? { endArrivalMode: draft.legs.at(-1)!.mode } : {}),
    stops: draft.activities.map((activity, index) => ({
      ...(draft.legs[index]?.mode && draft.legs[index].mode !== "walking" ? { arrivalMode: draft.legs[index].mode } : {}),
      externalId: externalId(activity.placeId),
      name: name(activity.placeId).slice(0, 80),
      startsAt: clock(activity.startsAt),
      endsAt: clock(activity.endsAt),
      role: activity.role,
      ...(activity.reason ? { reason: activity.reason } : {}),
    })),
    notes: planNotes(draft),
    journeyId: null,
  };
}

/** 地图坐标仅供本次响应渲染。 */
function toMapStops(draft: DayDraft, places: ReadonlyMap<string, PlaceSummary>): MapStop[] {
  const stop = (key: string, label: string, kind: MapStop["kind"], placeId: string): MapStop[] => {
    const place = places.get(placeId);
    return place
      ? [{ key, label, kind, name: place.name, longitude: place.location.longitude, latitude: place.location.latitude }]
      : [];
  };
  return [
    ...stop("start", "起", "start", draft.startPlace.placeId),
    ...draft.activities.flatMap((activity, index) => stop(activity.activityId, String(index + 1), "stop", activity.placeId)),
    // 短途最后一站与终点重合时只画一次，避免重复标记。
    ...(draft.activities.at(-1)?.placeId === draft.endPlace.placeId ? [] : stop("end", "终", "end", draft.endPlace.placeId)),
  ];
}
