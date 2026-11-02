import "server-only";
import { currentRun } from "@tripquest/agent/runs";
import { hasSavedOuting, savedOuting, type OutingReader } from "./outing-service";
import { randomUUID } from "node:crypto";
import type { AdjustTripRequest, ChatTrip } from "@tripquest/agent/chat";
import type { StoredJourney } from "@tripquest/application";
import type { ConversationRepository, NewMessage, StoredMessage } from "@tripquest/application/conversation";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { createDayPlanningProblem, type DayPlanningResult, type DayWeather } from "@tripquest/application/day-planning";
import { planningPlaceSchema, type PlanningPlace, type PlanningRequirements } from "@tripquest/application/planning";
import {
  adjustOfferOf,
  buildAdjustedDay,
  confirmRealDayAdjustment,
  planAdjustment,
  prepareAdjustment,
  withDrop,
  type AdjustConfirmReply,
  type AdjustRequest,
  type PreparedAdjustment,
  type RealDayAdjustRepository,
} from "@tripquest/application/real-adjust";
import type { createDayPlanningRunner } from "@tripquest/agent/day-planning";
import { planShortAdjustment, type createCandidateRunner } from "@tripquest/agent/short";
import { journeyCity } from "@tripquest/application/real-day";
import type { MobilityProvider, NearbyPlaceProvider, PlaceLookupProvider, WeatherProvider } from "@tripquest/providers";
import { readDraftSaveConfig } from "../planning/new/draft-receipt";
import { signAdjustReceipt, verifyAdjustReceipt } from "./adjust-receipt";
import type { PlanEvent } from "./plan-service";
import type { AdjustCardView, ChatMessageView } from "./view-models";

type Amap = MobilityProvider & PlaceLookupProvider & WeatherProvider & Partial<NearbyPlaceProvider>;
type Runner = ReturnType<typeof createDayPlanningRunner>;
type AdjustCard = Extract<StoredMessage, { kind: "adjust_card" }>;

