import { z } from "zod";
import {
  draftPatchSchema,
  type RequirementsDraft,
} from "@tripquest/application/conversation";
import type { CityResolver, PlaceSearchRequest, PlaceSearchData, ProviderCallOptions, ProviderResult, WeatherProvider, WebSearchProvider } from "@tripquest/providers";
import type { ModelReply } from "./contracts";
import type { IntentRoute, IntentRouter } from "./intent";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const slot = z.enum(["any", "morning", "noon", "afternoon", "dusk", "evening"]);
const interest = z.string().trim().min(1).max(40);
const stopKey = z.string().regex(/^s\d{1,2}$/);
/** 模型用 s1/s2 等行程站序号表达调整，服务端再映射为已保存活动 ID，禁止自造数据库身份。 */
export const adjustTripRequestSchema = z.strictObject({
  completed: z.array(stopKey).max(12).optional(),
  skipped: z.array(stopKey).max(12).optional(),
  replace: z.array(z.strictObject({ stop: stopKey, interest, when: slot.optional() })).max(3).optional(),
  addInterests: z.array(z.union([
    interest,
    z.strictObject({ text: interest, when: slot.optional(), count: z.number().int().min(1).max(3).optional() }),
  ])).max(3).optional(),
  /** 用户明确表示晚于现在才能继续时才填写；缺省由服务端从当前时刻安排。 */
  resumeAt: clock.optional(),
  /** 本次调整希望采用的新结束时刻；不填则沿用已保存行程的边界。 */
  endsAt: clock.optional(),
  /** 剩余行程从哪里继续：缺省为最后完成站，也可明确使用实时位置或原起点。 */
  from: z.enum(["last_done", "here", "start"]).optional(),
});
export type AdjustTripRequest = z.infer<typeof adjustTripRequestSchema>;

/**
 * V2.11 已保存出游的跨天改动（stages/V2.11.md §3.9），对话 Agent 发 change_outing：把卡片上的地点挪到另一天、
 * 改一趟固定交通的时刻、改某一晚的住处（mention 由服务端按名称查到地点）。一次只改一件事。
 */
export const outingChangeRequestSchema = z.union([
  z.strictObject({ move: z.strictObject({ visit: z.string().regex(/^v\d{1,2}$/), toDay: z.number().int().min(1).max(7) }) }),
  z.strictObject({
    transport: z.strictObject({ id: z.string().regex(/^t\d{1,2}$/), departAt: clock.optional(), arriveAt: clock.optional() }),
  }),
  z.strictObject({ lodging: z.strictObject({ night: z.number().int().min(1).max(6), mention: z.string().trim().min(2).max(30) }) }),
]);
export type OutingChangeRequest = z.infer<typeof outingChangeRequestSchema>;

/**
 * 一条消息触发有限次决策，最终只回复、更新需求草稿或产出调整请求。
 * 动作协议没有“直接保存计划”，正式规划和确认由后续应用流程负责。
 */
