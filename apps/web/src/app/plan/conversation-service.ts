import "server-only";
import { requireOwner } from "../auth/owner";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyCurrentLocation,
  applyDraftPatch,
  draftMissing,
  type ConversationRepository,
  type DraftPatch,
  type DraftPlace,
  type NewMessage,
  type RequirementsDraft,
  type StoredMessage,
  draftCity,
  emptyDraft,
  emptyOutingDraft,
  switchDraftMode,
  outingDays,
  type DraftCity,
  type OutingDraft,
} from "@tripquest/application/conversation";
import { ChatRunError, createChatRunner, describeDraft, replyHistoryText, type ChatOutside, type ChatProgress, type ChatTurnResult } from "@tripquest/agent/chat";
import { createChatSummarizer, type SummaryInput } from "@tripquest/agent/chat-summary";
import { createChatLiveModel } from "@tripquest/agent/chat-live";
import { createAllocationRequest } from "@tripquest/agent/outing-allocate";
import { afterOutingTurn, withAfterTurn } from "@tripquest/agent/outing-after-turn";
import { datesFromCard } from "@tripquest/application/said-dates";
import { rideHints } from "@tripquest/application/outing-rides";
import { stayHints, staysLabel } from "@tripquest/application/outing-stays";
import { createOutingService, hasSavedOuting, latestGeneration, outingChangeView, outingChatContext, outingReviewView, savedOuting, type OutingReader } from "./outing-service";
import type { OutingChangeRequest } from "@tripquest/agent/outing-change";
import { fingerprint } from "@tripquest/application/fingerprint";
import { DEFAULT_TRAVEL } from "@tripquest/application/planning";
import { DrizzleConversationRepository, DrizzleJourneyRepository, DrizzlePreferenceRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { PreferenceRepository } from "@tripquest/application/preferences";
import type { StoredJourney } from "@tripquest/application";
import type { AdjustRequest } from "@tripquest/application/real-adjust";
import { adjustCardView, chatTripOf, requestByIds } from "./adjust-service";
import type { CityResolver, MobilityProvider, NearbyPlaceProvider, PlaceLookupProvider, WeatherForecastData, WeatherProvider } from "@tripquest/providers";
import { straightMeters } from "@tripquest/application/leg-choice";
import { readRealPlaceMode } from "../real-places/real-mode";
import { storedChoicesView } from "./choices-view";
import { createUserUsage, meteredAmap, meteredIntentRouter, meteredKnowledge, meteredWebSearch, reserveModel, RUN_BUDGET_MESSAGE } from "../usage/usage";
import { currentRun, type AgentRun } from "@tripquest/agent/runs";
import { traced } from "../runs/runs";
import type {
  CardPlace,
  ChatMessageView,
  MapStop,
  OutingCardView,
  PlanCardView,
  RequirementsCardView,
  WeatherChip,
} from "./view-models";

export const DEFAULT_TITLE = "新的规划";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export type ChatAvailability = { enabled: true } | { enabled: false; message: string };

/** 对话规划仅在本机个人真实模式且配置了实时模型时启用（D-051）。 */
export function readChatAvailability(environment: NodeJS.ProcessEnv = process.env): ChatAvailability {
  if (!readRealPlaceMode(environment).enabled) {
    return { enabled: false, message: "对话规划只在本机个人模式下可用：请开启真实地点模式（见 .env.example）。" };
  }
  if (environment.AGENT_LIVE_ENABLED !== "true" || !environment.AGENT_MODEL_PROFILE) {
    return { enabled: false, message: "对话规划需要真实模型：请在 .env 设置 AGENT_LIVE_ENABLED 与 AGENT_MODEL_PROFILE。" };
  }
  return { enabled: true };
}

type Runner = { run: ReturnType<typeof createChatRunner>["run"] };

export interface ConversationServiceOptions {
  /** V2.12：当前用户（接口从会话取得）；仓库只读写这个用户的数据。 */
  userId?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  repository?: () => ConversationRepository;
  /** 测试可注入脚本 runner 和天气；默认按环境配置构建实际依赖。 */
  runner?: () => Promise<Runner>;
  weather?: () => WeatherProvider;
  /** V2.11：出游分配时补查地点（测试注入演示地点）；缺省用高德。 */
  places?: () => PlaceLookupProvider;
  nearby?: () => NearbyPlaceProvider;
  /** V3.6：补车站时按城市搜车站（测试注入演示地点）；缺省用高德。 */
  stations?: () => Pick<MobilityProvider, "searchPlaces"> & Partial<CityResolver>;
  /** 读取这段对话已保存的行程，给聊天提供当前安排与进度上下文。 */
  journeys?: () => {
    findCurrentJourney(journeyId: string): Promise<StoredJourney | null>;
    /** V2.11：出游的结构（这段对话保存的是出游时）。 */
    findTrip?: OutingReader["findTrip"];
  };
  /** V2.9：长期偏好（测试注入内存实现）。 */
  preferences?: () => PreferenceRepository;
  /** V2.9：长对话的滚动摘要（测试注入；null 表示不摘要）。 */
  summarizer?: () => Promise<Summarizer | null>;
  workspaceRoot?: string;
}

export type TurnReply =
  | {
      status: "ok";
      conversationId: string;
      messageCount: number;
      title: string;
      messages: ChatMessageView[];
      /** 本轮识别到对已保存行程的调整意图，页面收到后继续请求调整候选。 */
      adjust?: AdjustRequest;
      /** V2.11：对已保存出游的跨天改动，页面收到后请求重排受影响的天。 */
      outingChange?: OutingChangeRequest;
      /** V2.11：用户只说了“开始规划”这类话，页面接着做卡片的下一步（同底部按钮）。 */
      next?: "allocate" | "start";
    }
  | { status: "conflict" | "not_found" | "unavailable" };

/** 把结构化 Agent 进度转为一行可读文字，供对话等待期间展示。 */
export function progressText(progress: ChatProgress, nowMs: number): string {
  switch (progress.tool) {
    case "search_place":
      return `正在查找“${progress.subject}”`;
    case "get_weather":
      return `正在查${dateLabel(progress.subject, nowMs)}的天气`;
    case "web_search":
      return `正在联网搜索“${progress.subject}”`;
    case "ask_knowledge":
      return `正在查资料库：${progress.subject}`;
    case "understand":
      return "正在理解你的意思";
  }
}

type Summarizer = { summarize(input: SummaryInput, signal: AbortSignal): Promise<string | null> };

// V3.5 的客户端编号只认得已经存好的那一轮；一轮常要十几秒，页面断线 1 秒后就重发，这时还查不到它。
// 正在跑的轮次按“用户 + 客户端编号”记在进程里（同 jobs.ts 放在 globalThis 上），重发的接到同一次上。
const turnStore = globalThis as typeof globalThis & { __tripquestTurns?: Map<string, Promise<TurnReply>> };
turnStore.__tripquestTurns ??= new Map();
const runningTurns = turnStore.__tripquestTurns;
/** 与对话 runner 相同的窗口：本轮之外最近 11 条历史；更早的进摘要（stages/V2.9.md §3.5）。 */
const HISTORY_WINDOW = 11;

export type EditReply =
  | { status: "ok"; card: RequirementsCardView }
  | { status: "invalid"; code: string }
  | { status: "conflict" | "not_found" | "unavailable" };

/**
 * 对话的服务端装配层：注入模型、地点、天气与检索工具，把 Agent 结果转换为可持久化消息。
 * 业务补丁仍由 application 校验，正式行程修改另走规划与确认，聊天服务不直接保存新计划。
 */
export function createConversationService(options: ConversationServiceOptions = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const root = options.workspaceRoot ?? resolve(process.cwd(), "../..");
  const repository = () => options.repository?.() ??
    new DrizzleConversationRepository(getSharedJourneyDatabase().database, owner());
  const usage = () => createUserUsage(owner(), now);
  const amap = (purpose: string) => {
    const mode = readRealPlaceMode(environment());
    if (!mode.enabled) throw new Error("real mode disabled");
    return meteredAmap({ key: mode.key, usage: usage(), purpose, now });
  };
  const weather = () => options.weather?.() ?? amap("chat-weather");
  const journeys = () => options.journeys?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, owner());
  const preferenceStore = () => options.preferences?.() ?? new DrizzlePreferenceRepository(getSharedJourneyDatabase().database, owner());

  /** 读取关联真实行程；读取失败时仅缺少聊天上下文，不把它误报为行程已不存在。 */
  async function savedTrip(journeyId: string | null, messages: readonly StoredMessage[], draft: RequirementsDraft) {
    // V2.11：保存的是出游时，今天的调整用“现在”那一段，并带上整趟出游的结构（跨天改动用）。
    const outing = hasSavedOuting(messages) ? await (async () => {
      const store = journeys();
      return store.findTrip
        ? savedOuting(messages, { findTrip: store.findTrip.bind(store), findCurrentJourney: store.findCurrentJourney.bind(store) }, now())
        : null;
    })() : null;
    if (outing) {
      const active = outing.activeJourneyId ? outing.journeys.get(outing.activeJourneyId) : undefined;
      const today = active ? chatTripOf(active) : null;
      if (today) return { ...today, trip: { ...today.trip, outing: outingChatContext(outing, draft) } };
    }
    if (!journeyId) return null;
    const journey = await journeys().findCurrentJourney(journeyId).catch(() => null);
    // 短途每一站都对应用户在某一步选择的兴趣，需保留这层归因供后续调整。
    const picked = new Map(messages.flatMap((message) => {
      if (message.kind !== "choices" || !message.body.chosen) return [];
      const interest = draft.interests.find((item) => item.id === message.body.interestId);
      return interest ? [[message.body.chosen, interest.text] as const] : [];
    }));
    return journey ? chatTripOf(journey, picked) : null;
  }
  const nearby = () => options.nearby?.() ?? amap("chat-location");
  const stations = () => options.stations?.() ?? amap("chat");

  /**
   * 出游卡片每轮之后由代码补（V3.6 §3.4、V4.3 §3.2–3.4）：从原话认“住在哪”、日子和住宿对不上的车挪到对的天、补车站和
   * 漏掉的往返（都是暂定、可改），补了什么在回复后面加一句；模型的回复不动。查不了地图或没补上时照旧。
   */
  async function afterTurn(draft: RequirementsDraft, previous: RequirementsDraft, changed: boolean, messages: readonly StoredMessage[], text: string) {
    const userTexts = [...messages.flatMap((message) => (message.role === "user" && message.kind === "text" ? [message.body.text] : [])), text];
    const filled = await Promise.resolve()
      .then(() => afterOutingTurn(draft, userTexts, stations(), AbortSignal.timeout(10_000), { changed, previous }))
      .catch(() => null);
    return filled?.note || filled?.ask ? filled : null;
  }

  async function profileConfig(): Promise<unknown> {
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
    return JSON.parse(await readFile(profilePath, "utf8"));
  }

  async function summarizer(): Promise<Summarizer | null> {
    if (options.summarizer) return options.summarizer();
    if (options.runner) return null;
    const env = environment();
    const ledger = usage();
    return createChatSummarizer({
      config: await profileConfig(),
      profileId: env.AGENT_MODEL_PROFILE ?? "",
      environment: env,
      beforeRequest: () => ledger.reserve("model", "model", "chat-summary"),
    });
  }

  /**
   * V2.9：刚落出窗口、还没进摘要的消息合进摘要（对照 B 在长对话评测 0/18 → 18/18）。失败时保留
   * 旧摘要，下一轮再试；原消息不动。
   */
  async function rollSummary(
    conversationId: string,
    found: { conversation: { summary?: { text: string; throughSeq: number }; draft: RequirementsDraft }; messages: readonly StoredMessage[] },
    onProgress?: (text: string) => void,
  ): Promise<string | null> {
    const previous = found.conversation.summary ?? null;
    const history = historyOf(found.messages);
    const leaving = history.slice(0, Math.max(0, history.length - HISTORY_WINDOW)).filter((item) => item.seq > (previous?.throughSeq ?? 0));
    if (!leaving.length) return previous?.text ?? null;
    const summary = await summarizer().catch(() => null);
    if (!summary) return previous?.text ?? null;
    onProgress?.("正在整理前面的对话");
    const text = await summary.summarize(
      { previous: previous?.text ?? null, card: describeDraft(found.conversation.draft), messages: leaving },
      AbortSignal.timeout(20_000),
    );
    if (!text) return previous?.text ?? null;
    await repository().updateSummary({ conversationId, summary: { text, throughSeq: leaving.at(-1)!.seq } }).catch(() => null);
    return text;
  }

  async function runner(): Promise<Runner> {
    if (options.runner) return options.runner();
    const env = environment();
    const config = await profileConfig();
    const ledger = usage();
    const model = createChatLiveModel({
      config,
      profileId: env.AGENT_MODEL_PROFILE ?? "",
      environment: env,
      // 账本暂时记不了时这一轮按“暂时连不上”说，不说今天的次数用完了。
      beforeRequest: reserveModel(ledger, "chat", () => new ChatRunError("model_error")),
    });
    const provider = amap("chat");
    // 地图不能回答的资讯问题交给联网搜索，默认启用，可由 WEB_SEARCH_ENABLED 关闭。
    const webKey = env.WEB_SEARCH_ENABLED === "false" ? "" : env.DEEPSEEK_API_KEY?.trim() ?? "";
    const web = webKey ? meteredWebSearch({ key: webKey, usage: ledger, purpose: "chat", now }) : undefined;
    // 稳定背景知识由自有资料库回答，默认启用，可由 KNOWLEDGE_ENABLED 关闭。
    const knowledge = env.KNOWLEDGE_ENABLED !== "false" && env.DASHSCOPE_API_KEY?.trim()
      ? meteredKnowledge({ environment: env, usage: ledger, purpose: "chat", pool: getSharedJourneyDatabase().pool })
      : undefined;
    return createChatRunner({
      model,
      places: provider,
      weather: provider,
      cities: provider,
      ...(web ? { web } : {}),
      ...(knowledge ? { knowledge } : {}),
      router: meteredIntentRouter({ environment: env, usage: ledger, config }),
    });
  }

  /**
   * 同一个客户端编号的这一轮还在跑（网络断了、页面重发）：等它的结果，不再跑一遍模型，第一条消息也不再建一段新对话。
   * 重发的那次没有进度提示；跑完之后再来的重发照旧按已存的消息回（runTurn）。
   */
  function once(clientId: string | undefined, run: () => Promise<TurnReply>): Promise<TurnReply> {
    if (!clientId) return run();
    const key = `${options.userId ?? ""}:${clientId}`;
    const running = runningTurns.get(key);
    if (running) return running;
    const started = run().finally(() => runningTurns.delete(key));
    runningTurns.set(key, started);
    return started;
  }

  /** 一条用户输入执行一轮 Agent，完成后将本轮消息与草案原子追加到对话。V3.0：一轮一个 chat_turn 根运行。 */
  function turn(
    conversationId: string,
    text: string,
    expectedCount: number,
    onProgress?: (text: string) => void,
    clientId?: string,
  ): Promise<TurnReply> {
    return traced(
      { trigger: "chat_turn", userId: options.userId ?? null },
      (run) => runTurn(run, conversationId, text, expectedCount, onProgress, clientId),
      (reply) => (reply.status === "ok" ? { status: "ok" } : { status: "failed", outcome: reply.status }),
    );
  }

  async function runTurn(
    run: AgentRun,
    conversationId: string,
    text: string,
    expectedCount: number,
    onProgress?: (text: string) => void,
    clientId?: string,
  ): Promise<TurnReply> {
    if (!readChatAvailability(environment()).enabled && !options.runner) return { status: "unavailable" };
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    run.link({ conversationId });
    // V3.5（stages/V3.5.md §3.2）：同一个客户端编号的消息已经存过（网络断了重发）：回那一轮，不再跑一遍。
    const sent = clientId ? found.messages.findIndex((message) => message.role === "user" && message.kind === "text" && message.body.clientId === clientId) : -1;
    if (sent >= 0) {
      const next = found.messages.findIndex((message, index) => index > sent && message.role === "user");
      return {
        status: "ok",
        conversationId,
        messageCount: found.conversation.messageCount,
        title: found.conversation.title,
        messages: await toViews(found.messages.slice(sent, next < 0 ? undefined : next), found.messages, found.conversation.draft),
      };
    }
    run.set({ seq: expectedCount + 1 });
    if (found.conversation.messageCount !== expectedCount) return { status: "conflict" };

    // V2.11：卡片已经完整、还没保存过行程，用户只说“开始规划”“按天生成”这类话：由代码做卡片的下一步
    // （同底部按钮），不问模型。没保存过才这样，保存后的“重新规划”可能是要调整今天（走对话）。
    const { draft: card } = found.conversation;
    if (START_WORDS.test(text.trim()) && !draftMissing(card).length && !found.conversation.journeyId && !hasSavedOuting(found.messages)) {
      const multiDay = card.mode === "outing" && !!card.outing && outingDays(card.outing) > 1;
      const next = multiDay && !card.outing!.allocation ? "allocate" as const : "start" as const;
      const reply = next === "allocate"
        ? "好的，先把地点分到各天。分好后看一下每天的安排，再点“按天生成”或跟我说“开始规划”。"
        : card.mode === "outing" ? "好的，开始按天生成。" : "好的，开始规划。";
      const appended = await store.appendTurn({
        conversationId,
        expectedCount,
        messages: [
          { role: "user", kind: "text", body: { text, ...(clientId ? { clientId } : {}) } },
          { role: "assistant", kind: "text", body: { text: reply } },
        ],
        now: new Date(now()),
        newId: randomUUID,
      });
      if (appended.status !== "appended") return { status: appended.status };
      const reread = await store.findConversation(conversationId);
      if (!reread) return { status: "not_found" };
      return {
        status: "ok",
        conversationId,
        messageCount: appended.messageCount,
        title: reread.conversation.title,
        messages: await toViews(reread.messages.slice(expectedCount), reread.messages, reread.conversation.draft),
        next,
      };
    }

    let result: ChatTurnResult;
    const saved = await savedTrip(found.conversation.journeyId, found.messages, found.conversation.draft);
    try {
      // 偏好读不到时照常对话（只是不带偏好），不让它挡住这一轮。
      const remembered = await Promise.resolve().then(() => preferenceStore().list()).catch(() => []);
      const summary = await rollSummary(conversationId, found, onProgress).catch(() => null);
      result = await (await runner()).run(
        {
          ...(remembered.length ? { preferences: remembered.map((item) => ({ text: item.text, category: item.category })) } : {}),
          ...(summary ? { summary } : {}),
          draft: found.conversation.draft,
          history: historyOf(found.messages).map(({ role, text }) => ({ role, text })),
          userText: text,
          nowMs: now(),
          ...(saved ? { trip: saved.trip } : {}),
        },
        {
          signal: AbortSignal.timeout(90_000),
          ...(onProgress ? { onProgress: (progress: ChatProgress) => onProgress(progressText(progress, now())) } : {}),
        },
      );
    } catch {
      result = { status: "failed", code: "internal_error", hints: [], counts: { model: 0, searches: 0, weather: 0, webSearches: 0, knowledge: 0, repairs: 0 }, usage: null };
    }
    if (result.status === "failed" && environment().NODE_ENV === "development") {
      // 只记录失败代码，不输出用户对话正文。
      console.warn(`[chat] turn failed: ${result.code}; hints: ${result.hints.join(", ") || "none"}`);
    }

    const messages: NewMessage[] = [{ role: "user", kind: "text", body: { text, ...(clientId ? { clientId } : {}) } }];
    let draft: RequirementsDraft | undefined;
    if (result.status === "completed") {
      const rides = result.draft.mode === "outing"
        ? await afterTurn(result.draft, found.conversation.draft, result.draftChanged, found.messages, text)
        : null;
      // V4.3：模型没改卡片、代码认出了“住在哪”时，卡片也算改了（要存、要出新卡片）。
      if (rides) result = { ...result, draft: rides.draft, draftChanged: result.draftChanged || rides.draft !== result.draft };
      // 说明在回复后面，超长时截短模型的话，说明保留。V4.4：有问句时回复里只问这一个。
      const tail = rides ? `${rides.note ?? ""}${rides.ask ?? ""}` : "";
      const replyText = rides ? withAfterTurn(result.reply.text.slice(0, 1000 - tail.length - 2), rides) : result.reply.text;
      messages.push({
        role: "assistant",
        kind: "text",
        body: {
          text: replyText,
          asking: result.reply.asking || !!rides?.ask,
          ...(result.reply.sources?.length ? { sources: [...result.reply.sources] } : {}),
          ...(result.reply.places?.length ? { places: [...result.reply.places] } : {}),
        },
      });
      // V2.11：遇到外地的地点或城市时，卡片上方给出“切到出游”的提示（由代码决定，不看回复怎么说）。
      if (result.outside?.length) {
        messages.push({ role: "assistant", kind: "notice", body: outingNotice(result.outside, draftCity(result.draft).name) });
      }
      if (result.draftChanged) {
        draft = result.draft;
        messages.push({ role: "assistant", kind: "requirements_card", body: { draft: result.draft } });
      }
      // V2.9：提议只是一张卡片，用户点“记住”才写进偏好表。
      if (result.proposal) {
        messages.push({ role: "assistant", kind: "preference_proposal", body: { ...result.proposal, status: "pending" } });
      }
    } else {
      const notice = run.exhausted ? RUN_BUDGET_MESSAGE : failureText(result.code);
      messages.push({ role: "assistant", kind: "notice", body: { text: notice, tone: "warning" } });
    }
    // 标题还是自动生成的（默认，或按上一张卡片生成的）就跟着卡片走：V2.10 换城市后不能还叫“成都一日”。
    const current = found.conversation.title;
    const automatic = current === DEFAULT_TITLE || current === titleFor(found.conversation.draft);
    const title = draft && automatic && titleFor(draft) !== current ? titleFor(draft) : undefined;
    // 运行模型前的计数检查只用于及早拒绝；耗时调用结束后，仓储还要原子比较 expectedCount。
    // 此时若已有新消息，就丢弃这轮待写结果，防止旧上下文生成的卡片覆盖用户的新输入。
    const appended = await store.appendTurn({
      conversationId,
      expectedCount,
      messages,
      draft,
      title,
      now: new Date(now()),
      newId: randomUUID,
    });
    if (appended.status !== "appended") return { status: appended.status };
    // V3.0：这一轮的决策记录在运行记录里（对话 Agent 的子运行和它的步骤），不再写 chat_traces。
    const reread = await store.findConversation(conversationId);
    if (!reread) return { status: "not_found" };
    const fresh = reread.messages.slice(expectedCount);
    const adjust = result.status === "completed" && result.adjust && saved ? requestByIds(result.adjust, saved.keys) : null;
    return {
      status: "ok",
      conversationId,
      messageCount: appended.messageCount,
      title: reread.conversation.title,
      messages: await toViews(fresh, reread.messages, reread.conversation.draft),
      ...(adjust ? { adjust } : {}),
      ...(result.status === "completed" && result.outingChange && saved ? { outingChange: result.outingChange } : {}),
    };
  }

  /** 卡片编辑与 Agent 共用补丁和校验规则，只改当前草案、不追加消息；下一轮读取编辑后的需求。 */
  async function editDraft(conversationId: string, patch: DraftPatch, expectedFingerprint: string): Promise<EditReply> {
    if (!readChatAvailability(environment()).enabled && !options.runner) return { status: "unavailable" };
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    if (fingerprint(found.conversation.draft) !== expectedFingerprint) return { status: "conflict" };
    // 卡片不能直接绑定任意新地点，只能从服务端已有候选中选择。
    const result = applyDraftPatch(found.conversation.draft, patch, new Map(), { nowMs: now() });
    if (result.status === "invalid") return { status: "invalid", code: result.code };
    // V4.4：用户在卡片上自己改的日期就是用户给的，不再暂定。
    const draft = patch.date !== undefined || patch.dates !== undefined ? datesFromCard(result.draft) : result.draft;
    const updated = await store.updateDraft({
      conversationId,
      expectedFingerprint,
      draft,
      now: new Date(now()),
    });
    if (updated.status !== "updated") return { status: updated.status };
    const weatherChipFor = await weatherLookup();
    return { status: "ok", card: { ...cardView(draft, now(), await weatherChipFor(draft)), fingerprint: fingerprint(draft) } };
  }

  /**
   * V2.11 出游分到各天（§3.6）：卡片完整后由用户点“分到各天”；把一项移到别的天时固定在那天并重新检查。
   * 结果写进卡片（只存编号和理由），返回新卡片。
   */
  function allocate(conversationId: string, expectedFingerprint: string, move?: { target: string; day: number }): Promise<EditReply> {
    return traced({ trigger: "allocate", userId: options.userId ?? null }, () => allocateDays(conversationId, expectedFingerprint, move));
  }

  async function allocateDays(conversationId: string, expectedFingerprint: string, move?: { target: string; day: number }): Promise<EditReply> {
    if (!readChatAvailability(environment()).enabled && !options.runner) return { status: "unavailable" };
    const outing = createOutingService({
      now,
      repository,
      places: () => options.places?.() ?? amap("plan"),
      stations: () => options.stations?.() ?? amap("plan"),
      allocator: async () => {
        // 测试里没有模型：只用规则分配。
        if (options.runner) return undefined;
        const ledger = usage();
        return createAllocationRequest({
          config: await profileConfig(),
          profileId: environment().AGENT_MODEL_PROFILE ?? "",
          environment: environment(),
          beforeRequest: () => ledger.reserve("model", "model", "plan"),
        });
      },
    });
    const result = await outing.allocate(conversationId, expectedFingerprint, move);
    if (result.status === "ok") {
      const weatherChipFor = await weatherLookup();
      return { status: "ok", card: { ...cardView(result.draft, now(), await weatherChipFor(result.draft)), fingerprint: fingerprint(result.draft) } };
    }
    if (result.status === "incomplete" || result.status === "places_missing") return { status: "invalid", code: result.status };
    return result;
  }

  /** 单次解析设备点后，将等待定位的起终点绑定到最近高德地点；精确点本身不保存、不记日志。 */
  async function applyLocation(
    conversationId: string,
    point: { longitude: number; latitude: number },
    expectedFingerprint: string,
  ): Promise<EditReply> {
    if (!readChatAvailability(environment()).enabled && !options.runner) return { status: "unavailable" };
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    if (fingerprint(found.conversation.draft) !== expectedFingerprint) return { status: "conflict" };
    const reply = await nearby().nearestPlace(point).catch(() => null);
    if (!reply || reply.status !== "ok") {
      return { status: "invalid", code: reply?.status === "failure" && reply.failure.code === "invalid_request" ? "outside_city" : "location_unavailable" };
    }
    // V2.10：最近地点和它所在的城市一起写进卡片（卡片还没有城市时）；精确点不保存。
    const draft = applyCurrentLocation(found.conversation.draft, {
      externalId: reply.data.place.ref.externalId,
      name: reply.data.place.name.slice(0, 80),
      city: { adcode: reply.data.city.adcode, name: reply.data.city.name.slice(0, 40) },
    });
    const updated = await store.updateDraft({ conversationId, expectedFingerprint, draft, now: new Date(now()) });
    if (updated.status !== "updated") return { status: updated.status };
    const weatherChipFor = await weatherLookup();
    return { status: "ok", card: { ...cardView(draft, now(), await weatherChipFor(draft)), fingerprint: fingerprint(draft) } };
  }

  /** 同次视图构造每个城市只查一次天气，多个历史卡片不分别消耗接口额度（V2.10：按卡片的城市查）。 */
  async function weatherLookup() {
    const forecasts = new Map<string, WeatherForecastData | null>();
    return async (draft: RequirementsDraft): Promise<RequirementsCardView["weather"]> => {
      if (!draft.date) return null;
      const city = draftCity(draft).adcode;
      if (!forecasts.has(city)) {
        const reply = await weather().getWeatherForecast(city).catch(() => null);
        forecasts.set(city, reply?.status === "ok" ? reply.data : null);
      }
      const day = forecasts.get(city)?.days.find((item) => item.date === draft.date);
      return day ? weatherChip(day) : "unavailable";
    };
  }

  /** 最新需求卡展示当前草案与实时天气；旧卡保持当轮快照，不能被后来的编辑改写历史。 */
  async function toViews(
    selected: readonly StoredMessage[],
    all: readonly StoredMessage[],
    current: RequirementsDraft,
  ): Promise<ChatMessageView[]> {
    const latestCard = [...all].reverse().find((message) => message.kind === "requirements_card")?.id;
    const lastChoices = [...all].reverse().find((message) => message.kind === "choices");
    const latestChoices = lastChoices?.kind === "choices" && !lastChoices.body.chosen && all.at(-1)?.id === lastChoices.id
      ? lastChoices.id
      : null;
    const weatherFor = await weatherLookup();
    const views: ChatMessageView[] = [];
    for (const message of selected) {
      if (message.kind === "text") {
        views.push(message.role === "user"
          ? { id: message.id, role: "user", kind: "text", text: message.body.text }
          : {
              id: message.id,
              role: "assistant",
              kind: "text",
              text: message.body.text,
              asking: message.body.asking,
              ...(message.body.sources?.length ? { sources: message.body.sources } : {}),
              ...(message.body.places?.length ? { places: message.body.places } : {}),
            });
      } else if (message.kind === "requirements_card") {
        if (message.id === latestCard) {
          const card = cardView(current, now(), await weatherFor(current));
          views.push({
            id: message.id,
            role: "assistant",
            kind: "requirements_card",
            card: { ...card, fingerprint: fingerprint(current) },
            latest: true,
          });
        } else {
          views.push({
            id: message.id,
            role: "assistant",
            kind: "requirements_card",
            card: cardView(message.body.draft, now(), null),
            latest: false,
          });
        }
      } else if (message.kind === "notice") {
        views.push({
          id: message.id,
          role: "assistant",
          kind: "notice",
          text: message.body.text,
          tone: message.body.tone,
          ...(message.body.outing ? { outing: true } : {}),
        });
      } else if (message.kind === "preference_proposal") {
        views.push({
          id: message.id,
          role: "assistant",
          kind: "preference_proposal",
          text: message.body.text,
          category: message.body.category,
          status: message.body.status,
        });
      } else if (message.kind === "planning_progress") {
        views.push({
          id: message.id,
          role: "assistant",
          kind: "planning_progress",
          running: false,
          steps: message.body.steps.map((step) => ({ ...step, state: "done" as const })),
        });
      } else if (message.kind === "plan_card") {
        views.push({ id: message.id, role: "assistant", kind: "plan_card", plan: storedPlanView(message.body) });
      } else if (message.kind === "outing_review") {
        // 只有这次生成最新的那张建议还能采纳或忽略。
        const latest = all.filter((item) => item.kind === "outing_review").at(-1);
        views.push(outingReviewView(message, latest?.id === message.id && latestGeneration(all)?.generationId === message.body.generationId));
      } else if (message.kind === "outing_change") {
        // 保存凭据只在生成它的那次页面里；读回的改动卡片只能看。
        views.push(outingChangeView(message, all, false));
      } else if (message.kind === "outing_day") {
        // 保存凭据只在生成它的那次响应里；读回的出游各天只能看，保存要重新生成。
        const { body } = message;
        views.push({
          id: message.id,
          role: "assistant",
          kind: "outing_day",
          ...body,
          parts: body.parts.map((part) => (part.kind === "plan" ? { kind: "plan" as const, plan: storedPlanView(part.plan) } : part)),
        });
      } else if (message.kind === "adjust_card") {
        // 调整签名凭据只存在生成它的页面内存；历史读取关闭确认入口，避免旧卡重新获得保存能力。
        views.push(adjustCardView(message, false));
      } else if (message.kind === "choices") {
        // 只有最新短途步骤仍可操作，距离按本次实时数据重新补齐。
        const open = message.id === latestChoices;
        views.push(storedChoicesView(message, current, open, open ? await choiceMeters(message, current) : undefined));
      }
    }
    return views;
  }

  /** 一次实时查点计算锚点到候选的直线距离，不存坐标，也不把直线距离当作实际路线。 */
  async function choiceMeters(message: Extract<StoredMessage, { kind: "choices" }>, draft: RequirementsDraft) {
    const anchorId = message.body.anchor?.externalId ?? (draft.start?.status === "bound" ? draft.start.externalId : null);
    if (!anchorId) return undefined;
    try {
      const reply = await amap("chat-map").findPlacesById([anchorId, ...message.body.options.map((option) => option.externalId)].slice(0, 10));
      if (reply.status !== "ok") return undefined;
      const at = (id: string) => reply.data.items.find((item) => item.ref.externalId === id)?.location;
      const anchor = at(anchorId);
      if (!anchor) return undefined;
      const meters = new Map<string, number>();
      for (const option of message.body.options) {
        const location = at(option.externalId);
        if (location) meters.set(option.externalId, Math.round(straightMeters(anchor, location)));
      }
      return meters;
    } catch {
      return undefined;
    }
  }

  /** 只为最新计划按地点 ID 实时补查地图坐标，查询结果不进入对话存储。 */
  async function latestPlanMap(messages: readonly StoredMessage[]): Promise<{ plan: PlanCardView; mapStops: MapStop[] } | null> {
    const latest = [...messages].reverse().find((message) => message.kind === "plan_card");
    if (!latest || latest.kind !== "plan_card") return null;
    const plan = storedPlanView(latest.body);
    const ids = [...new Set([latest.body.start.externalId, ...latest.body.stops.map((stop) => stop.externalId), latest.body.end.externalId])];
    try {
      const reply = await amap("chat-map").findPlacesById(ids.slice(0, 10));
      if (reply.status !== "ok") return { plan, mapStops: [] };
      const at = (externalId: string) => reply.data.items.find((item) => item.ref.externalId === externalId)?.location;
      const stop = (key: string, label: string, kind: MapStop["kind"], place: { externalId: string; name: string }): MapStop[] => {
        const location = at(place.externalId);
        return location ? [{ key, label, kind, name: place.name, longitude: location.longitude, latitude: location.latitude }] : [];
      };
      return {
        plan,
        mapStops: [
          ...stop("start", "起", "start", latest.body.start),
          ...latest.body.stops.flatMap((item, index) => stop(`stop-${index}`, String(index + 1), "stop", item)),
          // 短途终点就是最后一站时仅显示一个标记，避免同地点重叠。
          ...(latest.body.stops.at(-1)?.externalId === latest.body.end.externalId ? [] : stop("end", "终", "end", latest.body.end)),
        ],
      };
    } catch {
      return { plan, mapStops: [] };
    }
  }

  /**
   * V2.11 对话中切换日常 / 出游（§3.10）：新建一张那个模式的卡片，把已说的地点、兴趣、日期带过去（出游 → 日常只带
   * 所在城市的），日常里遇到的外地地点也带上；说明带了什么、没带什么。
   */
  async function switchMode(conversationId: string, to: "daily" | "outing", expectedFingerprint: string): Promise<TurnReply> {
    const store = repository();
    const found = await store.findConversation(conversationId);
    if (!found) return { status: "not_found" };
    const current = found.conversation.draft;
    if (fingerprint(current) !== expectedFingerprint) return { status: "conflict" };
    const elsewhere = found.messages.flatMap((message) => (message.kind === "notice" && message.body.outing
      ? message.body.outing.places.flatMap((place) => (place.externalId ? [{ externalId: place.externalId, name: place.name, city: place.city }] : []))
      : []));
    const switched = switchDraftMode(current, to, elsewhere);
    if (switched.draft === current) return { status: "conflict" };
    const label = to === "outing" ? "出游" : "日常";
    const text = [
      `已切到${label}，新卡片在下面。`,
      switched.carried.length ? `带过去了：${switched.carried.join("、")}。` : "",
      switched.left.length ? `日常只规划${draftCity(current).name}，这些没带：${switched.left.join("、")}。` : "",
    ].join("").slice(0, 300);
    const automatic = found.conversation.title === DEFAULT_TITLE || found.conversation.title === titleFor(current);
    const appended = await store.appendTurn({
      conversationId,
      expectedCount: found.conversation.messageCount,
      messages: [
        { role: "assistant", kind: "notice", body: { text, tone: "info" } },
        { role: "assistant", kind: "requirements_card", body: { draft: switched.draft } },
      ],
      draft: switched.draft,
      ...(automatic ? { title: titleFor(switched.draft) } : {}),
      now: new Date(now()),
      newId: randomUUID,
    });
    if (appended.status !== "appended") return { status: appended.status };
    const reread = await store.findConversation(conversationId);
    if (!reread) return { status: "not_found" };
    return {
      status: "ok",
      conversationId,
      messageCount: appended.messageCount,
      title: reread.conversation.title,
      messages: await toViews(reread.messages.slice(found.conversation.messageCount), reread.messages, reread.conversation.draft),
    };
  }

  /** V2.9：提议卡片上点“记住”或“不用”。 */
  async function decidePreference(conversationId: string, messageId: string, decision: "save" | "dismiss") {
    const store = preferenceStore();
    const outcome = decision === "save"
      ? await store.saveProposal({ conversationId, messageId, newId: randomUUID(), now: new Date(now()) })
      : await store.dismissProposal({ conversationId, messageId, now: new Date(now()) });
    return outcome.status;
  }

  return {
    decidePreference,
    /** V2.10：city 是打开页面时定位得到的城市（页面带来），先写进卡片再跑第一轮；没有就是缺省杭州。 */
    // V3.0：新对话的第一轮和后面的轮次一样是 chat_turn 根运行（turn 沿用这个运行）。
    start: (text: string, onProgress?: (text: string) => void, city?: DraftCity, mode?: "outing", clientId?: string) =>
      once(clientId, () => traced({ trigger: "chat_turn", userId: options.userId ?? null }, () => start(text, onProgress, city, mode, clientId))),
    locateCity: (point: { longitude: number; latitude: number }) => traced({ trigger: "locate", userId: options.userId ?? null }, () => locateCity(point)),
    send: (conversationId: string, text: string, expectedCount: number, onProgress?: (text: string) => void, clientId?: string) =>
      once(clientId, () => turn(conversationId, text, expectedCount, onProgress, clientId)),
    switchMode: (...args: Parameters<typeof switchMode>) => traced({ trigger: "switch_mode", userId: options.userId ?? null }, () => switchMode(...args)),
    editDraft: (...args: Parameters<typeof editDraft>) => traced({ trigger: "edit_card", userId: options.userId ?? null }, () => editDraft(...args)),
    allocate,
    useLocation: (...args: Parameters<typeof applyLocation>) => traced({ trigger: "locate", userId: options.userId ?? null }, () => applyLocation(...args)),
    view: (conversationId: string) => traced({ trigger: "page_view", userId: options.userId ?? null }, () => view(conversationId)),
  };

  async function start(text: string, onProgress?: (text: string) => void, city?: DraftCity, mode?: "outing", clientId?: string): Promise<TurnReply> {
    if (!readChatAvailability(environment()).enabled && !options.runner) return { status: "unavailable" };
    const store = repository();
    // V3.5：第一条消息重发：已经建过对话就回那一轮（runTurn 按客户端编号找到它），不再建一段新的。
    const existing = clientId ? await store.findConversationIdByClientId?.(clientId) : null;
    if (existing) return turn(existing, text, 0, onProgress, clientId);
    const conversation = await store.createConversation({ id: randomUUID(), title: DEFAULT_TITLE, now: new Date(now()) });
    // V2.11：出游从出游卡片开始（模式由用户在页面上选）。
    const located = city ? { adcode: city.adcode, name: city.name, source: "located" as const } : undefined;
    if (city || mode === "outing") {
      await store.updateDraft({
        conversationId: conversation.id,
        expectedFingerprint: fingerprint(conversation.draft),
        draft: mode === "outing" ? emptyOutingDraft(located) : { ...emptyDraft(), city: located! },
        now: new Date(now()),
      });
    }
    return turn(conversation.id, text, 0, onProgress, clientId);
  }

  /** V2.10：打开页面时的定位只换成所在城市（编码和名称）；精确点不保存、不记日志。 */
  async function locateCity(point: { longitude: number; latitude: number }): Promise<DraftCity | null> {
    const reply = await nearby().nearestPlace(point).catch(() => null);
    return reply?.status === "ok" ? { adcode: reply.data.city.adcode, name: reply.data.city.name.slice(0, 40) } : null;
  }

  async function view(conversationId: string) {
    const found = await repository().findConversation(conversationId);
    if (!found) return null;
    currentRun()?.root.link({ conversationId });
    return {
      conversation: found.conversation,
      messages: await toViews(found.messages, found.messages, found.conversation.draft),
      latestPlan: readChatAvailability(environment()).enabled ? await latestPlanMap(found.messages) : null,
    };
  }
}

