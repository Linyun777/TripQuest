"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DraftPatch } from "@tripquest/application/conversation";
import type { PlanningMapConfig } from "../journeys/map-config";
import { ChatWorkspace } from "./chat-workspace";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { defaultJourney, OutingProgressHeader, useOutingTrip } from "./outing-progress";
import { useTripProgress } from "./trip-progress";
import { useLiveLocation } from "./use-live-location";
import type { TripProgressView } from "./trip-estimate";
import type { AdjustRequest } from "@tripquest/application/real-adjust";
import type { OutingChangeRequest } from "@tripquest/agent/chat";
import { usePageCity } from "../_ui/city";
import { ModeSwitch, type PlanMode } from "../_ui/mode";
import type {
  AdjustCardView,
  ChatMessageView,
  ChoiceOptionView,
  ChoicesView,
  MapPath,
  MapStop,
  OutingChangeView,
  OutingDayView,
  PlanCardView,
  ProgressStep,
  RequirementsCardView,
} from "./view-models";

const EDIT_FAILED: Record<string, string> = {
  window_order: "结束时间要晚于出发时间。",
  fixed_time: "固定事项的结束时间要晚于开始时间。",
  fixed_outside_window: "固定事项要在出发和结束时间之间。",
  too_many_protected: "必去和固定的地方最多 6 个。",
  too_many_fixed: "固定事项最多 2 个。",
  too_many_interests: "想体验的最多 5 项。",
  conflict: "卡片刚在别处更新过，已为你刷新，请再改一次。",
  location_unavailable: "没能根据定位找到附近的地点，直接告诉我从哪里出发吧。",
  outside_city: "这个位置没能解析成地点，直接告诉我从哪里出发吧。",
};

type TurnResponse =
  | {
      status: "ok";
      conversationId: string;
      messageCount: number;
      title: string;
      messages: ChatMessageView[];
      adjust?: AdjustRequest;
      /** V2.11：已保存出游的跨天改动（挪到另一天、改车次、改住处）。 */
      outingChange?: OutingChangeRequest;
      /** V2.11：用户只说了“开始规划”这类话，接着做卡片的下一步（同底部按钮）。 */
      next?: "allocate" | "start";
    }
  | { status: "conflict" | "not_found" | "unavailable" | "invalid_request" | "forbidden" | "too_large" };

/** 对话轮次按 NDJSON 逐行返回进度，done 才携带完整结果；启动前的 4xx 拒绝仍是普通 JSON。 */
async function readTurn(response: Response, onProgress: (text: string) => void): Promise<TurnResponse> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) {
    return (await response.json()) as TurnResponse;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  // 网络分块与 JSON 行没有一一对应关系；半行先留在 buffer，收齐换行后才解析。
  // 连接关闭却没收到 done 不能视为成功，服务器可能仍在完成本轮并保存消息。
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { status: "unavailable" };
    buffer += value;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: "progress"; text: string } | { type: "done"; reply: TurnResponse };
      if (event.type === "done") return event.reply;
      onProgress(event.text);
    }
  }
}

const ADJUST_FAILED: Record<string, string> = {
  stale: "行程刚有变化（比如在行程页标了完成），这个调整已经过时，请再跟我说一次。",
  draft_changed: "路线时间有变化，这个调整已经不准确，请再跟我说一次。",
  expired: "调整方案超过 15 分钟了，请再跟我说一次。",
  invalid_receipt: "离开过页面后需要再说一次才能确认。",
};

/** 只有最新调整卡可以确认，后续输入或新结果会关闭旧卡，避免用户误保存过期方案。 */
const closeAdjustments = (list: readonly ChatMessageView[]) =>
  list.map((message) => (message.kind === "adjust_card" && message.open ? { ...message, open: false } : message));

const FAILED: Record<Exclude<TurnResponse["status"], "ok">, string> = {
  conflict: "这段对话在别处有了新消息，已为你刷新。",
  not_found: "找不到这段对话了，可以回首页重新开始。",
  unavailable: "规划助手暂时不可用，请稍后再试。",
  invalid_request: "这条消息发不出去，请改短一些再试。",
  forbidden: "请求被拒绝，请刷新页面后再试。",
  too_large: "这条消息太长了，请改短一些再试。",
};

/** V2.11：这次生成的各天（同一天重排过的取最新的）。 */
/** V3.5：接上的页面拿不到保存凭据：这一天的方案当作读回的（要重排后才能保存）。 */
function asReadBack(message: ChatMessageView): ChatMessageView {
  if (message.kind !== "outing_day") return message;
  return { ...message, parts: message.parts.map((part) => (part.kind === "plan" ? { ...part, plan: { ...part.plan, live: false } } : part)) };
}

function latestOuting(messages: readonly ChatMessageView[]) {
  const all = messages.filter((message): message is OutingDayView => message.kind === "outing_day");
  const last = all.at(-1);
  if (!last) return null;
  const byDay = new Map<number, OutingDayView>();
  for (const message of all) if (message.generationId === last.generationId) byDay.set(message.day, message);
  return { generationId: last.generationId, days: [...byDay.values()].sort((a, b) => a.day - b.day) };
}