export const chatActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("search_place"),
    mention: z.string().trim().min(2).max(30),
    purpose: z.enum(["start", "end", "visit"]),
    /** V2.11 出游：在这个城市里找（车站、机场、住处常在别的城市）；日常里不用。 */
    city: z.string().trim().min(1).max(20).optional(),
  }),
  z.strictObject({ action: z.literal("get_weather"), date: z.iso.date() }),
  // V2.10：用户明说去别的城市（“下周去成都玩一天”）时换卡片的主要城市；服务端按行政区查询绑定。
  z.strictObject({ action: z.literal("set_city"), city: z.string().trim().min(1).max(20) }),
  z.strictObject({ action: z.literal("update_requirements"), patch: draftPatchSchema }),
  // V2.5：调整此对话已保存的行程，站点只能引用本轮 trip 视图中的 key。
  z.strictObject({ action: z.literal("adjust_trip"), request: adjustTripRequestSchema }),
  // V2.11：已保存出游的跨天改动（挪到另一天、改车次、改住处）；代码检查后重排受影响的天，用户确认才保存。
  z.strictObject({ action: z.literal("change_outing"), request: outingChangeRequestSchema }),
  // V2.7：高德无法回答的信息问题交联网工具；是否提供工具由产品配置和本轮规则决定。
  z.strictObject({
    action: z.literal("web_search"),
    query: z.string().trim().min(2).max(60),
    question: z.string().trim().min(1).max(128).optional(),
  }),
  // V2.8：稳定背景知识查询自有资料库；缺少依赖时动作仍会由执行层明确拒绝。
  // V2.9：提议记住一条长期偏好；用户在卡片上点“记住”才保存，模型不能自己保存、修改或删除。
  z.strictObject({
    action: z.literal("propose_preference"),
    text: z.string().trim().min(1).max(40),
    category: z.enum(["food", "pace", "travel", "interest", "other"]),
  }),
  z.strictObject({
    action: z.literal("ask_knowledge"),
    question: z.string().trim().min(2).max(60),
  }),
  // V3.4：专门 Agent 发现这条消息不归自己，把这一轮交给另一个（只能是第一个动作，一轮一次，见 chat-graph.ts）。
  z.strictObject({
    action: z.literal("handoff"),
    to: z.enum(["chat-intake", "chat-trip", "chat-info", "chat-advice", "chat-companion"]),
    reason: z.string().trim().min(1).max(80),
    /** 这条消息还有一部分是自己的：对方跑完后再叫回来做自己那部分。 */
    back: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("reply"),
    text: z.string().trim().min(1).max(300),
    ask: z.boolean().optional(),
    /** 引用本轮实际查到的 w 网页或 k 段落编号；URL 与正文出处由服务端表还原。 */
    sources: z.array(z.string().regex(/^[wk]\d{1,2}$/)).max(5).optional(),
    /** V2.9：回复推荐的地点，只能是本轮搜索候选的 c 编号；服务端还原成地点编号和名称。 */
    places: z.array(z.string().regex(/^c\d{1,2}$/)).max(5).optional(),
  }),
]);
export type ChatAction = z.infer<typeof chatActionSchema>;


/** 模型可见的已保存行程摘要：站序号、名称、计划时刻与完成状态；不暴露活动 UUID 或精确坐标。 */
/**
 * V2.11 已保存的出游：每天的地点（卡片上的 key、是否已去、是否固定）、每晚住处和固定交通。today 是第几天
 * （出游开始前为 0）。只有名称和我们自己的时刻。
 */
export interface ChatOutingTrip {
  readonly today: number;
  readonly days: readonly {
    readonly day: number;
    readonly date: string;
    readonly places: readonly { readonly key?: string; readonly name: string; readonly status: "todo" | "done"; readonly fixed?: true }[];
    /** 这天晚上住哪（最后一天没有）。 */
    readonly lodging?: string;
  }[];
  readonly transports: readonly {
    readonly id: string;
    readonly day: number;
    readonly from: string;
    readonly to: string;
    readonly departAt: string | null;
    readonly arriveAt: string | null;
  }[];
}

export interface ChatTrip {
  /** V2.11：这段对话保存的是一趟出游时才有。 */
  readonly outing?: ChatOutingTrip;
  readonly version: number;
  readonly date: string;
  readonly stops: readonly {
    readonly key: string;
    readonly name: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: "todo" | "done" | "skipped";
    readonly fixed?: boolean;
    /** 站点对应的原始兴趣，如“喝奶茶”，帮助理解替换目标；不是模型重新给出的地点事实。 */
    readonly for?: string;
  }[];
}