/** 给模型的历史保留普通文字，复杂卡片压成简短标记；业务草案通过独立结构化输入提供。 */
function historyOf(messages: readonly StoredMessage[]) {
  return messages.flatMap((message): { role: "user" | "assistant"; text: string; seq: number }[] => {
    const seq = message.seq;
    if (message.kind === "text") return [{ role: message.role, text: replyHistoryText(message.body.text, message.body.places), seq }];
    if (message.kind === "requirements_card") return [{ role: "assistant", text: "（已更新需求卡片）", seq }];
    if (message.kind === "preference_proposal") {
      const status = { pending: "用户还没决定", saved: "用户点了记住", dismissed: "用户选了不用" }[message.body.status];
      return [{ role: "assistant", text: `（提议记住偏好“${message.body.text}”：${status}）`, seq }];
    }
    if (message.kind === "plan_card") return [{ role: "assistant", text: `（已给出方案：${message.body.title}）`, seq }];
    if (message.kind === "outing_change") return [{ role: "assistant", text: `（出游改动方案：${message.body.note}）`, seq }];
    if (message.kind === "outing_day") {
      const done = message.body.status === "draft" ? "已给出方案" : "没排出来";
      return [{ role: "assistant", text: `（出游第 ${message.body.day} 天${done}${message.body.tripId ? "，已保存" : ""}）`, seq }];
    }
    if (message.kind === "adjust_card") {
      return [{ role: "assistant", text: `（已给出调整方案：${message.body.note}${message.body.savedVersion ? `，已保存为第 ${message.body.savedVersion} 版` : ""}）`, seq }];
    }
    return [];
  });
}

