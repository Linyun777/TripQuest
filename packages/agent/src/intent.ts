/**
 * V2.9 意图分流（stages/V2.9.md §3.1–3.2）：每轮先判断这条消息要什么，再决定本轮给模型哪些
 * 规则块和工具。判断不是单一类别，7 个可以同时成立（“明天去灵隐寺，要预约吗”既是规划也是
 * 提问）。接口与实现无关：正则、DeepSeek 分类、向量路由和级联都实现同一个接口，默认用哪个由
 * 分流评测决定；任何实现失败都退回正则。
 */
export const INTENT_FLAGS = ["planning", "adjust", "ask_timely", "ask_knowledge", "advice", "chitchat", "preference"] as const;
export type IntentFlag = (typeof INTENT_FLAGS)[number];
export type IntentFlags = Readonly<Record<IntentFlag, boolean>>;

export interface IntentInput {
  readonly text: string;
  /** 上一条助手消息（理解“那个呢”“就去这个”）；实现自行截断。 */
  readonly previous?: string;
  /** 这个对话已有保存的今天行程（才可能是调整）。 */
  readonly hasTrip: boolean;
  readonly cardEmpty: boolean;
}

export interface IntentRoute {
  readonly flags: IntentFlags;
  /** 每个判断 0–1 的把握；正则给 0 或 1。 */
  readonly confidence: Readonly<Record<IntentFlag, number>>;
  /** 实际给出结果的实现（失败退回时是 "regex"）。 */
  readonly router: string;
  /** 用了正则补的判断（拿不准或整条失败）。 */
  readonly fallback: readonly IntentFlag[];
  readonly latencyMs: number;
  /** 整条退回正则的原因（错误码，不含内容），方便评测和决策记录排查。 */
  readonly failure?: string;
  /** V2.9.2：实际回答的模型版本与输入 tokens（Jev 返回；用于报告版本和费用）。 */
  readonly model?: string;
  readonly inputTokens?: number;
}

export interface IntentRouter {
  readonly name: string;
  route(input: IntentInput, options: { signal: AbortSignal }): Promise<IntentRoute>;
}

const all = (value: (flag: IntentFlag) => boolean) =>
  Object.fromEntries(INTENT_FLAGS.map((flag) => [flag, value(flag)])) as Record<IntentFlag, boolean>;
const certain = (flags: IntentFlags) =>
  Object.fromEntries(INTENT_FLAGS.map((flag) => [flag, flags[flag] ? 1 : 0])) as Record<IntentFlag, number>;

/**
 * V2.7：像问句的消息。V2.8 起命中它（或 KNOWLEDGE_ASKS）就同时提供联网和资料库。
 * 常驻搜索规则曾干扰需求理解：I20/I29 的对照从关闭时 3/6 降为开启时 1/6，所以只在问句时提供。
 */
export const ASKS = /[?？]|吗|么|呢|多少|几点|几号|几时|何时|是否|有没有|要不要|需不需要|用不用|能不能|可不可以|开不开|周几|星期几|哪天|有什么|有啥/;
/** V2.8：ASKS 漏掉的知识问法，如“讲讲历史”“都有谁”“有哪些代表剧目”。 */
export const KNOWLEDGE_ASKS = /讲讲|介绍|历史|由来|来历|传说|典故|谁|哪里的|哪些|哪几|哪位|哪一|哪个|为什么|怎么来的|名字的来|故事/;

// 正则实现的词表。宁可多判（多给一个规则块，模型用不上就不用），也不要漏判规划和调整。
const TIMELY = /预约|门票|票价|多少钱|价格|收费|免费|开门|开不开|闭馆|关门|几点(开|关)|营业|演出|演什么|排期|排队|开放|活动|限流|人多吗/;
const KNOWLEDGE = /讲讲|介绍|历史|由来|来历|传说|典故|是谁|谁(修|建|造|写|画|开|创)|哪里的剧种|为什么(叫|会|要)|怎么来的|名字|故事|什么时候(建|修|成立|开始|有的)|什么意思|代表剧目|有哪些(代表|名)|都有谁/;
const ADVICE = /推荐|有什么(好|适合|值得|可以)|有啥(好|适合)|去哪|哪(里|儿).{0,8}(好|适合|比较|值得)|适合.{0,8}(去|的地方)|什么地方|好吃的|好玩的|值得去/;
const CHITCHAT = /^(你好|您好|嗨|哈喽|hi|hello)|谢谢|多谢|辛苦|好累|累死|太累|哈哈|真舒服|真好|真不错|开心|无聊|晚安|早上好|有意思|会聊天/i;
const PREFERENCE = /(从来|一直|一般|平时|向来)?(不吃|不喝|不能吃|吃不了)|素食|(比较|更|挺)?喜欢|不喜欢|以后(都|别|不要)|膝盖|腿脚|走不动|不太能走|过敏|忌口/;
const ADJUST = /逛完|看完|吃完|喝完|玩完|不去了|跳过|换成|换个|晚到|迟到|晚点到|晚.{0,2}(半小时|一小时|分钟)|累了|少安排|提前结束|下一站|接下来|已经.{0,4}完/;
/** 规划要有“做什么”的说法；单独的时间词不算（“今天好累啊”是闲聊）。 */
const PLANNING = /出发|回来|想去|想吃|想喝|想逛|想看|逛逛|走走|玩一天|(明天|后天|今天|今晚|周.|晚上|下午|上午|中午)去(?!哪)|去(?!哪)[^，。？?]{0,4}(看|逛|玩|吃|喝)|安排|排(进|上|一下|明天)|规划|就去|就排|加上|找个|找家|坐坐|小酌|喝一杯|喝杯/;
/** “不是要去，就问问”：明说只是问问时不算规划。 */
const ONLY_ASKING = /不是要去|就问问|随便问问|只是好奇|不去了.{0,4}问/;
/** 另一天的计划不是调整今天的行程。 */
const ANOTHER_DAY = /明天|后天|周[一二三四五六日天]|下周/;