/** 同时约束决策次数、各工具次数、修复次数、耗时和上下文字节数；图递归上限只作为引擎最后保护。 */
export const CHAT_LIMITS = {
  model: 6,
  searches: 4,
  /** V2.11：出游一句话常带十来个地点（车站、住处、各天去的地方）。 */
  outingSearches: 10,
  weather: 1,
  webSearches: 2,
  knowledge: 1,
  repairs: 3,
  turnMs: 60_000,
  modelMs: 20_000,
  providerMs: 6_000,
  contextBytes: 32 * 1024,
  historyMessages: 12,
  recursion: 40,
  /** V3.4：一轮里各专门 Agent 的模型请求合计（每个仍不超过 model）。 */
  turnModel: 10,
} as const;
export type ChatLimits = { readonly [K in keyof typeof CHAT_LIMITS]: number };

export type ChatCounts = { model: number; searches: number; weather: number; webSearches: number; knowledge: number; repairs: number };

export type ChatFailureCode =
  | "model_error"
  | "invalid_output"
  | "timeout"
  | "context_limit"
  | "budget_exhausted"
  | "live_budget"
  | "internal_error";

export class ChatRunError extends Error {
  constructor(readonly code: ChatFailureCode) {
    super(code);
  }
}

export interface ChatCandidate {
  readonly id: string;
  readonly externalId: string;
  readonly name: string;
  /** 地址仅在本轮帮助区分同名地点，持久化草稿只保留地点编号和名称。 */
  readonly address?: string;
  /** V2.10：地点所属城市的编码（写进草稿，判断主要城市用）。 */
  readonly cityAdcode?: string;
  /** V2.10：不在卡片的城市（全国搜索找到的，比如别的城市同名的地方）。 */
  readonly otherCity?: true;
  /** V2.11 出游：同名地点在这趟出游的几个城市都有时，标出在哪个城市。 */
  readonly cityName?: string;
}

/** 工具观察保留成功、空结果与失败，下一次决策据此继续；失败不会伪装成“已验证没有”。 */
export type ChatObservation =
  | {
      readonly tool: "search_place";
      readonly mention: string;
      readonly purpose: "start" | "end" | "visit";
      readonly candidates: readonly ChatCandidate[];
      readonly failure?: string;
    }
  | {
      readonly tool: "get_weather";
      readonly date: string;
      /** V2.10：这是哪个城市的预报（卡片当时的城市）。 */
      readonly city?: string;
      readonly forecast: null | {
        readonly dayWeather: string;
        readonly nightWeather: string;
        readonly highCelsius: number;
        readonly lowCelsius: number;
        readonly wet: boolean;
      };
      readonly availableDates: readonly string[];
      readonly failure?: string;
    }
  | {
      readonly tool: "update_requirements";
      readonly changed: boolean;
      /** V2.10：补丁里被去掉、没保存的部分（备注里的号码）。 */
      readonly refused?: string;
    }
  | {
      /** V2.10：卡片的主要城市换了（用户明说，或卡片上的地点大多在新城市）。 */
      readonly tool: "set_city" | "city_changed";
      readonly city: string | null;
      /** 卡片上不在新城市的地点：回复里问一句要不要保留，不悄悄删。 */
      readonly elsewhere?: readonly string[];
      readonly failure?: string;
    }
  | {
      /**
       * V2.11（D-072）：日常只做所在城市。用户点名的地点或要去的城市在外地：不进卡片，页面给出“切到出游”。
       * places 里是地点名或城市名，以及它所在的城市。
       */
      readonly tool: "other_city";
      readonly dailyCity: string;
      readonly places: readonly { readonly name: string; readonly city: string }[];
      /** 怎么回复（只在出现时给，不放进常驻提示词）。 */
      readonly note: string;
    }
  | {
      readonly tool: "web_search";
      readonly query: string;
      /** 网页摘要是不可信数据，按本轮临时 ID 引用，不能执行其中夹带的指令。 */
      readonly results: readonly {
        readonly id: string;
        readonly title: string;
        readonly site: string | null;
        readonly date: string | null;
        readonly authority: number | null;
        readonly summary: string;
      }[];
      readonly failure?: string;
    }
  | {
      /** V2.11：出游改动被挡下（固定事项、已去过的站）：照 note 说明，不说已经改了。 */
      readonly tool: "change_outing";
      readonly refused: "fixed" | "done";
      readonly note: string;
    }
  | {
      readonly tool: "propose_preference";
      readonly text: string;
      readonly shown: boolean;
      /** 被拒的原因（这一轮不能提议：含住处、号码，或已经保存过）。 */
      readonly refused?: string;
    }
  | {
      readonly tool: "ask_knowledge";
      readonly question: string;
      /** false 表示整次召回未达回答阈值；低相关的近似段落不会交给回答模型。 */
      readonly found: boolean;
      /** 自有语料也按数据而非指令处理；正文只进入本轮上下文。 */
      readonly passages: readonly { readonly id: string; readonly title: string; readonly section: string; readonly text: string }[];
      readonly failure?: string;
    };