function failureText(code: Extract<ChatTurnResult, { status: "failed" }>["code"]): string {
  switch (code) {
    case "live_budget":
      return "今天的对话或地点查询次数已用完，明天再来吧。";
    case "timeout":
      return "这次想得太久了，请再说一次。";
    case "model_error":
      return "规划助手暂时连不上，请稍后再试。";
    default:
      return "这次没能理解，请换个说法再试一次。";
  }
}

/** V2.11：“岚溪花海在岚溪市，日常只规划杭州市。去外地玩可以切到出游。” */
function outingNotice(outside: readonly ChatOutside[], dailyCity: string) {
  const byCity = new Map<string, string[]>();
  for (const item of outside) byCity.set(item.cityName, [...(byCity.get(item.cityName) ?? []), item.name]);
  const where = [...byCity].map(([city, names]) => names.length === 1 && names[0] === city ? city : `${names.join("、")}在${city}`);
  return {
    text: `${where.join("，")}，日常只规划${dailyCity}。去外地玩可以切到出游。`.slice(0, 300),
    tone: "info" as const,
    outing: { places: outside.map((item) => ({ ...item })) },
  };
}

/** “开始规划”“重新规划”“按天生成”“分到各天”“排吧”这类整句只是在催下一步的话（不含别的要求）。 */
const START_WORDS = /^(好的?[，,]?\s*)?(请|帮我)?(就按这个|按这个)?(开始|重新|再)?(规划|生成|排一下|排吧|安排一下|按天生成|分到各天)(吧|一下|一遍)?[。！!～~]*$|^开始吧[。！!～~]*$/;

