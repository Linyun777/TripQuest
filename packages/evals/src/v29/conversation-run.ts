import { evalChatRouter } from "../v293/chat-router";
import { emptyDraft, emptyOutingDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import { createChatRunner, describeDraft, replyHistoryText, type ChatDecisionModel, type ChatTrip, type ChatTurnInput } from "@tripquest/agent/chat";
import type { SummaryInput } from "@tripquest/agent/chat-summary";
import type { PlaceSearchData, PlaceSearchRequest, ProviderResult } from "@tripquest/providers";
import { TRIP_DATE, TRIP_NOW, TRIP_STOPS, tripStopName } from "../v21/adjust-dataset";
import { tripDraft } from "../v21/adjust-run";
import { CityAwareKnowledge, FakeKnowledge } from "../v21/knowledge-dataset";
import { FakeWeb } from "../v21/info-dataset";
import { FORECASTS, HANGZHOU_LOCATED, V21_NOW, V21World } from "../v21/world";

/**
 * V2.9 对话类评测（闲聊与建议、偏好、长对话）共用：多轮消息逐条走产品自己的对话 runner，
 * 记录每轮查了什么、拿到哪些候选、卡片和行程有没有变。地点、网页和资料库都是固定的虚构世界。
 */
export interface SavedPreference {
  readonly text: string;
  readonly category: "food" | "pace" | "travel" | "interest" | "other";
}

export interface ConversationCase {
  readonly id: string;
  readonly note: string;
  /** 本次评测里真正发给模型的消息（逐轮）。 */
  readonly turns: readonly string[];
  /** 在已保存行程的对话里（V2.5 的调整上下文）。 */
  readonly trip?: boolean;
  /** 已经保存的长期偏好（V2.9 起由产品带进上下文；之前的产品读不到）。 */
  readonly saved?: readonly SavedPreference[];
  /** 固定的更早对话（长对话题），最早的在前。 */
  readonly history?: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly checks: readonly ConversationCheck[];
  readonly heldOut?: boolean;
  /** V2.10：打开页面时定位到的城市（写进卡片）；不写 = 没有定位（缺省杭州）。现在的产品没有这个字段，会忽略它。 */
  readonly located?: { readonly adcode: string; readonly name: string };
  /** V2.10：用按城市过滤的资料库（资料库过滤题）。 */
  readonly cityKnowledge?: true;
  /** V2.11：在出游模式里开始（用户在页面上切到了出游）。没有出游模式的产品按日常卡片跑（基线）。 */
  readonly outing?: true;
}

export interface ConversationOutcome {
  readonly replies: readonly string[];
  readonly failed: boolean;
  readonly draft: RequirementsDraft;
  readonly cardChanged: boolean;
  readonly adjusted: boolean;
  /** 每次地点搜索的词，以及返回的候选名。 */
  readonly searches: readonly string[];
  readonly candidates: readonly string[];
  readonly webQueries: readonly string[];
  readonly knowledgeQuestions: readonly string[];
  /** 最后一轮回复引用的来源数。 */
  readonly sources: number;
  /** 最后一轮回复推荐的地点名（V2.9 的 `places`；之前没有这个字段）。 */
  readonly places: readonly string[];
  /** V2.9.1：每轮推荐的地点名（按推荐顺序），用来判断“就去第二家”选对没有。 */
  readonly turnPlaces: readonly (readonly string[])[];
  /** V2.9.1：每轮生成的摘要（只在带摘要器时有）。 */
  readonly summaries: readonly string[];
  /** 每轮发出的偏好提议（V2.9 的 `proposal`；之前没有）。 */
  readonly proposals: readonly { readonly text: string; readonly category: string }[];
  /** DeepSeek 返回的缓存命中与未命中输入 tokens（累加）。 */
  readonly cache: { readonly hit: number; readonly miss: number };
  /** 失败轮次的错误码与提示码。 */
  readonly failures: readonly string[];
  /** V2.10：最后一轮引用的来源种类（kb / web）。 */
  readonly sourceKinds: readonly string[];
  /** V2.9.3：每轮总耗时（毫秒，含分流）和分流用的输入 tokens（正则为 0）。 */
  readonly turnMs: readonly number[];
  readonly routeTokens: number;
  /** V2.11：日常模式里被引导到出游的地点或城市名（各轮累计；之前没有这个字段）。 */
  readonly outside: readonly string[];
  /** V3.4：每轮的输入 tokens（各次模型请求合计，失败轮为 0）、是否在问用户、跑了哪些专门 Agent（之前的产品没有，空）。 */
  readonly turnTokens: readonly number[];
  readonly turnAsks: readonly boolean[];
  readonly turnAgents: readonly (readonly string[])[];
  /** 全部轮次的对话模型请求。 */
  readonly modelRequests: number;
}

export interface ConversationCheck {
  readonly name: string;
  readonly test: (outcome: ConversationOutcome) => boolean;
}

/** 记下每次搜索返回的候选名，用来判断回复里的地点是不是本轮查到的。 */
class RecordingWorld extends V21World {
  readonly names: string[] = [];

  override async searchPlaces(request: PlaceSearchRequest): Promise<ProviderResult<PlaceSearchData>> {
    const result = await super.searchPlaces(request);
    if (result.status === "ok") this.names.push(...result.data.items.map((item) => item.name));
    return result;
  }
}

function savedTrip(): ChatTrip {
  return {
    version: 1,
    date: TRIP_DATE,
    stops: TRIP_STOPS.map((stop) => ({
      key: stop.key,
      name: tripStopName(stop),
      startsAt: stop.startsAt,
      endsAt: stop.endsAt,
      status: "todo" as const,
      for: stop.interest,
    })),
  };
}

/** 对照 B：每轮前把落在窗口外的旧消息交给摘要器（窗口与产品相同：本轮之外的最近 11 条）。 */
export type Summarize = (input: SummaryInput) => Promise<string | null>;
const WINDOW = 11;

export async function runConversationCase(item: ConversationCase, model: () => ChatDecisionModel, summarize?: Summarize): Promise<ConversationOutcome> {
  const world = new RecordingWorld(FORECASTS.dry);
  const web = new FakeWeb();
  const knowledge = item.cityKnowledge ? new CityAwareKnowledge() : new FakeKnowledge();
  const trip = item.trip ? savedTrip() : undefined;
  // V2.10：定位到的城市预先写进卡片；现在的产品没有 city 字段（基线会忽略或拒绝它）。
  // V2.11：出游题从出游卡片开始（用户在页面上选了出游）。
  let draft: RequirementsDraft = item.outing ? emptyOutingDraft(item.located) : {
    ...(trip ? tripDraft() : emptyDraft()),
    ...(item.located ? { city: item.located } : {}),
  } as RequirementsDraft;
  const history: { role: "user" | "assistant"; text: string }[] = [
    ...(trip ? [
      { role: "user" as const, text: "明天9点从东门广场出发再回来，想看展、看越剧、喝茶" },
      { role: "assistant" as const, text: "（方案已保存为行程）" },
    ] : []),
    ...(item.history ?? []),
  ];
  const replies: string[] = [];
  const proposals: { text: string; category: string }[] = [];
  const outside: string[] = [];
  let failed = false;
  let cardChanged = false;
  let adjusted = false;
  let sources = 0;
  let sourceKinds: string[] = [];
  let places: string[] = [];
  const turnPlaces: string[][] = [];
  const summaries: string[] = [];
  const turnMs: number[] = [];
  const turnTokens: number[] = [];
  const turnAsks: boolean[] = [];
  const turnAgents: string[][] = [];
  let modelRequests = 0;
  let routeTokens = 0;
  const cache = { hit: 0, miss: 0 };
  const failures: string[] = [];
  for (const text of item.turns) {
    // 偏好随输入带上；V2.9 之前的 runner 不认这个字段，照常忽略。
    const extra = item.saved ? { preferences: item.saved } : {};
    const leaving = history.length > WINDOW ? history.slice(0, history.length - WINDOW) : [];
    const summary = summarize && leaving.length
      ? await summarize({ previous: null, card: describeDraft(draft), messages: leaving })
      : null;
    if (summary) summaries.push(summary);
    const input: ChatTurnInput = {
      draft,
      history,
      userText: text,
      nowMs: trip ? TRIP_NOW : V21_NOW,
      ...(trip ? { trip } : {}),
      ...extra,
      ...(summary ? { summary } : {}),
    };
    const started = performance.now();
    const result = await createChatRunner({ model: model(), places: world, weather: world, cities: world, web, knowledge, ...evalChatRouter() })
      .run(input, { signal: new AbortController().signal });
    turnMs.push(Math.round(performance.now() - started));
    routeTokens += (result as { route?: { inputTokens?: number } }).route?.inputTokens ?? 0;
    turnTokens.push(result.usage?.inputTokens ?? 0);
    modelRequests += result.counts.model;
    // V3.4 起每轮记下跑了哪些专门 Agent（编号@提示词版本，交接的写成“甲→乙”）；之前的产品没有这一项。
    turnAgents.push([...((result as { agents?: readonly { id: string; version: string; handoffTo?: string }[] }).agents ?? [])]
      .map((agent) => `${agent.id}@${agent.version}${agent.handoffTo ? `→${agent.handoffTo}` : ""}`));
    history.push({ role: "user", text });
    const used = result.usage as { cacheHitTokens?: number | null; cacheMissTokens?: number | null } | null;
    cache.hit += used?.cacheHitTokens ?? 0;
    cache.miss += used?.cacheMissTokens ?? 0;
    if (result.status !== "completed") {
      // 失败轮的打回提示在决策记录里（result.hints 常是空的）。
      const hints = result.hints.length ? result.hints : (result as { trace?: { hints?: readonly string[] } }).trace?.hints ?? [];
      failures.push(`${result.code}: ${hints.join(", ")}`);
      failed = true;
      replies.push("");
      turnAsks.push(false);
      turnPlaces.push([]);
      continue;
    }
    draft = result.draft;
    cardChanged ||= result.draftChanged;
    adjusted ||= !!result.adjust;
    failed ||= result.reply.fallback;
    replies.push(result.reply.text);
    turnAsks.push(result.reply.asking);
    history.push({ role: "assistant", text: replyHistoryText(result.reply.text, result.reply.places) });
    if (result.draftChanged) history.push({ role: "assistant", text: "（已更新需求卡片）" });
    sources = result.reply.sources?.length ?? 0;
    sourceKinds = (result.reply.sources ?? []).map((source) => source.kind);
    const later = result as { proposal?: { text: string; category: string }; reply: { places?: readonly { name: string }[] } };
    if (later.proposal) proposals.push(later.proposal);
    outside.push(...((result as { outside?: readonly { name: string }[] }).outside ?? []).map((item) => item.name));
    places = (later.reply.places ?? []).map((place) => place.name);
    turnPlaces.push(places);
  }
  return {
    replies,
    failed,
    draft,
    cardChanged,
    adjusted,
    searches: world.searches,
    candidates: world.names,
    webQueries: web.queries,
    knowledgeQuestions: knowledge.questions,
    sources,
    places,
    turnPlaces,
    summaries,
    proposals,
    cache,
    failures,
    turnMs,
    routeTokens,
    sourceKinds,
    outside,
    turnTokens,
    turnAsks,
    turnAgents,
    modelRequests,
  };
}

export interface ConversationRow {
  readonly suite: "talk" | "pref" | "long" | "fix" | "e2e" | "city" | "kbcity" | "daily" | "stay" | "outing" | "accept" | "split";
  readonly caseId: string;
  readonly heldOut: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly replies: readonly string[];
  readonly searches: readonly string[];
  readonly cache: { readonly hit: number; readonly miss: number };
  readonly failures: readonly string[];
  readonly turnMs: readonly number[];
  readonly routeTokens: number;
  /** V3.4：每轮的输入 tokens 和专门 Agent，以及对话模型请求合计（对比代价用）。 */
  readonly turnTokens: readonly number[];
  readonly turnAgents: readonly (readonly string[])[];
  readonly modelRequests: number;
}

export async function runConversationRow(
  suite: ConversationRow["suite"],
  item: ConversationCase,
  model: () => ChatDecisionModel,
  summarize?: Summarize,
): Promise<ConversationRow> {
  // 城市理解与资料库过滤题按题目写的定位跑（不写 = 拒绝定位）；其余杭州回归题按定位在杭州。
  const located = suite === "city" || suite === "kbcity" || suite === "daily" || suite === "stay" || suite === "outing" || suite === "accept" ? item : { ...item, located: item.located ?? HANGZHOU_LOCATED };
  const outcome = await runConversationCase(located, model, summarize);
  const checks = [
    { name: "no_failed_turn", passed: !outcome.failed },
    ...item.checks.map((check) => ({ name: check.name, passed: check.test(outcome) })),
  ];
  return {
    suite,
    caseId: item.id,
    heldOut: !!item.heldOut,
    checks,
    passed: checks.every((check) => check.passed),
    replies: outcome.replies,
    searches: outcome.searches,
    cache: outcome.cache,
    failures: outcome.failures,
    turnMs: outcome.turnMs,
    routeTokens: outcome.routeTokens,
    turnTokens: outcome.turnTokens,
    turnAgents: outcome.turnAgents,
    modelRequests: outcome.modelRequests,
  };
}
