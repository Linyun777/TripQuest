import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { LURES, mentionedWorldNames } from "../v29/talk-dataset";

/**
 * V2.9.3 端到端分流题（stages/V2.9.3.md §3.2）：V2.9.2 新留出的 21 条（v292-route-holdout.v1）改成一轮
 * 真实对话，地点和话题换成评测虚构世界里有的，说法保持原样；另写 3 条（含像问句的规划）。检查的是
 * 结果，不是分流标签。写好后锁定，跑任何实现之前不看结果；只用于决定默认分流，不调任何东西。
 */
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const FOUND_NOTHING = /没(有)?(查|搜|找)到|查不到|找不到|暂无|没有(相关|可靠|确切)/;
const HOURS = /\d{1,2}[:：]\d{2}|\d{1,2}点(开|关|营业|到|打烊)|营业到\s*\d|打烊/;
const CLAIMS_SAVED = /记住了|记下了|已记住|已经记住|已保存|以后都(会|给你|按|帮你)/;

const bound = (name: string): ConversationCheck => ({
  name: "card_has_place",
  test: (outcome) => outcome.draft.visits.some((visit) => visit.place.status === "bound" && visit.place.name === name),
});
const cardSays = (pattern: RegExp): ConversationCheck => ({
  name: "card_changed_as_asked",
  test: (outcome) => outcome.cardChanged && pattern.test(JSON.stringify(outcome.draft)),
});
const changed: ConversationCheck = { name: "card_changed", test: (outcome) => outcome.cardChanged };
const untouched: ConversationCheck = { name: "card_untouched", test: (outcome) => !outcome.cardChanged };
const tripUntouched: ConversationCheck = { name: "trip_untouched", test: (outcome) => !outcome.adjusted };
const adjusted: ConversationCheck = { name: "adjusted", test: (outcome) => outcome.adjusted };
const noTools: ConversationCheck = {
  name: "no_tools",
  test: (outcome) => !outcome.searches.length && !outcome.webQueries.length && !outcome.knowledgeQuestions.length,
};
/** 时效问题：联网查了；带出处回答，或者照实说没查到；没出处时不说营业时间。 */
const timely: ConversationCheck = {
  name: "web_answer",
  test: (outcome) => outcome.webQueries.length > 0 &&
    (outcome.sources > 0 || FOUND_NOTHING.test(last(outcome))) &&
    (outcome.sources > 0 || !HOURS.test(last(outcome))),
};
/** 背景问题：先查资料库（没有再联网）。 */
const knowledge: ConversationCheck = { name: "asked_knowledge_base", test: (outcome) => outcome.knowledgeQuestions.length > 0 };
/** 建议：先查地点，推荐的都来自本轮候选，不说虚构世界之外的店名。 */
const advice: readonly ConversationCheck[] = [
  { name: "searched_first", test: (outcome) => outcome.searches.length > 0 },
  { name: "places_from_candidates", test: (outcome) => mentionedWorldNames(last(outcome)).every((name) => outcome.candidates.includes(name)) },
  { name: "no_invented_places", test: (outcome) => !LURES.test(outcome.replies.join("\n")) },
];
/** 偏好：提议了“要记住吗”，没说已经记住。 */
const preference: readonly ConversationCheck[] = [
  { name: "proposes_preference", test: (outcome) => outcome.proposals.length > 0 },
  { name: "no_false_memory", test: (outcome) => !CLAIMS_SAVED.test(outcome.replies.join("\n")) },
];

const e = (id: string, note: string, turn: string, checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns: [turn], checks, ...extra });
const after = (text: string) => ({ history: [{ role: "assistant" as const, text }] });

export const ROUTE_E2E_CASES: readonly ConversationCase[] = [
  e("E01", "方言规划（N01）", "明儿个想去湖滨步行街溜达溜达", [cardSays(/湖滨/)]),
  e("E02", "口语规划（N02）", "后天整点好吃的，再去老街晃一圈", [changed]),
  e("E03", "口语时效问句（N03）", "灵峰古寺得预约不", [timely, untouched]),
  e("E04", "错别字时效问句（N04）", "灵锋古寺要预月吗", [timely, untouched]),
  e("E05", "指代 + 打烊（N05）", "那家几点打烊", [timely, untouched], after("转角咖啡馆环境不错，适合坐一会儿。")),
  e("E06", "口语知识问题（N06）", "灵隐寺里头供的是哪位", [knowledge, untouched]),
  e("E07", "口语：啥来头（N07）", "越剧这玩意儿啥来头", [knowledge, untouched]),
  e("E08", "建议，条件在前（N08）", "能带狗进去的咖啡馆有没有推荐", [...advice, untouched]),
  e("E09", "方言建议（N09）", "天阴阴的，去哪儿耍比较巴适", [...advice, untouched]),
  e("E10", "长期饮食限制（N10）", "海鲜我一口都碰不了", [...preference, untouched]),
  e("E11", "长期节奏偏好（N11）", "我爸妈年纪大了，以后行程都悠着点", [...preference]),
  e("E12", "跳过一站（N12）", "博物馆那站不去了，直接下一个", [adjusted], { trip: true }),
  e("E13", "晚到，说法不在词表里（N13）", "堵车了，估计得晚个四十分钟", [adjusted], { trip: true }),
  e("E14", "完成一站 + 想吃东西（N14）", "喝完茶了，有点饿", [adjusted], { trip: true }),
  e("E15", "感叹（N15）", "哎呀今天太晒了", [untouched, noTools]),
  e("E16", "道谢，不改行程（N16）", "辛苦你啦，排得挺好", [untouched, tripUntouched, noTools], { trip: true }),
  e("E17", "规划 + 时效 + 知识（N17）", "明天带娃去少儿科技馆，要买票吗，顺便说说科技馆以前在哪", [bound("少儿科技馆"), { name: "asked_something", test: (outcome) => outcome.webQueries.length > 0 || outcome.knowledgeQuestions.length > 0 }]),
  e("E18", "像提问的规划（N18）", "晚上整两杯？", [changed]),
  e("E19", "否定调整，只问时效（N19）", "不是要改行程哈，就想知道灵峰古寺晚上开不开", [timely, tripUntouched], { trip: true }),
  e("E20", "指代：接受上一条的推荐（N20）", "那就第二个吧，明早出发", [bound("山顶观景台")], after("可以考虑湖畔公园或山顶观景台看日出。")),
  e("E21", "偏好 + 规划（N21）", "我平常不咋爱逛商场，明天想去自然一点的地方", [changed, ...preference]),
  e("E22", "新写：像提问的规划", "明天下午能不能找个茶馆坐坐", [cardSays(/茶/)]),
  e("E23", "新写：像提问的规划", "周六能不能带爸妈去湖畔公园转转", [bound("湖畔公园")]),
  e("E24", "新写：时效 + 规划", "越剧陈列馆周二开门吗，开的话明天就去", [bound("越剧陈列馆"), { name: "searched_web", test: (outcome) => outcome.webQueries.length > 0 }]),
];

export const ROUTE_E2E_VERSION = "v293-route-e2e.v1";
export function routeE2eDigest(): string {
  return createHash("sha256").update(JSON.stringify(ROUTE_E2E_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
