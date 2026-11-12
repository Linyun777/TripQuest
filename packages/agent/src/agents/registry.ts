import type { z } from "zod";
import { dayPlanningResultSchema } from "@tripquest/application/day-planning";
import { planningRequirementsSchema } from "@tripquest/application/planning";
import { CHAT_AGENT_VERSIONS } from "../chat-agent-prompts";
import { NOTES_PROMPT_VERSION } from "../notes-prompt";
import { notesOutputSchema } from "../notes-contracts";
import { JUDGE_PROMPT_VERSION, judgeInputSchema, judgeOutputSchema } from "../outing-judge";
import { REVIEW_PROMPT_VERSION, reviewInputSchema, reviewOutputSchema } from "../outing-review";
import type { RunBudget, RunCategory } from "../runs";

/**
 * V3.0 Agent 契约登记（stages/V3.0.md §3.5）：每个用模型的 Agent 一条——编号、版本、输入输出结构、可用的请求、
 * 缺省子预算、谁可以调用。结构都引用现有的 Zod，这一阶段不新写；没有现成结构的写 null，交接时只记录、不校验。
 * 调用方写的是父运行的 Agent 编号：根运行的 Agent 就是它的触发入口（如 chat_turn、plan）；评测的根运行不核对。
 * 摘要、分流、分配的版本常量定义在各自的 Agent 文件里，那些文件要用这里的登记，为免循环引用在这里写字面值，
 * 由测试核对两边一致。V3.6：分流（缺省正则，D-070）不再登记成 Agent，作为分流模块留在总控里；可选的 DeepSeek / Jev
 * 分流调模型时照样由传输层计量、记在当前运行（chat_turn）下。只服务演示行程的途中重排（replan）已删除。
 */
