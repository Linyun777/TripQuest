import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { LURES, mentionedWorldNames } from "../v29/talk-dataset";
import type { LodgingCase } from "../v33/lodging-dataset";
import { SPLIT_WORLD } from "../v21/world";

/**
 * V3.4 题集 `v34-split.v1`（stages/V3.4.md §4.1），写在拆分之前，锁定后不改。两部分：
 * - 对话题（S 开头）：混合意图、正则分错时的补救、每个专门 Agent 的单一意图。检查的是结果（卡片、行程、查了
 *   什么、回复），不是分流标签或跑了哪个 Agent；拆开前的产品（一个 Agent）也按同样的检查判分。每题另有两条
 *   共同检查：每条回复不超过 240 字、最多一个问号（一轮最多一个问题）。
 * - 搜索兜底题（F 开头）：照 V3.3 用户原题（只说“看熊猫”）在评测世界里搭的出游（v21/world.ts 的 SPLIT_WORLD：
 *   云岭南站旁三家名字带“丹顶鹤”的店，真正的繁育基地在二十公里外）。规则分配、产品逐天生成（同 V3.3 住处题），
 *   判分沿用住处题，另加“排到了繁育基地”。
 * 留出：S15–S17、F02。通过标准见 §4.2（开发中不改）。
 */
export const SPLIT_DATASET_VERSION = "v34-split.v1";

const QUESTION = /[？?]/g;
const FOUND_NOTHING = /没(有)?(查|搜|找)到|查不到|找不到|暂无|没有(相关|可靠|确切)/;
const CLAIMS_SAVED = /记住了|记下了|已记住|已经记住|已保存|以后都(会|给你|按|帮你)/;
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";

const bound = (name: string): ConversationCheck => ({
  name: "card_has_place",
  test: (outcome) => outcome.draft.visits.some((visit) => visit.place.status === "bound" && visit.place.name === name),
});
const cardSays = (pattern: RegExp): ConversationCheck => ({
  name: "card_changed_as_asked",
  test: (outcome) => outcome.cardChanged && pattern.test(JSON.stringify(outcome.draft)),
});
const untouched: ConversationCheck = { name: "card_untouched", test: (outcome) => !outcome.cardChanged };
const adjusted: ConversationCheck = { name: "adjusted", test: (outcome) => outcome.adjusted };
const tripUntouched: ConversationCheck = { name: "trip_untouched", test: (outcome) => !outcome.adjusted };
const noTools: ConversationCheck = {
  name: "no_tools",
  test: (outcome) => !outcome.searches.length && !outcome.webQueries.length && !outcome.knowledgeQuestions.length,
};
/** 时效问题：联网查了，带出处回答或照实说没查到。 */
const timely: ConversationCheck = {
  name: "web_answer",
  test: (outcome) => outcome.webQueries.length > 0 && (outcome.sources > 0 || FOUND_NOTHING.test(last(outcome))),
};
/** 背景问题：查了资料库，回答带出处。 */
const knowledge: ConversationCheck = {
  name: "knowledge_answer",
  test: (outcome) => outcome.knowledgeQuestions.length > 0 && outcome.sources > 0,
};
/** 建议：先查地点，推荐的都来自本轮候选，不说虚构世界之外的店名，至少推荐一个。 */
const advice: readonly ConversationCheck[] = [
  { name: "searched_first", test: (outcome) => outcome.searches.length > 0 },
  { name: "places_from_candidates", test: (outcome) => mentionedWorldNames(last(outcome)).every((name) => outcome.candidates.includes(name)) },
  { name: "recommends_some", test: (outcome) => outcome.places.length > 0 || mentionedWorldNames(last(outcome)).length > 0 },
  { name: "no_invented_places", test: (outcome) => !LURES.test(outcome.replies.join("\n")) },
];
/** 长期偏好：提议了“要记住吗”，没说已经记住。 */
const preference: readonly ConversationCheck[] = [
  { name: "proposes_preference", test: (outcome) => outcome.proposals.length > 0 },
  { name: "no_false_memory", test: (outcome) => !CLAIMS_SAVED.test(outcome.replies.join("\n")) },
];
/** 每题都查：回复不超过 240 字、一轮最多一个问题（拼接两段回复时最容易超）。 */
const everyCase: readonly ConversationCheck[] = [
  { name: "reply_within_240", test: (outcome) => outcome.replies.every((text) => [...text].length <= 240) },
  { name: "one_question", test: (outcome) => outcome.replies.every((text) => (text.match(QUESTION) ?? []).length <= 1) },
];

const s = (id: string, note: string, turn: string, checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns: [turn], checks: [...checks, ...everyCase], ...extra });