function titleFor(draft: RequirementsDraft): string {
  // V2.11：出游按日期范围：“云岭出游 · 10月17日–19日 · 3 天”。
  if (draft.mode === "outing") {
    const label = draft.outing?.dates ? outingView(draft.outing, () => ({ status: "missing" })).dates?.label : null;
    return label ? `${draftCity(draft).name.replace(/市$/, "")}出游 · ${label}` : DEFAULT_TITLE;
  }
  if (!draft.date) return DEFAULT_TITLE;
  const [, month, day] = draft.date.split("-").map(Number);
  return `${draftCity(draft).name.replace(/市$/, "")}一日 · ${month}月${day}日`;
}

function weatherChip(day: WeatherForecastData["days"][number]): WeatherChip {
  return { dayWeather: day.dayWeather, highCelsius: day.highCelsius, lowCelsius: day.lowCelsius, wet: day.wet };
}

/** 按杭州日期生成“今天 / 明天”等相对日期文案，不依赖服务器运行时的本地时区。 */
export function dateLabel(date: string, nowMs: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const today = new Date(nowMs + 8 * 3_600_000);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const offset = Math.round((Date.UTC(year, month - 1, day) - todayUtc) / 86_400_000);
  const relative = ({ 0: "今天", 1: "明天", 2: "后天" } as Record<number, string>)[offset];
  return `${month}月${day}日 ${weekday}${relative ? `（${relative}）` : ""}`;
}