/** 页面先展示用户临时气泡和等待状态，服务端完成后用正式保存消息替换，计数以服务端为准。 */
export function ChatController({
  conversationId: initialId,
  title: initialTitle,
  initialMessages,
  messageCount: initialCount,
  mapConfig,
  availability,
  initialText,
  latestPlan = null,
  journeyId: initialJourneyId = null,
  initialTrip = null,
  initialMode = "daily",
}: {
  conversationId: string | null;
  title: string;
  initialMessages: ChatMessageView[];
  messageCount: number;
  mapConfig: PlanningMapConfig;
  availability: { enabled: true } | { enabled: false; message: string };
  initialText?: string;
  latestPlan?: { plan: PlanCardView; mapStops: MapStop[]; mapPaths?: MapPath[] } | null;
  /** 这段对话已保存的真实行程，及能成功读取时的当前进度。 */
  journeyId?: string | null;
  initialTrip?: TripProgressView | null;
  /** V2.11：还没开始的对话按这个模式开始（首页的选择）。 */
  initialMode?: PlanMode;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialId);
  const [title, setTitle] = useState(initialTitle);
  const [messages, setMessages] = useState(initialMessages);
  const [count, setCount] = useState(initialCount);
  const [thinking, setThinking] = useState(false);
  /** 等待时展示当前查询步骤，如“正在查资料库”。 */
  const [thinkingStep, setThinkingStep] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  // 侧栏可展示完整方案，也可在短途尚未选完时只展示候选地点。
  const [panel, setPanel] = useState<{ plan: PlanCardView | null; mapStops: MapStop[]; mapPaths?: MapPath[] } | null>(latestPlan ?? null);
  const [savingRunId, setSavingRunId] = useState<string | null>(null);
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  // V2.11 出游：分到各天、保存整趟进行中。
  const [allocating, setAllocating] = useState(false);
  const [savingOuting, setSavingOuting] = useState(false);
  const [confirmingChange, setConfirmingChange] = useState<string | null>(null);
  // 此对话页只在内存保留签名确认凭据，有效期 15 分钟；刷新不恢复旧卡的保存能力。
  const receipts = useRef(new Map<string, string>());
  const sentInitial = useRef(false);
  // V3.5：正在跟着的任务编号（停止用）、是不是正在跟着、上次是不是连接断了（切回来要接上）。
  const jobRef = useRef<string | null>(null);
  const followingRef = useRef(false);
  const lostRef = useRef(false);
  /** 点过“停止”（编号可能还没到）。 */
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const busy = thinking || planning;
  const [journeyId, setJourneyId] = useState(initialJourneyId);
  // V2.11：保存过的出游，进度面板按天切换（默认今天、正在进行或下一段）。
  const savedTripId = latestOuting(messages)?.days.find((day) => day.tripId)?.tripId ?? null;
  const outingTrip = useOutingTrip(savedTripId, messages.filter((message) => message.kind === "outing_day").length);
  const [outingPick, setOutingPick] = useState<{ day: number; journeyId: string | null } | null>(null);
  const pick = outingPick ?? (outingTrip.trip ? defaultJourney(outingTrip.trip, outingTrip.now) : null);
  const trip = useTripProgress(outingTrip.trip ? pick?.journeyId ?? null : journeyId, initialTrip);
  // 设备位置仅保留页面内存；提示语只填入输入框，由用户决定是否发送。
  const live = useLiveLocation();
  // V2.10：直接打开对话页时也取一次所在城市（先用本机记住的），第一条消息带上。
  const pageCity = usePageCity();
  const [suggestion, setSuggestion] = useState<{ text: string; nonce: number } | null>(null);
  // V2.11：还没开始的对话可以先选模式；开始后跟着当前卡片。
  const [newMode, setNewMode] = useState<PlanMode>(initialMode);
  const [switching, setSwitching] = useState(false);

  async function send(text: string) {
    if (busy || !availability.enabled) return;
    // 先展示的气泡只是页面临时态；消息计数只在服务端整轮提交成功后推进。
    // 响应到达时用已保存消息替换它，避免刷新或冲突后把乐观消息当成正式记录。
    const optimistic: ChatMessageView = { id: `pending-${Date.now()}`, role: "user", kind: "text", text };
    setMessages((list) => [...list, optimistic]);
    setThinking(true);
    let reply: TurnResponse = { status: "unavailable" };
    // V3.5：每条消息一个客户端编号；网络断了用同一个编号再发一次，服务端回已经存的那一轮，不会写出两条（stages/V3.5.md §3.2）。
    const clientId = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(
          conversationId ? `/api/conversations/${conversationId}/messages` : "/api/conversations",
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/x-ndjson, application/json" },
            // V2.10：第一条消息带上打开页面时定位得到的城市（没定位就不带，服务端缺省杭州）。
            body: JSON.stringify(conversationId
              ? { text, expectedCount: count, clientId }
              : {
                text,
                clientId,
                ...(pageCity.located ? { city: { adcode: pageCity.adcode, name: pageCity.name } } : {}),
                ...(newMode === "outing" ? { mode: "outing" } : {}),
              }),
          },
        );
        reply = await readTurn(response, setThinkingStep);
        break;
      } catch {
        reply = { status: "unavailable" };
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    setThinking(false);
    setThinkingStep(null);
    // 并发冲突时刷新服务器状态；临时气泡必须移除，不能让失败的一轮看起来已经保存。
    if (reply.status !== "ok") {
      setMessages((list) => [
        ...list.filter((message) => message.id !== optimistic.id),
        { id: `notice-${Date.now()}`, role: "assistant", kind: "notice", text: FAILED[reply.status], tone: "warning" },
      ]);
      if (reply.status === "conflict") router.refresh();
      return;
    }
    if (!conversationId) {
      setConversationId(reply.conversationId);
      // 只替换地址以指向已创建对话，保留当前组件和内存凭据，不触发重新挂载。
      window.history.replaceState(null, "", `/plan/${reply.conversationId}`);
    }
    setTitle(reply.title);
    setCount(reply.messageCount);
    const arrivedCard = reply.messages.some((message) => message.kind === "requirements_card");
    setMessages((list) => [
      // 新需求卡成为唯一可编辑卡，旧卡保留当时内容作为历史。
      ...closeAdjustments(list)
        .filter((message) => message.id !== optimistic.id)
        .map((message) => (arrivedCard && message.kind === "requirements_card" ? { ...message, latest: false } : message)),
      ...reply.messages,
    ]);
    // 已识别的调整意图继续生成候选，此时仍需用户点击确认才能写入正式行程。
    if (reply.adjust) {
      // 用户明确要求从当前位置重排时，原始设备点仅随这次请求发送，用于解析最近地点。
      const here = reply.adjust.from === "here" ? live.device() : null;
      await streamPlanning(`/api/conversations/${reply.conversationId}/adjust`, {
        expectedCount: reply.messageCount,
        request: reply.adjust,
        ...(here ? { here } : {}),
      });
    }
    // V2.11：“开始规划”“按天生成”这类话：做卡片的下一步，和点底部按钮一样。
    if (reply.next === "allocate") await allocate();
    else if (reply.next === "start") await startPlanning();
    // V2.11：已保存出游的跨天改动，接着重排受影响的天，给出改动卡片。
    if (reply.outingChange) {
      await streamPlanning(`/api/conversations/${reply.conversationId}/outing/change`, {
        expectedCount: reply.messageCount,
        request: reply.outingChange,
      });
    }
  }

  /** V2.9：“要记住吗？”卡片的决定；成功后只改这张卡片的状态。 */
  async function decidePreference(messageId: string, decision: "save" | "dismiss"): Promise<string | null> {
    if (!conversationId) return "请先发一条消息。";
    let status = "unavailable";
    try {
      const response = await fetch(`/api/conversations/${conversationId}/preference`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, decision }),
      });
      status = ((await response.json().catch(() => null)) as { status?: string } | null)?.status ?? "unavailable";
    } catch {
      status = "unavailable";
    }
    if (status === "saved" || status === "dismissed") {
      setMessages((list) => list.map((message) =>
        message.id === messageId && message.kind === "preference_proposal" ? { ...message, status } : message));
      return null;
    }
    if (status === "limit") return "已经记了 30 条，请先到“我的偏好”删掉一些。";
    if (status === "already_decided") return "这条已经处理过了，刷新页面看看。";
    if (status === "invalid") return "这条含有住处或号码，不能记住。";
    return "这次没保存成功，请稍后再试。";
  }

  /**
   * V3.2 审查建议的“采纳”“忽略”。没保存时采纳会改卡片，接着按新卡片重排受影响的天（同“重排这一天”）；
   * 已保存的出游走改动流程：重排受影响的天、显示前后，确认才保存。
   */
  async function decideSuggestion(messageId: string, index: number, decision: "adopt" | "dismiss"): Promise<string | null> {
    if (!conversationId || !liveCard?.card.fingerprint || busy) return "请稍等，正在规划。";
    let reply: { status: string; card?: RequirementsCardView; days?: number[] };
    try {
      const response = await fetch(`/api/conversations/${conversationId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, index, decision, fingerprint: liveCard.card.fingerprint }),
      });
      reply = await response.json();
    } catch {
      return "这次没处理成功，请稍后再试。";
    }
    const mark = (status: "adopted" | "dismissed") => setMessages((list) => list.map((message) => message.id === messageId && message.kind === "outing_review"
      ? { ...message, suggestions: message.suggestions.map((item) => (item.index === index ? { ...item, status } : item)) }
      : message));
    if (reply.status === "saved_trip") {
      const shown = await streamPlanning(`/api/conversations/${conversationId}/outing/change`, { expectedCount: count, request: { adopt: { messageId, index } } });
      // 改动卡片出来了才算采纳（服务端也是这时记下）；放不下、被拒或连接中断时还能再点。
      if (shown.includes("outing_change")) mark("adopted");
      return null;
    }
    if (reply.status !== "ok") {
      if (reply.status === "conflict") router.refresh();
      return reply.status === "invalid" ? "这条建议放不进现在的卡片了。" : "这条建议已经处理过了，刷新页面看看。";
    }
    mark(decision === "adopt" ? "adopted" : "dismissed");
    if (decision === "adopt" && reply.card) {
      const card = reply.card;
      setMessages((list) => list.map((message) => (message.id === liveCard.id ? { ...liveCard, card } : message)));
      if (reply.days?.length && card.fingerprint) {
        await streamPlanning(`/api/conversations/${conversationId}/outing`, { fingerprint: card.fingerprint, days: reply.days });
      }
    }
    return null;
  }

  const liveCard = [...messages].reverse().find(
    (message): message is Extract<ChatMessageView, { kind: "requirements_card" }> =>
      message.kind === "requirements_card" && message.latest,
  );

  /** 卡片编辑复用聊天补丁协议和校验，成功后仅替换当前卡片。 */
  async function edit(patch: DraftPatch): Promise<string | null> {
    if (!conversationId || !liveCard?.card.fingerprint) return "请先在对话里说说你的需求。";
    let reply: { status: string; card?: RequirementsCardView; code?: string };
    try {
      const response = await fetch(`/api/conversations/${conversationId}/draft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch, fingerprint: liveCard.card.fingerprint }),
      });
      reply = await response.json();
    } catch {
      return "暂时保存不了，请稍后再试。";
    }
    if (reply.status === "ok" && reply.card) {
      const card = reply.card;
      setMessages((list) => list.map((message) => (message.id === liveCard.id ? { ...liveCard, card } : message)));
      return null;
    }
    if (reply.status === "conflict") router.refresh();
    return EDIT_FAILED[reply.code ?? reply.status] ?? "这处修改没有保存，请检查后再试。";
  }

  /** V2.11 出游：分到各天，或把一项移到别的天（服务端重新检查）；成功后替换当前卡片。 */
  async function allocate(move?: { target: string; day: number }) {
    if (!conversationId || !liveCard?.card.fingerprint || allocating) return;
    setAllocating(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/allocate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: liveCard.card.fingerprint, ...(move ? { move } : {}) }),
      });
      const reply: { status: string; card?: RequirementsCardView; code?: string } = await response.json();
      if (reply.status === "ok" && reply.card) {
        const card = reply.card;
        setMessages((list) => list.map((message) => (message.id === liveCard.id ? { ...liveCard, card } : message)));
      } else if (reply.status === "conflict") {
        router.refresh();
      } else {
        notice(reply.code === "places_missing" ? "有地点查不到了，请重新选一下再分。" : "这次没能分好，请稍后再试。");
      }
    } catch {
      notice("这次没能分好，请稍后再试。");
    } finally {
      setAllocating(false);
    }
  }

  const notice = (text: string) =>
    setMessages((list) => [...list, { id: `notice-${Date.now()}`, role: "assistant", kind: "notice", text, tone: "warning" }]);

  /**
   * 规划过程中更新一条临时进度消息，完成后替换成正式消息。
   * 开始规划、短途选点和换批候选共用这条流式处理逻辑。
   */
  /** 返回跨天改动这一轮新出现的消息种类（其他流是空的）。 */
  async function streamPlanning(url: string, body: unknown): Promise<string[]> {
    // V3.5：每次点开始一个请求键；同一段对话已有在跑的，服务端不开始新的，这里接上它（stages/V3.5.md §3.2）。
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(body as object), requestKey: crypto.randomUUID() }) };
    return follow(() => fetch(url, init), false);
  }

  /** V3.5：接上这段对话正在跑的任务（打开页面、切回前台、网络恢复、点开始时发现已有在跑的）。 */
  async function attach(): Promise<string[]> {
    if (!conversationId || followingRef.current) return [];
    return follow(() => fetch(`/api/conversations/${conversationId}/job`, { cache: "no-store" }), true);
  }

  /** V3.5：上次的任务中断了（服务中途停了），说一次在哪断的；不自动重跑。 */
  function interrupted(job: { jobId: string; kind: string; days: readonly number[]; planned: readonly number[] }) {
    const key = `tq-job-seen-${job.jobId}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      // 浏览器存储不可用时每次都说。
    }
    if (job.kind !== "outing") {
      notice("上次的规划没做完（服务中途停了），可以重新开始。");
      return;
    }
    const days = [...job.days].sort((a, b) => a - b);
    // 审查开着时（缺省）各天要等整趟审查完才存，中途中断就一天都没留下，只能重新排（用户 2026-11-02 定）。
    if (!days.length) {
      notice("上次的出游没排完（服务中途停了），点“按天生成”重新排。");
      return;
    }
    // 指定了天（继续、重排）就是其中第一个没排好的；整趟时是已排好的最后一天的下一天。
    const stuck = job.planned.length ? job.planned.find((day) => !days.includes(day)) : (days.at(-1) ?? 0) + 1;
    const kept = days.length ? `，已排好的第 ${days.length > 1 ? `${days[0]}–${days.at(-1)}` : days[0]} 天保留` : "";
    notice(`上次规划${stuck ? `在第 ${stuck} 天` : ""}中断了${kept}；点“继续规划剩下的天”接着排。`);
  }

  /** 跟着一个任务走：发起的请求（带保存凭据）或接上的（不带）。返回跨天改动这一轮新出现的消息种类。 */
  async function follow(open: () => Promise<Response>, attaching: boolean): Promise<string[]> {
    followingRef.current = true;
    setPlanning(true);
    let changed: string[] = [];
    const runningId = `running-${Date.now()}`;
    const steps: ProgressStep[] = [];
    const show = () => setMessages((list) => {
      const running: ChatMessageView = { id: runningId, role: "assistant", kind: "planning_progress", running: true, steps: [...steps] };
      return list.some((message) => message.id === runningId)
        ? list.map((message) => (message.id === runningId ? running : message))
        : [...list, running];
    });
    if (!attaching) show();
    try {
      const response = await open();
      if (!(response.headers.get("content-type") ?? "").includes("ndjson")) {
        // 没有在推的：别人已经在跑（接上它）、同一个请求已经跑完（刷新看结果）、上次中断了，或者什么都没有。
        const reply: { status: string; job?: { jobId: string; kind: string; days: number[]; planned: number[] } } = await response.json().catch(() => ({ status: "unavailable" }));
        setMessages((list) => list.filter((message) => message.id !== runningId));
        followingRef.current = false;
        if (reply.status === "running" && !attaching) return await attach();
        if (reply.status === "finished") router.refresh();
        else if (reply.status === "interrupted" && reply.job) interrupted(reply.job);
        else if (!attaching) notice(reply.status === "not_found" ? "找不到这段对话了，请刷新页面。" : "规划服务暂时不可用，请稍后再试。");
        return [];
      }
      if (!response.body) throw new Error("unavailable");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      // 读到 EOF 不等于业务完成；必须收到 done 或 refused，才能结束本轮页面状态。
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "job") {
            // 第一行是任务本身：记下编号（停止用）；接上时先把已有的步骤画出来。
            jobRef.current = event.job.jobId;
            lostRef.current = false;
            // 编号到之前就点了“停止”：现在停。
            if (stopRef.current) void requestStop(event.job.jobId);
            if (attaching) {
              steps.push(...(event.job.steps as string[]).slice(-6).map((text, index) => ({ key: `replayed-${index}`, text, state: "done" as const })));
              show();
            }
          } else if (event.type === "step") {
            if (steps.some((step) => step.key === event.step.key)) continue;
            steps.forEach((step, index) => (steps[index] = { ...step, state: "done" }));
            steps.push(event.step);
            show();
          } else if (event.type === "day") {
            // V2.11 出游：每排好一天插在进度消息前面，进度继续往下走；各段的保存凭据只放内存。
            for (const item of (event.receipts ?? []) as { runId: string; receipt: string }[]) receipts.current.set(item.runId, item.receipt);
            setCount(event.messageCount);
            // V3.5：接上的页面拿不到保存凭据，这几天要重排后才能保存（同刷新后读回的方案）。
            const day: ChatMessageView = event.receipts ? event.message : asReadBack(event.message);
            setMessages((list) => {
              const rest = list.filter((message) => message.id !== day.id);
              const at = rest.findIndex((message) => message.id === runningId);
              return at < 0 ? [...rest, day] : [...rest.slice(0, at), day, ...rest.slice(at)];
            });
          } else if (event.type === "card") {
            // V3.2：审查直接改了分到各天，卡片换成新的（之后“重排这一天”按新的排）。
            const card = event.card as RequirementsCardView;
            setMessages((list) => list.map((message) => (message.kind === "requirements_card" && message.latest ? { ...message, card } : message)));
          } else if (event.type === "review") {
            // V3.2：审查给的建议，放在各天后面。
            setCount(event.messageCount);
            const review: ChatMessageView = event.message;
            setMessages((list) => {
              const rest = list.filter((message) => message.id !== review.id);
              const at = rest.findIndex((message) => message.id === runningId);
              return at < 0 ? [...rest, review] : [...rest.slice(0, at), review, ...rest.slice(at)];
            });
          } else if (event.type === "change") {
            // V2.11 跨天改动：改动卡片（或放不下的提示）；新各段的保存凭据只放内存。
            finished = true;
            for (const item of (event.receipts ?? []) as { runId: string; receipt: string }[]) receipts.current.set(item.runId, item.receipt);
            setCount(event.messageCount);
            const fresh: ChatMessageView[] = event.messages;
            changed = fresh.map((message) => message.kind);
            setMessages((list) => [
              ...list.filter((message) => message.id !== runningId)
                .map((message) => (message.kind === "outing_change" && message.open ? { ...message, open: false } : message)),
              ...fresh,
            ]);
          } else if (event.type === "outing_done") {
            finished = true;
            if (stopRef.current) notice("已停止，已经排好的部分留着。");
            setCount(event.messageCount);
            setMessages((list) => list.filter((message) => message.id !== runningId));
          } else if (event.type === "done") {
            finished = true;
            // 过程消息由前端生成，done 里的消息才有正式 ID；签名凭据单独放 ref，
            // 不写入对话记录或浏览器存储。刷新后的旧卡片因缺少凭据不能继续确认。
            if (event.receipt && event.plan) receipts.current.set(event.plan.runId, event.receipt.receipt);
            const adjustment = (event.messages as ChatMessageView[]).find((message) => message.kind === "adjust_card");
            if (event.receipt && adjustment?.kind === "adjust_card") receipts.current.set(adjustment.runId, event.receipt.receipt);
            setCount(event.messageCount);
            const fresh: ChatMessageView[] = event.messages;
            const ids = new Set(fresh.map((message) => message.id));
            const trips = new Set(fresh.flatMap((message) => (message.kind === "choices" ? [message.tripId] : [])));
            setMessages((list) => [
              ...closeAdjustments(list)
                .filter((message) => message.id !== runningId && !ids.has(message.id))
                .map((message) => event.updated && message.id === event.updated.id ? event.updated
                  // 同一短途出现新步骤时关闭前面步骤，防止再次回答旧候选。
                  : message.kind === "choices" && trips.has(message.tripId) ? { ...message, open: false, canRefresh: false }
                    : message),
              ...fresh,
            ]);
            if (event.plan) setPanel({ plan: event.plan, mapStops: event.mapStops, mapPaths: event.mapPaths ?? [] });
            else if (event.mapStops?.length) setPanel({ plan: null, mapStops: event.mapStops, mapPaths: [] });
          } else if (event.type === "refused") {
            finished = true;
            setMessages((list) => list.filter((message) => message.id !== runningId));
            // 点过“停止”后任务以拒绝收尾（停得早时服务会说查不到之类）：照实说是停了。
            notice(event.status === "cancelled" || stopRef.current ? "已停止，已经排好的部分留着。" : event.message);
            if (event.status === "conflict") router.refresh();
          }
        }
      }
      if (!finished) throw new Error("incomplete");
      return changed;
    } catch {
      setMessages((list) => list.filter((message) => message.id !== runningId));
      // V3.5：连接断了，任务在服务端照样跑；切回页面或网络恢复时自动接上。
      lostRef.current = true;
      notice("规划连接断了，任务还在继续；回到页面或网络恢复后会自动接上。");
      return [];
    } finally {
      jobRef.current = null;
      stopRef.current = false;
      followingRef.current = false;
      setStopping(false);
      setPlanning(false);
    }
  }

  /** V3.5：停止正在跑的任务（已经排好的天留着）。结果由正在跟着的那条流收到。 */
  async function stopJob() {
    if (stopRef.current) return;
    stopRef.current = true;
    setStopping(true);
    // 进度先画出来、任务编号还没到时点的：记下，编号一到就停（见 follow 里的 job 行）。
    if (jobRef.current) await requestStop(jobRef.current);
  }

  async function requestStop(jobId: string) {
    if (!conversationId) return;
    try {
      await fetch(`/api/conversations/${conversationId}/job/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
    } catch {
      stopRef.current = false;
      setStopping(false);
      notice("暂时没能停止，请稍后再试。");
    }
  }

  /** 一日游生成完整候选，短途先生成第一步候选地点；出游按天生成。 */
  async function startPlanning() {
    if (busy || !conversationId || !liveCard?.card.fingerprint) return;
    if (liveCard.card.mode === "outing") {
      await streamPlanning(`/api/conversations/${conversationId}/outing`, { fingerprint: liveCard.card.fingerprint });
      return;
    }
    await streamPlanning(`/api/conversations/${conversationId}/plan`, { fingerprint: liveCard.card.fingerprint });
  }

  /** V2.11：切换日常 / 出游。对话已开始时新建一张那个模式的卡片，把已说的带过去（服务端决定带什么）。 */
  async function switchMode(to: PlanMode) {
    if (!conversationId) {
      setNewMode(to);
      return;
    }
    if (busy || switching || !liveCard?.card.fingerprint) return;
    setSwitching(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: to, fingerprint: liveCard.card.fingerprint }),
      });
      const reply: TurnResponse = await response.json();
      if (reply.status !== "ok") {
        if (reply.status === "conflict") router.refresh();
        notice("暂时没能切换，请稍后再试。");
        return;
      }
      setTitle(reply.title);
      setCount(reply.messageCount);
      setMessages((list) => [
        ...list.map((message) => (message.kind === "requirements_card" ? { ...message, latest: false } : message)),
        ...reply.messages,
      ]);
    } catch {
      notice("暂时没能切换，请稍后再试。");
    } finally {
      setSwitching(false);
    }
  }
  const mode: PlanMode = liveCard ? (liveCard.card.mode === "outing" ? "outing" : "daily") : newMode;

  /** V2.11：“继续规划剩下的天”“重排这一天”：沿用这次生成，其他天用过的地点不再用。 */
  async function generateDays(days: number[]) {
    if (busy || !conversationId || !liveCard?.card.fingerprint || !days.length) return;
    await streamPlanning(`/api/conversations/${conversationId}/outing`, { fingerprint: liveCard.card.fingerprint, days });
  }

  const outingDays = latestOuting(messages);
  const outingTotal = liveCard?.card.mode === "outing" ? liveCard.card.outing?.dates?.days ?? 0 : 0;

  /** V2.11：保存整趟。每段的凭据都在才能保存；服务端逐段复核路线，一个事务写出游和各天。 */
  async function saveOuting() {
    const current = latestOuting(messages);
    if (!conversationId || !current || savingOuting) return;
    const list = current.days
      .flatMap((day) => day.parts.flatMap((part) => (part.kind === "plan" ? [part.plan.runId] : [])))
      .map((runId) => receipts.current.get(runId));
    if (list.some((item) => !item)) {
      notice("有几天的方案已经过了可保存的时间，重排那几天就能保存。");
      return;
    }
    setSavingOuting(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/outing/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId: current.generationId, receipts: list, acknowledgeUnknowns: true }),
      });
      const reply: { status: string; tripId?: string; day?: number } = await response.json();
      if ((reply.status === "saved" || reply.status === "already_saved") && reply.tripId) {
        const tripId = reply.tripId;
        setMessages((list) => list.map((message) =>
          message.kind === "outing_day" && message.generationId === current.generationId ? { ...message, tripId } : message));
        router.refresh();
        return;
      }
      const which = reply.day ? `第 ${reply.day} 天` : "有一天";
      notice(reply.status === "draft_changed" ? `${which}的路线时间有变化，重排${reply.day ? "这一天" : "那一天"}再保存吧。`
        : reply.status === "expired" || reply.status === "invalid_receipt" ? `${which}的方案已经过了可保存的时间，重排一下再保存。`
          : "暂时没能保存，请稍后再试。");
    } catch {
      notice("暂时没能保存，请稍后再试。");
    } finally {
      setSavingOuting(false);
    }
  }

  /** 有选中项时提交选点，没有选中项时换一批；请求始终绑定最新需求指纹。 */
  async function answerChoices(view: ChoicesView, option?: ChoiceOptionView) {
    if (busy || !conversationId || !liveCard?.card.fingerprint) return;
    await streamPlanning(`/api/conversations/${conversationId}/choices`, {
      tripId: view.tripId,
      messageId: view.id,
      fingerprint: liveCard.card.fingerprint,
      ...(option ? { pick: option.externalId } : {}),
    });
  }

  /** 只有用户点击时才向浏览器申请定位；设备点单次发送给服务端解析为最近地点，不持久保留。 */
  async function locateMe() {
    if (!conversationId || !liveCard?.card.fingerprint || locating) return;
    if (!("geolocation" in navigator)) {
      notice("这个浏览器不能定位，直接告诉我从哪里出发吧。");
      return;
    }
    setLocating(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }));
      const response = await fetch(`/api/conversations/${conversationId}/location`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          fingerprint: liveCard.card.fingerprint,
        }),
      });
      const reply: { status: string; card?: RequirementsCardView; code?: string } = await response.json();
      if (reply.status === "ok" && reply.card) {
        const card = reply.card;
        setMessages((list) => list.map((message) => (message.id === liveCard.id ? { ...liveCard, card } : message)));
      } else {
        notice(EDIT_FAILED[reply.code ?? reply.status] ?? "暂时没能定位，直接告诉我从哪里出发吧。");
        if (reply.status === "conflict") router.refresh();
      }
    } catch {
      notice("没有拿到定位（可能是拒绝了权限），直接告诉我从哪里出发吧。");
    } finally {
      setLocating(false);
    }
  }

  /** 正式确认入口实时复查路线并保存，成功后才更新对话卡与行程关联。 */
  async function savePlan(plan: PlanCardView) {
    const receipt = receipts.current.get(plan.runId);
    if (!conversationId || savingRunId) return;
    if (!receipt) {
      notice("这个方案已经过了可保存的时间，点“换个方案”重新规划一下就能保存。");
      return;
    }
    setSavingRunId(plan.runId);
    try {
      const response = await fetch("/api/planning/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt, title: plan.title, acknowledgeUnknowns: true }),
      });
      const reply = await response.json();
      if (reply.status !== "saved" && reply.status !== "already_saved") {
        notice(reply.status === "draft_changed"
          ? "路线时间有变化，方案已不准确，点“换个方案”重新规划吧。"
          : "暂时没能保存，请稍后再试。");
        return;
      }
      // 行程保存与回链是两个步骤：正式保存成功后，即使回链暂时失败，也不重新创建行程。
      const journeyId: string = reply.journeyId;
      setJourneyId(journeyId);
      await fetch(`/api/conversations/${conversationId}/saved`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: plan.runId, journeyId }),
      }).catch(() => null);
      const saved = { ...plan, saved: { journeyId } };
      setMessages((list) => list.map((message) =>
        message.kind === "plan_card" && message.plan.runId === plan.runId ? { ...message, plan: saved } : message));
      setPanel((current) => (current?.plan && current.plan.runId === plan.runId ? { ...current, plan: saved } : current));
    } catch {
      notice("暂时没能保存，请稍后再试。");
    } finally {
      setSavingRunId(null);
    }
  }

  /** V2.11：确认跨天改动。每段的凭据都要在；服务端比对出游和每一天的版本，变了就整体拒绝。 */
  async function confirmOutingChange(view: OutingChangeView) {
    if (!conversationId || confirmingChange) return;
    const list = view.days.flatMap((day) => day.parts.flatMap((part) => (part.kind === "plan" ? [receipts.current.get(part.plan.runId)] : [])));
    if (list.some((item) => !item)) {
      notice("离开过页面后需要再说一次才能确认。");
      return;
    }
    setConfirmingChange(view.changeId);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/outing/change/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: view.id, receipts: list }),
      });
      const reply: { status: string; day?: number } = await response.json();
      if (reply.status === "saved" || reply.status === "already_saved") {
        router.refresh();
        return;
      }
      notice(reply.status === "stale" ? "出游刚有变化（比如别的天改过、今天标了完成），这个改动已经过时，请再跟我说一次。"
        : reply.status === "draft_changed" ? "路线时间有变化，这个改动已经不准确，请再跟我说一次。"
          : reply.status === "expired" || reply.status === "invalid_receipt" ? "这个改动超过可保存的时间了，请再跟我说一次。"
            : "暂时没能保存，请稍后再试。");
    } catch {
      notice("暂时没能保存，请稍后再试。");
    } finally {
      setConfirmingChange(null);
    }
  }

  /** 确认调整传签名凭据，服务端复核当前状态后才能创建下一版。 */
  async function confirmAdjust(card: AdjustCardView) {
    const receipt = receipts.current.get(card.runId);
    if (!conversationId || confirmingRunId) return;
    if (!receipt) {
      notice(ADJUST_FAILED.invalid_receipt);
      return;
    }
    setConfirmingRunId(card.runId);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/adjust/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt }),
      });
      const reply: { status: string; planVersion?: number } = await response.json();
      if ((reply.status === "saved" || reply.status === "already_saved") && reply.planVersion) {
        const savedVersion = reply.planVersion;
        setMessages((list) => list.map((message) =>
          message.kind === "adjust_card" && message.runId === card.runId ? { ...message, savedVersion, open: false } : message));
        // 确认成功后重读服务端新版本，不在前端根据预览自行拼接正式进度。
        void trip.reload();
        return;
      }
      notice(ADJUST_FAILED[reply.status] ?? "暂时没能保存，请稍后再试。");
    } catch {
      notice("暂时没能保存，请稍后再试。");
    } finally {
      setConfirmingRunId(null);
    }
  }

  // V3.5：打开对话时查一次在跑的任务（刷新、关掉再打开）；切回前台、网络恢复时，之前断了就接上。
  const reattach = useEffectEvent((always: boolean) => {
    if (always || (document.visibilityState === "visible" && lostRef.current)) void attach();
  });
  useEffect(() => {
    if (initialId) reattach(true);
    const back = () => reattach(false);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("online", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("online", back);
    };
  }, [initialId]);

  useEffect(() => {
    if (!initialText || sentInitial.current || conversationId) return;
    sentInitial.current = true;
    void send(initialText);
    // 首页带来的首条消息只在挂载时发送一次，避免状态更新触发重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ChatWorkspace
      title={title}
      plan={panel?.plan ?? null}
      mapStops={panel?.mapStops ?? []}
      mapPaths={panel?.mapPaths ?? []}
      mapConfig={mapConfig}
      trip={journeyId || outingTrip.trip ? trip : null}
      mode={mode}
      modeSwitch={<ModeSwitch value={mode} onChange={busy || switching ? undefined : (to) => void switchMode(to)} />}
      outingHeader={outingTrip.trip && pick ? (
        <OutingProgressHeader
          trip={outingTrip.trip}
          now={outingTrip.now}
          day={pick.day}
          journeyId={pick.journeyId}
          onSelect={(day, id) => setOutingPick({ day, journeyId: id })}
        />
      ) : null}
      onAdjust={() => document.getElementById("chat-composer")?.focus()}
      onSuggest={(text) => setSuggestion({ text, nonce: Date.now() })}
      live={live}
      conversation={
        messages.length === 0 ? (
          <EmptyState availability={availability} mode={mode} />
        ) : (
          <MessageList
            messages={messages}
            thinking={thinking}
            thinkingStep={thinkingStep}
            actions={{
              onEdit: busy ? undefined : edit,
              onAllocate: busy ? undefined : (move) => void allocate(move),
              allocating,
              onUseLocation: busy ? undefined : () => void locateMe(),
              locating,
              onStart: busy ? undefined : () => void startPlanning(),
              starting: planning,
              onSave: (plan) => void savePlan(plan),
              savingRunId,
              conversationId,
              onReplan: busy ? undefined : () => void startPlanning(),
              onChoosePlace: (target, placeId) => void edit({ choose: [{ target, externalId: placeId }] }),
              onPick: busy ? undefined : (view, option) => void answerChoices(view, option),
              onRefresh: busy ? undefined : (view) => void answerChoices(view),
              onPreference: conversationId ? decidePreference : undefined,
              onSuggestion: conversationId ? decideSuggestion : undefined,
              onConfirmAdjust: busy ? undefined : (card) => void confirmAdjust(card),
              confirmingRunId,
              onRedoDay: busy || !outingTotal || savedTripId ? undefined : (view) => void generateDays([view.day]),
              onConfirmOutingChange: busy ? undefined : (view) => void confirmOutingChange(view),
              onSwitchToOuting: busy || switching || mode === "outing" ? undefined : () => void switchMode("outing"),
              confirmingChange,
              onStop: () => void stopJob(),
              stopping,
              ...(outingDays && outingTotal ? {
                outing: {
                  total: outingTotal,
                  done: outingDays.days.filter((day) => day.status === "draft").length,
                  failed: outingDays.days.filter((day) => day.status !== "draft").length,
                  // 本次页面生成的方案（live）才带着保存凭据；读回的历史方案要重新生成。
                  savable: outingDays.days.every((day) => day.parts.every((part) => part.kind !== "plan" || part.plan.live)),
                  tripId: outingDays.days.find((day) => day.tripId)?.tripId ?? null,
                  saving: savingOuting,
                  busy,
                  onSave: busy ? undefined : () => void saveOuting(),
                  onContinue: () => void generateDays(
                    Array.from({ length: outingTotal }, (_, index) => index + 1).filter((day) => !outingDays.days.some((item) => item.day === day)),
                  ),
                },
              } : {}),
            }}
          />
        )
      }
      composer={
        <Composer
          onSend={send}
          suggestion={suggestion}
          disabled={busy || !availability.enabled}
          autoFocus={!initialText}
          placeholder={!availability.enabled ? "对话规划暂不可用"
            : trip.view ? "行程有变化直接说，比如：越剧不去了，换成喝茶"
              : mode === "outing" ? "说说这趟出游…" : "说说你想怎么过这一天…"}
        />
      }
    />
  );
}

function EmptyState({ availability, mode }: { availability: { enabled: true } | { enabled: false; message: string }; mode: PlanMode }) {
  return (
    <div className="pt-16 text-center">
      <h2 className="text-2xl font-semibold tracking-tight">{mode === "outing" ? "这趟出游想怎么玩？" : "想怎么过这一天？"}</h2>
      <p className="mt-2 text-ink-soft">
        {mode === "outing" ? "哪几天、去哪些城市、怎么去，想玩什么，想到什么说什么。" : "时间、出发地、预约和兴趣，想到什么说什么。"}
      </p>
      {!availability.enabled && (
        <p className="mx-auto mt-6 max-w-md rounded-(--radius-field) bg-sun-50 px-4 py-3 text-sm text-sun-700">
          {availability.message}
        </p>
      )}
    </div>
  );
}
