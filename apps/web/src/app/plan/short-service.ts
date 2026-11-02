import "server-only";
import { currentRun } from "@tripquest/agent/runs";
import { randomUUID } from "node:crypto";
import { draftCity, shortStepDeparture, type ConversationRepository, type NewMessage, type RequirementsDraft, type StoredMessage } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import { DEFAULT_TRAVEL, planningPlaceSchema, type PlanningPlace } from "@tripquest/application/planning";
import { createCandidateRunner, planShortTrip, type Candidate } from "@tripquest/agent/short";
import type { DayRoute } from "@tripquest/domain";
import type { MobilityProvider, PlaceLookupProvider, WeatherProvider } from "@tripquest/providers";
import type { PlanEvent } from "./plan-service";
import { planOutcome, planTitle } from "./plan-service";
import { ROUNDS, storedChoicesView } from "./choices-view";
import type { ChatMessageView, ChoiceOptionView, ChoicesView, LegView, MapStop } from "./view-models";

type Amap = MobilityProvider & PlaceLookupProvider & WeatherProvider;
type Runner = ReturnType<typeof createCandidateRunner>;
type Choices = Extract<StoredMessage, { kind: "choices" }>;


export interface ShortServiceDependencies {
  environment: () => NodeJS.ProcessEnv;
  now: () => number;
  repository: () => ConversationRepository;
  amap: () => Amap;
  candidates: (amap: Amap) => Promise<Runner>;
}

export type ChooseInput = {
  readonly tripId: string;
  readonly messageId: string;
  readonly fingerprint: string;
  /** 存在时代表用户选定地点，缺省时表示请求换一批。 */
  readonly pick?: string;
};

/**
 * 短途按兴趣逐步选点：从起点附近开始，再围绕上一站寻找下一站，最终按用户选择顺序排程。
 * 距离、路线、评分和价格仅在本次响应展示，不进入长期对话存储（D-046）。
 */