/**
 * 安全网（V2.9 回归发现）：像问句、但没认出是哪种提问也不是要建议时，按 V2.8 的做法两种都给。
 * 细分的词表总有没见过的问法（“周一开吗”“叫什么”“是白居易修的吗”），漏判会让模型凭记忆回答。
 * V2.9.2 起 Jev 分流之后也用它。
 */
export function questionNet<T extends Pick<IntentFlags, "ask_timely" | "ask_knowledge" | "advice">>(text: string, flags: T): T {
  if ((ASKS.test(text) || KNOWLEDGE_ASKS.test(text)) && !flags.ask_timely && !flags.ask_knowledge && !flags.advice) {
    return { ...flags, ask_timely: true, ask_knowledge: true };
  }
  return flags;
}

/**
 * V3.4：这条消息的提问判断只来自安全网（像问句，但词表没认出是哪种提问、也不是要建议，也没说只是问问）。
 * 拆开后总控据此把它也交给需求理解：“晚上整两杯？”这类问句式的计划，拆开前同一轮两套规则都在。
 */
export function guessedQuestion(text: string): boolean {
  const value = text.trim();
  return (ASKS.test(value) || KNOWLEDGE_ASKS.test(value)) && !TIMELY.test(value) && !KNOWLEDGE.test(value) &&
    !ADVICE.test(value) && !ONLY_ASKING.test(value);
}

/** V3.4：像问句（问号、吗、几点……或知识问法）。“茶馆关门了不去了”判出时效词，但不是在问。 */
export function looksLikeQuestion(text: string): boolean {
  return ASKS.test(text.trim()) || KNOWLEDGE_ASKS.test(text.trim());
}

/** 正则实现：零成本、确定，作为基线和所有实现的退回。 */
export function regexIntent(input: IntentInput): IntentFlags {
  const text = input.text.trim();
  const onlyAsking = ONLY_ASKING.test(text);
  const adjust = input.hasTrip && !onlyAsking && ADJUST.test(text) && !ANOTHER_DAY.test(text);
  const flags = questionNet(text, {
    adjust,
    ask_timely: TIMELY.test(text),
    ask_knowledge: KNOWLEDGE.test(text),
    advice: ADVICE.test(text),
    chitchat: CHITCHAT.test(text),
    preference: PREFERENCE.test(text) && !onlyAsking,
  });
  const anyOther = Object.values(flags).some(Boolean);
  // 有规划的说法就是规划；什么都没认出来时也按规划处理（与 V2.8 的默认一致，不漏判）。
  const planning = !onlyAsking && !adjust && (PLANNING.test(text) || !anyOther);
  return { planning, ...flags };
}

export const regexRouter: IntentRouter = {
  name: "regex",
  async route(input) {
    const started = performance.now();
    const flags = regexIntent(input);
    return {
      flags,
      confidence: certain(flags),
      router: "regex",
      fallback: [],
      latencyMs: Math.round(performance.now() - started),
    };
  },
};

/**
 * 有分数的实现（DeepSeek、向量）共用：分数 ≥ 上界为真、≤ 下界为假，落在中间的“拿不准”
 * 用正则补，并记在 fallback 里。
 */
export function decide(
  scores: Readonly<Record<IntentFlag, number>>,
  input: IntentInput,
  band: { readonly low: number; readonly high: number },
): { flags: IntentFlags; fallback: IntentFlag[] } {
  const regex = regexIntent(input);
  const fallback: IntentFlag[] = [];
  const flags = all((flag) => {
    const score = scores[flag];
    if (score >= band.high) return true;
    if (score <= band.low) return false;
    fallback.push(flag);
    return regex[flag];
  });
  // 没有已保存的行程就不可能是调整。
  return { flags: { ...flags, adjust: flags.adjust && input.hasTrip }, fallback };
}

/** 整条失败（超时、格式不对、超出额度）时：正则的结果，标明退回。 */
export function regexFallback(input: IntentInput, router: string, started: number, failure?: string): IntentRoute {
  const flags = regexIntent(input);
  return {
    flags,
    confidence: certain(flags),
    router: `${router}->regex`,
    fallback: [...INTENT_FLAGS],
    latencyMs: Math.round(performance.now() - started),
    ...(failure ? { failure } : {}),
  };
}