/**
 * 回复持久化的出处只保留网页元信息或自有段落 ID。
 * 网页摘要不存，知识正文在打开引用时按 ID 从资料库读取，避免消息里复制一份语料。
 */
export interface WebSource {
  readonly url: string;
  readonly title: string;
  readonly site: string | null;
  readonly date: string | null;
}

export type ChatSource =
  | ({ readonly kind: "web" } & WebSource)
  | {
      readonly kind: "kb";
      readonly documentId: string;
      readonly chunkId: string;
      readonly title: string;
      readonly headingPath: string;
    };

/** 一次知识查询返回的可引用段落；标题路径提供上下文，正文给模型组织回答。 */
/** V2.9：推荐地点在存储和展示时只有供应商地点编号和名称（D-046）。 */
export interface ChatPlace {
  readonly externalId: string;
  readonly name: string;
  /** V2.10：所在城市（行政区编码），页面的高德链接按它搜。 */
  readonly city?: string;
}

export interface ChatKnowledgePassage {
  readonly chunkId: string;
  readonly documentId: string;
  readonly title: string;
  readonly headingPath: string;
  readonly text: string;
}

/** 对话层只依赖 found / not_found / failed 三种结果，阈值与检索实现由资料库内部负责。 */
export interface ChatKnowledgeBase {
  /** V2.10：cityAdcode 是卡片的城市，只检索这个城市的文档。 */
  ask(question: string, options: { signal: AbortSignal; cityAdcode?: string }): Promise<
    | { readonly status: "found"; readonly passages: readonly ChatKnowledgePassage[] }
    | { readonly status: "not_found" }
    | { readonly status: "failed"; readonly code: "daily_limit" | "unavailable" }
  >;
}

/** 结构化状态与文本历史分开：草稿给当前卡片视图，工具观察给本轮证据，反馈给下一次修复。 */
export interface ChatDecisionContext {
  readonly protocolVersion: "chat-turn.v1";
  readonly now: { readonly date: string; readonly weekday: string; readonly time: string };
  readonly draft: unknown;
  readonly missing: readonly string[];
  /**
   * V2.10：卡片的主要城市；location 是 unknown 时用户没有授权定位（城市是缺省的杭州），
   * 没说从哪出发时要问一句。
   */
  readonly city: { readonly name: string; readonly location: "known" | "unknown" };
  /** 只有已保存行程的对话才提供 trip，未保存时保持原需求理解规则，避免无关提示干扰。 */
  readonly trip?: ChatTrip;
  readonly conversation: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly observations: readonly ChatObservation[];
  readonly feedback: null | { readonly code: string };
  /** 联网预算字段仅在本轮可用时出现；提示词据此加入联网规则，不能用 0 代替“未提供”。 */
  /** 资料库预算也用字段是否存在表示可用性，与额度耗尽是两个不同状态。 */
  readonly remaining: {
    readonly model: number;
    readonly searches: number;
    readonly weather: number;
    readonly webSearches?: number;
    readonly knowledge?: number;
  };
  /**
   * V2.9：分流判出建议或闲聊时才出现，并加上对应规则块；普通规划消息的上下文和提示词保持原样。
   */
  readonly intent?: readonly ("advice" | "chitchat" | "preference")[];
  /**
   * V2.9：用户确认保存过的长期偏好，一行一条（“p1: 不吃辣”）；没有偏好时不出现。放在上下文里
   * 而不是系统提示词里，系统提示词的固定前缀才稳定（利于缓存）。
   */
  readonly preferences?: readonly string[];
  /** V2.9 对照 B：更早对话的摘要（只在有摘要时出现）。 */
  readonly earlier?: string;
  /**
   * V3.4：一轮两个专门 Agent 时，第二个看到第一个已经说的话（会拼在它的回复前面）和有没有问用户；
   * 只有第二个有这一项。
   */
  readonly said?: { readonly text: string; readonly asked: boolean };
  /** V3.4：一轮两个专门 Agent 时，第一个知道后面那个做什么（它的回复接在后面）；只有第一个有这一项。 */
  readonly next?: string;
}