export function cardView(
  draft: RequirementsDraft,
  nowMs: number,
  weather: RequirementsCardView["weather"],
): RequirementsCardView {
  const place = (value: DraftPlace | null): CardPlace =>
    value === null ? { status: "missing" }
      : value.status === "current" ? { status: "current" }
      : value.status === "bound"
        ? { status: "bound", placeId: value.externalId, name: value.name, ...(value.nearby ? { nearby: true } : {}) }
        : {
            status: "choose",
            mention: value.mention,
            choices: value.choices.map((choice) => ({ placeId: choice.externalId, name: choice.name })),
          };
  return {
    mode: draft.mode ?? "day",
    city: draftCity(draft).name,
    date: draft.date,
    dateLabel: draft.date ? dateLabel(draft.date, nowMs) : null,
    ...(draft.date && draft.datesGuessed ? { dateGuessed: true as const } : {}),
    window: draft.startsAt && draft.endsAt ? { startsAt: draft.startsAt, endsAt: draft.endsAt } : null,
    start: place(draft.start),
    end: place(draft.end),
    visits: draft.visits.map((visit) => ({
      key: visit.key,
      place: place(visit.place),
      role: visit.role,
      ...(visit.stayMinutes ? { stayMinutes: visit.stayMinutes } : {}),
      ...(visit.stayMinutes && visit.staySource === "estimate" ? { estimated: true as const } : {}),
      ...(visit.startsAt ? { startsAt: visit.startsAt } : {}),
      ...(visit.endsAt ? { endsAt: visit.endsAt } : {}),
      ...(visit.day ? { day: visit.day } : {}),
    })),
    interests: draft.interests.map(({ city, ...interest }) => ({ ...interest, ...(city ? { city: city.name } : {}) })),
    ...(draft.mode === "outing" && draft.outing ? { outing: outingView(draft.outing, place, draft) } : {}),
    pace: draft.pace,
    notes: draft.notes,
    travel: { ...(draft.travel ?? DEFAULT_TRAVEL), recommended: !draft.travel },
    weather,
    missing: draftMissing(draft),
  };
}