export function createShortService(dependencies: ShortServiceDependencies) {
  const { now, repository } = dependencies;

  /** 起点、已选地点和返程点都按高德 ID 实时补查，不能复用保存过的地点详情。 */
  async function lookup(provider: Amap, ids: readonly string[], signal: AbortSignal): Promise<Map<string, PlanningPlace> | null> {
    const found = new Map<string, PlanningPlace>();
    const unique = [...new Set(ids)];
    for (let index = 0; index < unique.length; index += 10) {
      const reply = await provider.findPlacesById(unique.slice(index, index + 10), { signal }).catch(() => null);
      if (!reply || reply.status !== "ok") return null;
      for (const place of reply.data.items) {
        found.set(place.ref.externalId, planningPlaceSchema.parse({
          place,
          evidence: { provider: "amap", sourceKind: "live", retrievedAt: reply.evidence.retrievedAt, attribution: "高德地图" },
        }));
      }
    }
    return unique.every((id) => found.has(id)) ? found : null;
  }

  /** 候选步骤只存 ID、名称和自有理由，页面另接收本次查到的实时事实。 */
  async function offer(input: {
    provider: Amap;
    draft: RequirementsDraft;
    tripId: string;
    step: number;
    round: number;
    anchor: PlanningPlace;
    anchorIsStart: boolean;
    exclude: readonly string[];
    /** 用前面已选站点的停留时长估计本步骤何时出发，避免始终按最初出发时间选点。 */
    earlierStays?: readonly number[];
    signal: AbortSignal;
  }): Promise<{ body: Choices["body"]; candidates: readonly Candidate[] } | "none" | "failed"> {
    const interest = input.draft.interests[input.step - 1];
    const result = await (await dependencies.candidates(input.provider)).run({
      interest: { text: interest.text, ...(interest.when ? { when: interest.when } : {}) },
      anchor: input.anchor,
      anchorIsStart: input.anchorIsStart,
      exclude: input.exclude,
      travel: input.draft.travel ?? DEFAULT_TRAVEL,
      departureAt: shortStepDeparture(input.draft.date!, input.draft.startsAt!, input.earlierStays ?? []),
      cityAdcode: draftCity(input.draft).adcode,
    }, { signal: input.signal });
    if (result.status !== "ok") return result.status === "none" ? "none" : "failed";
    return {
      candidates: result.candidates,
      body: {
        tripId: input.tripId,
        step: input.step,
        interestId: interest.id,
        anchor: input.anchorIsStart ? null : { externalId: input.anchor.place.ref.externalId, name: input.anchor.place.name.slice(0, 80) },
        round: input.round,
        options: result.candidates.map((candidate) => ({
          externalId: candidate.selection.place.ref.externalId,
          name: candidate.selection.place.name.slice(0, 80),
          reason: candidate.reason,
          stayMinutes: candidate.stayMinutes,
        })),
        chosen: null,
      },
    };
  }

  const none = (draft: RequirementsDraft, step: number) =>
    `附近没找到合适的“${draft.interests[step - 1]?.text ?? "地方"}”，可以换个说法，或者换个出发点再试。`;

  /** 短途开始时先围绕起点查第一项兴趣候选，不直接生成全部行程。 */
  async function start(
    conversationId: string,
    found: { conversation: { draft: RequirementsDraft; messageCount: number } },
    emit: (event: PlanEvent) => void,
    signal: AbortSignal,
  ) {
    const { draft } = found.conversation;
    const provider = dependencies.amap();
    emit(step("s1", "从你的位置附近找第一站的候选"));
    const startId = draft.start?.status === "bound" ? draft.start.externalId : null;
    const places = startId ? await lookup(provider, [startId], signal) : null;
    if (!startId || !places) return emit({ type: "refused", status: "unavailable", message: "暂时查不到出发地点，请稍后再试。" });
    const tripId = randomUUID();
    const offered = await offer({ provider, draft, tripId, step: 1, round: 1, anchor: places.get(startId)!, anchorIsStart: true, exclude: [], signal });
    await finish(conversationId, found.conversation.messageCount, draft, 1, offered, places.get(startId)!, emit);
  }

  /** 只处理当前短途的最新步骤，旧步骤不能再次选点或换批。 */
  async function choose(conversationId: string, input: ChooseInput, emit: (event: PlanEvent) => void, signal: AbortSignal) {
    const refuse = (status: Extract<PlanEvent, { type: "refused" }>["status"], message: string) =>
      emit({ type: "refused", status, message });
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return refuse("not_found", "找不到这段对话了。");
    currentRun()?.root.link({ conversationId });
    const { draft } = found.conversation;
    if (fingerprint(draft) !== input.fingerprint || draft.mode !== "short") {
      return refuse("conflict", "需求卡片改过了，请看一下最新的卡片再开始。");
    }
    const trip = found.messages.filter((message): message is Choices => message.kind === "choices" && message.body.tripId === input.tripId);
    const target = trip.at(-1);
    if (!target || target.id !== input.messageId || target.body.chosen) return refuse("conflict", "这一步已经选过了，请看一下最新的选择。");
    const provider = dependencies.amap();
    const picked = trip.filter((message) => message.body.chosen).map((message) => message.body.chosen!);
    const stayOf = (externalId: string) =>
      trip.flatMap((message) => message.body.options).find((item) => item.externalId === externalId)?.stayMinutes ?? 60;
    const startId = draft.start?.status === "bound" ? draft.start.externalId : null;
    if (!startId) return refuse("conflict", "出发地点变了，请重新开始规划。");

    if (!input.pick) {
      if (target.body.round >= ROUNDS) return refuse("conflict", "这一步已经换过两批了，从现有的里挑一家吧。");
      emit(step("s1", "换一批候选"));
      const anchorId = picked.at(-1) ?? startId;
      const places = await lookup(provider, [anchorId], signal);
      if (!places) return refuse("unavailable", "暂时查不到地点信息，请稍后再试。");
      const shown = trip.filter((message) => message.body.step === target.body.step).flatMap((message) => message.body.options.map((option) => option.externalId));
      const offered = await offer({
        provider, draft, tripId: input.tripId, step: target.body.step, round: target.body.round + 1,
        anchor: places.get(anchorId)!, anchorIsStart: !picked.length, exclude: [...shown, ...picked],
        earlierStays: picked.map(stayOf), signal,
      });
      return finish(conversationId, found.conversation.messageCount, draft, target.body.step, offered, places.get(anchorId)!, emit);
    }

    const option = target.body.options.find((item) => item.externalId === input.pick);
    if (!option) return refuse("conflict", "这家不在这一步的候选里。");
    // 用户选择先在消息行锁内记录一次，再查询下一站；外部查询期间不占用数据库事务。
    // 后续查询失败也不撤回已经确认的选择，另一个标签页不能趁重试改成另一家。
    const marked = await store.chooseOption({ conversationId, messageId: target.id, externalId: option.externalId, now: new Date(now()) });
    if (marked.status !== "updated") return refuse("conflict", "这一步已经选过了，请看一下最新的选择。");
    const updated = storedChoicesView({ ...target, body: { ...target.body, chosen: option.externalId } }, draft, false);
    const picks = [...picked, option.externalId];

    if (picks.length < draft.interests.length) {
      emit(step("s1", `在“${option.name}”附近找下一站的候选`));
      const places = await lookup(provider, [option.externalId], signal);
      if (!places) return refuse("unavailable", "暂时查不到地点信息，请稍后再试。");
      const offered = await offer({
        provider, draft, tripId: input.tripId, step: picks.length + 1, round: 1,
        anchor: places.get(option.externalId)!, anchorIsStart: false, exclude: picks,
        earlierStays: picks.map(stayOf), signal,
      });
      return finish(conversationId, found.conversation.messageCount, draft, picks.length + 1, offered, places.get(option.externalId)!, emit, updated);
    }

    // 全部步骤选完后才生成计划，保持用户选择顺序；终点按是否要求返程确定。
    emit(step("s1", "按你选的顺序核对路线和时间"));
    const backId = draft.end?.status === "bound" ? draft.end.externalId : null;
    const places = await lookup(provider, [startId, ...picks, ...(backId ? [backId] : [])], signal);
    if (!places) return refuse("unavailable", "暂时查不到地点信息，请稍后再试。");
    const stays = new Map(trip.flatMap((message) => message.body.options.map((item) => [item.externalId, item.stayMinutes] as const)));
    const paths = new Map<string, readonly (readonly [number, number])[]>();
    const { result, snapshot } = await planShortTrip({
      date: draft.date!,
      window: { startsAt: draft.startsAt!, endsAt: draft.endsAt! },
      start: places.get(startId)!,
      city: draftCity(draft),
      ...(backId ? { back: places.get(backId)! } : {}),
      stops: picks.map((id) => ({ place: places.get(id)!, stayMinutes: stays.get(id) ?? 60 })),
      travel: draft.travel ?? DEFAULT_TRAVEL,
      provider,
      now,
      signal,
      onRoutePath: (from, to, path) => paths.set(`${from}>${to}`, path),
    });
    const messages: NewMessage[] = [];
    let event: Pick<Extract<PlanEvent, { type: "done" }>, "plan" | "mapStops" | "mapPaths" | "receipt"> = { plan: null, mapStops: [], mapPaths: [], receipt: null };
    if (result.status === "completed" && result.outcome === "draft" && snapshot) {
      const done = await planOutcome({ result, snapshot, title: planTitle(draft), paths, environment: dependencies.environment(), nowMs: now() });
      messages.push({ role: "assistant", kind: "plan_card", body: done.body });
      event = { plan: done.planView, mapStops: done.mapStops, mapPaths: done.mapPaths, receipt: done.receipt };
    } else {
      const text = result.status === "completed" && result.outcome === "no_plan"
        ? "选的这几家在剩下的时间里排不开。可以换一家近一点的，或者在卡片上把结束时间放晚一些。"
        : "暂时没能核对完路线，请稍后再试一次。";
      messages.push({ role: "assistant", kind: "notice", body: { text, tone: "warning" } });
    }
    const appended = await store.appendTurn({ conversationId, expectedCount: found.conversation.messageCount, messages, now: new Date(now()), newId: randomUUID });
    if (appended.status !== "appended") return refuse(appended.status, "这段对话在别处有了新消息，请刷新后再试。");
    const fresh = (await store.findConversation(conversationId))?.messages.slice(found.conversation.messageCount) ?? [];
    emit({
      type: "done",
      messageCount: appended.messageCount,
      messages: fresh.flatMap((message): ChatMessageView[] => message.kind === "plan_card" && event.plan
        ? [{ id: message.id, role: "assistant", kind: "plan_card", plan: event.plan }]
        : message.kind === "notice" ? [{ id: message.id, role: "assistant", kind: "notice", text: message.body.text, tone: message.body.tone }] : []),
      updated,
      ...event,
    });
  }

  /** 先成功保存候选步骤或“附近没有合适地点”的说明，再发回含实时事实的页面结果。 */
  async function finish(
    conversationId: string,
    expectedCount: number,
    draft: RequirementsDraft,
    stepNumber: number,
    offered: Awaited<ReturnType<typeof offer>>,
    anchor: PlanningPlace,
    emit: (event: PlanEvent) => void,
    updated?: ChoicesView,
  ) {
    const store = repository();
    const message: NewMessage = typeof offered === "string"
      ? { role: "assistant", kind: "notice", body: { text: offered === "none" ? none(draft, stepNumber) : "暂时查不到附近的地点，请稍后再试。", tone: "warning" } }
      : { role: "assistant", kind: "choices", body: offered.body };
    const appended = await store.appendTurn({ conversationId, expectedCount, messages: [message], now: new Date(now()), newId: randomUUID });
    if (appended.status !== "appended") {
      return emit({ type: "refused", status: appended.status, message: "这段对话在别处有了新消息，请刷新后再试。" });
    }
    const stored = (await store.findConversation(conversationId))?.messages.at(-1);
    const view: ChatMessageView | null = stored?.kind === "choices" && typeof offered !== "string"
      ? liveChoicesView(stored, draft, offered.candidates)
      : stored?.kind === "notice" ? { id: stored.id, role: "assistant", kind: "notice", text: stored.body.text, tone: stored.body.tone } : null;
    const mapStops: MapStop[] = typeof offered === "string" ? [] : [
      { key: "anchor", label: "起", kind: "start", name: anchor.place.name, longitude: anchor.place.location.longitude, latitude: anchor.place.location.latitude },
      ...offered.candidates.map((candidate, index): MapStop => ({
        key: candidate.selection.place.ref.externalId, label: String(index + 1), kind: "stop", name: candidate.selection.place.name,
        longitude: candidate.selection.place.location.longitude, latitude: candidate.selection.place.location.latitude,
      })),
    ];
    emit({ type: "done", messageCount: appended.messageCount, messages: view ? [view] : [], plan: null, mapStops, mapPaths: [], receipt: null, ...(updated ? { updated } : {}) });
  }

  return { start, choose };
}