export interface ChatDecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  /** V3.4：system 是这次跑的专门 Agent 的系统提示词（缺省按上下文拼，同 V3.3）。 */
  decide(context: ChatDecisionContext, options: { signal: AbortSignal; system?: string }): Promise<ModelReply>;
}

export interface ChatPlaceSearch {
  searchPlaces(request: PlaceSearchRequest, options?: ProviderCallOptions): Promise<ProviderResult<PlaceSearchData>>;
}

export interface ChatTurnInput {
  readonly draft: RequirementsDraft;
  /** 历史按时间从旧到新排列，卡片压为短标记；本轮消息单独放 userText，不能重复加入历史。 */
  readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly userText: string;
  readonly nowMs: number;
  readonly trip?: ChatTrip;
  /** V2.9：用户保存过的长期偏好（全部，最多 30 条）。 */
  readonly preferences?: readonly { readonly text: string; readonly category: string }[];
  /** V2.9 对照 B：最近消息窗口之外的旧对话的滚动摘要。 */
  readonly summary?: string;
}

/**
 * 工具通过校验后、实际查询前报告“正在做什么”；进度只有主题，不包含检索返回正文。
 * 它不是模型逐字输出，也不是正式业务记录。
 */
export type ChatProgress =
  | { readonly tool: "search_place"; readonly subject: string }
  | { readonly tool: "get_weather"; readonly subject: string }
  | { readonly tool: "web_search"; readonly subject: string }
  | { readonly tool: "ask_knowledge"; readonly subject: string }
  /** V2.9：分流要花时间时（DeepSeek、向量）先报“正在理解”；正则是瞬时的，不报。 */
  | { readonly tool: "understand"; readonly subject: string };

export interface ChatRunOptions {
  readonly signal: AbortSignal;
  /** 监听器只用于展示，应快速返回；抛错会被忽略，不能让 UI 消费失败终止本轮。 */
  readonly onProgress?: (progress: ChatProgress) => void;
}

/** 一轮的用量；缓存命中与未命中按 DeepSeek 返回累加（没返回时为 null）。 */
export interface ChatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
}

/**
 * V2.9 每轮决策记录（stages/V2.9.md §3.6）：分流 → 模型动作 → 校验提示码 → 工具 → 计数与用量。
 * 工具只记名称、查询对象、返回数量和本轮临时编号；不记地址、坐标、网页摘要或资料库正文。
 */
export interface ChatTrace {
  readonly version: "chat-trace.v1";
  readonly prompt: string;
  readonly route: {
    readonly router: string;
    readonly flags: readonly string[];
    readonly fallback: readonly string[];
    readonly failure?: string;
    readonly latencyMs: number;
  } | null;
  /** 本轮用了哪些上下文：分流规则块、偏好条数、有没有摘要。 */
  readonly context: { readonly intent: readonly string[]; readonly preferences: number; readonly summary: boolean };
  /** 模型每次的决定，原样（动作里只有搜索词、补丁和临时编号）。 */
  readonly decisions: readonly unknown[];
  readonly hints: readonly string[];
  readonly tools: readonly {
    readonly tool: string;
    readonly subject?: string;
    readonly count?: number;
    readonly ids?: readonly string[];
    readonly found?: boolean;
    readonly changed?: boolean;
    readonly failure?: string;
  }[];
  readonly durationMs: number;
  /** V3.4：这一轮跑了哪些专门 Agent。 */
  readonly agents?: readonly ChatAgentRun[];
}