/** V2.11：出游卡片的日期、住处和交通（每一晚都列出来，没定的显示未定）。 */
function outingView(outing: OutingDraft, place: (value: DraftPlace | null) => CardPlace, draft?: RequirementsDraft): OutingCardView {
  const days = outingDays(outing);
  const [, fromMonth, fromDay] = (outing.dates?.from ?? "").split("-").map(Number);
  const [, toMonth, toDay] = (outing.dates?.to ?? "").split("-").map(Number);
  const label = !outing.dates ? "" : days === 1 ? `${fromMonth}月${fromDay}日 · 1 天`
    : `${fromMonth}月${fromDay}日–${toMonth === fromMonth ? "" : `${toMonth}月`}${toDay}日 · ${days} 天`;
  return {
    dates: outing.dates ? { ...outing.dates, label, days, ...(draft?.datesGuessed ? { guessed: true as const } : {}) } : null,
    startAt: outing.startAt,
    endAt: outing.endAt,
    dailyWindow: outing.dailyWindow,
    lodging: Array.from({ length: Math.max(0, days - 1) }, (_, index) => {
      const night = outing.lodging.find((item) => item.night === index + 1);
      return {
        night: index + 1,
        place: place(night?.place ?? null),
        ...(night?.onBoard ? { onBoard: true as const } : {}),
        ...(night?.source === "suggested" && night.place ? { suggested: true as const } : {}),
        ...(night?.source === "suggested" && night.others?.length
          ? { others: night.others.map((choice) => ({ placeId: choice.externalId, name: choice.name })) }
          : {}),
      };
    }),
    ...(outing.lodgingAreas?.length ? { lodgingAreas: outing.lodgingAreas.map((area) => area.text) } : {}),
    ...(outing.stays?.length ? { stays: outing.stays.map((item) => ({ nights: [...item.nights], text: staysLabel([item]) })) } : {}),
    transports: outing.transports.map((item) => ({
      id: item.id,
      day: item.day,
      mode: item.mode,
      from: place(item.from),
      to: place(item.to),
      departAt: item.departAt,
      arriveAt: item.arriveAt,
      overnight: item.arriveDay === "next",
      confirmed: !!item.overnightConfirmed,
      ...(item.suggested ? { suggested: suggestedView(item.suggested) } : {}),
    })),
    ...(draft && [...rideHints(draft), ...stayHints(draft)].length ? { rideHints: [...rideHints(draft), ...stayHints(draft)] } : {}),
    ...(outing.allocation && draft ? { allocation: allocationView(outing, draft) } : {}),
  };
}