function step(key: string, text: string): PlanEvent {
  return { type: "step", step: { key, text, state: "active" } };
}

function legView(route: DayRoute): LegView | undefined {
  if (route.status !== "known") return undefined;
  return {
    mode: route.mode ?? "walking",
    minutes: Math.ceil(route.durationSeconds / 60),
    ...(route.fareYuan !== undefined ? { fareYuan: route.fareYuan } : {}),
    ...(route.summary ? { summary: route.summary } : {}),
  };
}

/** 本轮新候选展示本次查到的距离、路线与高德事实，历史正文不持有这些字段。 */
function liveChoicesView(message: Choices, draft: RequirementsDraft, candidates: readonly Candidate[]): ChoicesView {
  const base = storedChoicesView(message, draft, true);
  return {
    ...base,
    options: base.options.map((option): ChoiceOptionView => {
      const candidate = candidates.find((item) => item.selection.place.ref.externalId === option.externalId);
      if (!candidate) return option;
      const travel = legView(candidate.route);
      return {
        ...option,
        meters: candidate.meters,
        ...(travel ? { travel } : {}),
        ...(candidate.business?.rating ? { rating: candidate.business.rating } : {}),
        ...(candidate.business?.costYuan ? { costYuan: candidate.business.costYuan } : {}),
        ...(candidate.business?.keytag ? { keytag: candidate.business.keytag } : {}),
        ...(candidate.business?.openToday ? { openToday: candidate.business.openToday } : {}),
      };
    }),
  };
}
