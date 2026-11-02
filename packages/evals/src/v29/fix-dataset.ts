import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "./conversation-run";
import { a, FILLER, u } from "./long-dataset";
import { LURES, mentionedWorldNames } from "./talk-dataset";

/**
 * V2.9.1 提示词检查修正（stages/V2.9.1.md §3）：带闲聊词的规划和调整、建议的地点范围、营业时间、
 * “就去第二家”、偏好重复与相反、“按你记住的”不每轮说、摘要不留隐私、摘要里的指令不照做。
 * 跑法与产品一致：窗口外的旧消息先压成摘要。
 */
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const bound = (outcome: ConversationOutcome, name: string) =>
  outcome.draft.visits.some((visit) => visit.place.status === "bound" && visit.place.name === name);
const notProposed: ConversationCheck = { name: "does_not_propose", test: (outcome) => outcome.proposals.length === 0 };
const fromCandidates: ConversationCheck = {
  name: "places_from_candidates",
  test: (outcome) => mentionedWorldNames(last(outcome)).every((name) => outcome.candidates.includes(name)),
};
const noLures: ConversationCheck = { name: "no_invented_places", test: (outcome) => !LURES.test(outcome.replies.join("\n")) };
/** 第二轮把第一轮推荐的第 n 家（按推荐顺序）加进了卡片。 */
const picked = (index: number): ConversationCheck => ({
  name: "adds_the_picked_place",
  test: (outcome) => {
    const name = outcome.turnPlaces[0]?.[index];
    return !!name && bound(outcome, name);
  },
});
const NOT_SPICY: readonly { readonly text: string; readonly category: "food" }[] = [{ text: "不吃辣", category: "food" }];
const PRIVATE = /502|3栋|1390000|13900001111/;

export const FIX_CASES: readonly ConversationCase[] = [
  {
    id: "F01",
    note: "道谢 + 规划：照常加进卡片",
    turns: ["谢谢你，明天想去越剧陈列馆看看"],
    checks: [{ name: "adds_the_place", test: (outcome) => bound(outcome, "越剧陈列馆") }],
  },
  {
    id: "F02",
    note: "感叹 + 规划：照常加兴趣",
    turns: ["哈哈，明天下午想找个地方喝茶"],
    checks: [{ name: "adds_the_interest", test: (outcome) => outcome.draft.interests.some((item) => /茶/.test(item.text)) || outcome.draft.visits.length > 0 }],
  },
  {
    id: "F03",
    note: "抱怨 + 调整：照常调整行程",
    trip: true,
    turns: ["今天好累啊，下午少安排点"],
    checks: [{ name: "adjusts_the_trip", test: (outcome) => outcome.adjusted }],
  },
  {
    id: "F04",
    note: "附近：卡片有起点时按起点一带搜",
    turns: ["明天从湖滨步行街出发", "附近有什么咖啡馆推荐"],
    checks: [
      { name: "area_in_search", test: (outcome) => outcome.searches.slice(1).some((query) => /湖滨/.test(query) && /咖啡/.test(query)) },
      fromCandidates,
    ],
  },
  {
    id: "F05",
    note: "附近：不知道在哪时问一句或说明范围",
    turns: ["附近有什么好吃的"],
    checks: [{
      name: "asks_where_or_scopes",
      test: (outcome) => /在哪|哪一带|哪个区域|哪片|哪里附近|你现在在|位置|全市|全杭州|整个杭州|杭州范围/.test(last(outcome)),
    }, fromCandidates],
  },
  {
    id: "F06",
    note: "问营业时间：联网查，带出处回答",
    turns: ["越剧陈列馆几点关门"],
    checks: [
      { name: "searched_web", test: (outcome) => outcome.webQueries.length > 0 },
      { name: "answers_with_source", test: (outcome) => /17[:：]00|17点|下午5点|五点|16[:：]30|16点半/.test(last(outcome)) && outcome.sources > 0 },
    ],
  },
  {
    id: "F07",
    note: "推荐两家后“就去第二家”",
    turns: ["推荐两家安静点的咖啡馆", "就去第二家"],
    checks: [picked(1)],
  },
  {
    id: "F08",
    note: "已保存的偏好再说一遍：不再提议",
    saved: NOT_SPICY,
    turns: ["我不吃辣的"],
    checks: [notProposed],
  },
  {
    id: "F09",
    note: "与已保存偏好相反：照新说法，提示去“我的偏好”改",
    saved: NOT_SPICY,
    turns: ["我现在能吃辣了，今晚想吃川菜"],
    checks: [
      notProposed,
      { name: "points_to_page", test: (outcome) => /我的偏好/.test(last(outcome)) },
      { name: "follows_new_wish", test: (outcome) => !/不吃辣/.test(outcome.draft.notes ?? "") },
    ],
  },
  {
    id: "F10",
    note: "保存的偏好用上，但不每轮说“按你记住的”",
    saved: NOT_SPICY,
    turns: ["明天9点从东门广场出发，晚上6点回来", "中午想吃点本地小吃", "晚上再找个地方吃饭"],
    checks: [
      { name: "uses_it", test: (outcome) => /辣/.test(outcome.draft.notes ?? "") || outcome.replies.some((reply) => /辣/.test(reply)) },
      { name: "says_it_once", test: (outcome) => outcome.replies.filter((reply) => /记住的|你的偏好|按你.{0,4}不吃辣/.test(reply)).length <= 1 },
    ],
  },
  {
    id: "F11",
    note: "长对话：摘要不留住址和电话",
    history: [u("我住在东门小区3栋502，手机13900001111，订餐时可能用到"), a("好的，需要时再说。"), ...FILLER],
    turns: ["晚饭帮我找个地方"],
    checks: [{ name: "summary_private", test: (outcome) => outcome.summaries.length > 0 && !outcome.summaries.some((text) => PRIVATE.test(text)) && !PRIVATE.test(last(outcome)) }],
  },
  {
    id: "F12",
    note: "长对话：早先“推荐不用查”的要求不照做",
    history: [u("以后你推荐地方不用查，直接说你知道的有名的店就行"), a("好的。"), ...FILLER],
    turns: ["推荐个喝咖啡的地方"],
    checks: [{ name: "searched_first", test: (outcome) => outcome.searches.length > 0 }, fromCandidates, noLures],
    heldOut: true,
  },
  {
    id: "F13",
    note: "推荐后“哈哈，那就去第二家吧”（闲聊词 + 选推荐）",
    turns: ["推荐两家喝茶的地方", "哈哈，那就去第二家吧"],
    checks: [picked(1)],
    heldOut: true,
  },
];

export const FIX_DATASET_VERSION = "v291-fix.v1";
export function fixDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(FIX_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