/** V3.6：暂定的交通和车站，以及“换一个”的候选。 */
function suggestedView(suggested: NonNullable<OutingDraft["transports"][number]["suggested"]>): NonNullable<OutingCardView["transports"][number]["suggested"]> {
  const others = (end: "from" | "to") => suggested[end]
    ? { [end]: suggested[end]!.others.map((choice) => ({ placeId: choice.externalId, name: choice.name })) }
    : {};
  return { ...(suggested.ride ? { ride: true as const } : {}), ...(suggested.day ? { day: true as const } : {}), ...others("from"), ...others("to") };
}

/** 分配里的编号换成名称（地点名、兴趣原话），日期写成“10月17日”。 */
function allocationView(outing: OutingDraft, draft: RequirementsDraft): NonNullable<OutingCardView["allocation"]> {
  const allocation = outing.allocation!;
  const date = (day: number) => {
    const value = new Date(Date.parse(`${outing.dates!.from}T00:00:00Z`) + (day - 1) * 86_400_000);
    return `第 ${day} 天 · ${value.getUTCMonth() + 1}月${value.getUTCDate()}日`;
  };
  return {
    days: allocation.days.map((entry) => ({
      day: entry.day,
      label: date(entry.day),
      items: [
        ...entry.visits.flatMap((key) => {
          const visit = draft.visits.find((item) => item.key === key);
          return visit ? [{ target: key, kind: "visit" as const, name: visit.place.status === "bound" ? visit.place.name : "待定地点" }] : [];
        }),
        ...entry.interests.flatMap((id) => {
          const interest = draft.interests.find((item) => item.id === id);
          return interest ? [{ target: id, kind: "interest" as const, name: interest.text }] : [];
        }),
      ],
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    source: allocation.source,
    problems: allocation.problems,
  };
}

/** 历史计划只含自有时间、名称与理由，未保存实时交通数字，读取时不能伪装为仍有那些估算。 */
function storedPlanView(body: Extract<StoredMessage, { kind: "plan_card" }>["body"]): PlanCardView {
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
    live: false,
  };
}
