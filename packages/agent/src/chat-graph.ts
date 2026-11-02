import { Annotation, END, GraphRecursionError, START, StateGraph } from "@langchain/langgraph";
import {
  applyDraftPatch,
  draftMissing,
  interestWindowConflicts,
  type DraftPlace,
  type RequirementsDraft,
  cityFromPlaces,
  draftCity,
  draftPatchSchema,
} from "@tripquest/application/conversation";
import { INTEREST_SLOTS, SLOT_MIN_OVERLAP_MINUTES } from "@tripquest/application/planning";
import type { PlaceSearchRequest } from "@tripquest/providers";
import { z } from "zod";
import {
  CHAT_LIMITS,
  chatActionSchema,
  ChatRunError,
  type AdjustTripRequest,
  type ChatOutingTrip,
  type OutingChangeRequest,
  type ChatAction,
  type ChatAgentRun,
  type ChatCandidate,
  type ChatCounts,
  type ChatDecisionContext,
  type ChatLimits,
  type ChatObservation,
  type ChatOutside,
  type ChatPlace,
  type ChatTrace,
  type ChatTrip,
  type ChatUsage,
  type ChatProgress,
  type ChatRunOptions,
  type ChatRunnerDependencies,
  type ChatSource,
  type ChatTurnInput,
  type ChatTurnResult,
} from "./chat-contracts";
import { serializeChatContext } from "./chat-prompt";
import { agentFlags, CHAT_AGENTS, CHAT_INTAKE_WITH_QUESTIONS, onlySmallTalk as onlyChatting, pickAgents, type ChatAgentId, type ChatAgentSpec } from "./chat-agents";
import type { ChatSpecialistId } from "./chat-agent-prompts";
import { DecisionModelError } from "./contracts";
import { guessedQuestion, INTENT_FLAGS, looksLikeQuestion, regexFallback, regexRouter, type IntentRoute, type IntentRouter } from "./intent";
import { hasPrivateNumber, preferenceProblem } from "@tripquest/application/preferences";
import { assertLocalTracingOnly } from "./tracing";
import { inAgent } from "./agents/run-agent";
import { currentRun, type AgentRun } from "./runs";

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheHitTokens: z.number().int().nonnegative().nullable(),
  cacheMissTokens: z.number().int().nonnegative().nullable(),
}).nullable();
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** V2.7：住处、楼栋和疑似精确坐标不允许进入联网检索词，避免把用户位置发给搜索服务。 */
const WHERE_USER_IS = /小区|公寓|宿舍|我家|家附近|\d+\s*(幢|栋|号楼|单元|室)|\d{2,3}\.\d{3,}/;
/** 明确说明未查到资料时允许不带出处；不能为了满足引用格式捏造来源。 */
const FOUND_NOTHING = /没(有)?(查|搜|找)到|未(查|找|搜)到|查不到|找不到|没有(相关|找到|查到)|资料库(里|中)?(没有|暂无|还没有)/;
/** V2.9.1：没说在哪的“附近”（“附近有什么好吃的”；“湖滨附近”说了区域，不算）。 */
const NEARBY = /(^|[，,。！？\s])(这附近|附近|这边|周边|周围)/;
/** 问了在哪，或说明了是全城范围（V2.10：城市名来自卡片，不再写死杭州）。 */
const SCOPED = /全市|全城|整个城市|市内各处|你在哪|你现在在|在哪一带|哪一带|哪个区域|哪片/;
/** V2.10：回复问了从哪出发，或请求位置。 */
const ASKS_START = /从哪(里|儿)?出发|(允许|开启|打开|授权).{0,6}(位置|定位)|获取.{0,6}位置|出发地|在哪(里|儿)?出发/;
/** V2.10：地点名和用户说的名字对得上（“云岭山”对“云岭山(山门)”）；只按标签模糊命中的不算。 */
const namedAs = (name: string, mention: string) => {
  const plain = (text: string) => text.replace(/[\s()（）·]/g, "");
  // 只在名字中间出现不算（“乌味丰…乌镇特色大锅熟食”不是“乌镇”，真实验证）。
  return plain(name).startsWith(plain(mention)) || plain(mention).includes(plain(name));
};
/**
 * V2.10：这一轮从卡片上拿掉的地点和兴趣（按名称比，兴趣编号删掉后会被新兴趣重用）。
 * 回复里出现名称的前 4 个字就算提到了（“湖滨步行街逛逛”对“湖滨步行街那条”）。
 */
function silentlyRemoved(before: RequirementsDraft, after: RequirementsDraft, text: string): string[] {
  const named = (place: DraftPlace) => (place.status === "bound" ? [place.name] : place.status === "choose" ? [place.mention] : []);
  const kept = new Set([...after.visits.flatMap((visit) => named(visit.place)), ...after.interests.map((item) => item.text)]);
  const plain = (value: string) => value.replace(/[\s()（）·]/g, "");
  return [...before.visits.flatMap((visit) => named(visit.place)), ...before.interests.map((item) => item.text)]
    .filter((name) => !kept.has(name) && !plain(text).includes(plain(name).slice(0, 4)));
}

const scopedTo = (text: string, cityName: string) => {
  const short = cityName.replace(/市$/, "");
  return SCOPED.test(text) || text.includes(`全${short}`) || text.includes(`整个${short}`) || text.includes(`${short}范围`);
};
const LINK = /https?:\/\/|www\./i;
/** V2.9：声称已经记住（偏好要用户确认才保存）。说偏好的这一轮，连“记下了”也算。 */
const CLAIMS_MEMORY = /记住了|记下(了|你|来)|已记住|已经记住|已记下|已经记下|以后都(会|给你|按|帮你)/;
/**
 * 其余轮次（没说偏好、也没有已保存的偏好）：卡片没改时，单独的“记下了 / 帮你记着 / 记住啦”也算
 * （V2.9.3 端到端：“海鲜我一口都碰不了”被回成“记下了，全程避开海鲜”，其实什么都没存）。
 */
const CLAIMS_LASTING_MEMORY = /已经记下|已记下|记住了|记下你|已记住|已经记住|记下了|帮你记着|记住啦|记着了|以后都(会|给你|按|帮你)/;
/**
 * 卡片改过的轮次只拦声称长期的说法：规划时“记下了，明天加上灵隐寺”是对卡片的正常确认，
 * “以后都按慢节奏”“下次也给你避开”才是在冒充长期记忆（V2.9.3：E11 改了卡片，这句没被查）。
 */
const CLAIMS_LONG_TERM = /以后都(会|给你|按|帮你|不)|以后(会|就)(按|给你|帮你)|下次(都|也|就|会)|一直(都会|会|都)(按|给你|帮你)|今后/;
/** V2.7/V2.8 的问句判断，V2.9 起放在分流里（intent.ts），这里转出以保持原有导出。 */
export { ASKS, KNOWLEDGE_ASKS } from "./intent";

export function chatLimits(overrides: Partial<ChatLimits> = {}): ChatLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in CHAT_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > CHAT_LIMITS[key as keyof ChatLimits]) {
      throw new TypeError("Chat limits may only tighten the production bounds");
    }
  }
  return { ...CHAT_LIMITS, ...overrides };
}

export function createChatRunner(dependencies: ChatRunnerDependencies) {
  const limits = chatLimits(dependencies.limits);
  return {
    // V3.0：原来写进 chat_traces 的内容（分流、校验提示、工具）记成运行记录的步骤。V3.4：先分流、由代码挑专门 Agent，
    // 分流和挑选记在这一轮的根运行上，每个专门 Agent 是自己的子运行（见 runSplit）。
    run: (input: ChatTurnInput, options: ChatRunOptions): Promise<ChatTurnResult> => runSplit(input, options, dependencies, limits),
  };
}

const classifyTurn = (result: ChatTurnResult) => result.status === "completed"
  ? { status: result.reply.fallback ? "fallback" as const : "ok" as const }
  : { status: "failed" as const, outcome: result.code };

function recordTrace(run: AgentRun, result: AgentTurnResult) {
  const trace = result.trace!;
  run.set({ prompt: trace.prompt, context: trace.context });
  for (const hint of trace.hints) run.step("repair", "hint", { hint });
  for (const { tool, ...summary } of trace.tools) run.step("tool_call", tool, summary);
  if (result.status === "completed" && result.reply.fallback) run.step("fallback", "reply", {});
}

/** 同时限制底层请求与调用方等待时间。依赖即使忽略 AbortSignal，迟到结果也不能继续本轮。 */
async function bounded<T>(signal: AbortSignal, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  if (signal.aborted) throw new ChatRunError("timeout");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new ChatRunError("timeout"));
        controller.signal.addEventListener("abort", abort, { once: true });
      }),
      operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

/** 统一转换为北京时间的日期、星期和时刻（全国同一时区）；相对日期按这份时钟解释，不依赖服务端机器的时区。 */
function chinaNow(nowMs: number) {
  const local = new Date(nowMs + 8 * 3_600_000);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: WEEKDAYS[local.getUTCDay()],
    time: local.toISOString().slice(11, 16),
  };
}

/**
 * V2.9.1：助手回复在对话历史里的文字。推荐过地点时按推荐顺序附上名字，“就去第二家”才有据可依
 * （推荐卡片只在页面上，候选编号也不跨轮）。只给名字，不给编号和地址。
 */
/** V2.9.1：去掉补丁里卡片上已经有的地点（按高德编号），其余照旧。 */
function withoutResentVisits(
  action: Extract<ChatAction, { action: "update_requirements" }>,
  draft: RequirementsDraft,
  candidates: ReadonlyMap<string, ChatCandidate>,
): Extract<ChatAction, { action: "update_requirements" }> {
  const added = action.patch.addVisits;
  if (!added?.length) return action;
  const onCard = new Set(draft.visits.flatMap((visit) => (visit.place.status === "bound" ? [visit.place.externalId] : [])));
  const kept = added.filter((visit) => {
    const candidate = "candidate" in visit.place ? candidates.get(visit.place.candidate) : undefined;
    return !candidate || !onCard.has(candidate.externalId);
  });
  if (kept.length === added.length) return action;
  const patch: typeof action.patch = { ...action.patch, addVisits: kept };
  if (!kept.length) delete patch.addVisits;
  return { ...action, patch };
}

/**
 * V2.10：模型常发不存在的 patch.interests 来整体替换兴趣（Y07、P07 第一次补丁几乎都这样，每次耗一次纠错额度）。
 * 按替换理解：拿掉卡片上原有的兴趣、加上新的；只在没有同时发 add/removeInterests 时改写，其余照常校验。
 */
function interestsAsReplace(item: unknown, draft: RequirementsDraft): unknown {
  return chooseTargets(singleChoiceAsCandidate(replaceInterests(outingAsFields(item), draft)));
}

/**
 * V2.11 验收复测：选住处时模型写 `lodging1`、`night1`，选车站时写 `t1.from`、`transport1_to`（合法的是 n1、
 * t1:from），被结构校验挡下后改不过来，4 次打回整轮失败。这几种写法规整成合法的，其余照常校验。
 */
function chooseTargets(item: unknown): unknown {
  if (!item || typeof item !== "object" || (item as { action?: unknown }).action !== "update_requirements") return item;
  const patch = (item as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object" || !Array.isArray((patch as { choose?: unknown }).choose)) return item;
  const target = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const night = /^(?:lodging|night|nights|hotel|n)[\s_.:-]?(\d)$/i.exec(value.trim());
    if (night) return `n${night[1]}`;
    const leg = /^(?:t|transport|transports)[\s_.:-]?(\d{1,2})[\s_.:-]?(from|to)$/i.exec(value.trim());
    return leg ? `t${leg[1]}:${leg[2]!.toLowerCase()}` : value;
  };
  const choose = (patch as { choose: unknown[] }).choose.map((pick) =>
    pick && typeof pick === "object" ? { ...pick, target: target((pick as { target?: unknown }).target) } : pick);
  return { ...item, patch: { ...patch, choose } };
}

/**
 * V2.11：模型照着上下文里卡片的样子发 patch.outing（O09 连发几次用完纠错额度），展开成补丁字段：
 * 日期、时刻、每天的时间窗、交通（没有编号的当新增）、住处（按晚）。其余照常校验。
 */
function outingAsFields(item: unknown): unknown {
  if (!item || typeof item !== "object" || (item as { action?: unknown }).action !== "update_requirements") return item;
  const patch = (item as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object" || !("outing" in patch)) return item;
  const { outing, ...rest } = patch as Record<string, unknown>;
  if (!outing || typeof outing !== "object") return item;
  const given = outing as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of ["dates", "startAt", "endAt", "dailyWindow"] as const) {
    if (key in given && !(key in rest)) fields[key] = given[key];
  }
  if (Array.isArray(given.transports) && !("addTransports" in rest)) {
    // 编号由服务端给，确认只能由用户做：这两项不带过去。
    fields.addTransports = given.transports.map((transport) => {
      if (!transport || typeof transport !== "object") return transport;
      const entry = { ...(transport as Record<string, unknown>) };
      delete entry.id;
      delete entry.overnightConfirmed;
      return entry;
    });
  }
  if (Array.isArray(given.lodging) && !("setLodging" in rest)) {
    fields.setLodging = given.lodging.flatMap((night) => {
      const value = night as { night?: unknown; place?: unknown; onBoard?: unknown } | null;
      return value && typeof value.night === "number" && !value.onBoard ? [{ nights: [value.night], place: value.place ?? null }] : [];
    });
  }
  return { ...item, patch: { ...rest, ...fields } };
}