export interface AdjustServiceDependencies {
  environment: () => NodeJS.ProcessEnv;
  now: () => number;
  repository: () => ConversationRepository;
  journeys: () => RealDayAdjustRepository & { findTrip?: OutingReader["findTrip"] };
  amap: () => Amap;
  runner: (amap: Amap) => Promise<Runner>;
  /** 短途新增兴趣沿用逐步候选选择，不能跳过用户原有顺序约定。 */
  candidates: (amap: Amap) => Promise<ReturnType<typeof createCandidateRunner>>;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** 按北京时间计算当前日期与当天分钟数。 */
const chinaTime = (nowMs: number) => {
  const local = new Date(nowMs + 8 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), minute: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
};

/** 给聊天模型的当前行程用 s1… 按版本顺序标识；服务端维护局部键到活动 UUID 的映射。 */
export function chatTripOf(
  journey: StoredJourney,
  /** 按高德地点 ID 关联原短途选择步骤，保留每个地点对应的兴趣。 */
  picked: ReadonlyMap<string, string> = new Map(),
): { trip: ChatTrip; keys: Map<string, string> } | null {
  const details = journey.realDay;
  if (journey.creationKind !== "real_day" || !details) return null;
  const done = new Set(journey.dayProgress?.completedActivityIds ?? []);
  const skipped = new Set(journey.dayProgress?.skippedActivityIds ?? []);
  const keys = new Map<string, string>();
  const stops = details.activities.map((item, index) => {
    const key = `s${index + 1}`;
    const { activityId, placeId, role } = item.record.activity;
    keys.set(key, activityId);
    const interest = details.context.freeInterests?.find((entry) => entry.id === item.record.interest)?.text ??
      picked.get(details.places.find((place) => place.placeId === placeId)!.externalId);
    return {
      key,
      name: details.places.find((place) => place.placeId === placeId)!.name,
      startsAt: clock(item.startsAt),
      endsAt: clock(item.endsAt),
      status: done.has(activityId) ? "done" as const : skipped.has(activityId) ? "skipped" as const : "todo" as const,
      ...(role === "fixed" ? { fixed: true } : {}),
      ...(interest ? { for: interest } : {}),
    };
  });
  return { trip: { version: journey.currentPlan.version, date: details.context.date, stops }, keys };
}

/** 把模型局部键转换成当前版本的活动 UUID；未知键返回 null，不能猜测目标活动。 */
export function requestByIds(request: AdjustTripRequest, keys: ReadonlyMap<string, string>): AdjustRequest | null {
  const id = (key: string) => keys.get(key);
  const named = [...(request.completed ?? []), ...(request.skipped ?? []), ...(request.replace ?? []).map((item) => item.stop)];
  if (named.some((key) => !id(key))) return null;
  return {
    completed: (request.completed ?? []).map((key) => id(key)!),
    skipped: (request.skipped ?? []).map((key) => id(key)!),
    replace: (request.replace ?? []).slice(0, 3).map((item) => ({
      activityId: id(item.stop)!,
      interest: item.interest,
      ...(item.when && item.when !== "any" ? { when: item.when } : {}),
    })),
    // any 与未指定时段等价，归一化后再进入需求处理。
    addInterests: (request.addInterests ?? []).slice(0, 3).map((item) => {
      if (typeof item === "string") return item;
      const { when, ...rest } = item;
      return when && when !== "any" ? { ...rest, when } : rest;
    }),
    ...(request.resumeAt ? { resumeAt: request.resumeAt } : {}),
    ...(request.endsAt ? { endsAt: request.endsAt } : {}),
    ...(request.from ? { from: request.from } : {}),
  };
}

const INVALID_TEXT: Record<string, string> = {
  unknown_stop: "行程刚有变化，这几站已经不在当前版本里了。请刷新后再说一次。",
  window: "剩下的时间太短，排不下了。可以把结束时间往后放一放。",
  fixed_passed: "有一个预约的时间已经过了：先告诉我它是去过了还是不去了，我再排后面的。",
  nothing_left: "剩下没有要去的地方了。想再加点什么，直接跟我说就行。",
};

/** 将已保存真实行程的剩余部分重新规划，服务端计算差异，用户确认后才保存成下一版（D-057）。 */
export function createAdjustService(dependencies: AdjustServiceDependencies) {
  const { now, repository } = dependencies;

  /** 当前版本每个地点都按高德 ID 重新查询，实时详情不从存储读取。 */
  async function livePlaces(provider: Amap, journey: StoredJourney, signal: AbortSignal) {
    const places = journey.realDay!.places;
    const found = new Map<string, PlanningPlace>();
    for (let index = 0; index < places.length; index += 10) {
      const batch = places.slice(index, index + 10);
      const reply = await provider.findPlacesById(batch.map((place) => place.externalId), { signal }).catch(() => null);
      if (!reply || reply.status !== "ok") return null;
      for (const place of batch) {
        const live = reply.data.items.find((item) => item.ref.externalId === place.externalId);
        if (live) {
          found.set(place.placeId, planningPlaceSchema.parse({
            place: live,
            evidence: { provider: "amap", sourceKind: "live", retrievedAt: reply.evidence.retrievedAt, attribution: "高德地图" },
          }));
        }
      }
    }
    return found;
  }

  async function adjust(
    conversationId: string,
    /** 设备精确点仅随“从我这里重新排”这次请求发送，用于找附近地点，不进入对话或行程存储。 */
    input: { expectedCount: number; request: AdjustRequest; here?: { longitude: number; latitude: number } },
    emit: (event: PlanEvent) => void,
    signal: AbortSignal,
  ) {
    const refuse = (status: Extract<PlanEvent, { type: "refused" }>["status"], message: string) =>
      emit({ type: "refused", status, message });
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return refuse("not_found", "找不到这段对话了。");
    currentRun()?.root.link({ conversationId });
    if (found.conversation.messageCount !== input.expectedCount) return refuse("conflict", "这段对话在别处有了新消息，请刷新后再试。");
    // V2.11：保存的是出游时，调整的是“现在”那一段（今天正在进行或下一段）。
    const saved = hasSavedOuting(found.messages) ? dependencies.journeys() : null;
    const outing = saved?.findTrip
      ? await savedOuting(found.messages, { findTrip: saved.findTrip.bind(saved), findCurrentJourney: saved.findCurrentJourney.bind(saved) }, now())
      : null;
    const journeyId = outing?.activeJourneyId ?? found.conversation.journeyId;
    const journey = journeyId ? await dependencies.journeys().findCurrentJourney(journeyId) : null;
    if (!journey?.realDay) return refuse("not_found", "这段对话还没有保存的行程。");

    const steps: { key: string; text: string }[] = [];
    const step = (text: string) => {
      if (steps.at(-1)?.text === text) return;
      const next = { key: `s${steps.length + 1}`, text };
      steps.push(next);
      emit({ type: "step", step: { ...next, state: "active" } });
    };
    const finish = async (messages: NewMessage[], receipt: { receipt: string; expiresAt: string } | null) => {
      const appended = await store.appendTurn({ conversationId, expectedCount: input.expectedCount, messages, now: new Date(now()), newId: randomUUID });
      if (appended.status !== "appended") return refuse(appended.status, "这段对话在别处有了新消息，请刷新后再试。");
      const reread = await store.findConversation(conversationId);
      const fresh = reread?.messages.slice(input.expectedCount) ?? [];
      emit({
        type: "done",
        messageCount: appended.messageCount,
        messages: fresh.map((message) => adjustMessageView(message, true)).filter((view): view is ChatMessageView => view !== null),
        plan: null,
        mapStops: [],
        mapPaths: [],
        receipt,
      });
    };
    const notice = (text: string) => finish([
      ...(steps.length ? [{ role: "assistant" as const, kind: "planning_progress" as const, body: { steps: steps.slice(-30), outcome: "no_plan" as const } }] : []),
      { role: "assistant", kind: "notice", body: { text, tone: "warning" } },
    ], null);

    const details = journey.realDay;
    const today = chinaTime(now());
    if (details.context.date < today.date) return notice("这份行程的日期已经过去了，不能再调整。想再出去玩，可以重新规划一份。");
    // 未来日期的行程按出发前调整处理，不把今天的时钟套到旅行日。
    const nowMinute = details.context.date === today.date ? today.minute : 0;

    const provider = dependencies.amap();
    step("按地点编号查询行程里地点的最新信息");
    const live = await livePlaces(provider, journey, signal);
    if (!live) return notice("暂时查不到地点的最新信息，请稍后再试。");
    let request = input.request;
    let here: PlanningPlace | undefined;
    if (request.from === "here") {
      // 将这次设备坐标解析成最近的可规划地点，沿用“用我的位置”的查点逻辑。
      const nearest = input.here && provider.nearestPlace
        ? await provider.nearestPlace(input.here, { signal }).catch(() => null)
        : null;
      if (nearest?.status === "ok") {
        step(`从你现在的位置（${nearest.data.place.name.slice(0, 20)}附近）继续排`);
        here = planningPlaceSchema.parse({
          place: nearest.data.place,
          evidence: { provider: "amap", sourceKind: "live", retrievedAt: nearest.evidence.retrievedAt, attribution: "高德地图" },
        });
      } else {
        // 没有定位或解析失败时明确告知用户，再按上一站继续，不能假装已经用了当前位置。
        step(input.here ? "没能根据你的位置找到附近的地点，先从上一站继续排" : "还没有你的位置（需要允许定位），先从上一站继续排");
        request = { ...request, from: "last_done" };
      }
    }
    // 使用刚重读的计划、累计进度与实时地点来准备剩余部分；聊天里提到的“完成”此时仍是候选。
    // 只有确认签名方案后，所隐含的报告和新版本才会一起落库。
    const prepared = prepareAdjustment({
      details,
      done: { completed: journey.dayProgress?.completedActivityIds ?? [], skipped: journey.dayProgress?.skippedActivityIds ?? [] },
      request,
      nowMinute,
      live,
      ...(here ? { here } : {}),
      ...(details.context.travel ? { travel: details.context.travel } : {}),
      city: journeyCity(journey),
    });
    if (prepared.status !== "ok") return notice(INVALID_TEXT[prepared.code] ?? "这次没能调整，请换个说法再试。");
    step(`从 ${clock(prepared.resumeAt)} 起重新安排剩下的部分`);

    const forecast = await provider.getWeatherForecast(journeyCity(journey).adcode, { signal }).catch(() => null);
    const day = forecast?.status === "ok" ? forecast.data.days.find((item) => item.date === details.context.date) : undefined;
    const weather: DayWeather | undefined = day
      ? { dayWeather: day.dayWeather, nightWeather: day.nightWeather, highCelsius: day.highCelsius, lowCelsius: day.lowCelsius, wet: day.wet, ...(day.windy ? { windy: true } : {}) }
      : undefined;
    const runner = await dependencies.runner(provider);
    const plan = async (requirements: PlanningRequirements) => {
      const problem = createDayPlanningProblem({
        requirements,
        runId: randomUUID(),
        requirementsFingerprint: fingerprintRequirements(requirements),
        nowMs: now(),
        weather,
        leaveLate: true,
      });
      let snapshot: DayDraftConfirmationSnapshot | null = null;
      let result: DayPlanningResult | null;
      try {
        result = await runner.run(problem, {
          signal,
          onProgress: (progress) => {
            if (progress.detail) step(progress.detail);
          },
          onDraftReady: (ready) => (snapshot = ready),
        });
      } catch {
        result = null;
      }
      return { result, snapshot: snapshot as DayDraftConfirmationSnapshot | null };
    };
    // 短途围绕前一站寻找新增兴趣并保持原选择顺序；一日游则允许规划器重排可调整的剩余部分。
    const short = found.conversation.draft.mode === "short"
      ? await planShortAdjustment({
          details, prepared, request, provider, now, signal,
          candidates: await dependencies.candidates(provider),
          onProgress: step,
        }).catch(() => ({ status: "none" as const, result: null, noFit: false }))
      : null;
    if (short?.status === "no_place") return notice(`附近没找到合适的“${short.interest}”，可以换个说法，或者告诉我具体想去哪。`);
    const planned = short ?? await planAdjustment(prepared, plan);
    if (planned.status === "none") {
      const reason = planned.noFit
        ? "按现在的时间排不开剩下的安排，去掉一站也不行。可以把结束时间往后放，或者告诉我哪一站不去了。"
        : "有些路线或信息查不到，暂时给不出可靠的调整，请稍后再试。";
      return notice(reason);
    }
    const final: PreparedAdjustment = planned.status === "suggest" ? withDrop(prepared, planned.drop, planned.requirements) : prepared;
    const note = changeNote(journey, request, planned.status === "suggest" ? planned.drop : null);
    // 此处新 ID 只用于形成预览；确认会根据凭据重建并分配正式身份。
    const preview = buildAdjustedDay({ stored: journey, prepared: final, draft: planned.snapshot.draft, snapshot: planned.snapshot, note, idGenerator: { next: () => randomUUID() } });
    const nameOf = (activityId: string) => {
      const item = details.activities.find((entry) => entry.record.activity.activityId === activityId)!;
      return details.places.find((place) => place.placeId === item.record.activity.placeId)!.name;
    };
    const already = new Set(journey.dayProgress?.completedActivityIds ?? []);
    const body: AdjustCard["body"] = {
      runId: planned.snapshot.problem.runId,
      journeyId: journey.journeyId,
      basePlanVersion: journey.currentPlan.version,
      note,
      items: [
        ...input.request.completed.filter((id) => !already.has(id)).map((id) => ({ kind: "done" as const, name: nameOf(id) })),
        ...preview.diff.map((item) => ({
          kind: item.kind,
          name: item.name.slice(0, 80),
          ...("from" in item ? { before: { startsAt: clock(item.from.startsAt), endsAt: clock(item.from.endsAt) } } : {}),
          ...("to" in item ? { after: { startsAt: clock(item.to.startsAt), endsAt: clock(item.to.endsAt) } } : {}),
        })),
      ].slice(0, 16),
      suggestDrop: planned.status === "suggest" ? nameOf(planned.drop) : null,
      arriveAt: clock(planned.snapshot.draft.endArrival),
      endName: planned.snapshot.draft.endPlace.name.slice(0, 80),
      savedVersion: null,
    };
    const secret = readDraftSaveConfig(dependencies.environment()).secret;
    const offer = adjustOfferOf({ journey, runId: body.runId, note, prepared: final, snapshot: planned.snapshot });
    const receipt = secret ? signAdjustReceipt({ conversationId, offer, now: now(), secret }) : null;
    return finish([
      { role: "assistant", kind: "planning_progress", body: { steps: steps.slice(-30), outcome: "draft" } },
      { role: "assistant", kind: "adjust_card", body },
    ], receipt);
  }

  /** 签名方案仍需在服务端复核当前双版本、路线与业务约束，随后才保存下一版。 */
  async function confirm(conversationId: string, receipt: string): Promise<AdjustConfirmReply | { status: "invalid_receipt" }> {
    const config = readDraftSaveConfig(dependencies.environment());
    const payload = config.enabled ? verifyAdjustReceipt(receipt, config.secret, now()) : null;
    if (!payload || payload.conversationId !== conversationId) return { status: "invalid_receipt" };
    const result = await confirmRealDayAdjustment({
      offer: payload.offer,
      expiresAt: payload.expiresAt,
      routes: dependencies.amap(),
      repository: dependencies.journeys(),
      idGenerator: { next: () => randomUUID() },
      now: new Date(now()),
    });
    if (result.status === "saved" || result.status === "already_saved") {
      await repository().markAdjustSaved({ conversationId, runId: payload.offer.runId, planVersion: result.planVersion, now: new Date(now()) });
    }
    return result;
  }

  return { adjust, confirm };
}

/** 用简短文字描述本次实际改动，作为新版本的变更说明。 */
function changeNote(journey: StoredJourney, request: AdjustRequest, dropped: string | null): string {
  const details = journey.realDay!;
  const name = (activityId: string) => {
    const item = details.activities.find((entry) => entry.record.activity.activityId === activityId)!;
    // 版本说明压缩掉分店后缀；完整店名仍在方案卡中展示。
    return details.places.find((place) => place.placeId === item.record.activity.placeId)!.name.replace(/[（(].*$/, "").slice(0, 12);
  };
  const parts = [
    ...request.skipped.map((id) => `跳过${name(id)}`),
    ...request.replace.map((item) => `${name(item.activityId)}换成${item.interest}`),
    ...request.addInterests.map((item) => `加${typeof item === "string" ? item : item.text}`),
    ...(dropped ? [`去掉${name(dropped)}`] : []),
    ...(request.resumeAt ? [`${request.resumeAt} 继续`] : []),
    ...(request.endsAt ? [`${request.endsAt} 结束`] : []),
    ...(request.completed.length ? [`完成${request.completed.map(name).join("、")}`] : []),
    ...(request.from === "here" ? ["从当前位置继续"] : []),
  ];
  return (parts.join("，") || "按现在的时间重排").slice(0, 60);
}

/** 调整过程的消息视图只开放最新未保存卡片，历史卡片仅作记录。 */
export function adjustMessageView(message: StoredMessage, open: boolean): ChatMessageView | null {
  if (message.kind === "planning_progress") {
    return { id: message.id, role: "assistant", kind: "planning_progress", running: false, steps: message.body.steps.map((item) => ({ ...item, state: "done" as const })) };
  }
  if (message.kind === "notice") return { id: message.id, role: "assistant", kind: "notice", text: message.body.text, tone: message.body.tone };
  if (message.kind === "adjust_card") return adjustCardView(message, open);
  return null;
}

export function adjustCardView(message: AdjustCard, open: boolean): AdjustCardView {
  return { id: message.id, role: "assistant", kind: "adjust_card", ...message.body, open: open && message.body.savedVersion === null };
}
