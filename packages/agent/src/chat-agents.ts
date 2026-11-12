import { CHAT_AGENT_VERSIONS, chatAgentPrompt, type ChatSpecialistId } from "./chat-agent-prompts";
import type { ChatAction, ChatDecisionContext } from "./chat-contracts";
import { INTENT_FLAGS, type IntentFlag, type IntentFlags } from "./intent";

/**
 * V3.4 对话的专门 Agent（stages/V3.4.md §3.1）：同一个引擎（chat-graph.ts 的 runTurn）按这份说明跑，各自的提示词、
 * 可用动作、管哪些分流判断（这些判断对应的检查和规则块只在管它的 Agent 里起作用）、给不给联网和资料库。
 * 拆开前的一个 Agent（`chat`，CHAT_AGENTS=single）在评测对比后删除（§3.5）。
 */
export type ChatAgentId = ChatSpecialistId;

export interface ChatAgentSpec {
  readonly id: ChatAgentId;
  readonly version: string;
  readonly actions: readonly ChatAction["action"][];
  /** 这个 Agent 管的分流判断；没管的在它这里当作没判出。 */
  readonly owns: readonly IntentFlag[];
  /** 这一轮给不给联网、资料库（还要产品配了这两样）。 */
  readonly offers: (flags: IntentFlags) => { readonly web: boolean; readonly knowledge: boolean };
  readonly prompt: (context: ChatDecisionContext) => string;
}

const specialist = (
  id: ChatSpecialistId,
  actions: readonly ChatAction["action"][],
  owns: readonly IntentFlag[],
  offers: ChatAgentSpec["offers"] = () => ({ web: false, knowledge: false }),
): ChatAgentSpec => ({ id, version: CHAT_AGENT_VERSIONS[id], actions, owns, offers, prompt: (context) => chatAgentPrompt(id, context) });

/** 需求理解不加交接（它的提示词逐字是 CHAT_SYSTEM_PROMPT，也是缺省的那个）；其余四个都可以交接。 */
export const CHAT_AGENTS: Readonly<Record<ChatSpecialistId, ChatAgentSpec>> = {
  // 规划里带着要建议（“晚上想看夜景，去哪好”）时由需求理解带着建议规则做（同拆开前那一轮的提示词）。
  "chat-intake": specialist("chat-intake", ["search_place", "get_weather", "set_city", "update_requirements", "reply"], ["planning", "advice"]),
  "chat-trip": specialist("chat-trip", ["adjust_trip", "change_outing", "search_place", "reply", "handoff"], ["adjust", "planning"]),
  "chat-info": specialist(
    "chat-info",
    ["web_search", "ask_knowledge", "get_weather", "search_place", "reply", "handoff"],
    ["ask_timely", "ask_knowledge"],
    (flags) => ({ web: true, knowledge: flags.ask_knowledge }),
  ),
  "chat-advice": specialist("chat-advice", ["search_place", "get_weather", "reply", "handoff"], ["advice"]),
  "chat-companion": specialist("chat-companion", ["propose_preference", "reply", "handoff"], ["chitchat", "preference"]),
};

/**
 * 在这个 Agent 看来的分流判断：没管的当作没判出。需求理解总是当作规划（它只在判出规划、什么都没判出，或被交接来时跑）。
 */
export function agentFlags(agent: ChatAgentSpec, flags: IntentFlags): IntentFlags {
  const owned = Object.fromEntries(INTENT_FLAGS.map((flag) => [flag, agent.owns.includes(flag) && flags[flag]])) as Record<IntentFlag, boolean>;
  return agent.id === "chat-intake" ? { ...owned, planning: true } : owned;
}

/** 只是闲聊：没要求规划、调整、偏好或提问（V2.9.1：闲聊规则只给纯闲聊）。 */
export function onlySmallTalk(flags: IntentFlags): boolean {
  return flags.chitchat && !flags.planning && !flags.adjust && !flags.preference && !flags.advice && !flags.ask_timely && !flags.ask_knowledge;
}

/** 一轮最多几个专门 Agent。 */
export const MAX_AGENTS_PER_TURN = 2;

/**
 * 总控（§3.2，代码，不问模型）：按固定次序挑，一轮最多 2 个；判出长期偏好时 chat-companion 一定在，替换排第二的。
 * 闲聊只在纯闲聊时交给 chat-companion（V2.9.1 的老规矩：“谢谢，明天想去…”按请求处理）。
 * V4.1：问句安全网的消息不再退回“需求理解 + 提问规则”一个 Agent（V3.4 的 CHAT_INTAKE_WITH_QUESTIONS），由级联分流
 * 交给模型判断后按一般规则挑（stages/V4.1.md §3.3）。
 */
export function pickAgents(
  flags: IntentFlags,
  hasTrip: boolean,
  cues: { readonly asks?: boolean } = {},
): { agent: ChatSpecialistId; reason: string }[] {
  const picked: { agent: ChatSpecialistId; reason: string }[] = [];
  if (hasTrip && (flags.adjust || flags.planning)) {
    picked.push({ agent: "chat-trip", reason: flags.adjust ? "adjust" : "planning" });
  } else if (flags.planning) picked.push({ agent: "chat-intake", reason: "planning" });
  // 资料查询排在别人后面时，只在消息像问句时才加（“茶馆关门了不去了”判出时效词，但没什么可答）。
  if ((flags.ask_timely || flags.ask_knowledge) && (cues.asks !== false || !picked.length)) {
    picked.push({ agent: "chat-info", reason: flags.ask_timely ? "ask_timely" : "ask_knowledge" });
  }
  // 规划带着要建议：建议规则给需求理解（拆开前这样的消息也是规则块一起给，推荐的地点不自动进卡片），不另跑建议。
  if (flags.advice && !picked.some((item) => item.agent === "chat-intake")) picked.push({ agent: "chat-advice", reason: "advice" });
  if (flags.preference || onlySmallTalk(flags)) picked.push({ agent: "chat-companion", reason: flags.preference ? "preference" : "chitchat" });
  if (!picked.length) return [{ agent: "chat-intake", reason: "none" }];
  const kept = picked.slice(0, MAX_AGENTS_PER_TURN);
  const companion = picked.find((item) => item.agent === "chat-companion");
  if (flags.preference && companion && !kept.includes(companion)) kept[MAX_AGENTS_PER_TURN - 1] = companion;
  return kept;
}