/**
 * V2.11：只有一个候选的“让用户选”就是绑定这个候选（D07 连发 4 次 choose 一个候选，纠错额度用完）；
 * 一个候选都没有的“让用户选”（搜索什么都没找到时，K18）这一项不写。起点、终点和新增地点都这样处理；
 * 其余照常校验。
 */
function singleChoiceAsCandidate(item: unknown): unknown {
  if (!item || typeof item !== "object" || (item as { action?: unknown }).action !== "update_requirements") return item;
  const patch = (item as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object") return item;
  const EMPTY = Symbol("empty");
  const single = (place: unknown): unknown => {
    const choose = place && typeof place === "object" ? (place as { choose?: { candidates?: unknown } }).choose : undefined;
    if (!Array.isArray(choose?.candidates)) return place;
    if (choose.candidates.length === 0) return EMPTY;
    return choose.candidates.length === 1 ? { candidate: choose.candidates[0] } : place;
  };
  const value = { ...(patch as Record<string, unknown>) };
  if (Array.isArray(value.addVisits)) {
    value.addVisits = value.addVisits
      .map((visit) => (visit && typeof visit === "object" ? { ...visit, place: single((visit as { place?: unknown }).place) } : visit))
      .filter((visit) => !(visit && typeof visit === "object" && (visit as { place?: unknown }).place === EMPTY));
    if (!(value.addVisits as unknown[]).length) delete value.addVisits;
  }
  for (const key of ["start", "end"] as const) {
    if (!(key in value)) continue;
    const place = single(value[key]);
    if (place === EMPTY) delete value[key];
    else value[key] = place;
  }
  return { ...item, patch: value };
}

function replaceInterests(item: unknown, draft: RequirementsDraft): unknown {
  if (!item || typeof item !== "object" || (item as { action?: unknown }).action !== "update_requirements") return item;
  const patch = (item as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object" || !("interests" in patch)) return item;
  const { interests, ...rest } = patch as Record<string, unknown>;
  if (!Array.isArray(interests) || "addInterests" in rest || "removeInterests" in rest) return item;
  return {
    ...item,
    patch: {
      ...rest,
      ...(draft.interests.length ? { removeInterests: draft.interests.map((interest) => interest.id) } : {}),
      ...(interests.length ? { addInterests: interests } : {}),
    },
  };
}

/** V2.11：用户这句话里说了明确的时长（“4个小时”“半小时”“90分钟”“两个钟头”“玩半天”）。 */
const SAYS_DURATION = /([0-9]+(\.[0-9])?|[一二两三四五六七八九十半]+)\s*个?\s*(小时|钟头|分钟)|半天/;

/**
 * V2.11（stages/V2.11.md §3.2）：模型给的停留，用户这句话里说了时长就是用户说的，否则是估计（排不下时可以缩短）。
 * 由代码判断、不让模型标：常驻提示词里加一句停留说明就会牵动不相关的题（I20、E15）。模型自己标了的照它标的。
 */
function withStaySource(
  action: Extract<ChatAction, { action: "update_requirements" }>,
  userText: string,
): Extract<ChatAction, { action: "update_requirements" }> {
  const source = SAYS_DURATION.test(userText) ? "user" as const : "estimate" as const;
  const mark = <T extends { stayMinutes?: number | null; staySource?: "user" | "estimate" }>(item: T): T =>
    typeof item.stayMinutes === "number" && !item.staySource ? { ...item, staySource: source } : item;
  const { addVisits, updateVisits } = action.patch;
  if (!addVisits?.length && !updateVisits?.length) return action;
  return {
    ...action,
    patch: {
      ...action.patch,
      ...(addVisits ? { addVisits: addVisits.map(mark) } : {}),
      ...(updateVisits ? { updateVisits: updateVisits.map(mark) } : {}),
    },
  };
}

/** V2.10：备注里有手机号、证件号、邮箱或坐标时整条不写进卡片（备注是自由文字，不去猜哪段能留）。 */
function withoutPrivateNotes(
  action: Extract<ChatAction, { action: "update_requirements" }>,
): Extract<ChatAction, { action: "update_requirements" }> {
  if (!action.patch.notes || !hasPrivateNumber(action.patch.notes)) return action;
  const patch: typeof action.patch = { ...action.patch };
  delete patch.notes;
  return { ...action, patch };
}

/**
 * V2.11：这一轮遇到了外地的地点或城市，名字对得上的兴趣也不写进卡片（Y10：“湖滨步行街散步”写成了兴趣，
 * 规划时会在本市找“湖滨”）。地点按名称前 4 个字，城市按去掉“市”的名字。
 */
function withoutOutsideInterests(
  action: Extract<ChatAction, { action: "update_requirements" }>,
  outside: readonly ChatOutside[],
): Extract<ChatAction, { action: "update_requirements" }> {
  const added = action.patch.addInterests;
  if (!added?.length || !outside.length) return action;
  const keys = outside.map((item) => (item.externalId ? item.name.slice(0, 4) : item.name.replace(/市$/, "")));
  const kept = added.filter((item) => !keys.some((key) => (typeof item === "string" ? item : item.text).includes(key)));
  if (kept.length === added.length) return action;
  const patch: typeof action.patch = { ...action.patch, addInterests: kept };
  if (!kept.length) delete patch.addInterests;
  return { ...action, patch };
}

/** V2.11：出游卡片的补丁错误，说清楚该怎么改（只给错误码时模型常重发同样的补丁）。 */
const OUTING_HINTS: Partial<Record<string, string>> = {
  day_only: "an outing card uses dates {from,to}, startAt / endAt and dailyWindow, not date / startsAt / endsAt",
  outing_only: "dates, lodging, transports and day numbers are for 出游 only; this is a 日常 card",
  mode_is_users: "only the user switches between 日常 and 出游, on the page",
  day_outside_dates: "a day number (or date) is outside the dates",
  transport_day_missing: "a transport needs \"date\" (YYYY-MM-DD, the day it runs) or \"day\"",
  night_outside_dates: "night n is the night after day n; the last day has no night",
  night_on_board: "that night is on an overnight train or flight; no lodging for it",
  fixed_needs_day: "a fixed visit on an outing needs its day",
  transport_time_order: "arriveAt is not after departAt; if it arrives the next day send arriveDay \"next\"",
};

/** V2.11：过夜交通只有用户能在卡片上确认，模型补丁里的确认去掉。 */
function withoutConfirmations(
  action: Extract<ChatAction, { action: "update_requirements" }>,
): Extract<ChatAction, { action: "update_requirements" }> {
  if (!action.patch.confirmOvernight) return action;
  const patch: typeof action.patch = { ...action.patch };
  delete patch.confirmOvernight;
  return { ...action, patch };
}

/** V2.10：卡片上不在主要城市的已绑定地点（换城市时提示用户要不要保留，不悄悄删）。 */
function elsewhereOf(draft: RequirementsDraft): { elsewhere?: string[] } {
  const city = draftCity(draft).adcode;
  const names = [draft.start, draft.end, ...draft.visits.map((visit) => visit.place)]
    .flatMap((place) => (place?.status === "bound" && place.city && place.city !== city ? [place.name] : []));
  return names.length ? { elsewhere: [...new Set(names)] } : {};
}

/** V2.9.1：知道用户这一天在哪一带：卡片有确定的起点或地点，或者有已保存的行程。 */
/** V2.10：定位过（或卡片起点已确定）才算知道用户从哪出发；缺省的杭州不算。 */
function knowsStart(draft: RequirementsDraft): boolean {
  return located(draft) || draft.start?.status === "bound";
}

/**
 * V2.11（D-072）：日常的城市已经确定（定位得到，或用户说了“我在成都”）。确定后外地的地点和城市不进卡片，
 * 引导到出游；没确定时（缺省杭州）用户点名外地，城市跟着换（V2.10 的规则，当作“我在那儿”）。
 */
function cityFixed(draft: RequirementsDraft): boolean {
  // 出游不限城市（一天里也可以跨城市），不引导、不换城市。
  if (draft.mode === "outing") return false;
  return located(draft) || draft.city?.source === "said";
}

/** 卡片城市是定位得到的（没写来源的按定位算，同 knowsStart）。 */
function located(draft: RequirementsDraft): boolean {
  return !!draft.city && (draft.city.source ?? "located") === "located";
}

/** V2.11：回复说外地的地点已经排上（代码挡住了，它不在卡片上）。 */
const CLAIMS_ARRANGED = /(已经|已|帮你|给你).{0,12}(加|排|安排)(上|进|好|到)|(加|排)(上|进)(了|去了)/;

function knowsWhere(draft: RequirementsDraft, trip: ChatTrip | undefined): boolean {
  return !!trip || draft.start?.status === "bound" || draft.visits.some((visit) => visit.place.status === "bound");
}

/**
 * V2.9.1：推荐卡片按回复文字里提到的先后排（文字说“安静书房和转角咖啡馆”、卡片却先列转角时，
 * 用户说“第二家”就对不上）。文字里没出现的排在后面，保持原顺序。
 */
export function inTextOrder<T extends { readonly name: string }>(text: string, places: readonly T[]): T[] {
  // 回复常把半角括号写成全角，或只写店名不写分店：“新白鹿餐厅（湖滨88店）”“新白鹿餐厅”。
  const plain = (value: string) => value.replace(/（/g, "(").replace(/）/g, ")");
  const said = plain(text);
  const at = (place: T) => {
    const name = plain(place.name);
    const index = [name, name.split("(")[0]].map((key) => (key ? said.indexOf(key) : -1)).find((found) => found >= 0) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return places.map((place, index) => ({ place, index })).sort((a, b) => at(a.place) - at(b.place) || a.index - b.index).map(({ place }) => place);
}

export function replyHistoryText(text: string, places?: readonly { readonly name: string }[]): string {
  return places?.length ? `${text}\n（推荐了：${places.map((place) => place.name).join("、")}）` : text;
}

/**
 * 把持久化草稿投影成模型所需的名称、角色、时段和待选序号。
 * 供应商 ID 留在服务端；模型用临时候选或用户选择序号更新卡片，不能直接拼外部地点编号。
 */
export function describeDraft(draft: RequirementsDraft) {
  const place = (value: RequirementsDraft["start"]) =>
    value === null ? null
      : value.status === "current" ? { currentLocation: "waiting for the user to allow location on the card" }
        : value.status === "bound" ? { name: value.name, ...(value.nearby ? { nearUserLocation: true } : {}) }
        : {
            waitingForUserChoice: value.mention,
            options: value.choices.map((choice, index) => ({ option: index + 1, name: choice.name })),
          };
  const waiting = (value: ReturnType<typeof place>, target: string) =>
    value && "waitingForUserChoice" in value ? { ...value, chooseTarget: target } : value;
  return {
    date: draft.date,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    start: place(draft.start),
    end: place(draft.end),
    visits: draft.visits.map((visit) => ({
      key: visit.key,
      place: place(visit.place),
      role: visit.role,
      stayMinutes: visit.stayMinutes,
      startsAt: visit.startsAt,
      endsAt: visit.endsAt,
      ...(visit.day ? { day: visit.day } : {}),
    })),
    interests: draft.interests,
    pace: draft.pace,
    notes: draft.notes,
    travel: draft.travel ?? null,
    // V2.4：short 按兴趣逐站选择；字段缺省时保持兼容，按一日规划理解。
    mode: draft.mode ?? "day",
    // V2.11：出游的日期、住处和交通；日常卡片没有这一项（上下文和以前一样）。
    ...(draft.mode === "outing" && draft.outing ? {
      outing: {
        dates: draft.outing.dates,
        // 第几天对应哪一天（“30 号的高铁”是第几天，模型自己换算曾差一天）。
        ...(draft.outing.dates ? { days: outingDayDates(draft.outing.dates) } : {}),
        startAt: draft.outing.startAt,
        endAt: draft.outing.endAt,
        dailyWindow: draft.outing.dailyWindow,
        // 等用户选的住处和车站带上 choose 的写法（验收复测：模型写成 lodging1，改不过来）。
        lodging: draft.outing.lodging.map((night) => ({
          night: night.night,
          ...(night.onBoard ? { onBoard: true } : { place: night.place && waiting(place(night.place), `n${night.night}`) }),
        })),
        transports: draft.outing.transports.map((item) => ({
          id: item.id, day: item.day, ...(draft.outing!.dates ? { date: outingDayDates(draft.outing!.dates)[item.day - 1]?.date } : {}),
          mode: item.mode, from: item.from && waiting(place(item.from), `${item.id}:from`), to: item.to && waiting(place(item.to), `${item.id}:to`),
          departAt: item.departAt, arriveAt: item.arriveAt, arriveDay: item.arriveDay, ...(item.overnightConfirmed ? { overnightConfirmed: true } : {}),
        })),
      },
    } : {}),
  };
}

/** 能让用户选的位置和它在 choose 里的写法：起点、终点、地点，出游的第几晚住处（n1）和交通的起止站（t1:from）。 */
function choosable(draft: RequirementsDraft): (readonly [string, RequirementsDraft["start"] | undefined])[] {
  return [
    ["start", draft.start],
    ["end", draft.end],
    ...draft.visits.map((visit) => [visit.key, visit.place] as const),
    ...(draft.outing?.lodging ?? []).map((night) => [`n${night.night}`, night.place] as const),
    ...(draft.outing?.transports ?? []).flatMap((item) => [[`${item.id}:from`, item.from] as const, [`${item.id}:to`, item.to] as const]),
  ];
}

/** V2.11：出游每一天的日期（第 1 天是 dates.from）。 */
function outingDayDates(dates: { from: string; to: string }): { day: number; date: string }[] {
  const count = Math.round((Date.parse(dates.to) - Date.parse(dates.from)) / 86_400_000) + 1;
  return Array.from({ length: Math.max(0, Math.min(count, 7)) }, (_, index) => ({
    day: index + 1,
    date: new Date(Date.parse(dates.from) + index * 86_400_000).toISOString().slice(0, 10),
  }));
}

/**
 * V3.4：一轮里几个专门 Agent 共用的东西：分流结果（split 时先分好）、第一个说过的话、各工具的次数（按轮算）、
 * 还剩的模型请求、整轮的截止时刻、已经跑过谁、交接用过没有。
 */
interface TurnShared {
  readonly route?: IntentRoute;
  readonly said?: { readonly text: string; readonly asked: boolean };
  /** 第一个专门 Agent 知道后面那个做什么。 */
  readonly next?: string;
  readonly counts: ChatCounts;
  readonly modelLeft: number;
  readonly deadline: number;
  readonly ran: readonly ChatAgentId[];
  readonly handoffUsed: boolean;
}

/** 一个专门 Agent 跑完：照常的结果，或者把这一轮交给了另一个（这时没有回复）。 */
type AgentTurnResult = ChatTurnResult | {
  readonly status: "handoff";
  readonly to: ChatSpecialistId;
  readonly reason: string;
  readonly back: boolean;
  readonly counts: ChatCounts;
  readonly usage: ChatUsage | null;
  readonly trace: ChatTrace;
};

/**
 * 一轮对话只整理需求、查资料或产出调整请求；正式行程仍由应用层的确认链路写入。
 * 图在 decide → act 之间循环，工具观察和校验反馈会进入下一次决策，直到回复或预算耗尽。
 * V3.4：按专门 Agent 跑（提示词、可用动作、管哪些分流判断）；校验、打回、观察、卡片补丁的代码各 Agent 共用。
 */
async function runTurn(
  input: ChatTurnInput,
  options: ChatRunOptions,
  dependencies: ChatRunnerDependencies,
  limits: ChatLimits,
  agent: ChatAgentSpec,
  turn: TurnShared,
): Promise<AgentTurnResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(cancel, Math.max(0, turn.deadline - Date.now()));
  const searchLimit = input.draft.mode === "outing" ? limits.outingSearches : limits.searches;

  // 工具次数按轮算（几个专门 Agent 共用）；模型请求和纠错次数按 Agent 算，从这个 Agent 开始时的数起。
  const counts = turn.counts;
  const modelStart = counts.model;
  const repairStart = counts.repairs;
  const modelLimit = Math.min(limits.model, turn.modelLeft);
  const repairsUsed = () => counts.repairs - repairStart;
  const can = (action: ChatAction["action"]) => agent.actions.includes(action);
  /** 本轮检索的引用表和已发送的检索词。网页用 w 编号、资料段落用 k 编号，均不跨轮复用。 */
  const webResults = new Map<string, ChatSource>();
  const webQueries = new Set<string>();
  const passages = new Map<string, ChatSource>();
  // V2.9：每轮先分流，再决定提供哪些规则块和工具（取代 V2.7/V2.8 的“是提问就同时提供”）。
  // 分流失败或超时时用正则；普通规划消息不加任何规则块，提示词与之前逐字相同。
  const route = turn.route ?? await routeOnce(input, options, dependencies, controller.signal);
  /** 用户这句话的全部判断；flags 是这个 Agent 管的那部分（single 管全部）。 */
  const heard = route.flags;
  const flags = agentFlags(agent, heard);
  // 用户这句话含住处或号码时不提议偏好（“住在 XX 附近，别排太远”去掉住处后仍是在记住处）。
  // 规则块照常给（里面有“不要说已经记住”）；模型提议时作为观察结果拒绝，不消耗纠错额度。
  const privateMessage = preferenceProblem(input.userText) === "private";
  const offered = agent.offers(flags);
  const webOffered = !!dependencies.web && offered.web;
  const knowledgeOffered = !!dependencies.knowledge && offered.knowledge;
  /** 只是闲聊：没要求规划、调整、偏好或提问。 */
  const onlySmallTalk = onlyChatting(flags);
  // V2.9.1：闲聊规则（不调工具、不改卡片）只给纯闲聊；“谢谢，明天想去…”“好累，下午少安排点”
  // 同时有闲聊词和请求，按请求处理（混合时加了这条规则，等于告诉模型别做用户要的事）。
  // V2.9.1：上一条回复推荐过地点时（“就去第二家”），这一轮也给建议规则，里面写了怎么把推荐的加进卡片。
  const lastReply = [...input.history].reverse().find((message) => message.role === "assistant" && !message.text.startsWith("（"))?.text ?? "";
  const recommendedBefore = lastReply.includes("\n（推荐了：");
  // V3.4：“就去第二家”的加法写在建议规则里，给能改卡片的那个（split 时是需求理解）。
  const intent = [
    ...(flags.advice || (recommendedBefore && can("update_requirements")) ? ["advice" as const] : []),
    ...(onlySmallTalk ? ["chitchat" as const] : []),
    ...(flags.preference ? ["preference" as const] : []),
  ];
  /** V2.9：本轮提议记住的偏好（每轮最多一条）。 */
  let proposal: { text: string; category: "food" | "pace" | "travel" | "interest" | "other" } | undefined;
  /** 出处缺失或正文带链接的提示最多反馈一次，避免回复检查陷入循环；引用 ID 的合法性仍逐次检查。 */
  let sourcesChecked = false;
  let usage: ChatUsage | null = null;
  const startedAt = performance.now();
  /** V2.9 决策记录：模型每次的决定（原样）。 */
  const decisions: unknown[] = [];
  let draft = input.draft;
  let draftChanged = false;
  /** V2.10：这一轮用户明说了城市（set_city）；之后卡片地点的多数城市不再覆盖它。 */
  let citySaid = false;
  /** V2.11：这一轮遇到的外地地点或城市，页面据此显示“切到出游”的提示条。 */
  const outside: ChatOutside[] = [];
  let outsideChecked = false;
  const observations: ChatObservation[] = [];
  // c / w / k 都是本轮的临时引用。模型选择引用，服务端再映射回真实地点或出处；
  // 不接受模型自造的供应商 ID，也不把上一轮的检索结果当成本轮已经核实的事实。
  const candidates = new Map<string, ChatCandidate>();
  const searchedMentions = new Set<string>();
  let feedback: ChatDecisionContext["feedback"] = null;
  let pending: unknown;
  let reply: { text: string; asking: boolean; sources?: readonly ChatSource[]; places?: readonly ChatPlace[] } | undefined;
  let adjust: AdjustTripRequest | undefined;
  let outingChange: OutingChangeRequest | undefined;
  let outingRefused: "fixed" | "done" | undefined;
  /** V3.4：交给了谁（交接时这个 Agent 不回复）；第二个 Agent 又问了问题、回复太长时各打回一次。 */
  let handoff: { to: ChatSpecialistId; reason: string; back: boolean } | undefined;
  let saidAskChecked = false;
  let nextChecked = false;
  let saidLengthChecked = false;

  const active = () => {
    if (controller.signal.aborted) throw new ChatRunError("timeout");
  };
  const addUsage = (reported: z.infer<typeof usageSchema>) => {
    if (!reported) return;
    // 缓存命中与未命中只在 DeepSeek 返回时累加；一直没返回就保持 null，不当作 0。
    const add = (sum: number | null | undefined, value: number | null) => (value === null ? sum ?? null : (sum ?? 0) + value);
    usage = {
      inputTokens: (usage?.inputTokens ?? 0) + reported.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + reported.outputTokens,
      totalTokens: (usage?.totalTokens ?? 0) + reported.totalTokens,
      cacheHitTokens: add(usage?.cacheHitTokens, reported.cacheHitTokens),
      cacheMissTokens: add(usage?.cacheMissTokens, reported.cacheMissTokens),
    };
  };
  // 只裁剪文本历史；当前草稿和已保存行程单独注入，不依赖“最近几句”来保存硬约束。
  // 本轮用户消息占一个名额，避免窗口截断时恰好把正在处理的指令挤掉。
  const conversation = [
    ...input.history.slice(-(limits.historyMessages - 1)),
    { role: "user" as const, text: input.userText },
  ];
  const context = (): ChatDecisionContext => ({
    protocolVersion: "chat-turn.v1",
    now: chinaNow(input.nowMs),
    draft: describeDraft(draft),
    missing: draftMissing(draft),
    city: {
      name: draftCity(draft).name,
      location: knowsStart(draft) ? "known" : "unknown",
    },
    ...(input.trip ? { trip: input.trip } : {}),
    conversation,
    observations,
    feedback,
    remaining: {
      model: modelLimit - (counts.model - modelStart),
      searches: searchLimit - counts.searches,
      weather: limits.weather - counts.weather,
      ...(webOffered ? { webSearches: limits.webSearches - counts.webSearches } : {}),
      ...(knowledgeOffered ? { knowledge: limits.knowledge - counts.knowledge } : {}),
    },
    ...(intent.length ? { intent } : {}),
    ...(input.preferences?.length
      ? { preferences: input.preferences.slice(0, 30).map((item, index) => `p${index + 1}: ${item.text}（${item.category}）`) }
      : {}),
    ...(input.summary ? { earlier: input.summary.slice(0, 300) } : {}),
    ...(turn.said ? { said: turn.said } : {}),
    ...(turn.next ? { next: turn.next } : {}),
  });

  /** 保存给模型的错误提示码，便于本机诊断；纠错次数有上限，不能反复试错到预算失控。 */
  const hints: string[] = [];
  /** V2.3：回复前检查兴趣时段与整天时间窗是否冲突；同一轮只提示一次。 */
  let windowChecked = false;
  /** V2.5：一日卡片缺少可补的日期或时间时先提示模型；短途默认值走另一套规则。 */
  let dayChecked = false;
  /** V2.9：建议的“先查、只说查到的地点”只提醒一次。 */
  let adviceSearchChecked = false;
  let advicePlacesChecked = false;
  let nearbyChecked = false;
  let startChecked = false;
  let removalChecked = false;
  /** V2.9：用户点“记住”之前什么都没保存；回复说“记住了”先提醒一次。 */
  let memoryChecks = 0;
  // 批次不是数据库事务：前面已经执行的工具或补丁不会因后面的错误回滚。
  // index 写进反馈，提示模型从失败位置继续，避免重发已执行动作造成重复修改。
  const repair = (code: string, index: number) => {
    hints.push(code);
    if (repairsUsed() >= limits.repairs) throw new ChatRunError("invalid_output");
    counts.repairs += 1;
    feedback = { code: index > 0 ? `${code} (action ${index + 1}; earlier ones ran)` : code };
  };

  // Schema 只保证动作形状；这里检查本轮是否有权执行、预算是否足够、引用是否存在。
  // 失败提示交回模型修正，但执行权始终在代码中，不能靠提示词约定这些边界。
  const guard = (next: ChatAction): string | null => {
    switch (next.action) {
      case "search_place":
        if (counts.searches >= searchLimit) return "search_budget_exhausted";
        // V2.9：重复搜同一个词不再打回（模型反复重搜曾把一轮拖到纠错额度用完），在 execute 里
        // 作为观察结果说明“已经搜过”，不消耗纠错额度，也不再请求高德。
        return null;
      case "get_weather":
        return counts.weather >= limits.weather ? "weather_already_checked" : null;
      case "set_city":
        return citySaid ? "city_already_set: one city per turn" : null;
      case "update_requirements": {
        // “多点选择”要求增加可选项，不等于多去几个地点，不能通过增加 count 来误改行程容量。
        if (asksForOptions(input.userText) && raisesCount(next.patch)) {
          return `count_is_stops: the user wants more places to choose from, not more stops; keep count 1 and use mode "short" (each step offers a few places) for today`;
        }
        // 先在副本上试应用补丁，检查候选绑定、数量和时段；真正接受后才在 execute 更新本轮草稿。
        const result = applyDraftPatch(draft, next.patch, candidates, { nowMs: input.nowMs });
        // V2.5：逐站挑选只用于今天出发；未来日期仍走一日规划，避免错误套用“现在”的默认值。
        const today = chinaNow(input.nowMs).date;
        if (result.status === "ok" && result.draft.mode === "short" && result.draft.date && result.draft.date !== today) {
          return `short_is_today: mode "short" is for today (${today}) only; for ${result.draft.date} make a day plan (mode "day")`;
        }
        if (result.status === "ok") return null;
        if (OUTING_HINTS[result.code]) return `${result.code}: ${OUTING_HINTS[result.code]}`;
        if (result.code !== "unknown_choice") return result.code;
        // 错误反馈列出正在等待选择的字段和有效序号，给模型可执行的修正范围（V2.11：含出游的住处 n1 和交通的起止站 t1:from）。
        const waiting = choosable(draft)
          .flatMap(([target, place]) => (place?.status === "choose" ? [`${target} (options 1-${place.choices.length})`] : []));
        return `unknown_choice; sent ${JSON.stringify(next.patch.choose ?? [])}; waiting: ${waiting.join(", ") || "none"}`;
      }
      case "change_outing":
        return outingChangeProblem(next.request, input.trip?.outing);
      case "adjust_trip":
        // V2.11：同一轮重发调整（回复等工具结果被压住后，模型常把调整连同新回复一起重发）用最新的那份，不打回；
        // 这时还没生成方案，也没写入任何东西（A14 曾因每次重发都被打回而整轮失败）。
        return adjustProblem(normalizeAdjust(next.request), input.trip, chinaNow(input.nowMs));
      case "web_search":
        if (!webOffered) return "web_search_unavailable: answer without it, or say you cannot look it up";
        if (counts.webSearches >= limits.webSearches) return "web_search_budget_exhausted: answer from the results you have";
        if (webQueries.has(next.query)) return "duplicate_web_search";
        if (WHERE_USER_IS.test(next.query) || nearbyNames(draft).some((name) => next.query.includes(name))) {
          return "query_has_user_location: search the place or topic only, never where the user is or lives";
        }
        return null;
      case "propose_preference": {
        if (!flags.preference && !privateMessage) return "propose_preference_unavailable: only when the user states a lasting preference";
        if (proposal) return "preference_already_proposed: one proposal per turn";
        // 内容不合规或已保存过时不打回（模型换着说法反复提议会耗光纠错额度），而是作为观察结果
        // 告诉它“这条不提议”，见 execute。
        return null;
      }
      case "ask_knowledge":
        if (!knowledgeOffered) return "ask_knowledge_unavailable: answer without it, or say you cannot look it up";
        if (counts.knowledge >= limits.knowledge) return "ask_knowledge_budget_exhausted: answer from the passages you have";
        if (WHERE_USER_IS.test(next.question) || nearbyNames(draft).some((name) => next.question.includes(name))) {
          return "question_has_user_location: ask about the place or topic only, never where the user is or lives";
        }
        return null;
      case "handoff":
        return null;
      case "reply": {
        const strangers = (next.places ?? []).filter((id) => !candidates.has(id));
        if (strangers.length) return `unknown_place_id: ${strangers.join(", ")}; recommend ids of this turn's search results only`;
        const unknown = (next.sources ?? []).filter((id) => !webResults.has(id) && !passages.has(id));
        if (unknown.length) return `unknown_source: ${unknown.join(", ")}; cite ids of this turn's results only`;
        // 一次回答通常只用一类证据来源，避免知识段落与时效网页混用时出处归属不清。V2.9：一句话里
        // 既问背景又问时效（“灵隐寺是谁建的？要预约吗”）、两类都查了时可以同时引用（真实测试里
        // 这条规则把这类问题逼到纠错额度用完而失败）。这里只检查 ID 与来源类别，不验证每句话。
        const kinds = new Set((next.sources ?? []).map((id) => id[0]));
        const askedBoth = flags.ask_knowledge && flags.ask_timely && passages.size > 0 && webResults.size > 0;
        if (kinds.size > 1 && !askedBoth) return "mixed_sources: cite either knowledge passages (k…) or web results (w…), not both";
        return null;
      }
    }
  };

  const report = (progress: ChatProgress) => {
    try {
      options.onProgress?.(progress);
    } catch {
      // 进度通知只用于界面展示，监听器出错不能改变本轮的业务结果。
    }
  };

  /** 查卡片当前城市的天气，观察里写明城市（V2.10）。 */
  const checkWeather = async (date: string) => {
    const city = draftCity(draft);
    const reply = await bounded(controller.signal, limits.providerMs, (signal) =>
      dependencies.weather.getWeatherForecast(city.adcode, { signal })).catch((error) => {
      if (error instanceof ChatRunError && controller.signal.aborted) throw error;
      return null;
    });
    if (!reply || reply.status !== "ok") {
      observations.push({
        tool: "get_weather",
        date,
        city: city.name,
        forecast: null,
        availableDates: [],
        failure: reply?.status === "failure" ? reply.failure.code : "unavailable",
      });
      return;
    }
    // 预报未覆盖指定日期时保留 null，并告诉模型实际可查日期；不能拿今天的天气代替未来某天。
    const day = reply.data.days.find((item) => item.date === date) ?? null;
    observations.push({
      tool: "get_weather",
      date,
      city: city.name,
      forecast: day && {
        dayWeather: day.dayWeather,
        nightWeather: day.nightWeather,
        highCelsius: day.highCelsius,
        lowCelsius: day.lowCelsius,
        wet: day.wet,
      },
      availableDates: reply.data.days.map((item) => item.date),
    });
  };
  /**
   * V2.10：这一轮先查了天气、后来卡片城市才变（先搜地点和天气，绑定后城市跟着地点走）时，按新城市再查一次
   * 同一天；不然回复会拿杭州的“小雨”说黄山（真实验证）。不占模型的天气次数。
   */
  let weatherRefreshes = 0;
  const refreshWeather = async () => {
    const name = draftCity(draft).name;
    const dates = new Set(observations.flatMap((item) => (item.tool === "get_weather" && item.city !== name ? [item.date] : [])));
    for (const date of dates) await checkWeather(date);
    weatherRefreshes += dates.size;
  };

  /** V2.11：外地城市的名称（查不到就说“外地”，不让编码出现在回复里）。 */
  const nameOfCity = async (adcode: string) => {
    if (!dependencies.cities) return "外地";
    const found = await bounded(controller.signal, limits.providerMs, (signal) =>
      dependencies.cities!.resolveCity(adcode, { signal })).catch(() => null);
    return found?.status === "ok" ? found.data.name : "外地";
  };
  /** V2.11：外地的地点或城市不进卡片，记下来给页面，并告诉模型。 */
  const otherCity = async (found: readonly { readonly externalId?: string; readonly name: string; readonly city: string }[]) => {
    const entries: ChatOutside[] = [];
    for (const item of found) {
      const cityName = entries.find((entry) => entry.city === item.city)?.cityName ?? await nameOfCity(item.city);
      entries.push({ ...(item.externalId ? { externalId: item.externalId } : {}), name: item.name.slice(0, 80), city: item.city, cityName });
    }
    for (const entry of entries) {
      if (!outside.some((known) => known.name === entry.name) && outside.length < 6) outside.push(entry);
    }
    observations.push({
      tool: "other_city",
      dailyCity: draftCity(draft).name,
      places: entries.map((entry) => ({ name: entry.name, city: entry.cityName })),
      note: `Not on the card: daily planning keeps to ${draftCity(draft).name}. Say so, and that trips elsewhere go in 出游 (the switch above the card); never say it is added, and do not add it as an interest.`,
    });
  };

  /**
   * 用户说了一个城市（set_city，或被当成地点去搜的城市名）。V2.11：定位过、又不是所在城市：日常不换城市，
   * 引导到出游（D-072）；没定位时当作“我在那儿”，照旧换（V2.10）。
   */
  const cityNamed = async (city: { readonly adcode: string; readonly name: string }) => {
    citySaid = true;
    // V2.11 出游：城市只决定没说城市时在哪找，不引导到别处，也不问原来的地点要不要保留。
    if (draft.mode === "outing") {
      if (city.adcode !== draftCity(draft).adcode) {
        draft = { ...draft, city: { adcode: city.adcode, name: city.name, source: "said" } };
        draftChanged = true;
      }
      observations.push({ tool: "set_city", city: city.name });
      return;
    }
    if (located(draft) && city.adcode !== draftCity(draft).adcode) {
      await otherCity([{ name: city.name, city: city.adcode }]);
      return;
    }
    if (city.adcode !== draftCity(draft).adcode || draft.city?.source !== "said") {
      draft = { ...draft, city: { adcode: city.adcode, name: city.name, source: "said" } };
      draftChanged = true;
    }
    observations.push({ tool: "set_city", city: city.name, ...elsewhereOf(draft) });
    await refreshWeather();
  };

  /** V2.11 出游：兴趣里的城市名（“在云岭吃海鲜”）换成城市；查不到就不限城市。 */
  const withInterestCities = async (patch: Extract<ChatAction, { action: "update_requirements" }>["patch"]) => {
    if (!patch.addInterests?.some((item) => typeof item !== "string" && item.cityName)) return patch;
    const addInterests = await Promise.all(patch.addInterests.map(async (item) => {
      if (typeof item === "string" || !item.cityName) return item;
      const { cityName, ...rest } = item;
      const found = dependencies.cities
        ? await bounded(controller.signal, limits.providerMs, (signal) => dependencies.cities!.resolveCity(cityName, { signal })).catch(() => null)
        : null;
      return found?.status === "ok" ? { ...rest, city: { adcode: found.data.adcode, name: found.data.name } } : rest;
    }));
    return { ...patch, addInterests };
  };

  const execute = async (next: ChatAction) => {
    switch (next.action) {
      case "search_place": {
        // V2.11：出游里同一个词可以在不同城市各搜一次（杭州的“高铁站”和云岭的“高铁站”）。
        const searchKey = next.city ? `${next.mention}@${next.city}` : next.mention;
        if (searchedMentions.has(searchKey)) {
          observations.push({
            tool: "search_place",
            mention: next.mention,
            purpose: next.purpose,
            candidates: [],
            failure: "already_searched: see the earlier result; try another kind of place or say nothing fits",
          });
          return;
        }
        // 请求前先消耗次数并标记已查；失败也是一次调查，不能靠重复同词绕过预算。
        counts.searches += 1;
        searchedMentions.add(searchKey);
        // V2.11 出游：搜的是一个城市（“从杭州坐高铁去云岭”搜了“云岭”）就不给候选，按名字模糊命中的地点会被当成车站
        // 绑上（O06 三次都绑成第一个结果）；告诉模型去搜那个城市的车站或机场。
        if (draft.mode === "outing" && dependencies.cities) {
          const city = await bounded(controller.signal, limits.providerMs, (signal) =>
            dependencies.cities!.resolveCity(next.mention, { signal })).catch(() => null);
          if (city?.status === "ok") {
            observations.push({
              tool: "search_place",
              mention: next.mention,
              purpose: next.purpose,
              candidates: [],
              failure: `is_a_city: ${city.data.name} is a city; for its station or airport search "高铁站" (high-speed train), "火车站" or "机场" with "city":"${city.data.name}"`,
            });
            return;
          }
        }
        report({ tool: "search_place", subject: next.mention });
        // V2.10：先在卡片的城市里找；找不到再全国找（用户点名的地点可能在别的城市，如乌镇、云岭山）。
        // V2.11 出游：模型说了城市（车站、机场、住处常在别的城市）就先在那个城市里找。
        const askedCity = draft.mode === "outing" && next.city && dependencies.cities
          ? await bounded(controller.signal, limits.providerMs, (signal) => dependencies.cities!.resolveCity(next.city!, { signal })).catch(() => null)
          : null;
        const cityAdcode = askedCity?.status === "ok" ? askedCity.data.adcode : draftCity(draft).adcode;
        const search = (scope: PlaceSearchRequest["scope"]) => bounded(controller.signal, limits.providerMs, (signal) =>
          dependencies.places.searchPlaces({ query: next.mention, scope, limit: 5 }, { signal })).catch((error) => {
          if (error instanceof ChatRunError && controller.signal.aborted) throw error;
          return null;
        });
        // 城市里的结果只是模糊命中（搜“岚溪花海”按“海”字命中本市海滩、搜“乌镇”命中名字带乌镇的饭馆）也要
        // 再全国找：外地名字对得上的排在前面，标 otherCity 由模型按名字取舍（V2.10 城市理解 Y04、Y05、Y12）。
        const inCity = await search({ kind: "city", cityAdcode });
        let reply = inCity;
        if (inCity?.status === "ok" && !inCity.data.items.some((place) => namedAs(place.name, next.mention))) {
          const country = await search({ kind: "country" });
          const named = country?.status === "ok"
            ? country.data.items.filter((place) => namedAs(place.name, next.mention) &&
              !inCity.data.items.some((item) => item.ref.externalId === place.ref.externalId)).slice(0, 2)
            : [];
          // V2.11：日常的城市确定后，名字只在外地对得上：不给模型编号（城市里模糊命中的也不给，免得绑错），
          // 告诉它在外地、页面引导到出游（D-072，日常跨城市 D01、Y04）。
          const fixed = cityFixed(draft);
          const away = fixed ? named.filter((place) => !!place.cityAdcode && place.cityAdcode !== cityAdcode) : [];
          const usable = named.filter((place) => !away.includes(place));
          if (away.length && !usable.length) {
            observations.push({ tool: "search_place", mention: next.mention, purpose: next.purpose, candidates: [] });
            await otherCity(away.map((place) => ({ externalId: place.ref.externalId, name: place.name, city: place.cityAdcode! })));
            return;
          }
          // 城市里只有模糊命中时，全国名字对得上的排在前面；城市确定后不给外地的结果。
          reply = !inCity.data.items.length
            ? fixed ? inCity : country
            : { ...inCity, data: { ...inCity.data, items: [...usable, ...inCity.data.items.slice(0, 5 - usable.length)] } };
        }
        if (!reply || reply.status !== "ok") {
          observations.push({
            tool: "search_place",
            mention: next.mention,
            purpose: next.purpose,
            candidates: [],
            failure: reply?.status === "failure" ? reply.failure.code : "unavailable",
          });
          if (reply?.status === "failure" && reply.failure.code === "quota_exceeded") throw new ChatRunError("live_budget");
          return;
        }
        // V2.11：什么都没找到，而搜的其实是一个城市（D02 把“岚溪市”当地点搜）：按说了这个城市处理。
        if (!reply.data.items.length && !citySaid && dependencies.cities) {
          const city = await bounded(controller.signal, limits.providerMs, (signal) =>
            dependencies.cities!.resolveCity(next.mention, { signal })).catch(() => null);
          if (city?.status === "ok" && city.data.adcode !== draftCity(draft).adcode) {
            observations.push({ tool: "search_place", mention: next.mention, purpose: next.purpose, candidates: [] });
            await cityNamed(city.data);
            return;
          }
        }
        // 向模型只展示有限候选；c 编号在整个本轮递增，后续补丁再映射回真实 ID 与名称。
        // 地址用于区分同名地点，写入需求卡片时会被应用层剔除。
        // V2.11 出游：没说城市时，这趟出游涉及的其他城市里名字对得上的也给出来，标上城市（“去上海玩……外滩”
        // 只在杭州找时绑成了杭州的外滩）。由模型按用户说的城市挑。
        const cityNames = new Map<string, string>([[draftCity(draft).adcode, draftCity(draft).name]]);
        let items = reply.data.items;
        if (draft.mode === "outing" && !next.city && dependencies.cities) {
          // 全国找一次（模型常在把交通写上卡片之前就先查地点），再加上卡片上已有的其他城市。
          const extra: (typeof items)[number][] = [];
          const add = (found: readonly (typeof items)[number][]) => {
            for (const place of found.filter((item) => namedAs(item.name, next.mention)).slice(0, 2)) {
              if (place.cityAdcode !== cityAdcode && ![...items, ...extra].some((item) => item.ref.externalId === place.ref.externalId)) extra.push(place);
            }
          };
          const country = await search({ kind: "country" });
          if (country?.status === "ok") add(country.data.items);
          for (const adcode of outingCities(draft).filter((code) => code !== cityAdcode).slice(0, 3)) {
            const there = await search({ kind: "city", cityAdcode: adcode });
            if (there?.status === "ok") add(there.data.items);
          }
          for (const adcode of new Set(extra.flatMap((place) => (place.cityAdcode ? [place.cityAdcode] : [])))) {
            const city = await bounded(controller.signal, limits.providerMs, (signal) => dependencies.cities!.resolveCity(adcode, { signal })).catch(() => null);
            if (city?.status === "ok") cityNames.set(adcode, city.data.name);
          }
          if (extra.length) {
            const here = items.filter((place) => namedAs(place.name, next.mention));
            items = [...here.slice(0, 2), ...extra, ...items.filter((place) => !here.slice(0, 2).includes(place))].slice(0, 6);
          }
        }
        const labeled = new Set(items.map((place) => place.cityAdcode)).size > 1;
        const found = items.slice(0, 6).map((place): ChatCandidate => {
          const id = `c${candidates.size + 1}`;
          const candidate = {
            id,
            externalId: place.ref.externalId,
            name: place.name.slice(0, 80),
            ...(place.address ? { address: place.address.slice(0, 60) } : {}),
            ...(place.cityAdcode ? { cityAdcode: place.cityAdcode } : {}),
            ...(place.cityAdcode && place.cityAdcode !== cityAdcode ? { otherCity: true as const } : {}),
            ...(labeled && place.cityAdcode && cityNames.has(place.cityAdcode) ? { cityName: cityNames.get(place.cityAdcode)! } : {}),
          };
          candidates.set(id, candidate);
          return candidate;
        });
        observations.push({ tool: "search_place", mention: next.mention, purpose: next.purpose, candidates: found });
        return;
      }
      case "get_weather": {
        counts.weather += 1;
        report({ tool: "get_weather", subject: next.date });
        await checkWeather(next.date);
        return;
      }
      case "update_requirements": {
        const result = applyDraftPatch(draft, await withInterestCities(next.patch), candidates, { nowMs: input.nowMs });
        if (result.status !== "ok") throw new ChatRunError("internal_error");
        draft = result.draft;
        draftChanged ||= result.changed;
        observations.push({ tool: "update_requirements", changed: result.changed });
        // V2.10：卡片上的地点大多在别的城市时，主要城市跟着地点走（用户这一轮明说了城市就不改）。
        // V2.11：只在日常的城市还没确定时（缺省杭州）；确定后外地的地点进不了卡片。
        const placesCity = citySaid || cityFixed(draft) || draft.mode === "outing" ? null : cityFromPlaces(draft);
        if (placesCity && placesCity !== draftCity(draft).adcode && dependencies.cities) {
          const named = await bounded(controller.signal, limits.providerMs, (signal) =>
            dependencies.cities!.resolveCity(placesCity, { signal })).catch(() => null);
          if (named?.status === "ok") {
            draft = { ...draft, city: { adcode: named.data.adcode, name: named.data.name, source: "places" } };
            observations.push({ tool: "city_changed", city: named.data.name, ...elsewhereOf(draft) });
            await refreshWeather();
          }
        }
        return;
      }
      case "set_city": {
        if (!dependencies.cities) {
          observations.push({ tool: "set_city", city: null, failure: "unavailable" });
          return;
        }
        const reply = await bounded(controller.signal, limits.providerMs, (signal) =>
          dependencies.cities!.resolveCity(next.city, { signal })).catch(() => null);
        if (reply?.status !== "ok") {
          observations.push({ tool: "set_city", city: null, failure: reply?.status === "failure" ? `not_a_city: ${next.city}` : "unavailable" });
          return;
        }
        await cityNamed(reply.data);
        return;
      }
      case "adjust_trip":
        adjust = normalizeAdjust(next.request);
        return;
      case "handoff":
        return;
      case "change_outing": {
        // 固定事项、已去过的站由代码挡下，让模型先看到原因再回复（不能说已经挪了）。
        const refused = outingRefusal(next.request, input.trip!.outing!);
        if (refused) {
          outingRefused = refused.refused;
          observations.push({ tool: "change_outing", ...refused });
          return;
        }
        outingChange = next.request;
        return;
      }
      case "web_search": {
        counts.webSearches += 1;
        webQueries.add(next.query);
        report({ tool: "web_search", subject: next.query });
        const web = dependencies.web!;
        const found = await bounded(controller.signal, limits.providerMs, (signal) =>
          web.searchWeb({ query: next.query, ...(next.question ? { question: next.question } : {}), count: 5 }, { signal }))
          .catch((error) => {
            if (error instanceof ChatRunError && controller.signal.aborted) throw error;
            return null;
          });
        if (!found || found.status !== "ok") {
          observations.push({
            tool: "web_search",
            query: next.query,
            results: [],
            failure: found?.status === "failure" ? found.failure.code : "unavailable",
          });
          return;
        }
        // 模型看到摘要与临时编号，最终回复再由服务端从表里提取 URL 等出处元信息。
        // 摘要只作为本轮观察使用，不写入聊天记录，也不能充当可修改系统规则的指令。
        const results = found.data.results.slice(0, 5).map((result) => {
          const id = `w${webResults.size + 1}`;
          webResults.set(id, { kind: "web", url: result.url, title: result.title, site: result.site, date: result.date });
          return { id, title: result.title, site: result.site, date: result.date, authority: result.authority, summary: result.summary.slice(0, 300) };
        });
        observations.push({ tool: "web_search", query: next.query, results });
        return;
      }
      case "propose_preference": {
        const same = (input.preferences ?? []).find((item) => item.text.includes(next.text.trim()) || next.text.includes(item.text));
        const refused = same ? "already_saved: it is already remembered"
          : preferenceProblem(next.text) || privateMessage ? "not_allowed: never where they live, addresses, coordinates, phone or ID numbers, nor what depends on them"
            : null;
        if (refused) {
          observations.push({ tool: "propose_preference", text: next.text.trim(), shown: false, refused });
          return;
        }
        proposal = { text: next.text.trim(), category: next.category };
        observations.push({ tool: "propose_preference", text: proposal.text, shown: true });
        return;
      }
      case "ask_knowledge": {
        counts.knowledge += 1;
        report({ tool: "ask_knowledge", subject: next.question });
        const knowledge = dependencies.knowledge!;
        const found = await bounded(controller.signal, limits.providerMs, (signal) => knowledge.ask(next.question, { signal, cityAdcode: draftCity(draft).adcode }))
          .catch((error) => {
            if (error instanceof ChatRunError && controller.signal.aborted) throw error;
            return null;
          });
        if (!found || found.status === "failed") {
          observations.push({ tool: "ask_knowledge", question: next.question, found: false, passages: [], failure: found?.code ?? "unavailable" });
          return;
        }
        // not_found 表示检索未达到回答阈值，和服务故障区分开，供模型继续联网或诚实说明没有资料。
        if (found.status === "not_found") {
          observations.push({ tool: "ask_knowledge", question: next.question, found: false, passages: [] });
          return;
        }
        // 只暴露回答需要的少量段落；引用表保存文档与段落 ID，正文展示时按 ID 从资料库读取。
        const shown = found.passages.slice(0, 4).map((passage) => {
          const id = `k${passages.size + 1}`;
          passages.set(id, { kind: "kb", documentId: passage.documentId, chunkId: passage.chunkId, title: passage.title, headingPath: passage.headingPath });
          return { id, title: passage.title, section: passage.headingPath, text: passage.text.slice(0, 500) };
        });
        observations.push({ tool: "ask_knowledge", question: next.question, found: true, passages: shown });
        return;
      }
      case "reply":
        reply = {
          text: next.text,
          // V3.4：第一个已经问过时，第二个仍问也不算问（一轮最多一个问题）。
          asking: (next.ask ?? false) && !turn.said?.asked,
          ...(next.sources?.length
            ? { sources: [...new Set(next.sources)].map((id) => webResults.get(id) ?? passages.get(id)!) }
            : {}),
          ...(next.places?.length
            ? {
                places: inTextOrder(next.text, [...new Set(next.places)].map((id) => {
                  const candidate = candidates.get(id)!;
                  return { externalId: candidate.externalId, name: candidate.name, ...(candidate.cityAdcode ? { city: candidate.cityAdcode } : {}) };
                })),
              }
            : {}),
        };
    }
  };

  /** 决策记录：工具只留名称、对象、数量和临时编号（地址、网页摘要、资料正文都不进记录）。 */
  const trace = (): ChatTrace => ({
    version: "chat-trace.v1",
    prompt: agent.version,
    route: {
      router: route.router,
      flags: INTENT_FLAGS.filter((flag) => route.flags[flag]),
      fallback: route.fallback,
      ...(route.failure ? { failure: route.failure } : {}),
      latencyMs: route.latencyMs,
    },
    context: { intent, preferences: input.preferences?.length ?? 0, summary: !!input.summary },
    decisions,
    hints: [...hints],
    tools: observations.map((item) => {
      switch (item.tool) {
        case "search_place":
          return { tool: item.tool, subject: item.mention, count: item.candidates.length, ids: item.candidates.map((candidate) => candidate.id), ...(item.failure ? { failure: item.failure } : {}) };
        case "get_weather":
          return { tool: item.tool, subject: item.date, found: !!item.forecast, ...(item.failure ? { failure: item.failure } : {}) };
        case "update_requirements":
          return { tool: item.tool, changed: item.changed, ...(item.refused ? { failure: item.refused.split(":")[0] } : {}) };
        case "other_city":
          return { tool: item.tool, subject: item.places.map((place) => place.name).join("、"), count: item.places.length };
        case "set_city":
        case "city_changed":
          return { tool: item.tool, subject: item.city ?? "", ...(item.failure ? { failure: item.failure.split(":")[0] } : {}) };
        case "web_search":
          return { tool: item.tool, subject: item.query, count: item.results.length, ids: item.results.map((result) => result.id), ...(item.failure ? { failure: item.failure } : {}) };
        case "propose_preference":
          return { tool: item.tool, subject: item.text, ...(item.refused ? { failure: item.refused.split(":")[0] } : {}) };
        case "ask_knowledge":
          return { tool: item.tool, subject: item.question, found: item.found, ids: item.passages.map((passage) => passage.id), ...(item.failure ? { failure: item.failure } : {}) };
        case "change_outing":
          return { tool: item.tool, failure: item.refused };
      }
    }),
    durationMs: Math.round(performance.now() - startedAt),
  });

  const State = Annotation.Root({ step: Annotation<number>() });
  const graph = new StateGraph(State)
    .addNode("decide", async (state) => {
      active();
      if (counts.model - modelStart >= modelLimit) return { step: state.step + 1 };
      const current = context();
      serializeChatContext(current, limits.contextBytes); // 先检查上下文字节上限，再消耗模型请求；不能静默截断后丢掉用户约束。
      counts.model += 1;
      let raw: unknown;
      try {
        raw = await bounded(controller.signal, limits.modelMs, (signal) => dependencies.model.decide(current, { signal, system: agent.prompt(current) }));
      } catch (error) {
        if (error instanceof DecisionModelError) {
          const reported = usageSchema.safeParse(error.metadata?.usage ?? null);
          if (reported.success) addUsage(reported.data);
        }
        throw error;
      }
      const parsed = z.object({ decision: z.unknown(), usage: usageSchema }).passthrough().safeParse(raw);
      if (!parsed.success) throw new ChatRunError("invalid_output");
      addUsage(parsed.data.usage);
      pending = parsed.data.decision;
      decisions.push(parsed.data.decision);
      currentRun()?.note({ decision: parsed.data.decision });
      return { step: state.step + 1 };
    })
    .addNode("act", async (state) => {
      active();
      if (pending === undefined) return { step: state.step + 1 };
      const decision = pending;
      pending = undefined;
      // 兼容单动作与 1～5 个动作的批次；先校验整批结构，再执行其中任何动作。
      // 结构错误只反馈字段路径和错误原因，不把整份不可信输出塞回上下文。
      const list: unknown[] | null =
        decision !== null && typeof decision === "object" && "actions" in decision
          ? Array.isArray(decision.actions) ? decision.actions : null
          : [decision];
      // V2.11：出游一句话常带七八个地点，一批最多 10 个动作（日常照旧 5 个）。
      const batch = draft.mode === "outing" ? 10 : 5;
      if (!list || list.length < 1 || list.length > batch) {
        repair(`invalid_action_shape; expected {"actions":[1-${batch} actions]}`, 0);
        return { step: state.step + 1 };
      }
      const actions: ChatAction[] = [];
      for (const [index, item] of list.entries()) {
        const parsed = chatActionSchema.safeParse(interestsAsReplace(item, draft));
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`);
          // V2.10：模型会反复发不存在的 patch.interests（Y07 连发 4 次用完纠错额度），只说“不认识”不够，附上合法字段。
          const unknownPatchKey = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys" && issue.path.join(".") === "patch");
          // V2.11 验收复测：choose 的 target 写错时说清楚有哪些写法（只说“Invalid input”时模型连发同样的写法）。
          const badTarget = parsed.error.issues.some((issue) => issue.path[0] === "patch" && issue.path[1] === "choose");
          const fields = unknownPatchKey ? `; patch fields are ${Object.keys(draftPatchSchema.shape).join(", ")}`
            : badTarget ? `; choose target is one of: ${choosable(draft).filter(([, place]) => place?.status === "choose").map(([target]) => target).join(", ") || "none waiting"}`
              : "";
          repair(`invalid_action_shape; actions.${index}: ${issues.join("; ")}${fields}`, 0);
          return { step: state.step + 1 };
        }
        actions.push(parsed.data);
      }
      feedback = null;
      // 固定在整批动作开始前取快照：同批 search 刚生成的编号尚未被模型看到，不能立即绑定。
      // 批内先执行的合法动作会保留；后续动作被拒绝时，反馈会说明前面的动作已经执行。
      const seen = new Set(candidates.keys());
      let lookedUp = false;
      for (const [index, sent] of actions.entries()) {
        if (reply) break; // 回复是本轮终态，后续动作不再执行。
        // V3.4：不在这个专门 Agent 清单里的动作由代码拒绝并打回（single 有全部动作，不会走到这里）。
        if (!can(sent.action)) {
          repair(`action_unavailable: ${agent.id} cannot ${sent.action}; it can ${agent.actions.join(", ")}${sent.action === "update_requirements" || sent.action === "adjust_trip" ? "; another assistant changes the card and the trip" : ""}`, index);
          break;
        }
        // V3.4 交接（§3.4）：只能是这个 Agent 的第一个动作（还没调用工具、没改卡片），一轮一次，只交给还没跑过的。
        if (sent.action === "handoff") {
          const problem = handoffProblem(sent.to, { first: decisions.length === 1 && index === 0, agent: agent.id, turn, hasTrip: !!input.trip });
          if (problem) {
            repair(problem, index);
            break;
          }
          handoff = { to: sent.to, reason: sent.reason, back: !!sent.back };
          break;
        }
        // V2.9.1：纠错后模型常把已执行的“加地点”连同新补丁一起重发；卡片上已有的同一地点直接略过，
        // 不再判 duplicate_place 打回。每次打回都耗一次纠错额度，F07、F13、L05 都因此整轮失败。
        const sourced = sent.action === "update_requirements" ? withStaySource(sent, input.userText) : sent;
        const resent = sourced.action === "update_requirements" ? withoutResentVisits(sourced, draft, candidates) : sourced;
        const unnoted = resent.action === "update_requirements" ? withoutPrivateNotes(resent) : resent;
        const inCity = unnoted.action === "update_requirements" ? withoutOutsideInterests(unnoted, outside) : unnoted;
        // V2.11：过夜交通只有用户能在卡片上确认，模型发的确认不写。
        const next = inCity.action === "update_requirements" ? withoutConfirmations(inCity) : inCity;
        // V2.10：备注里的号码没保存，要让模型先看到这一点；同批写好的“记下了”不能直接发出。
        // V2.11：外地的兴趣、模型替用户的确认同样不写，同批的回复等模型看到后再说。
        if (next !== resent) {
          observations.push({
            tool: "update_requirements",
            changed: false,
            refused: unnoted !== resent
              ? "private_notes: phone, ID numbers, emails and coordinates are never kept on the card; the notes were not saved"
              : inCity !== unnoted
                ? "outside_interest: interests about the other city are not kept; daily plans only this city"
                : "confirm_is_users: only the user confirms an overnight ride, on the card",
          });
          lookedUp = true;
          if (!Object.keys(next.action === "update_requirements" ? next.patch : {}).length) continue;
        }
        // 同批工具调用后暂停回复，让下一次 decide 先看到实际结果；不能把调用前编好的回复直接发出。
        if (next.action === "reply" && lookedUp) {
          hints.push("reply_held_until_results");
          break;
        }
        // V3.4：后面还有人做另一部分时，第一个不答、不提那部分（真实端到端两次说“预约的事我这边查不到”“另一位同事接着答”，
        // 和后面带出处的回答矛盾；只写在提示词里时没照做）。打回一次。
        if (next.action === "reply" && turn.next && !nextChecked && OTHER_PART.test(next.text)) {
          nextChecked = true;
          repair("next_part_mentioned: another assistant answers the rest right after you; leave that part out of your reply entirely", index);
          break;
        }
        // V3.4：一轮两个专门 Agent 时，第二个不能再问（第一个问过了）；问了打回一次，仍问就去掉问句的标记、照实拼接。
        if (next.action === "reply" && turn.said?.asked && next.ask && !saidAskChecked) {
          saidAskChecked = true;
          repair("one_question: the reply before yours already asks the user something; do not ask another (ask false)", index);
          break;
        }
        if (next.action === "reply" && turn.said && !saidLengthChecked && [...turn.said.text].length + [...next.text].length > SPLIT_REPLY_CHARS) {
          saidLengthChecked = true;
          repair(`reply_too_long: with what was already said, the whole reply must stay within ${SPLIT_REPLY_CHARS} characters; yours may use about ${Math.max(40, SPLIT_REPLY_CHARS - [...turn.said.text].length)}`, index);
          break;
        }
        if (next.action === "reply" && !windowChecked && can("update_requirements")) {
          windowChecked = true;
          const conflicts = interestWindowConflicts(draft);
          if (conflicts.length) {
            const needs = conflicts.map((item) => `${item.id} is ${item.when}, needs ${Object.entries(item.needs).map(([field, time]) => `${field} ${time}`).join(" ")}`);
            repair(`interest_outside_window: ${needs.join("; ")}; fix the window with update_requirements, then reply`, index);
            break;
          }
        }
        // 即使回复在追问出行方式，也先检查一日卡片缺项，避免把另一类追问当成需求已经完整。
        if (next.action === "reply" && !dayChecked && can("update_requirements")) {
          dayChecked = true;
          const gaps = dayGaps(draft, chinaNow(input.nowMs).date);
          if (gaps.length) {
            repair(`day_incomplete: ${gaps.join("; ")}; fix with update_requirements (or ask the user), then reply`, index);
            break;
          }
        }
        // V2.9：偏好要用户点“记住”才保存，回复不能说已经记住（基线里没有记忆的产品会这样说）。
        // 没有任何已保存的偏好时，任何一轮都不能说已经记住（P05：上一轮说的偏好，下一轮说“已经记下了”）。
        // 第二次提醒只在纠错额度还有富余时：宁可放过一句“记下了”，也不能让这一轮因额度用完而失败。
        // 没说偏好的轮次：卡片没改时按 CLAIMS_LASTING_MEMORY 查；改过卡片时只查声称长期的说法
        // （V2.10 第 1 步。V2.9 曾因改过卡片后打回、模型重发补丁而失败，V2.9.1 起重发的地点会被略过）。
        if (next.action === "reply" && (memoryChecks === 0 || (memoryChecks === 1 && repairsUsed() + 1 < limits.repairs)) && (heard.preference || proposal
          ? CLAIMS_MEMORY.test(next.text)
          : !input.preferences?.length && (draftChanged ? CLAIMS_LONG_TERM : CLAIMS_LASTING_MEMORY).test(next.text))) {
          memoryChecks += 1;
          repair("reply_claims_memory: nothing is saved until the user taps 记住 on the card; offer to remember it instead", index);
          break;
        }
        // V2.9：建议先查再说，只说本轮查到的或卡片上的地点（只能发现一部分编造，其余靠评测）。
        if (next.action === "reply" && flags.advice && !adviceSearchChecked && !counts.searches && !next.ask && !FOUND_NOTHING.test(next.text)) {
          adviceSearchChecked = true;
          repair("advice_needs_search: search_place for what they want first, then recommend from the results", index);
          break;
        }
        if (next.action === "reply" && flags.advice && !advicePlacesChecked) {
          const allowed = [...candidates.values()].map((candidate) => candidate.name).concat(cardPlaceNames(draft));
          const strangers = unknownPlaceNames(next.text, allowed);
          if (strangers.length) {
            advicePlacesChecked = true;
            repair(`unknown_place: ${strangers.join(", ")} is not in this turn's results or the card; name only places you found`, index);
            break;
          }
        }
        // V2.9.1：搜索是全杭州范围；不知道用户在哪时（卡片没有确定的地点、也没有行程），不能把搜到的
        // 说成“附近”：问一句在哪，或说明是全杭州范围。只写在提示词里时模型三次都没照做。
        if (next.action === "reply" && flags.advice && !nearbyChecked && NEARBY.test(input.userText) && !knowsWhere(draft, input.trip) && !next.ask && !scopedTo(next.text, draftCity(draft).name)) {
          nearbyChecked = true;
          repair(`nearby_unknown: you do not know where the user is; ask where they are, or say these picks are from across ${draftCity(draft).name}`, index);
          break;
        }
        // V2.11：这一轮遇到了外地的地点或城市：回复不能说已经排上，要说日常只管本市、可以切到出游（D-072）。
        if (next.action === "reply" && outside.length && !outsideChecked && repairsUsed() + 1 < limits.repairs && can("update_requirements")) {
          const named = outside.map((entry) => entry.name).join("、");
          const claimed = outside.some((entry) => next.text.includes(entry.name.slice(0, 4))) && CLAIMS_ARRANGED.test(next.text);
          if (claimed || !/出游/.test(next.text)) {
            outsideChecked = true;
            repair(`${claimed ? "claimed_other_city" : "other_city_unexplained"}: ${named} is not on the card (daily plans only ${draftCity(draft).name}); say so and point to 出游 (the button on the page)`, index);
            break;
          }
        }
        // V2.10：换城市的这一轮拿掉了原来的地点或兴趣，回复要说出来，不悄悄删（城市理解 Y07 三次都没提）。
        // V2.11：说了外地被挡下（other_city）的这一轮也算：Y07 在这一轮悄悄拿掉了湖滨。
        const cityMoved = observations.some((item) => item.tool === "other_city" ||
          ((item.tool === "set_city" || item.tool === "city_changed") && item.city));
        if (next.action === "reply" && !removalChecked && cityMoved && repairsUsed() + 1 < limits.repairs && can("update_requirements")) {
          const silent = silentlyRemoved(input.draft, draft, next.text);
          if (silent.length) {
            removalChecked = true;
            repair(`removed_silently: you took ${silent.join("、")} off the card while changing city; say so in the reply, or put them back and ask`, index);
            break;
          }
        }
        // V2.10：没授权定位、起点还等着位置时，回复要问从哪出发或请求位置（卡片同时提示）。
        // 只写在提示词里时三次都没照做（城市理解 Y06）；纠错额度不够时宁可放过。
        // 分流判为规划、卡片还没有起点时也要问（Y06 走了建议：查完推荐就回复，卡片没填起点）。
        const waitsForStart = draft.start?.status === "current" || (flags.planning && !draft.start);
        if (next.action === "reply" && !startChecked && !input.trip && waitsForStart && !knowsStart(draft) && can("update_requirements") &&
          !ASKS_START.test(next.text) && repairsUsed() + 1 < limits.repairs) {
          startChecked = true;
          // 定位过、但这一天在用户说的别的城市：现在的位置不是出发点，也要问。
          const away = !!draft.city && (draft.city.source === "said" || draft.city.source === "places") && input.draft.city?.source === "located";
          repair(away
            ? `start_unknown: the day is in ${draftCity(draft).name}, not where they are now; keep the rest of the reply and end it asking where they will start from there`
            : "start_unknown: no location was allowed and they named no start; end the reply asking where they will start from, or to allow the location", index);
          break;
        }
        // V2.7/V2.8：正文只写回答，出处由结构化字段交页面展示；模型不能自行拼链接。
        // 资料库与联网引用共用这项回复检查；存在引用并不等于回答已忠于原文，后者仍由评测检验。
        if (next.action === "reply" && !sourcesChecked) {
          const problem = (webResults.size || passages.size) && !next.sources?.length && !FOUND_NOTHING.test(next.text)
            ? `reply_needs_sources: list the ids (${passages.size ? "k1…" : "w1…"}) your answer rests on in "sources", or say you found nothing useful`
            : LINK.test(next.text) ? "reply_has_link: the page shows the sources; remove links from the text" : null;
          if (problem) {
            sourcesChecked = true;
            repair(problem, index);
            break;
          }
        }
        // V3.4：拆开后改卡片只有需求理解能做（陪聊、改行程的清单里没有这个动作，前面直接拒绝），拆开前的三处提醒
        // （只是闲聊、已保存的出游、已保存行程那一天）不再需要；新计划由改行程交接给需求理解。
        if (next.action === "update_requirements" && unseenCandidate(next.patch, seen)) {
          repair("candidate_not_seen_yet: use ids from this turn's observations only; ids from earlier turns are gone, so search_place the place by its name first", index);
          break;
        }
        const invalid = guard(next);
        if (invalid) {
          repair(invalid, index);
          break;
        }
        const refreshes = weatherRefreshes;
        await execute(next);
        if (next.action === "search_place" || next.action === "get_weather" || next.action === "web_search" || next.action === "ask_knowledge") lookedUp = true;
        // V2.10：换城市后重查的天气也是新结果，同批里事先写好的回复要等模型看过再发。
        if (weatherRefreshes > refreshes) lookedUp = true;
        // V2.11：说的城市在外地（set_city 被挡下）也是新结果。
        if (observations.at(-1)?.tool === "other_city") lookedUp = true;
        if (next.action === "change_outing" && observations.at(-1)?.tool === "change_outing") lookedUp = true;
        active();
      }
      return { step: state.step + 1 };
    })
    .addEdge(START, "decide")
    .addEdge("decide", "act")
    .addConditionalEdges("act", () => (reply || handoff || counts.model - modelStart >= modelLimit ? END : "decide"))
    .compile();

  try {
    assertLocalTracingOnly();
    await graph.invoke({ step: 0 }, { recursionLimit: limits.recursion, callbacks: [], signal: controller.signal });
    active();
    if (handoff) return { status: "handoff", ...handoff, counts: { ...counts }, usage, trace: trace() };
    const finalReply = reply ?? {
      // 决策额度耗尽仍没发出 reply 时，按是否已整理卡片给出诚实兜底，不把过程状态说成规划成功。
      text: draftChanged ? "我先把听到的整理到卡片上了，请看看还缺什么，也可以直接改。" : "抱歉，这次没能整理好，可以换个说法再告诉我吗？",
      asking: false,
    };
    return {
      status: "completed",
      reply: { ...finalReply, fallback: !reply },
      draft,
      draftChanged,
      ...(adjust ? { adjust } : {}),
      ...(outingChange ? { outingChange } : {}),
      ...(outingRefused ? { outingRefused } : {}),
      route,
      ...(proposal ? { proposal } : {}),
      ...(outside.length ? { outside: [...outside] } : {}),
      counts: { ...counts },
      usage,
      trace: trace(),
    };
  } catch (error) {
    const code = controller.signal.aborted ? "timeout"
      : error instanceof ChatRunError ? error.code
        : error instanceof GraphRecursionError ? "budget_exhausted"
          : error instanceof DecisionModelError
            ? error.code === "invalid_output" ? "invalid_output" : error.code === "timeout" ? "timeout" : "model_error"
            : "internal_error";
    return { status: "failed", code, hints, counts: { ...counts }, usage, trace: trace() };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

/** V3.4：第一个专门 Agent 说到了后面那个的部分（“我这边查不到”“另一位同事接着答”）。 */
const OTHER_PART = /查不到|查不了|没法查|无法查|没查到|另一位|同事|助手|接着(答|回答|说)|稍后(答|回答|告诉)/;

/** V3.4：一轮两个专门 Agent 时，拼起来的回复最多这么多字（§3.3）。 */
const SPLIT_REPLY_CHARS = 240;

/** 分流一次（同 V2.9）：要花时间的实现先报“正在理解”。 */
async function routeOnce(input: ChatTurnInput, options: ChatRunOptions, dependencies: ChatRunnerDependencies, signal: AbortSignal): Promise<IntentRoute> {
  const router = dependencies.router ?? regexRouter;
  if (router.name !== "regex") {
    try {
      options.onProgress?.({ tool: "understand", subject: "" });
    } catch {
      // 进度只用于展示。
    }
  }
  return routeTurn(input, router, signal);
}

/** V3.4 交接的检查（§3.4）：第一个动作、一轮一次、交给还没跑过的别人；改行程要有已保存的行程。 */
function handoffProblem(
  to: ChatSpecialistId,
  at: { readonly first: boolean; readonly agent: ChatAgentId; readonly turn: TurnShared; readonly hasTrip: boolean },
): string | null {
  if (!at.first) return "handoff_not_first: hand off only as your first action; now finish your part and reply";
  if (at.turn.handoffUsed) return "handoff_used: this turn was already handed off once; do your part and reply";
  if (to === at.agent || at.turn.ran.includes(to)) return `handoff_ran: ${to} already answered this turn; do your part and reply`;
  if (to === "chat-trip" && !at.hasTrip) return "handoff_no_trip: there is no saved trip; do your part and reply";
  return null;
}

/** 两段回复接起来：第一段没有句末标点时补一个句号。 */
function joinReplies(first: string, second: string): string {
  return /[。！？!?…~～）)」”]$/.test(first) ? `${first}${second}` : `${first}。${second}`;
}

function sumUsage(items: readonly (ChatUsage | null)[]): ChatUsage | null {
  const reported = items.filter((item): item is ChatUsage => !!item);
  if (!reported.length) return null;
  const cache = (pick: (item: ChatUsage) => number | null) => {
    const values = reported.map(pick).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    inputTokens: reported.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: reported.reduce((sum, item) => sum + item.outputTokens, 0),
    totalTokens: reported.reduce((sum, item) => sum + item.totalTokens, 0),
    cacheHitTokens: cache((item) => item.cacheHitTokens),
    cacheMissTokens: cache((item) => item.cacheMissTokens),
  };
}

/** 几个专门 Agent 的决策记录合成这一轮的一份（提示词版本用“+”连起来）。 */
function mergeTraces(traces: readonly ChatTrace[], agents: readonly ChatAgentRun[], route: IntentRoute, startedAt: number): ChatTrace {
  return {
    version: "chat-trace.v1",
    prompt: agents.map((agent) => agent.version).join("+"),
    route: traces[0]?.route ?? {
      router: route.router,
      flags: INTENT_FLAGS.filter((flag) => route.flags[flag]),
      fallback: route.fallback,
      latencyMs: route.latencyMs,
    },
    context: {
      intent: [...new Set(traces.flatMap((trace) => trace.context.intent))],
      preferences: traces[0]?.context.preferences ?? 0,
      summary: traces[0]?.context.summary ?? false,
    },
    decisions: traces.flatMap((trace) => trace.decisions),
    hints: traces.flatMap((trace) => trace.hints),
    tools: traces.flatMap((trace) => trace.tools),
    durationMs: Math.round(performance.now() - startedAt),
    agents,
  };
}

/**
 * V3.4 总控（stages/V3.4.md §3.2–3.4）：分流一次 → 代码挑专门 Agent（最多 2 个）→ 依次跑（第二个看到第一个改过的卡片
 * 和说过的话）→ 回复由代码拼接。交接：被挑中的 Agent 第一个动作就交给另一个，由对方跑这一部分。第一个出错照拆开前
 * 的做法（整轮失败）；第二个出错保留第一个的结果，回复说那部分没能处理。
 */
async function runSplit(
  input: ChatTurnInput,
  options: ChatRunOptions,
  dependencies: ChatRunnerDependencies,
  limits: ChatLimits,
): Promise<ChatTurnResult> {
  const startedAt = performance.now();
  const deadline = Date.now() + limits.turnMs;
  const counts: ChatCounts = { model: 0, searches: 0, weather: 0, webSearches: 0, knowledge: 0, repairs: 0 };
  const route = await routeOnce(input, options, dependencies, options.signal);
  const picked = pickAgents(route.flags, !!input.trip, { guessed: guessedQuestion(input.userText), asks: looksLikeQuestion(input.userText) });
  const parent = currentRun();
  if (parent) {
    const { router, flags, fallback, failure } = { ...route, flags: INTENT_FLAGS.filter((flag) => route.flags[flag]) };
    parent.step("check", "route", { router, flags, fallback, ...(failure ? { failure } : {}) }, route.latencyMs, parent.startedAt);
    parent.step("check", "pick", { agents: picked.map((item) => item.agent), reasons: picked.map((item) => item.reason) });
  }

  const queue: { agent: ChatSpecialistId; reason: string; back?: true }[] = [...picked];
  const ran: ChatSpecialistId[] = [];
  const agents: ChatAgentRun[] = [];
  const traces: ChatTrace[] = [];
  const usages: (ChatUsage | null)[] = [];
  const done: Extract<ChatTurnResult, { status: "completed" }>[] = [];
  let handoffUsed = false;
  let partFailed = false;
  while (queue.length && done.length + (partFailed ? 1 : 0) < picked.length + 1) {
    const { agent: id, reason, back } = queue.shift()!;
    if (ran.includes(id) && !back) continue;
    const said = done.length ? { text: done.map((item) => item.reply.text).reduce(joinReplies), asked: done.some((item) => item.reply.asking) } : undefined;
    const next = !done.length ? queue.find((item) => item.agent !== id && (item.back || !ran.includes(item.agent)))?.agent : undefined;
    const turn: TurnShared = {
      route,
      ...(said ? { said } : {}),
      ...(next ? { next: AGENT_PARTS[next] } : {}),
      counts,
      modelLeft: limits.turnModel - counts.model,
      deadline,
      ran,
      handoffUsed,
    };
    const spec = reason === "guessed_question" && id === "chat-intake" ? CHAT_INTAKE_WITH_QUESTIONS : CHAT_AGENTS[id];
    const draft = done.at(-1)?.draft ?? input.draft;
    const result = turn.modelLeft <= 0
      ? null
      : await inAgent(
          id,
          { attributes: { reason } },
          async (run) => {
            const outcome = await runTurn({ ...input, draft }, options, dependencies, limits, spec, turn);
            if (run) recordTrace(run, outcome);
            return outcome;
          },
          (outcome) => outcome.status === "handoff" ? { status: "ok", outcome: `handoff:${outcome.to}` } : classifyTurn(outcome),
        );
    ran.push(id);
    if (!result) {
      partFailed = true;
      break;
    }
    traces.push(result.trace!);
    usages.push(result.usage);
    if (result.status === "handoff") {
      handoffUsed = true;
      agents.push({ id, version: spec.version, handoffTo: result.to, reason });
      // 交给的那个先跑；它本来排在后面就不再跑第二次。还有自己那部分时（back），对方跑完再叫回来。
      const later = queue.findIndex((item) => item.agent === result.to);
      if (later >= 0) queue.splice(later, 1);
      queue.unshift({ agent: result.to, reason: `handoff:${id}` }, ...(result.back ? [{ agent: id, reason: "back", back: true as const }] : []));
      continue;
    }
    agents.push({ id, version: spec.version, reason });
    if (result.status === "failed") {
      // 第一个出错：整轮失败（同拆开前）。第二个出错：保留第一个的结果。
      if (!done.length) {
        return { status: "failed", code: result.code, hints: traces.flatMap((trace) => trace.hints), counts: { ...counts }, usage: sumUsage(usages), trace: mergeTraces(traces, agents, route, startedAt), agents };
      }
      partFailed = true;
      break;
    }
    if (result.reply.fallback && done.length) {
      partFailed = true;
      break;
    }
    done.push(result);
    if (done.length >= MAX_PARTS) break;
  }

  const first = done[0];
  if (!first) {
    // 只有交接、没有谁回复（预算用完）：照拆开前的兜底说。
    return {
      status: "completed",
      reply: { text: "抱歉，这次没能整理好，可以换个说法再告诉我吗？", asking: false, fallback: true },
      draft: input.draft,
      draftChanged: false,
      route,
      counts: { ...counts },
      usage: sumUsage(usages),
      trace: mergeTraces(traces, agents, route, startedAt),
      agents,
    };
  }
  const last = done.at(-1)!;
  const text = [...done.map((item) => item.reply.text), ...(partFailed ? ["另一部分没能处理好，请再说一次。"] : [])].reduce(joinReplies);
  const sources = done.flatMap((item) => item.reply.sources ?? []);
  const places = done.flatMap((item) => item.reply.places ?? []);
  const outside = done.flatMap((item) => item.outside ?? []).filter((item, index, list) => list.findIndex((other) => other.name === item.name) === index).slice(0, 6);
  const pick = <K extends "adjust" | "outingChange" | "outingRefused" | "proposal">(key: K) => done.find((item) => item[key])?.[key];
  const adjust = pick("adjust");
  const outingChange = pick("outingChange");
  const outingRefused = pick("outingRefused");
  const proposal = pick("proposal");
  return {
    status: "completed",
    reply: {
      text,
      asking: done.some((item) => item.reply.asking),
      fallback: done.some((item) => item.reply.fallback) || partFailed,
      ...(sources.length ? { sources } : {}),
      ...(places.length ? { places } : {}),
    },
    draft: last.draft,
    draftChanged: done.some((item) => item.draftChanged),
    ...(adjust ? { adjust } : {}),
    ...(outingChange ? { outingChange } : {}),
    ...(outingRefused ? { outingRefused } : {}),
    route,
    ...(proposal ? { proposal } : {}),
    ...(outside.length ? { outside } : {}),
    counts: { ...counts },
    usage: sumUsage(usages),
    trace: mergeTraces(traces, agents, route, startedAt),
    agents,
  };
}

/** 一轮最多几段回复（每个专门 Agent 一段）。 */
const MAX_PARTS = 2;

/** 告诉第一个专门 Agent 后面那个做什么（上下文的 next）。 */
const AGENT_PARTS: Readonly<Record<ChatSpecialistId, string>> = {
  "chat-intake": "puts the plan on the requirements card",
  "chat-trip": "changes the saved trip",
  "chat-info": "answers the question with sources",
  "chat-advice": "recommends places",
  "chat-companion": "replies to the small talk and offers to remember the lasting preference",
};

/** 设备位置解析出的“某地附近”名称也视为位置线索，不能直接带进联网检索词。 */
function nearbyNames(draft: RequirementsDraft): string[] {
  return [draft.start, draft.end].flatMap((place) => (place?.status === "bound" && place.nearby ? [place.name] : []));
}

/** 被替换的站本来就不再访问；从 skipped 中去掉同一站，避免下游收到两份重复的删除意图。 */
function normalizeAdjust(request: AdjustTripRequest): AdjustTripRequest {
  const replaced = new Set((request.replace ?? []).map((item) => item.stop));
  if (!request.skipped?.some((key) => replaced.has(key))) return request;
  return { ...request, skipped: request.skipped.filter((key) => !replaced.has(key)) };
}

/**
 * 调整只允许引用已保存行程里尚未处理的站，且不能重复或完全没有变化。
 * 日期和继续时刻也在这里检查；拒绝时列出可引用的站，供模型修正指代。
 */
function adjustProblem(
  request: AdjustTripRequest,
  trip: ChatDecisionContext["trip"] | undefined,
  today: { date: string; time: string },
): string | null {
  const now = today.time;
  if (!trip) return "no_saved_trip: change the card with update_requirements instead";
  const todo = trip.stops.filter((stop) => stop.status === "todo").map((stop) => stop.key);
  const named = [...(request.completed ?? []), ...(request.skipped ?? []), ...(request.replace ?? []).map((item) => item.stop)];
  const unknown = named.filter((key) => !todo.includes(key));
  if (unknown.length) return `unknown_stop ${unknown.join(",")}; stops still to do: ${todo.join(", ") || "none"}`;
  const twice = [...new Set(named.filter((key, index) => named.indexOf(key) !== index))];
  if (twice.length) return `stop_named_twice ${twice.join(",")}: put each stop in only one of completed, skipped, replace`;
  const changes = named.length + (request.addInterests?.length ?? 0) + (request.resumeAt ? 1 : 0) + (request.endsAt ? 1 : 0) + (request.from ? 1 : 0);
  if (!changes) return "empty_adjustment";
  if (request.resumeAt && request.resumeAt <= now) return `resume_not_later: now is ${now}; leave resumeAt out to go on now`;
  if (request.endsAt && request.endsAt <= (request.resumeAt ?? now)) return `ends_too_early: now is ${now}`;
  // 用行程当天的继续时刻判断兴趣时段；已经过去的“上午”或晚于新结束时刻的“晚上”
  // 应在需求理解时说明冲突，避免等规划失败后只返回笼统的“排不开”。
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const from = trip.date === today.date ? toMinutes(request.resumeAt ?? now) : 0;
  const until = request.endsAt ? toMinutes(request.endsAt) : 24 * 60;
  const timed = [
    ...(request.replace ?? []).map((item) => ({ text: item.interest, when: item.when })),
    ...(request.addInterests ?? []).map((item) => (typeof item === "string" ? { text: item, when: undefined } : item)),
  ];
  for (const item of timed) {
    if (!item.when || item.when === "any") continue;
    const slot = INTEREST_SLOTS[item.when];
    if (Math.min(slot.endsAt, until) - Math.max(slot.startsAt, from) < SLOT_MIN_OVERLAP_MINUTES) {
      return `slot_passed: "${item.text}" is ${item.when} (${slot.label}), but the trip goes on ${trip.date === today.date ? `from ${request.resumeAt ?? now}` : ""}${request.endsAt ? ` until ${request.endsAt}` : ""}; do not send it, tell the user and ask what instead`;
    }
  }
  return null;
}

/** V2.11：出游卡片上出现过的城市（主要城市、固定交通两端、住处、地点、兴趣指定的城市）。 */
function outingCities(draft: RequirementsDraft): string[] {
  const outing = draft.outing;
  const places = [
    draft.start, draft.end,
    ...(outing?.transports ?? []).flatMap((ride) => [ride.from, ride.to]),
    ...(outing?.lodging ?? []).map((night) => night.place),
    ...draft.visits.map((visit) => visit.place),
  ];
  return [...new Set([
    draftCity(draft).adcode,
    ...places.flatMap((place) => (place?.status === "bound" && place.city ? [place.city] : [])),
    ...draft.interests.flatMap((item) => (item.city ? [item.city.adcode] : [])),
  ])];
}

/** V2.11：出游改动只能引用这趟出游里的地点 key、交通 id 和存在的天、晚。 */
function outingChangeProblem(request: OutingChangeRequest, outing: ChatOutingTrip | undefined): string | null {
  if (!outing) return "no_saved_outing: there is no saved outing; change the card with update_requirements instead";
  const days = outing.days.length;
  if ("move" in request) {
    const keys = outing.days.flatMap((day) => day.places.flatMap((place) => (place.key ? [`${place.key} ${place.name} (day ${day.day})`] : [])));
    if (!outing.days.some((day) => day.places.some((place) => place.key === request.move.visit))) {
      return `unknown_place ${request.move.visit}; places by key: ${keys.join(", ") || "none"} (places found for an interest cannot be moved)`;
    }
    if (request.move.toDay > days) return `no_such_day: the outing has ${days} days`;
    return null;
  }
  if ("transport" in request) {
    return outing.transports.some((item) => item.id === request.transport.id) ? null
      : `unknown_transport ${request.transport.id}; rides: ${outing.transports.map((item) => `${item.id} day ${item.day} ${item.from}→${item.to}`).join(", ") || "none"}`;
  }
  return request.lodging.night < days ? null : `no_such_night: nights are 1-${days - 1} (night n is after day n)`;
}

/** V2.11：固定事项、已去过的站不能挪；其余由服务端按装不装得下检查。 */
function outingRefusal(request: OutingChangeRequest, outing: ChatOutingTrip): { refused: "fixed" | "done"; note: string } | null {
  if (!("move" in request)) return null;
  const place = outing.days.flatMap((day) => day.places).find((item) => item.key === request.move.visit);
  if (place?.fixed) return { refused: "fixed", note: `${place.name} is a fixed booking: it cannot move to another day. Say so; nothing changed.` };
  if (place?.status === "done") return { refused: "done", note: `${place.name} is already done: nothing to move. Say so; nothing changed.` };
  return null;
}

/**
 * 找出一日需求里尚缺、但按规则应可补齐的日期和起止时间。
 * 曾见“晚上吃饭再喝酒”只套用了一半短途规则而留下空值；空卡和真正短途不在这里补。
 */
function dayGaps(draft: RequirementsDraft, today: string): string[] {
  // V2.11 出游：只看日期范围（一日卡片的 date、end 规则不适用）。
  if (draft.mode === "outing") {
    return draft.outing?.dates || (!draft.interests.length && !draft.visits.length) ? [] : ["dates is empty: ask which days, or set dates"];
  }
  if (draft.mode === "short" || (!draft.interests.length && !draft.visits.length)) return [];
  const gaps: string[] = [];
  if (!draft.date) gaps.push(`date is empty: with no other day named ("晚上", "今晚") it is today ${today}`);
  const fromHere = draft.start?.status === "current" || (draft.start?.status === "bound" && !!draft.start.nearby);
  if (fromHere && !draft.end) {
    gaps.push(`end is empty: with no end named, the day ends where it starts, end {"current":true}`);
  }
  return gaps;
}

/** “多点选择”指候选数量，“多逛几家”指实际站数；不能把两个数量混成同一个兴趣 count。 */
function asksForOptions(text: string): boolean {
  return /选择|选项|备选|自己挑|挑一挑/.test(text) && !/多(逛|去|吃|看|走)几/.test(text);
}

function raisesCount(patch: Extract<ChatAction, { action: "update_requirements" }>["patch"]): boolean {
  const counts = [
    ...(patch.addInterests ?? []).map((item) => (typeof item === "string" ? 1 : item.count ?? 1)),
    ...(patch.updateInterests ?? []).map((item) => item.count ?? 1),
  ];
  return counts.some((count) => count > 1);
}

/** 检查补丁中的候选是否已在先前观察中展示给模型；同批搜索刚产生的 ID 尚不能绑定。 */
function unseenCandidate(patch: Extract<ChatAction, { action: "update_requirements" }>["patch"], seen: ReadonlySet<string>): boolean {
  const ids: string[] = [];
  const collect = (place: unknown) => {
    if (!place || typeof place !== "object") return;
    if ("candidate" in place && typeof place.candidate === "string") ids.push(place.candidate);
    if ("choose" in place && place.choose && typeof place.choose === "object" && "candidates" in place.choose) {
      ids.push(...(place.choose.candidates as string[]));
    }
  };
  collect(patch.start);
  collect(patch.end);
  for (const visit of patch.addVisits ?? []) collect(visit.place);
  for (const visit of patch.updateVisits ?? []) collect(visit.place);
  return ids.some((id) => !seen.has(id));
}

/**
 * V2.9：本轮的分流。输入只有本条消息、上一条助手消息、有没有已保存的行程和卡片是否为空；
 * 分流出错或超过 6 秒时用正则，不让分流拖住或中断一轮对话。
 */
async function routeTurn(input: ChatTurnInput, router: IntentRouter, signal: AbortSignal): Promise<IntentRoute> {
  const previous = [...input.history].reverse().find((message) => message.role === "assistant" && !message.text.startsWith("（"))?.text;
  const draft = input.draft;
  const routeInput = {
    text: input.userText,
    ...(previous ? { previous } : {}),
    hasTrip: !!input.trip,
    cardEmpty: !draft.date && !draft.interests.length && !draft.visits.length && !draft.start && !draft.end,
  };
  const started = performance.now();
  try {
    return await bounded(signal, 6_000, (bound) => router.route(routeInput, { signal: bound }));
  } catch (error) {
    if (error instanceof ChatRunError && signal.aborted) throw error;
    return regexFallback(routeInput, router.name, started, "error");
  }
}

/** 卡片上已有的地点名（建议里提到它们不算编造）。 */
function cardPlaceNames(draft: RequirementsDraft): string[] {
  return [draft.start, draft.end, ...draft.visits.map((visit) => visit.place)].flatMap((place) =>
    place?.status === "bound" ? [place.name] : place?.status === "choose" ? place.choices.map((choice) => choice.name) : []);
}

/** 像地点名的词尾：店、馆、寺、塔、公园…… */
const PLACE_SUFFIX = /(博物馆|纪念馆|陈列馆|美术馆|科技馆|咖啡馆|咖啡店|茶馆|茶室|书店|书房|书城|餐厅|饭店|酒家|酒馆|酒吧|清吧|面馆|小馆|火锅|公园|广场|商场|步行街|小吃街|古镇|湿地|观景台|夜景台|寺|塔|楼|阁|园|街|店|馆)$/;
/** 只是类别或描述（“附近的咖啡馆”“室内博物馆”），不是具体的地点名。 */
const GENERIC_PLACE = /^(室内|室外|附近|周边|安静|热闹|小众|网红|本地|特色|环境好|这|那|一|几|两|别|其他|各种|很多|不少|老字号)?(博物馆|纪念馆|陈列馆|美术馆|科技馆|咖啡馆|咖啡店|茶馆|茶室|书店|书房|书城|餐厅|饭店|酒家|酒馆|酒吧|清吧|面馆|小馆|火锅店?|公园|广场|商场|步行街|小吃街|古镇|湿地|观景台|夜景台|小店|老店|网红店)$/;

/**
 * 回复里像具体地点、却不在本轮候选和卡片上的名字。只是启发式：按标点和虚词切开，取以地点词尾
 * 结尾、不是泛称的片段；发现不了所有编造（例如没有词尾的店名），其余由评测检查。
 */
export function unknownPlaceNames(text: string, allowed: readonly string[]): string[] {
  const pieces = text.split(/[，。！？、；：,.!?\s“”"'「」《》（）()]|或者|可以|推荐|试试|还有|比如|考虑|选择|和|或|与|跟|及|的|去|到|在|是|有|家|个|像|也|就|再|先|吧/);
  const found = new Set<string>();
  for (const piece of pieces) {
    const name = piece.trim();
    if ([...name].length < 3 || !PLACE_SUFFIX.test(name) || GENERIC_PLACE.test(name)) continue;
    if (allowed.some((known) => known.includes(name) || name.includes(known))) continue;
    found.add(name);
  }
  return [...found];
}