/** V3.4：一轮里跑过的一个专门 Agent：编号、提示词版本、交给了谁（交接时）、为什么挑它。 */
export interface ChatAgentRun {
  readonly id: string;
  readonly version: string;
  readonly handoffTo?: string;
  readonly reason?: string;
}

export type ChatTurnResult =
  | {
      readonly status: "completed";
      readonly reply: {
        readonly text: string;
        readonly asking: boolean;
        readonly fallback: boolean;
        readonly sources?: readonly ChatSource[];
        /** V2.9：回复推荐的地点（本轮搜索结果里的，只有编号和名称）。 */
        readonly places?: readonly ChatPlace[];
      };
      /** V2.9：本轮的分流结果，写进决策记录。 */
      readonly route?: IntentRoute;
      /** V2.11：这一轮遇到的外地地点或城市（只有编号、名称和所在城市）；页面显示“切到出游”的提示条。 */
      readonly outside?: readonly ChatOutside[];
      /** V2.9：本轮提议记住的偏好；页面显示“要记住吗？”卡片，用户点了才保存。 */
      readonly proposal?: { readonly text: string; readonly category: "food" | "pace" | "travel" | "interest" | "other" };
      readonly draft: RequirementsDraft;
      readonly draftChanged: boolean;
      /** 已通过站点 key 检查的调整意图；调用方还要重新规划、展示差异并请求用户确认。 */
      readonly adjust?: AdjustTripRequest;
      /** V2.11：通过检查的出游改动；调用方重排受影响的天并请用户确认。 */
      readonly outingChange?: OutingChangeRequest;
      /** V2.11：被挡下的出游改动（固定事项、已去过的站），回复里已说明。 */
      readonly outingRefused?: "fixed" | "done";
      readonly counts: ChatCounts;
      readonly usage: ChatUsage | null;
      /** V2.9：本轮的决策记录。 */
      readonly trace?: ChatTrace;
      /** V3.4：这一轮跑了哪些专门 Agent（按顺序）。 */
      readonly agents?: readonly ChatAgentRun[];
    }
  | {
      readonly status: "failed";
      readonly code: ChatFailureCode;
      /** 本轮给过模型的校验提示码，仅用于本机诊断，不保存对话正文。 */
      readonly hints: readonly string[];
      readonly counts: ChatCounts;
      readonly usage: ChatUsage | null;
      /** V2.9：本轮的决策记录。 */
      readonly trace?: ChatTrace;
      readonly agents?: readonly ChatAgentRun[];
    };

/** V2.11：日常模式里遇到的外地地点（有编号）或城市（没有编号）。 */
export interface ChatOutside {
  readonly externalId?: string;
  readonly name: string;
  readonly city: string;
  readonly cityName: string;
}

export interface ChatRunnerDependencies {
  readonly model: ChatDecisionModel;
  readonly places: ChatPlaceSearch;
  readonly weather: WeatherProvider;
  /** 缺省代表未提供联网依赖：不加相关规则，模型仍请求时返回 unavailable。 */
  readonly web?: WebSearchProvider;
  /** 缺省代表未提供资料库依赖；可用性与查询无结果、服务故障分别表达。 */
  readonly knowledge?: ChatKnowledgeBase;
  /** V2.9：决定本轮提供哪些规则块和工具；缺省用正则分流。 */
  readonly router?: IntentRouter;
  /** V2.10：城市名换成城市编码；缺省时 set_city 返回 unavailable。 */
  readonly cities?: CityResolver;
  readonly limits?: Partial<ChatLimits>;
}