export const SPLIT_CHAT_CASES: readonly ConversationCase[] = [
  // 混合意图
  s("S01", "规划 + 时效提问", "明天去灵峰古寺，要预约吗", [bound("灵峰古寺"), timely]),
  s("S02", "规划 + 长期偏好", "我从来不吃辣，明天想去本地小吃街逛逛", [cardSays(/小吃/), ...preference]),
  s("S03", "闲聊 + 规划", "谢谢你呀！对了，明天下午想找个茶馆坐坐", [cardSays(/茶/)]),
  s("S04", "时效提问 + 建议", "灵峰古寺要预约吗？顺便推荐个能喝茶的地方", [timely, ...advice, untouched]),
  s("S05", "已保存行程：调整 + 时效提问", "博物馆看完了，戏曲小剧场今天有越剧演出吗", [adjusted, timely], { trip: true }),
  // 正则分错时的补救
  s("S06", "像提问的规划（正则判成提问）", "下周一能带孩子去少儿科技馆玩玩吗", [bound("少儿科技馆")]),
  s("S07", "有已保存行程时说另一天的新计划", "后天想去西郊湿地看看鸟", [bound("西郊湿地"), tripUntouched], { trip: true }),
  // 单一意图：每个专门 Agent 一到两题
  s("S08", "需求理解", "明天上午去城东博物馆看展，下午喝杯茶", [bound("城东博物馆"), cardSays(/茶/)]),
  s("S09", "背景知识", "越剧最早是怎么来的？", [knowledge, untouched]),
  s("S10", "建议", "推荐一家安静点的咖啡馆", [...advice, untouched]),
  s("S11", "闲聊", "今天天气真不错，心情很好", [untouched, noTools]),
  s("S12", "长期偏好", "我膝盖不好，以后别给我排爬山", [...preference, untouched]),
  s("S13", "改行程", "越剧不去了", [adjusted], { trip: true }),
  s("S14", "改行程：晚到", "路上堵车，大概要晚半小时到", [adjusted], { trip: true }),
  // 留出
  s("S15", "留出：规划 + 背景知识", "明天去越剧陈列馆，顺便讲讲越剧是怎么来的", [bound("越剧陈列馆"), knowledge], { heldOut: true }),
  s("S16", "留出：像提问的规划", "这周日能不能去东郊大学城那边转一圈", [bound("东郊大学城")], { heldOut: true }),
  s("S17", "留出：有已保存行程时说另一天的新计划", "周六再去茶园观景台转转", [bound("茶园观景台"), tripUntouched], { trip: true, heldOut: true }),
];

/** 搜索兜底题：住处题的一张出游卡片，加上一定要排到的地点（世界编号）。 */
export interface SplitOutingCase extends LodgingCase {
  readonly reach: string;
}

const PUBLIC = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;
const YL = "990100";

export const SPLIT_OUTING_CASES: readonly SplitOutingCase[] = [
  {
    id: "F01", note: "用户原题的样子：杭州东站往返坐高铁、没填车次、没说住哪，想吃火锅、看丹顶鹤（车站旁只有名字带丹顶鹤的店）",
    dates: { from: "2026-10-17", to: "2026-10-19" }, start: { place: "V21-HZ-EAST" }, end: { place: "V21-HZ-EAST" }, lodging: [null, null],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH" },
      { day: 3, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST" },
    ],
    visits: [], interests: [{ text: "吃火锅" }, { text: "看丹顶鹤" }], travel: PUBLIC,
    expect: { cities: [[YL], [YL], [YL]], nights: [{ city: YL, segment: "A" }, { city: YL, segment: "A" }] },
    reach: "V34-Y-CRANE",
  },
  {
    id: "F02", note: "留出：两天、只想看丹顶鹤：应排到繁育基地，住处在基地附近（3 公里内）", heldOut: true,
    dates: { from: "2026-10-17", to: "2026-10-18" }, start: { place: "V21-HZ-EAST" }, end: { place: "V21-HZ-EAST" }, lodging: [null],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH" },
      { day: 2, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST" },
    ],
    visits: [], interests: [{ text: "看丹顶鹤" }], travel: PUBLIC,
    expect: { cities: [[YL], [YL]], nights: [{ city: YL, segment: "A" }], area: { place: "V34-Y-CRANE", nights: [1] } },
    reach: "V34-Y-CRANE",
  },
];

/** 题目、检查（连同判分代码）和评测世界的补充一起算摘要，改了哪一样都看得出来。 */
export function splitDatasetDigest(): string {
  const chat = SPLIT_CHAT_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => [check.name, check.test.toString()]) }));
  return createHash("sha256").update(JSON.stringify({ chat, outing: SPLIT_OUTING_CASES, world: SPLIT_WORLD })).digest("hex");
}
