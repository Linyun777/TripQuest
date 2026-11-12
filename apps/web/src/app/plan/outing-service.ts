import "server-only";
import { outingReview, type OutingReviewOutcome } from "@tripquest/agent/outing-graph";
import type { JudgeRequest } from "@tripquest/agent/outing-judge";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import { currentRun } from "@tripquest/agent/runs";
import { randomUUID } from "node:crypto";
import { allocateOuting, type AllocationRequest } from "@tripquest/agent/outing-allocate";
import { forecastLookup, generateOuting, type GeneratedDay } from "@tripquest/agent/outing-generate";
import type { LodgingChoice } from "@tripquest/agent/outing-lodging";
import { fillRides } from "@tripquest/agent/outing-rides";
import { pickPendingChoices } from "@tripquest/application/outing-rides";
import { planOutingChange, type AdoptedChange, type OutingChangeRequest } from "@tripquest/agent/outing-change";
import type { SuggestionFix } from "@tripquest/application/outing-review-contract";
import {
  applyDraftPatch,
  DRAFT_LIMITS,
  draftCity,
  draftMissing,
  outingDays,
  type ConversationRepository,
  type DraftPlace,
  type NewMessage,
  type OutingDraft,
  type RequirementsDraft,
  type StoredMessage,
} from "@tripquest/application/conversation";
import type { ChatOutingTrip } from "@tripquest/agent/chat";
import type { StoredJourney } from "@tripquest/application";
import type { DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import type { DayPlanningResult, DayPlanningRunner } from "@tripquest/application/day-planning";
import { fingerprint } from "@tripquest/application/fingerprint";
import { allocateByRules, checkAllocation, outingFrames, visitStay, type OutingPlanInput } from "@tripquest/application/outing-allocation";
import {
  confirmOuting,
  confirmOutingChange,
  type OutingChangeRepository,
  type StoredTrip,
  type TripRepository,
  type TripSegment,
} from "@tripquest/application/outing-trip";
import { DEFAULT_TRAVEL, type PlanningPlace } from "@tripquest/application/planning";
import type { CityResolver, MobilityProvider, PlaceLookupProvider, PlaceSummary, WeatherProvider } from "@tripquest/providers";
import type { ChatMessageView, OutingChangeView, OutingDayPartView, OutingDayView, OutingReviewView, PlanCardView, ProgressStep } from "./view-models";

/**
 * V2.11 出游分到各天（stages/V2.11.md §3.6）：卡片上的地点按编号实时补查（坐标不存），组成分配的输入，
 * 交给模型分配（代码检查、打回一次、规则兜底），结果只存地点 key、兴趣 id 和理由。用户把一项移到别的天时
 * 固定在那天，代码重新检查并显示问题。
 */
export type AllocateReply =
  | { readonly status: "ok"; readonly draft: RequirementsDraft }
  | { readonly status: "incomplete"; readonly missing: readonly string[] }
  | { readonly status: "places_missing"; readonly names: readonly string[] }
  | { readonly status: "invalid"; readonly code: string }
  | { readonly status: "conflict" | "not_found" | "unavailable" };

export function createOutingService(dependencies: {
  readonly now: () => number;
  readonly repository: () => ConversationRepository;
  readonly places: () => PlaceLookupProvider;
  /** 模型分配的请求；没有时只用规则分配。 */
  readonly allocator: () => Promise<AllocationRequest | undefined>;
  /** V3.6：开始前补车站时按城市搜车站；没有时不补。 */
  readonly stations?: () => Pick<MobilityProvider, "searchPlaces">;
}) {
  async function allocate(
    conversationId: string,
    expectedFingerprint: string,
    move?: { readonly target: string; readonly day: number },
  ): Promise<AllocateReply> {
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    currentRun()?.root.link({ conversationId });
    let draft = found.conversation.draft;
    if (fingerprint(draft) !== expectedFingerprint) return { status: "conflict" };
    if (draft.mode !== "outing" || !draft.outing) return { status: "invalid", code: "outing_only" };
    if (dependencies.stations) draft = await withStations(draft, found.messages, dependencies.stations);
    const missing = draftMissing(draft);
    if (missing.length) return { status: "incomplete", missing };
    if (move) {
      const moved = applyDraftPatch(draft, { moveToDay: move });
      if (moved.status !== "ok") return { status: "invalid", code: moved.code };
      draft = moved.draft;
    }
    const signal = AbortSignal.timeout(60_000);
    const built = await outingInput(draft, dependencies.places(), signal, dependencies.now);
    if (built.status !== "ok") return built;
    const frames = outingFrames(built.input);
    let allocation = draft.outing!.allocation;
    if (move && allocation) {
      // 移动后不再问模型：按用户放的重新检查，有问题就显示出来。
      allocation = { ...allocation, problems: checkAllocation(built.input, frames, allocation, "zh").slice(0, 8).map((item) => item.slice(0, 200)) };
    } else {
      const request = await dependencies.allocator().catch(() => undefined);
      const result = await allocateOuting(built.input, { ...(request ? { request } : {}), ...(draft.notes ? { notes: draft.notes } : {}), signal });
      // 验收复测第 3 条：模型的分配被打回的原因记在卡片上（pnpm trace 能看到），页面不显示。
      const rejected = result.attempts.flatMap((problems, index) => problems.map((item) => `#${index + 1} ${item}`.slice(0, 200))).slice(0, 8);
      allocation = {
        days: result.allocation.days.map((entry) => ({
          day: entry.day, visits: [...entry.visits], interests: [...entry.interests], ...(entry.reason ? { reason: entry.reason.slice(0, 80) } : {}),
        })),
        source: result.source,
        problems: checkAllocation(built.input, frames, result.allocation, "zh").slice(0, 8).map((item) => item.slice(0, 200)),
        ...(rejected.length ? { rejected } : {}),
      };
    }
    // 验收复测第 4 条：没写停留的地点把按类型估计的停留写到卡片上（显示“约 2 小时（估计）”，用户可以改）。
    const visits = draft.visits.map((visit) => {
      const used = built.input.visits.find((item) => item.key === visit.key);
      if (visit.stayMinutes !== null || visit.role === "fixed" || !used) return visit;
      return { ...visit, stayMinutes: used.stayMinutes, staySource: "estimate" as const, ...(used.kind ? { kind: used.kind } : {}) };
    });
    const next: RequirementsDraft = { ...draft, visits, outing: { ...draft.outing!, allocation } };
    const updated = await store.updateDraft({ conversationId, expectedFingerprint, draft: next, now: new Date(dependencies.now()) });
    if (updated.status !== "updated") return { status: updated.status };
    return { status: "ok", draft: next };
  }

  return { allocate };
}

/**
 * V3.6（stages/V3.6.md §3.5）：分到各天、按天生成之前，卡片还缺东西时先补交通空着的车站（暂定、可换），免得只因为这个
 * 被挡住；补完仍缺的照旧提示。这时没有回复能说明加了什么，只补车站，不加交通。验收反馈：还在等用户选的车站和住处
 * 先取第一个候选作暂定，其余留着“换一个”（用户选过的不动）。
 */
async function withStations(
  draft: RequirementsDraft,
  messages: readonly StoredMessage[],
  provider: () => Pick<MobilityProvider, "searchPlaces">,
): Promise<RequirementsDraft> {
  if (!draftMissing(draft).length) return draft;
  const texts = messages.flatMap((message) => (message.role === "user" && message.kind === "text" ? [message.body.text] : []));
  const filled = await Promise.resolve()
    .then(() => fillRides(draft, texts, provider(), AbortSignal.timeout(10_000), { stationsOnly: true }))
    .catch(() => null);
  const picked = pickPendingChoices(filled?.draft ?? draft);
  if (picked.picked.length) currentRun()?.step("check", "outing:picked", { picked: picked.picked });
  return picked.draft;
}

/** 出游卡片 → 分配的输入：每个已绑定地点按编号实时补查；查不到的列出来，让用户重新选。 */
export async function outingInput(
  draft: RequirementsDraft,
  places: PlaceLookupProvider,
  signal: AbortSignal,
  now: () => number,
): Promise<{ status: "ok"; input: OutingPlanInput } | { status: "places_missing"; names: string[] } | { status: "unavailable" }> {
  const outing = draft.outing!;
  const bound = (place: DraftPlace | null | undefined) => (place?.status === "bound" ? place : null);
  const named = [
    draft.start, draft.end, ...outing.lodging.map((night) => night.place),
    ...outing.transports.flatMap((item) => [item.from, item.to]), ...draft.visits.map((visit) => visit.place),
  ].flatMap((place) => (bound(place) ? [bound(place)!] : []));
  const ids = [...new Set(named.map((place) => place.externalId))];
  const found = new Map<string, PlaceSummary>();
  let retrievedAt = new Date(now()).toISOString();
  for (let index = 0; index < ids.length; index += 10) {
    const reply = await places.findPlacesById(ids.slice(index, index + 10), { signal });
    if (reply.status !== "ok") return { status: "unavailable" };
    for (const item of reply.data.items) found.set(item.ref.externalId, item);
    retrievedAt = reply.evidence.retrievedAt;
  }
  const lost = named.filter((place) => !found.has(place.externalId)).map((place) => place.name);
  if (lost.length) return { status: "places_missing", names: [...new Set(lost)] };
  const selection = (place: DraftPlace | null | undefined): PlanningPlace => ({
    place: found.get(bound(place)!.externalId)!,
    evidence: { provider: "amap", sourceKind: "live", retrievedAt, attribution: "高德地图" },
  });
  const days = outingDays(outing);
  return {
    status: "ok",
    input: {
      dates: outing.dates!,
      dailyWindow: outing.dailyWindow,
      start: { place: selection(draft.start), at: outing.startAt },
      end: { place: selection(draft.end ?? draft.start), at: outing.endAt },
      lodging: Array.from({ length: Math.max(0, days - 1) }, (_, index) => {
        const night = outing.lodging.find((item) => item.night === index + 1);
        return night?.onBoard ? "onBoard" as const : bound(night?.place) ? selection(night!.place) : null;
      }),
      transports: outing.transports.map((item) => ({
        day: item.day,
        mode: item.mode,
        from: selection(item.from),
        to: selection(item.to),
        departAt: item.departAt,
        arriveAt: item.arriveAt,
        arriveDay: item.arriveDay,
        ...(item.overnightConfirmed ? { overnightConfirmed: true as const } : {}),
      })),
      visits: draft.visits.map((visit) => {
        const place = selection(visit.place);
        // 没写停留的按类型估计（高德分类），可以缩到这类的下限；固定事项按预约的时间，不用停留。
        const stay = visit.role === "fixed" ? { stayMinutes: visit.stayMinutes ?? 60 } : visitStay(visit, place.place.categoryCode);
        return {
          key: visit.key,
          place,
          role: visit.role,
          ...stay,
          ...(visit.startsAt ? { startsAt: visit.startsAt } : {}),
          ...(visit.endsAt ? { endsAt: visit.endsAt } : {}),
          ...(visit.day ? { day: visit.day } : {}),
        };
      }),
      interests: draft.interests.map((item) => ({
        id: item.id,
        text: item.text,
        ...(item.when ? { when: item.when } : {}),
        ...(item.city ? { city: item.city.adcode } : {}),
        ...(item.day ? { day: item.day } : {}),
        ...(item.perDay ? { perDay: true as const } : {}),
      })),
      travel: draft.travel ?? DEFAULT_TRAVEL,
      ...(outing.noDriving?.length ? { noDriving: [...outing.noDriving] } : {}),
      ...(outing.lodgingAreas?.length ? { lodgingAreas: outing.lodgingAreas.map((area) => ({ text: area.text })) } : {}),
      ...(outing.stays?.length ? { stays: outing.stays.map((item) => ({ nights: [...item.nights], city: item.city.adcode })) } : {}),
    },
  };
}

type Amap = MobilityProvider & PlaceLookupProvider & WeatherProvider;
type OutingDayBody = Extract<StoredMessage, { kind: "outing_day" }>["body"];
type PlanBody = Extract<StoredMessage, { kind: "plan_card" }>["body"];
/** 一段方案的保存凭据（只在本次响应里，不存）。 */
export interface OutingReceipt {
  readonly day: number;
  readonly part: number;
  readonly runId: string;
  readonly receipt: string;
  readonly expiresAt: string;
}
export type OutingEvent =
  | { type: "step"; step: ProgressStep }
  | { type: "day"; messageCount: number; message: OutingDayView; receipts: OutingReceipt[] }
  /** V3.2：审查直接改了分配，卡片跟着换；审查给用户的建议（一条消息）。 */
  | { type: "card"; card: unknown }
  | { type: "review"; messageCount: number; message: OutingReviewView }
  | { type: "outing_done"; messageCount: number }
  | { type: "refused"; status: "conflict" | "not_found" | "unavailable" | "incomplete"; message: string };

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * V2.11 逐天生成（§3.7）：按卡片上的分配一天天排（agent 的 generateOuting，前几天找到的地点后面不再用），
 * 每天完成就存一条 outing_day 消息并推给页面，连接中断最多丢正在排的那一天。“继续规划剩下的天”和
 * “重排这一天”传 days，沿用同一次生成，排除其他天已经用了的地点。
 */
export function createOutingGeneration(dependencies: {
  readonly now: () => number;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly repository: () => ConversationRepository;
  readonly amap: () => Amap;
  readonly runner: (amap: Amap) => Promise<DayPlanningRunner>;
  /** 一段方案的页面卡片、存储正文和保存凭据（同一日方案的收口）。 */
  readonly planOutcome: (input: {
    result: Extract<DayPlanningResult, { status: "completed"; outcome: "draft" }>;
    snapshot: DayDraftConfirmationSnapshot;
    title: string;
    paths: ReadonlyMap<string, readonly (readonly [number, number])[]>;
    environment: NodeJS.ProcessEnv;
    nowMs: number;
  }) => Promise<{ planView: PlanCardView; body: PlanBody; receipt: { receipt: string; expiresAt: string } | null }>;
  /** V3.2 审查 Agent 的模型请求；没有或 OUTING_REVIEW=off 时不审查。 */
  readonly reviewer?: () => Promise<ReviewRequest | undefined>;
  /** V4.7 整体判断的模型请求（OUTING_REVIEW=agent 才用）。 */
  readonly judge?: () => Promise<JudgeRequest | undefined>;
  /** V4.7：用户保存的长期偏好（读不到时为空，不挡住规划）。 */
  readonly preferences?: () => Promise<readonly string[]>;
  /** V3.2：审查改了分配后，卡片换成新的给页面（同对话里卡片的样子）。 */
  readonly cardView?: (draft: RequirementsDraft) => Promise<unknown>;
}) {
  return async function generate(
    conversationId: string,
    input: { readonly fingerprint: string; readonly days?: readonly number[] },
    emit: (event: OutingEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const refuse = (status: Extract<OutingEvent, { type: "refused" }>["status"], message: string) =>
      emit({ type: "refused", status, message });
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    if (!found) return refuse("not_found", "找不到这段对话了。");
    currentRun()?.root.link({ conversationId });
    const stored = found.conversation.draft;
    if (fingerprint(stored) !== input.fingerprint) return refuse("conflict", "卡片刚更新过，请看一下最新的卡片再开始。");
    if (stored.mode !== "outing" || !stored.outing) return refuse("unavailable", "这张卡片不是出游。");
    const provider = dependencies.amap();
    const draft = await withStations(stored, found.messages, () => provider);
    const missing = draftMissing(draft);
    if (missing.length || !draft.outing) return refuse("incomplete", `还需要：${missing.join("、")}`);
    const days = outingDays(draft.outing);
    if (days > 1 && !draft.outing.allocation) return refuse("incomplete", "先把地点分到各天。");
    // V3.6：补了车站的卡片先存好、推给页面；后面写卡片时按补过的比对。
    let expected = input.fingerprint;
    if (draft !== stored) {
      const updated = await store.updateDraft({ conversationId, expectedFingerprint: expected, draft, now: new Date(dependencies.now()) });
      if (updated.status !== "updated") return refuse("conflict", "卡片刚更新过，请看一下最新的卡片再开始。");
      expected = fingerprint(draft);
      if (dependencies.cardView) emit({ type: "card", card: await dependencies.cardView(draft) });
    }

    let steps = 0;
    const step = (text: string) => emit({ type: "step", step: { key: `s${(steps += 1)}`, text, state: "active" } });
    step("按地点编号查询最新的地点信息");
    const built = await outingInput(draft, provider, signal, dependencies.now);
    if (built.status === "places_missing") return refuse("incomplete", `这些地点查不到了，请重新选：${built.names.join("、")}`);
    if (built.status !== "ok") return refuse("unavailable", "地点信息暂时查不到，请稍后再试。");
    const allocation = draft.outing.allocation ?? allocateByRules(built.input, outingFrames(built.input));

    // 继续或重排沿用最近一次生成；其他天用过的推荐地点排除掉。
    const earlier = latestGeneration(found.messages);
    const again = !!input.days?.length && !!earlier;
    const generationId = again ? earlier!.generationId : randomUUID();
    const exclude = again
      ? earlier!.days.filter((body) => !input.days!.includes(body.day)).flatMap((body) => discoveredIds(body))
      : [];
    const title = found.conversation.title;
    let messageCount = found.conversation.messageCount;
    const runner = await dependencies.runner(provider);
    const reviewer = outingReview() !== "off" ? await dependencies.reviewer?.().catch(() => undefined) : undefined;
    let review: OutingReviewOutcome | null = null;
    let lodging: readonly LodgingChoice[] = [];
    const judge = outingReview() === "agent" ? await dependencies.judge?.().catch(() => undefined) : undefined;
    // V4.7 验收未通过：长期偏好只跟着新流程（OUTING_REVIEW=agent）进规划，缺省流程没评测过，和卡片冲突时可能排不出。
    const preferences = outingReview() === "agent"
      ? await dependencies.preferences?.().catch(() => []) ?? []
      : [];
    // 用户原话只在这次判断时送模型，不存（stages/V4.7.md §3.1）。
    const said = found.messages.flatMap((message) => (message.role === "user" && message.kind === "text" ? [message.body.text] : []));
    await generateOuting({
      ...built.input,
      pace: draft.pace,
      cityAdcode: draftCity(draft).adcode,
      ...(draft.notes ? { notes: draft.notes } : {}),
      ...(preferences.length ? { preferences: preferences.slice(0, 10) } : {}),
      ...(judge ? { said } : {}),
    }, allocation, {
      runner,
      provider,
      now: dependencies.now,
      weather: forecastLookup(provider, signal),
      ...(reviewer ? { reviewer } : {}),
      ...(judge ? { judge } : {}),
    }, {
      signal,
      ...(again ? { days: input.days, exclude } : {}),
      onReviewStart: () => step("正在检查整趟安排"),
      onReview: (outcome) => {
        review = outcome;
      },
      onLodging: (choices) => {
        lodging = choices;
      },
      onProgress: (day, progress) => {
        if (progress.detail) step(`第 ${day} 天：${progress.detail}`);
      },
      onDay: async (generated) => {
        // V3.5：用户点了停止（或超时）之后没排出来的天不存：那不是“规划服务出错”，是没排；排好的天照常留着。
        if (signal.aborted && generated.result.status !== "draft") return;
        const built = await outingDayMessage(generated, generationId, `${title} · 第 ${generated.day} 天`.slice(0, 80), dependencies);
        const message: NewMessage = { role: "assistant", kind: "outing_day", body: built.body };
        const appended = await store.appendTurn({
          conversationId, expectedCount: messageCount, messages: [message], now: new Date(dependencies.now()), newId: randomUUID,
        });
        if (appended.status !== "appended") throw new Error(`append_${appended.status}`);
        messageCount = appended.messageCount;
        const reread = await store.findConversation(conversationId);
        const stored = reread?.messages.at(-1);
        emit({
          type: "day",
          messageCount,
          message: { ...built.view, id: stored?.id ?? randomUUID() },
          receipts: built.receipts,
        });
      },
    });
    // V3.2：审查直接改过分配就换掉卡片上的分配（之后“重排这一天”按新的排）；有建议就存一条建议消息。
    // V3.3：定了的暂定住处一起写进卡片（来源 suggested）。中途取消时不改卡片、不存建议（已排好的天照常留着）。
    const outcome = signal.aborted ? null : review as OutingReviewOutcome | null;
    const reallocated = !!outcome && !!draft.outing.allocation &&
      JSON.stringify(outcome.allocation.days.map(dayItems)) !== JSON.stringify(draft.outing.allocation.days.map(dayItems));
    const picked = signal.aborted ? [] : lodging.filter((choice) => choice.place);
    if (reallocated || picked.length) {
      const next: RequirementsDraft = {
        ...draft,
        outing: {
          ...draft.outing,
          ...(reallocated ? {
            allocation: {
              ...draft.outing.allocation!,
              days: outcome!.allocation.days.map((entry) => ({
                day: entry.day, visits: [...entry.visits], interests: [...entry.interests], ...(entry.reason ? { reason: entry.reason } : {}),
              })),
            },
          } : {}),
          lodging: withSuggestedLodging(draft.outing.lodging, picked),
          ...lodgingAreasAfter(draft.outing, picked),
        },
      };
      const updated = await store.updateDraft({ conversationId, expectedFingerprint: expected, draft: next, now: new Date(dependencies.now()) });
      if (updated.status === "updated" && dependencies.cardView) emit({ type: "card", card: await dependencies.cardView(next) });
    }
    if (outcome?.suggestions.length || outcome?.assessment) {
      const body: OutingReviewBody = {
        generationId,
        ...(outcome.assessment ? { assessment: { summary: outcome.assessment.summary, items: outcome.assessment.items.map((item) => ({ ...item })), issues: outcome.assessment.issues.map((issue) => ({ ...issue })) } } : {}),
        // V3.3：上限 8 → 12（7 天的出游可能有好几段连住，每段 2 个换住处的候选）。
        suggestions: outcome.suggestions.slice(0, 12).map((item) => ({
          fix: item.fix,
          text: item.text.slice(0, 80),
          status: "pending" as const,
          ...(item.tried ? { tried: item.tried.slice(0, 120) } : {}),
        })),
      };
      const appended = await store.appendTurn({
        conversationId, expectedCount: messageCount, messages: [{ role: "assistant", kind: "outing_review", body }], now: new Date(dependencies.now()), newId: randomUUID,
      });
      if (appended.status === "appended") {
        messageCount = appended.messageCount;
        const stored = (await store.findConversation(conversationId))?.messages.at(-1);
        if (stored?.kind === "outing_review") emit({ type: "review", messageCount, message: outingReviewView(stored, true) });
      }
    }
    emit({ type: "outing_done", messageCount });
  };
}

/**
 * V3.3：把这次定的暂定住处写进卡片的住处（只存编号、名称和城市，来源 suggested）；用户给的那几晚不动，只有原来
 * 记成住处的其实是个区域（replaces）时才替换。
 */
function withSuggestedLodging(lodging: OutingDraft["lodging"], picked: readonly LodgingChoice[]): OutingDraft["lodging"] {
  const nights = new Map(lodging.map((item) => [item.night, item]));
  for (const choice of picked) {
    const place = choice.place!.place;
    for (const night of choice.nights) {
      if (nights.get(night)?.onBoard || (nights.get(night)?.place && !choice.replaces)) continue;
      nights.set(night, {
        night,
        place: { status: "bound", externalId: place.ref.externalId, name: place.name.slice(0, 80), city: place.cityAdcode },
        source: "suggested",
      });
    }
  }
  return [...nights.values()].sort((a, b) => a.night - b.night);
}

/** V3.3：原来记成住处的区域换成暂定住处后，区域记到卡片的“住处区域”里（以后重新找也在那一带）。 */
function lodgingAreasAfter(outing: OutingDraft, picked: readonly LodgingChoice[]): Pick<OutingDraft, "lodgingAreas"> {
  const added = picked.flatMap((choice) => (choice.replaces && choice.area ? [choice.area.slice(0, DRAFT_LIMITS.lodgingAreaChars)] : []));
  if (!added.length) return {};
  const areas = [...(outing.lodgingAreas ?? [])];
  for (const text of added) if (!areas.some((item) => item.text === text)) areas.push({ text });
  return { lodgingAreas: areas.slice(0, DRAFT_LIMITS.lodgingAreas) };
}

/** V3.2 保存之后采纳一条审查建议（第几条），走改动流程。 */
export interface AdoptRequest {
  readonly adopt: { readonly messageId: string; readonly index: number };
}

/** 还没处理的那条建议（已采纳、已忽略或不存在返回 null）。 */
function pendingSuggestion(messages: readonly StoredMessage[], target: AdoptRequest["adopt"]): SuggestionFix | null {
  const message = messages.find((item) => item.id === target.messageId);
  const suggestion = message?.kind === "outing_review" ? message.body.suggestions[target.index] : undefined;
  return suggestion?.status === "pending" ? suggestion.fix : null;
}

/**
 * V3.2：把一条审查建议换成改好的卡片和受影响的天（采纳时用）。挪天、对调用卡片的“移到第几天”（分配跟着挪），
 * 加兴趣、去掉地点会作废分配，由这里把原来的分配补回去再加上 / 去掉这一项；改出行方式记在卡片的“哪几天不自驾”。
 * V3.3 换住处：这一段的每一晚换成那一家（来源改成用户的），分配不变，重排这几晚涉及的天。放不进卡片时返回 null。
 */
export function adoptedDraft(draft: RequirementsDraft, fix: SuggestionFix): AdoptedChange["adopted"] | null {
  const allocation = draft.outing?.allocation;
  if (draft.mode !== "outing" || !allocation) return null;
  const dayOf = (ref: string) => allocation.days.find((entry) => entry.visits.includes(ref) || entry.interests.includes(ref))?.day;
  const apply = (current: RequirementsDraft | null, patch: Parameters<typeof applyDraftPatch>[1]) => {
    if (!current) return null;
    const applied = applyDraftPatch(current, patch);
    return applied.status === "ok" ? applied.draft : null;
  };
  const withAllocation = (next: RequirementsDraft | null, days: typeof allocation.days): RequirementsDraft | null =>
    next ? { ...next, outing: { ...next.outing!, allocation: { ...allocation, days } } } : null;
  const note = fix.reason.slice(0, 80);
  switch (fix.action) {
    case "move_visit":
    case "move_interest": {
      const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
      const next = apply(draft, { moveToDay: { target: ref, day: fix.toDay } });
      const from = dayOf(ref);
      return next ? { draft: next, affected: [...new Set([...(from ? [from] : []), fix.toDay])].sort((a, b) => a - b), note } : null;
    }
    case "swap_days_content": {
      const [a, b] = fix.days;
      const movable = (day: number) => {
        const entry = allocation.days.find((item) => item.day === day);
        const visits = (entry?.visits ?? []).filter((key) => draft.visits.find((visit) => visit.key === key)?.role !== "fixed");
        return [...visits, ...(entry?.interests ?? [])];
      };
      let next: RequirementsDraft | null = draft;
      for (const ref of movable(a)) next = apply(next, { moveToDay: { target: ref, day: b } });
      for (const ref of movable(b)) next = apply(next, { moveToDay: { target: ref, day: a } });
      return next ? { draft: next, affected: [a, b].sort((x, y) => x - y), note } : null;
    }
    case "add_interest": {
      const next = apply(draft, { addInterests: [{ text: fix.text, ...(fix.when ? { when: fix.when } : {}), day: fix.day }] });
      const added = next?.interests.find((item) => !draft.interests.some((old) => old.id === item.id));
      if (!next || !added) return null;
      const days = allocation.days.map((entry) => (entry.day === fix.day ? { ...entry, interests: [...entry.interests, added.id] } : entry));
      const kept = withAllocation(next, days);
      return kept ? { draft: kept, affected: [fix.day], note } : null;
    }
    case "set_day_travel": {
      if (fix.remove.some((mode) => mode !== "driving")) return null;
      const next = apply(draft, { noDriving: [fix.day] });
      return next ? { draft: next, affected: [fix.day], note } : null;
    }
    case "choose_lodging": {
      const outing = draft.outing!;
      const days = outingDays(outing);
      if (fix.nights.some((night) => night >= days || outing.lodging.some((item) => item.night === night && item.onBoard))) return null;
      const place = { status: "bound" as const, externalId: fix.place.externalId, name: fix.place.name, ...(fix.place.city ? { city: fix.place.city } : {}) };
      const lodging = [
        ...outing.lodging.filter((item) => !fix.nights.includes(item.night)),
        ...fix.nights.map((night) => ({ night, place })),
      ].sort((a, b) => a.night - b.night);
      // 第 n 晚住哪影响第 n 天的终点和第 n + 1 天的起点。
      const affected = [...new Set(fix.nights.flatMap((night) => [night, night + 1]))].sort((a, b) => a - b);
      return { draft: { ...draft, outing: { ...outing, lodging } }, affected, note };
    }
    case "drop_visit": {
      const from = dayOf(fix.visit);
      const next = apply(draft, { removeVisits: [fix.visit] });
      const days = allocation.days.map((entry) => ({ ...entry, visits: entry.visits.filter((key) => key !== fix.visit) }));
      const kept = withAllocation(next, days);
      return kept ? { draft: kept, affected: from ? [from] : [], note } : null;
    }
  }
}

export type ReviewDecisionReply =
  | { readonly status: "ok"; readonly card?: unknown; readonly days?: readonly number[] }
  /** 这趟已经保存：采纳要走改动流程（页面接着调改动接口，确认才保存）。 */
  | { readonly status: "saved_trip" }
  | { readonly status: "not_found" | "conflict" | "invalid" };

/**
 * V3.2 审查建议的“采纳”“忽略”（stages/V3.2.md §3.6）。忽略只记下；采纳时还没保存的出游直接改卡片，页面接着重排
 * 受影响的天（同“重排这一天”）；已保存的出游告诉页面走改动流程。
 */
export function createReviewDecision(dependencies: {
  readonly now: () => number;
  readonly repository: () => ConversationRepository;
  readonly cardView: (draft: RequirementsDraft) => Promise<unknown>;
}) {
  return async function decide(
    conversationId: string,
    input: { readonly messageId: string; readonly index: number; readonly decision: "adopt" | "dismiss"; readonly fingerprint: string },
  ): Promise<ReviewDecisionReply> {
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    currentRun()?.root.link({ conversationId });
    const fix = pendingSuggestion(found.messages, input);
    if (!fix) return { status: "conflict" };
    const now = new Date(dependencies.now());
    if (input.decision === "dismiss") {
      const decided = await store.decideSuggestion({ conversationId, messageId: input.messageId, index: input.index, status: "dismissed", now });
      return decided.status === "updated" ? { status: "ok" } : { status: decided.status };
    }
    if (hasSavedOuting(found.messages)) return { status: "saved_trip" };
    const { draft } = found.conversation;
    if (fingerprint(draft) !== input.fingerprint) return { status: "conflict" };
    const adopted = adoptedDraft(draft, fix);
    if (!adopted) return { status: "invalid" };
    const updated = await store.updateDraft({ conversationId, expectedFingerprint: input.fingerprint, draft: adopted.draft, now });
    if (updated.status !== "updated") return { status: updated.status };
    await store.decideSuggestion({ conversationId, messageId: input.messageId, index: input.index, status: "adopted", now });
    return { status: "ok", card: await dependencies.cardView(adopted.draft), days: adopted.affected };
  };
}

/** 一天分到的地点和兴趣（比较审查有没有改分配）。 */
const dayItems = (entry: { readonly day: number; readonly visits: readonly string[]; readonly interests: readonly string[] }) =>
  ({ day: entry.day, visits: [...entry.visits], interests: [...entry.interests] });

type OutingReviewBody = Extract<StoredMessage, { kind: "outing_review" }>["body"];

/** V3.2 审查建议卡片：每条一句话和理由；open 时还能采纳或忽略（只有这次生成最新的那张）。 */
export function outingReviewView(message: Extract<StoredMessage, { kind: "outing_review" }>, open: boolean): OutingReviewView {
  return {
    id: message.id,
    role: "assistant",
    kind: "outing_review",
    open,
    ...(message.body.assessment ? { assessment: message.body.assessment } : {}),
    suggestions: message.body.suggestions.map((item, index) => ({
      index,
      text: item.text,
      reason: item.fix.reason,
      status: item.status,
      ...(item.tried ? { tried: item.tried } : {}),
      ...(item.fix.action === "choose_lodging"
        ? { place: { name: item.fix.place.name, ...(item.fix.place.city ? { city: item.fix.place.city } : {}) } }
        : {}),
    })),
  };
}

/** 最近一次生成的各天（同一天重排过的取最新那条）。 */
export function latestGeneration(messages: readonly StoredMessage[]) {
  const outing = messages.filter((message): message is Extract<StoredMessage, { kind: "outing_day" }> => message.kind === "outing_day");
  const last = outing.at(-1);
  if (!last) return null;
  const byDay = new Map<number, OutingDayBody>();
  for (const message of outing) {
    if (message.body.generationId === last.body.generationId) byDay.set(message.body.day, message.body);
  }
  return { generationId: last.body.generationId, days: [...byDay.values()].sort((a, b) => a.day - b.day) };
}

/** 这一天按兴趣新找到的地点（跨天不重复用）。 */
function discoveredIds(body: OutingDayBody): string[] {
  return body.parts.flatMap((part) => (part.kind === "plan" ? part.plan.stops.filter((stop) => stop.role === "discovered").map((stop) => stop.externalId) : []));
}

/** 一天的结果 → 存储正文（只有编号、名称和我们的时刻）、页面视图和各段的保存凭据。 */
async function outingDayMessage(
  generated: GeneratedDay,
  generationId: string,
  title: string,
  dependencies: Parameters<typeof createOutingGeneration>[0],
): Promise<{ body: OutingDayBody; view: Omit<OutingDayView, "id">; receipts: OutingReceipt[] }> {
  const { result } = generated;
  const base = { generationId, day: generated.day, date: generated.date, title, tripId: null };
  if (result.status === "failed" && dependencies.environment().NODE_ENV === "development") {
    // 只记录错误代码，不输出地点或对话。
    console.warn(`[outing] day ${generated.day} segment ${result.segment} failed: ${result.code}`);
  }
  if (result.status !== "draft") {
    const explanation = result.status === "no_plan" ? result.explanation
      : result.status === "needs_confirmation" ? "有过夜交通还没确认。"
        // V3.1：共用预算用完后没排的天（总控图停下来了），和服务出错分开说。
        : result.code === "budget_exhausted" ? "这次请求太复杂，没能做完，可以重排这一天。" : "规划服务暂时出错，可以重排这一天。";
    const notes = result.status === "no_plan" ? result.notes.slice(0, 8).map((note) => note.slice(0, 120)) : [];
    const body: OutingDayBody = { ...base, status: result.status === "no_plan" ? "no_plan" : "failed", parts: [], notes, explanation: explanation.slice(0, 300) };
    return { body, view: { role: "assistant", kind: "outing_day", ...body, parts: [] }, receipts: [] };
  }
  const parts: OutingDayBody["parts"][number][] = [];
  const views: OutingDayPartView[] = [];
  const receipts: OutingReceipt[] = [];
  let failed = false;
  for (const part of result.parts) {
    if (part.kind === "transfer") {
      const item = {
        kind: "transfer" as const, mode: part.mode, from: part.from.slice(0, 80), to: part.to.slice(0, 80),
        departAt: clock(part.departAt), arriveAt: clock(part.arriveAt), nextDay: part.nextDay, estimated: part.estimated,
      };
      parts.push(item);
      views.push(item);
      continue;
    }
    if (part.kind === "connect") {
      if (part.mode === "same_place") continue;
      const item = { kind: "connect" as const, from: part.from.slice(0, 80), to: part.to.slice(0, 80), departAt: clock(part.departsAt), arriveAt: clock(part.arrivesAt) };
      parts.push(item);
      views.push(item);
      continue;
    }
    const snapshot = generated.snapshots.get(part.segment);
    if (!snapshot || !part.result) {
      failed = true;
      continue;
    }
    const done = await dependencies.planOutcome({
      result: part.result, snapshot, title, paths: new Map(), environment: dependencies.environment(), nowMs: dependencies.now(),
    });
    parts.push({ kind: "plan", segment: part.segment, plan: done.body });
    views.push({ kind: "plan", plan: done.planView });
    if (done.receipt) receipts.push({ day: generated.day, part: part.segment, runId: snapshot.problem.runId, ...done.receipt });
  }
  // V3.2：审查后调整了这一天时写在最前面。
  const notes = [...(generated.reviewNote ? [generated.reviewNote] : []), ...result.notes].slice(0, 8).map((note) => note.slice(0, 120));
  const body: OutingDayBody = failed
    ? { ...base, status: "failed", parts: [], notes, explanation: "这一天的方案没能保存下来，可以重排这一天。" }
    : { ...base, status: "draft", parts, notes };
  return { body, view: { role: "assistant", kind: "outing_day", ...body, parts: failed ? [] : views }, receipts: failed ? [] : receipts };
}

export type OutingSaveReply =
  | { status: "saved" | "already_saved"; tripId: string }
  | { status: "not_found" | "incomplete" | "invalid_receipt" | "expired" | "disabled" | "acknowledgment_required" | "draft_changed" | "temporarily_unavailable" | "intent_conflict"; day?: number };

/**
 * V2.11 保存整趟（§3.8）：这次生成的每一天都排好了才能保存；每段用它的签名凭据复核（同一日的保存流程），
 * 全部通过后出游和各天在一个事务里创建，再把各天消息关联到出游。
 */
export function createOutingSave(dependencies: {
  readonly now: () => number;
  readonly repository: () => ConversationRepository;
  readonly trips: () => TripRepository;
  readonly routes: () => MobilityProvider;
  readonly verify: (receipt: string, now: number) => { snapshot: DayDraftConfirmationSnapshot; draftFingerprint: string; expiresAt: number };
  readonly enabled: () => boolean;
  /** 卡片里不认得名字的城市按编码查一次（“我的行程”每天标出城市名）。 */
  readonly cities?: () => CityResolver;
}) {
  return async function save(
    conversationId: string,
    input: { readonly generationId: string; readonly receipts: readonly string[]; readonly acknowledgeUnknowns: boolean },
  ): Promise<OutingSaveReply> {
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    currentRun()?.root.link({ conversationId });
    const { draft } = found.conversation;
    const latest = latestGeneration(found.messages);
    if (!latest || latest.generationId !== input.generationId || draft.mode !== "outing" || !draft.outing) return { status: "not_found" };
    const total = outingDays(draft.outing);
    if (latest.days.length !== total || latest.days.some((body) => body.status !== "draft")) return { status: "incomplete" };
    const now = dependencies.now();
    const verified = new Map<string, ReturnType<typeof dependencies.verify>>();
    for (const receipt of input.receipts) {
      try {
        const payload = dependencies.verify(receipt, now);
        verified.set(payload.snapshot.problem.runId, payload);
      } catch {
        return { status: "invalid_receipt" };
      }
    }
    const names = await withCityNames(cityNames(draft, found.messages), [...verified.values()], dependencies.cities?.());
    const segments: TripSegment[] = [];
    for (const body of latest.days) {
      for (const part of body.parts) {
        if (part.kind !== "plan") continue;
        const payload = verified.get(part.plan.runId);
        if (!payload) return { status: "invalid_receipt", day: body.day };
        const adcode = segmentCity(payload.snapshot);
        segments.push({
          day: body.day,
          part: part.segment,
          snapshot: payload.snapshot,
          draftFingerprint: payload.draftFingerprint,
          expiresAt: payload.expiresAt,
          city: { adcode, name: names.get(adcode) ?? adcode },
        });
      }
    }
    const result = await confirmOuting({
      generationId: input.generationId,
      title: found.conversation.title,
      details: tripDetails(draft, latest.days),
      segments,
      acknowledgeUnknowns: input.acknowledgeUnknowns,
      enabled: dependencies.enabled(),
      routes: dependencies.routes(),
      repository: dependencies.trips(),
      idGenerator: { next: () => randomUUID() },
      clock: { now: () => new Date(now) },
    });
    if (result.status !== "saved" && result.status !== "already_saved") return result;
    const journeys = await dependencies.trips().findTrip(result.tripId);
    await store.markOutingSaved({
      conversationId, generationId: input.generationId, tripId: result.tripId, journeys: journeys?.days ?? [], now: new Date(now),
    });
    return result;
  };
}

/**
 * 这一段记在哪个城市（“我的行程”每天标出城市）：去的地方大多在哪个城市就记哪个（开车去苏州的那天记苏州），
 * 没有地点时用这段规划时的城市。
 */
function segmentCity(snapshot: DayDraftConfirmationSnapshot): string {
  const counts = new Map<string, number>();
  for (const activity of snapshot.draft.activities) {
    const city = snapshot.places.find((place) => place.placeId === activity.placeId)?.selection.place.cityAdcode;
    if (city) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? snapshot.problem.requirements.cityAdcode;
}

/** 实际的高德提供方也能按编码查城市（测试注入的演示提供方可能没有）。 */
function cityResolver(provider: object): CityResolver | undefined {
  return "resolveCity" in provider ? provider as CityResolver : undefined;
}

/** 各段所在的城市里还不认得名字的，按编码查城市名（查不到就留空，显示时退回编码）。 */
async function withCityNames(
  names: Map<string, string>,
  segments: readonly { snapshot: DayDraftConfirmationSnapshot }[],
  resolver: CityResolver | undefined,
): Promise<Map<string, string>> {
  if (!resolver) return names;
  for (const adcode of new Set(segments.map((segment) => segmentCity(segment.snapshot)))) {
    if (names.has(adcode)) continue;
    const found = await resolver.resolveCity(adcode).catch(() => null);
    if (found?.status === "ok") names.set(adcode, found.data.name);
  }
  return names;
}

/** 卡片里知道名字的城市（主要城市、兴趣指定的城市、日常提示里带过来的外地）。 */
function cityNames(draft: RequirementsDraft, messages: readonly StoredMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  const city = draftCity(draft);
  names.set(city.adcode, city.name);
  for (const interest of draft.interests) if (interest.city) names.set(interest.city.adcode, interest.city.name);
  for (const message of messages) {
    if (message.kind !== "notice" || !message.body.outing) continue;
    for (const place of message.body.outing.places) names.set(place.city, place.cityName);
  }
  return names;
}

/** 出游本身的结构：只有地点编号、名称和我们自己的时刻（D-046）。 */
function tripDetails(draft: RequirementsDraft, days: readonly OutingDayBody[]): StoredTrip {
  const outing = draft.outing!;
  const ref = (place: DraftPlace | null | undefined) =>
    place?.status === "bound" ? { externalId: place.externalId, name: place.name.slice(0, 80) } : null;
  const transports: StoredTrip["transports"][number][] = [];
  const structure = days.map((body) => ({
    day: body.day,
    date: body.date,
    parts: body.parts.flatMap((part): StoredTrip["days"][number]["parts"] => {
      if (part.kind === "plan") return [{ kind: "plan", part: part.segment }];
      if (part.kind === "connect") return [{ kind: "connect", from: part.from, to: part.to, departAt: part.departAt, arriveAt: part.arriveAt }];
      const given = outing.transports.find((item) => item.day === body.day && ref(item.from)?.name === part.from && ref(item.to)?.name === part.to);
      if (!given) return [];
      transports.push({
        day: body.day, mode: part.mode, from: ref(given.from)!, to: ref(given.to)!, departAt: part.departAt, arriveAt: part.arriveAt,
        arriveDay: given.arriveDay, estimated: part.estimated,
      });
      return [{ kind: "transfer", transport: transports.length - 1 }];
    }),
  }));
  return {
    schemaVersion: "trip.v1",
    start: { place: ref(draft.start)!, at: outing.startAt },
    end: { place: ref(draft.end ?? draft.start)!, at: outing.endAt },
    lodging: outing.lodging.map((night) => ({
      night: night.night,
      place: night.onBoard ? null : ref(night.place),
      onBoard: !!night.onBoard,
      ...(night.source === "suggested" && !night.onBoard && night.place ? { source: "suggested" as const } : {}),
    })),
    transports,
    days: structure,
  };
}

/** 读已保存出游要用的两样：出游结构和某个一日行程的当前版本。 */
export interface OutingReader {
  findTrip(tripId: string): Promise<{ details: StoredTrip; days: readonly { day: number; part: number; journeyId: string }[] } | null>;
  findCurrentJourney(journeyId: string): Promise<StoredJourney | null>;
}

const chinaNow = (nowMs: number) => {
  const local = new Date(nowMs + 8 * 3_600_000).toISOString();
  return { date: local.slice(0, 10), minute: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
};

/** 这段对话里有没有保存过的出游（只看消息，不读库）。 */
export function hasSavedOuting(messages: readonly StoredMessage[]): boolean {
  return !!latestGeneration(messages)?.days.some((day) => day.tripId);
}

/**
 * V2.11 这段对话保存的出游：各天各段的一日行程（当前版本）、今天是第几天（出游开始前 0、结束后天数 + 1），
 * 以及“现在”对应的那一段（今天正在进行或下一段；出游前是第一段，结束后是最后一段）。今天的调整（V2.5）用它。
 */
export async function savedOuting(messages: readonly StoredMessage[], reader: OutingReader, nowMs: number) {
  const tripId = latestGeneration(messages)?.days.find((day) => day.tripId)?.tripId;
  if (!tripId) return null;
  const trip = await reader.findTrip(tripId).catch(() => null);
  if (!trip) return null;
  const journeys = new Map<string, StoredJourney>();
  for (const part of trip.days) {
    const journey = await reader.findCurrentJourney(part.journeyId).catch(() => null);
    if (journey) journeys.set(part.journeyId, journey);
  }
  const now = chinaNow(nowMs);
  const dates = trip.details.days.map((day) => day.date);
  const today = dates.indexOf(now.date) + 1 || (now.date < dates[0]! ? 0 : dates.length + 1);
  const ordered = [...trip.days].sort((a, b) => a.day - b.day || a.part - b.part);
  const todays = ordered.filter((part) => part.day === today);
  const ends = (part: { journeyId: string }) => journeys.get(part.journeyId)?.realDay?.context.window.endsAt ?? 0;
  const active = today === 0 ? ordered[0]
    : today > dates.length ? ordered.at(-1)
      : todays.find((part) => ends(part) > now.minute) ?? todays.at(-1) ?? ordered.find((part) => part.day > today);
  return { tripId, trip, journeys, today, activeJourneyId: active?.journeyId ?? null };
}

/** 给对话 Agent 的出游结构：每天的地点（卡片上的 key、是否已去、是否固定）、每晚住处、固定交通（卡片 id）。 */
export function outingChatContext(
  saved: NonNullable<Awaited<ReturnType<typeof savedOuting>>>,
  draft: RequirementsDraft,
): ChatOutingTrip {
  const keyOf = (externalId: string) => draft.visits.find((visit) => visit.place.status === "bound" && visit.place.externalId === externalId)?.key;
  const lodging = saved.trip.details.lodging;
  const days = saved.trip.details.days.map((day) => {
    const parts = saved.trip.days.filter((part) => part.day === day.day).sort((a, b) => a.part - b.part);
    const places = parts.flatMap((part) => {
      const journey = saved.journeys.get(part.journeyId);
      const details = journey?.realDay;
      if (!details) return [];
      const done = new Set(journey!.dayProgress?.completedActivityIds ?? []);
      return details.activities.map((item) => {
        const place = details.places.find((entry) => entry.placeId === item.record.activity.placeId)!;
        const key = keyOf(place.externalId);
        return {
          ...(key ? { key } : {}),
          name: place.name,
          status: done.has(item.record.activity.activityId) ? "done" as const : "todo" as const,
          ...(item.record.activity.role === "fixed" ? { fixed: true as const } : {}),
        };
      });
    });
    const night = lodging.find((item) => item.night === day.day);
    return {
      day: day.day,
      date: day.date,
      places,
      ...(night ? { lodging: night.onBoard ? "车上" : night.place ? `${night.place.name}${night.source ? "（暂定）" : ""}` : "未定" } : {}),
    };
  });
  const transports = (draft.outing?.transports ?? []).map((ride) => ({
    id: ride.id,
    day: ride.day,
    from: ride.from?.status === "bound" ? ride.from.name : "未定",
    to: ride.to?.status === "bound" ? ride.to.name : "未定",
    departAt: ride.departAt,
    arriveAt: ride.arriveAt,
  }));
  return { today: saved.today, days, transports };
}

type OutingChangeBody = Extract<StoredMessage, { kind: "outing_change" }>["body"];
export type OutingChangeEvent =
  | { type: "step"; step: ProgressStep }
  | { type: "change"; messageCount: number; messages: ChatMessageView[]; receipts: OutingReceipt[] }
  | { type: "refused"; status: "conflict" | "not_found" | "unavailable" | "incomplete"; message: string };

/**
 * V2.11 已保存出游的跨天改动（§3.9）：对话理解出 change_outing 后，代码检查并重排受影响的天，存成一张改动卡片
 * （前后对比、基础版本、改动后的卡片和新的各天）；用户确认时复核每段、比对基础版本，一个事务写入。
 */
export function createOutingChangeService(dependencies: Parameters<typeof createOutingGeneration>[0] & {
  readonly journeys: () => OutingReader & OutingChangeRepository;
  readonly routes: () => MobilityProvider;
  readonly verify: (receipt: string, now: number) => { snapshot: DayDraftConfirmationSnapshot; draftFingerprint: string; expiresAt: number };
  readonly saveEnabled: () => boolean;
}) {
  async function plan(
    conversationId: string,
    input: { readonly expectedCount: number; readonly request: OutingChangeRequest | AdoptRequest },
    emit: (event: OutingChangeEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const refuse = (status: Extract<OutingChangeEvent, { type: "refused" }>["status"], message: string) => emit({ type: "refused", status, message });
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    if (!found) return refuse("not_found", "找不到这段对话了。");
    currentRun()?.root.link({ conversationId });
    if (found.conversation.messageCount !== input.expectedCount) return refuse("conflict", "这段对话在别处有了新消息，请刷新后再试。");
    const { draft } = found.conversation;
    const reader = dependencies.journeys();
    const saved = await savedOuting(found.messages, reader, dependencies.now());
    if (!saved || draft.mode !== "outing") return refuse("not_found", "这段对话还没有保存的出游。");
    const base = await reader.readTripBase(saved.tripId);
    if (!base) return refuse("not_found", "这段对话还没有保存的出游。");
    const provider = dependencies.amap();
    let steps = 0;
    const step = (text: string) => emit({ type: "step", step: { key: `s${(steps += 1)}`, text, state: "active" } });

    // 已去过的卡片地点（各天的完成记录）；从今天挪走时要知道今天那一站的活动编号。
    const context = outingChatContext(saved, draft);
    const done = context.days.flatMap((day) => day.places.flatMap((place) => (place.key && place.status === "done" ? [place.key] : [])));
    let lodging: { externalId: string; name: string; cityAdcode?: string } | undefined;
    // V3.2：保存之后采纳审查建议，卡片由代码按建议改好，和用户说的改动走同一套重排、确认。
    const adopting = "adopt" in input.request ? input.request.adopt : null;
    let request: OutingChangeRequest | AdoptedChange;
    if ("adopt" in input.request) {
      const fix = pendingSuggestion(found.messages, input.request.adopt);
      if (!fix) return refuse("not_found", "这条建议已经处理过了。");
      const adopted = adoptedDraft(draft, fix);
      if (!adopted) return refuse("not_found", "这条建议放不进现在的卡片了。");
      request = { adopted };
    } else {
      request = input.request;
    }
    if ("lodging" in request) {
      const { mention, night } = request.lodging;
      step(`查找“${mention}”`);
      const current = draft.outing!.lodging.find((item) => item.night === night)?.place;
      const city = (current?.status === "bound" ? current.city : undefined) ?? draftCity(draft).adcode;
      const reply = await provider.searchPlaces({ query: mention, scope: { kind: "city", cityAdcode: city }, limit: 5 }, { signal })
        .catch(() => null);
      const items = reply?.status === "ok" ? reply.data.items : [];
      const item = items.find((entry) => entry.name.includes(mention)) ?? items[0];
      if (item) lodging = { externalId: item.ref.externalId, name: item.name, ...(item.cityAdcode ? { cityAdcode: item.cityAdcode } : {}) };
    }
    step("重排受影响的那几天");
    const earlier = latestGeneration(found.messages)!;
    const reviewer = outingReview() !== "off" ? await dependencies.reviewer?.().catch(() => undefined) : undefined;
    const result = await planOutingChange(draft, request, { today: saved.today, done }, {
      toInput: async (next) => {
        const built = await outingInput(next, provider, signal, dependencies.now);
        return built.status === "ok" ? built.input : null;
      },
      ...(lodging ? { lodging } : {}),
      exclude: (affected) => earlier.days.filter((body) => !affected.includes(body.day)).flatMap((body) => discoveredIds(body)),
      runner: await dependencies.runner(provider),
      provider,
      now: dependencies.now,
      weather: forecastLookup(provider, signal),
      ...(reviewer ? { reviewer } : {}),
    }, signal);

    const messages: NewMessage[] = [];
    let receipts: OutingReceipt[] = [];
    const failedDay = result.status === "ok" ? result.generated.find((day) => day.result.status !== "draft") : undefined;
    if (result.status === "refused") {
      messages.push({ role: "assistant", kind: "notice", body: { text: result.detail.slice(0, 300), tone: "warning" } });
    } else if (failedDay) {
      const why = failedDay.result.status === "no_plan" ? failedDay.result.explanation : "规划服务暂时出错。";
      messages.push({ role: "assistant", kind: "notice", body: { text: `${result.note}后，第 ${failedDay.day} 天排不开：${why}`.slice(0, 300), tone: "warning" } });
    } else {
      const days: OutingDayBody[] = [];
      for (const generated of result.generated) {
        const built = await outingDayMessage(generated, earlier.generationId, `${found.conversation.title} · 第 ${generated.day} 天`.slice(0, 80), dependencies);
        days.push(built.body);
        receipts = [...receipts, ...built.receipts];
      }
      const skip = result.skipToday ? todayActivity(saved, draft, result.skipToday) : undefined;
      const body: OutingChangeBody = {
        changeId: randomUUID(),
        tripId: saved.tripId,
        note: result.note.slice(0, 80),
        base: { tripVersion: base.tripVersion, journeys: [...base.journeys] },
        ...(skip ? { skip } : {}),
        before: result.affected.map((day) => ({
          day,
          stops: (context.days.find((entry) => entry.day === day)?.places ?? []).map((place) => place.name.slice(0, 80)).slice(0, 16),
        })),
        days,
        draft: result.draft,
      };
      messages.push({ role: "assistant", kind: "outing_change", body });
    }
    const appended = await store.appendTurn({
      conversationId, expectedCount: input.expectedCount, messages, now: new Date(dependencies.now()), newId: randomUUID,
    });
    if (appended.status !== "appended") return refuse(appended.status, "这段对话在别处有了新消息，请刷新后再试。");
    if (adopting && messages.some((message) => message.kind === "outing_change")) {
      await store.decideSuggestion({ conversationId, ...adopting, status: "adopted", now: new Date(dependencies.now()) });
    }
    const reread = await store.findConversation(conversationId);
    const fresh = reread?.messages.slice(input.expectedCount) ?? [];
    emit({
      type: "change",
      messageCount: appended.messageCount,
      messages: fresh.flatMap((message): ChatMessageView[] => {
        if (message.kind === "notice") return [{ id: message.id, role: "assistant", kind: "notice", text: message.body.text, tone: message.body.tone }];
        if (message.kind === "outing_change") return [outingChangeView(message, reread!.messages, true)];
        return [];
      }),
      receipts,
    });
  }

  async function confirm(
    conversationId: string,
    input: { readonly messageId: string; readonly receipts: readonly string[] },
  ): Promise<{ status: "saved" | "already_saved" } | { status: "not_found" | "stale" | "invalid_receipt" | "expired" | "disabled" | "acknowledgment_required" | "draft_changed" | "temporarily_unavailable"; day?: number }> {
    const store = dependencies.repository();
    const found = await store.findConversation(conversationId);
    const message = found?.messages.find((item) => item.id === input.messageId);
    if (!found || message?.kind !== "outing_change") return { status: "not_found" };
    currentRun()?.root.link({ conversationId });
    const { body } = message;
    if (found.messages.some((item) => item.kind === "outing_day" && item.body.fromChange === body.changeId)) return { status: "already_saved" };
    const now = dependencies.now();
    const verified = new Map<string, ReturnType<typeof dependencies.verify>>();
    for (const receipt of input.receipts) {
      try {
        const payload = dependencies.verify(receipt, now);
        verified.set(payload.snapshot.problem.runId, payload);
      } catch {
        return { status: "invalid_receipt" };
      }
    }
    const names = await withCityNames(cityNames(body.draft, found.messages), [...verified.values()], cityResolver(dependencies.amap()));
    const segments: TripSegment[] = [];
    for (const day of body.days) {
      for (const part of day.parts) {
        if (part.kind !== "plan") continue;
        const payload = verified.get(part.plan.runId);
        if (!payload) return { status: "invalid_receipt", day: day.day };
        const adcode = segmentCity(payload.snapshot);
        segments.push({
          day: day.day, part: part.segment, snapshot: payload.snapshot, draftFingerprint: payload.draftFingerprint,
          expiresAt: payload.expiresAt, city: { adcode, name: names.get(adcode) ?? adcode },
        });
      }
    }
    // 出游结构：没改的天沿用现在的，改的天换成新的。
    const current = latestGeneration(found.messages)!.days;
    const merged = current.map((day) => body.days.find((item) => item.day === day.day) ?? day);
    const result = await confirmOutingChange({
      tripId: body.tripId,
      changeId: body.changeId,
      title: found.conversation.title,
      base: body.base,
      details: tripDetails(body.draft, merged),
      days: body.days.map((day) => day.day),
      segments,
      ...(body.skip ? { skip: body.skip } : {}),
      enabled: dependencies.saveEnabled(),
      routes: dependencies.routes(),
      repository: dependencies.journeys(),
      idGenerator: { next: () => randomUUID() },
      clock: { now: () => new Date(now) },
    });
    if (result.status !== "saved" && result.status !== "already_saved") return result;
    // 新的各天作为 outing_day 存进对话（带出游和各段行程），卡片换成改动后的；对话关联第一天第一段。
    const journeyOf = (day: number, part: number) => result.journeys.find((item) => item.day === day && item.part === part)?.journeyId ?? null;
    const first = [...result.journeys].sort((a, b) => a.day - b.day || a.part - b.part)[0];
    const messages: NewMessage[] = body.days.map((day) => ({
      role: "assistant" as const,
      kind: "outing_day" as const,
      body: {
        ...day,
        tripId: body.tripId,
        fromChange: body.changeId,
        parts: day.parts.map((part) => (part.kind === "plan" ? { ...part, plan: { ...part.plan, journeyId: journeyOf(day.day, part.segment) } } : part)),
      },
    }));
    // 出游已经写进去了，对话必须跟上：复核路线的这几秒里对话有了新消息（别的页面发了一条）就按最新的条数再写；
    // 一直写不进去就报暂时失败，页面重试时出游回“已保存”、这里再补（不能回“已保存”却让对话停在旧的各天和卡片上）。
    let expectedCount = found.conversation.messageCount;
    for (let attempt = 0; ; attempt += 1) {
      const appended = await store.appendTurn({
        conversationId,
        expectedCount,
        messages,
        draft: body.draft,
        ...(first ? { journeyId: first.journeyId } : {}),
        now: new Date(now),
        newId: randomUUID,
      });
      if (appended.status === "appended") break;
      const latest = appended.status === "conflict" && attempt < 2 ? await store.findConversation(conversationId) : null;
      if (!latest) throw new Error(`outing_change_append_${appended.status}`);
      // 同一个改动的另一次确认已经写过了。
      if (latest.messages.some((item) => item.kind === "outing_day" && item.body.fromChange === body.changeId)) break;
      expectedCount = latest.conversation.messageCount;
    }
    return { status: result.status };
  }

  return { plan, confirm };
}

/** 今天行程里对应这个卡片地点、还没完成的那一站。 */
function todayActivity(
  saved: NonNullable<Awaited<ReturnType<typeof savedOuting>>>,
  draft: RequirementsDraft,
  visitKey: string,
): { journeyId: string; activityId: string } | undefined {
  const visit = draft.visits.find((item) => item.key === visitKey);
  if (visit?.place.status !== "bound") return undefined;
  const externalId = visit.place.externalId;
  for (const part of saved.trip.days.filter((item) => item.day === saved.today)) {
    const journey = saved.journeys.get(part.journeyId);
    const details = journey?.realDay;
    const place = details?.places.find((item) => item.externalId === externalId);
    const activity = place && details!.activities.find((item) => item.record.activity.placeId === place.placeId);
    if (activity && !(journey!.dayProgress?.completedActivityIds ?? []).includes(activity.record.activity.activityId)) {
      return { journeyId: part.journeyId, activityId: activity.record.activity.activityId };
    }
  }
  return undefined;
}

/** 改动卡片的页面视图：只有最新一张、还没确认的能确认。 */
export function outingChangeView(
  message: Extract<StoredMessage, { kind: "outing_change" }>,
  all: readonly StoredMessage[],
  live: boolean,
): OutingChangeView {
  const { body } = message;
  const saved = all.some((item) => item.kind === "outing_day" && item.body.fromChange === body.changeId);
  const latest = [...all].reverse().find((item) => item.kind === "outing_change")?.id === message.id;
  return {
    id: message.id,
    role: "assistant",
    kind: "outing_change",
    changeId: body.changeId,
    note: body.note,
    before: body.before,
    days: body.days.map((day) => ({
      id: `${message.id}-${day.day}`,
      role: "assistant" as const,
      kind: "outing_day" as const,
      ...day,
      parts: live
        ? day.parts.map((part) => (part.kind === "plan" ? { kind: "plan" as const, plan: storedPlanCard(part.plan, true) } : part))
        : day.parts.map((part) => (part.kind === "plan" ? { kind: "plan" as const, plan: storedPlanCard(part.plan, false) } : part)),
    })),
    saved,
    open: live && latest && !saved,
  };
}

/** 存储的一段方案 → 页面卡片（只有名称和我们的时刻）。 */
function storedPlanCard(body: PlanBody, live: boolean): PlanCardView {
  return {
    runId: body.runId,
    title: body.title,
    date: body.date,
    startName: body.start.name,
    endName: body.end.name,
    departAt: body.departAt,
    arriveAt: body.arriveAt,
    travelBeforeEnd: { mode: body.endArrivalMode ?? "walking", minutes: null },
    totals: null,
    stops: body.stops.map((stop, index) => ({
      key: `stop-${index}`,
      startsAt: stop.startsAt,
      endsAt: stop.endsAt,
      name: stop.name,
      role: stop.role,
      ...(stop.reason ? { reason: stop.reason } : {}),
      travelBefore: { mode: stop.arrivalMode ?? "walking", minutes: null },
      waitMinutes: 0,
    })),
    notes: body.notes,
    pending: [],
    saved: body.journeyId ? { journeyId: body.journeyId } : null,
    live,
  };
}