export const AGENT_IDS = [
  "chat-intake", "chat-trip", "chat-info", "chat-advice", "chat-companion", "chat-summary", "day-planner", "short-picker", "trip-notes", "outing-allocator", "outing-reviewer", "outing-repair", "outing-judge",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentContract {
  readonly id: AgentId;
  /**
   * V4.3（D-079，stages/V4.3.md §3.5）：agent 是带工具循环的（模型看了工具结果再决定下一步），step 是一次模型调用
   * （摘要、出发须知、分配、单步审查）。只是登记，不改行为。
   */
  readonly kind: "agent" | "step";
  readonly version: string;
  readonly description: string;
  /** 交接时按它校验；null 表示输入只有 TypeScript 类型。 */
  readonly input: z.ZodType | null;
  readonly output: z.ZodType | null;
  /** 允许发的请求类别；用了别的记一步 check（不拦，这一阶段不改行为）。 */
  readonly tools: readonly RunCategory[];
  /** 一次运行的缺省上限（与 Agent 自己代码里的上限一致，只作登记）。 */
  readonly budget: RunBudget;
  readonly callers: readonly string[];
}

export const AGENTS: Readonly<Record<AgentId, AgentContract>> = {
  // V3.4 对话的五个专门 Agent（stages/V3.4.md §3.1）：由 chat_turn 的总控按分流挑，每个最多 6 次模型请求。
  "chat-intake": {
    id: "chat-intake",
    kind: "agent",
    version: CHAT_AGENT_VERSIONS["chat-intake"],
    description: "需求理解：把用户说的整理进需求卡片（提示词同 chat-turn.v6）",
    input: null,
    output: null,
    tools: ["model", "amap"],
    budget: { model: 6 },
    callers: ["chat_turn"],
  },
  "chat-trip": {
    id: "chat-trip",
    kind: "agent",
    version: CHAT_AGENT_VERSIONS["chat-trip"],
    description: "改行程：调整今天的已保存行程、已保存出游的跨天改动",
    input: null,
    output: null,
    tools: ["model", "amap"],
    budget: { model: 6 },
    callers: ["chat_turn"],
  },
  "chat-info": {
    id: "chat-info",
    kind: "agent",
    version: CHAT_AGENT_VERSIONS["chat-info"],
    description: "资料查询：联网与资料库，带出处回答",
    input: null,
    output: null,
    tools: ["model", "amap", "web", "embed"],
    budget: { model: 6 },
    callers: ["chat_turn"],
  },
  "chat-advice": {
    id: "chat-advice",
    kind: "agent",
    version: CHAT_AGENT_VERSIONS["chat-advice"],
    description: "建议：先查再推荐，只说本轮查到的地点",
    input: null,
    output: null,
    tools: ["model", "amap"],
    budget: { model: 6 },
    callers: ["chat_turn"],
  },
  "chat-companion": {
    id: "chat-companion",
    kind: "agent",
    version: CHAT_AGENT_VERSIONS["chat-companion"],
    description: "陪聊与偏好：闲聊、提议记住长期偏好",
    input: null,
    output: null,
    tools: ["model"],
    budget: { model: 6 },
    callers: ["chat_turn"],
  },
  "chat-summary": {
    id: "chat-summary",
    kind: "step",
    version: "chat-summary.v3",
    description: "长对话的滚动摘要",
    input: null,
    output: null,
    tools: ["model"],
    budget: { model: 1 },
    callers: ["chat_turn"],
  },
  "day-planner": {
    id: "day-planner",
    kind: "agent",
    version: "day-planning.v1",
    description: "一日规划：搜地点、试排、完成",
    input: planningRequirementsSchema,
    output: dayPlanningResultSchema,
    tools: ["model", "amap"],
    budget: { model: 10 },
    // V4.0：审查-修复 Agent 试排时也调它（重排受影响的天）。
    callers: ["plan", "adjust", "outing_generate", "outing_change", "outing-repair"],
  },
  "short-picker": {
    id: "short-picker",
    kind: "agent",
    version: "short-candidates.v1",
    description: "短途：写搜索词、挑候选",
    input: null,
    output: null,
    tools: ["model", "amap", "jev"],
    budget: { model: 4 },
    callers: ["short_step", "adjust"],
  },
  "trip-notes": {
    id: "trip-notes",
    kind: "step",
    version: NOTES_PROMPT_VERSION,
    description: "出发须知：联网查每站须知",
    input: null,
    output: notesOutputSchema,
    tools: ["model", "amap", "web"],
    budget: {},
    callers: ["trip_notes"],
  },
  "outing-allocator": {
    id: "outing-allocator",
    kind: "step",
    version: "outing-allocate.v2",
    description: "出游：把地点和兴趣分到各天",
    input: null,
    output: null,
    tools: ["model"],
    budget: { model: 2 },
    callers: ["allocate", "outing_change"],
  },
  // V3.2：第一个新写了 Zod 输入输出的 Agent（只有结构和编号，没有坐标、地址）。
  "outing-reviewer": {
    id: "outing-reviewer",
    kind: "step",
    version: REVIEW_PROMPT_VERSION,
    description: "出游审查：看整趟结果，从 6 种修改里选，代码检查后直接改或作为建议",
    input: reviewInputSchema,
    output: reviewOutputSchema,
    tools: ["model"],
    budget: { model: 4 },
    callers: ["outing_generate", "outing_change"],
  },
  // V4.0：审查-修复 Agent（OUTING_REVIEW=agent）：带工具循环，试排调一日规划；一次最多 8 次模型请求、4 次试排、60 秒。
  "outing-repair": {
    id: "outing-repair",
    kind: "agent",
    version: "outing-repair.v2",
    description: "出游审查-修复：试排一个改法、看前后指标，再决定留下、作为建议或换个改法",
    input: reviewInputSchema,
    output: null,
    tools: ["model", "amap"],
    budget: { model: 8 },
    callers: ["outing_generate", "outing_change"],
  },
  // V4.7 整体判断（stages/V4.7.md §3.2）：单步，一次判断或复查一条问题。输入含用户原话，运行记录只记校验结果。
  "outing-judge": {
    id: "outing-judge",
    kind: "step",
    version: JUDGE_PROMPT_VERSION,
    description: "出游整体判断：对照需求清单看整趟是否满足、排得好不好，代码校验防编造",
    input: judgeInputSchema,
    output: judgeOutputSchema,
    tools: ["model"],
    budget: { model: 2 },
    callers: ["outing_generate", "outing-repair"],
  },
};

/**
 * 每个触发入口的共用预算（根运行下所有 Agent 加起来）。先按现有代码上限的上沿设，基线评测核对现有题目不会
 * 碰到（stages/V3.0.md §3.4）；Agent 自己的上限不变，这里是总的那道闸。不在表里的入口不限。出游逐天生成、
 * 跨天改动的预算按要排的段数算（V3.1，见 outing-generate.ts 的 outingSegmentBudget）。
 */
export const TRIGGER_BUDGETS: Readonly<Record<string, RunBudget>> = {
  // 对话 6 次 + 摘要 1 次 + 分流 1 次。V3.4：一轮两个专门 Agent 时共 10 次（每个最多 6 次）+ 摘要 + 分流。
  chat_turn: { model: 12, ms: 180_000 },
  plan: { model: 12, amap: 80, ms: 240_000 },
  short_step: { model: 8, amap: 60, ms: 120_000 },
  adjust: { model: 24, amap: 160, ms: 300_000 },
  allocate: { model: 3, ms: 60_000 },
  trip_notes: { model: 2, amap: 20, web: 12, ms: 120_000 },
};

export function contractOf(agent: string): AgentContract | undefined {
  return (AGENTS as Record<string, AgentContract | undefined>)[agent];
}
