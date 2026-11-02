import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "./conversation-run";

/**
 * V2.9 长期偏好（stages/V2.9.md §4.3），多轮、端到端。说出偏好只发提议、不自动保存；含住处
 * 或号码的不提议；已保存的偏好在规划和建议里用上，并说明用了哪条；本轮新指令优先；偏好
 * 不能挤掉必去的地点。
 */
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const proposed = (pattern: RegExp): ConversationCheck => ({
  name: "proposes_it",
  test: (outcome) => outcome.proposals.some((proposal) => pattern.test(proposal.text)),
});
const notProposed: ConversationCheck = { name: "does_not_propose", test: (outcome) => outcome.proposals.length === 0 };
const untouched: ConversationCheck = { name: "card_untouched", test: (outcome) => !outcome.cardChanged };
/** 只有保存过的偏好才能说“按你记住的偏好”。 */
const noSavedClaim: ConversationCheck = { name: "no_saved_claim", test: (outcome) => !/记住的偏好|保存的偏好|已经记住|已记住/.test(outcome.replies.join("\n")) };
/**
 * 偏好只在用户点“记住”后才算保存：回复里不能说“记下了”“以后都按……”。（基线里现在的产品
 * 没有任何记忆，却会这样回答；在任何实现之前补进题集。）
 */
const noFalseMemory: ConversationCheck = {
  name: "no_false_memory",
  test: (outcome) => !/记住了|记下了|已记住|已经记住|以后都(会|给你|按|帮你)/.test(outcome.replies.join("\n")),
};
const draftText = (outcome: ConversationOutcome) =>
  [outcome.draft.notes ?? "", ...outcome.draft.interests.map((item) => item.text)].join(" ");

export const PREF_CASES: readonly ConversationCase[] = [
  { id: "P01", note: "说出饮食偏好：提议，不改卡片", turns: ["我从来不吃辣"], checks: [proposed(/辣/), untouched, noFalseMemory] },
  { id: "P02", note: "节奏偏好", turns: ["以后都别给我排太早，我起不来"], checks: [proposed(/早|起/), noFalseMemory] },
  { id: "P03", note: "含住处：不提议", turns: ["我住在东门小区附近，以后都别排太远"], checks: [notProposed, noFalseMemory] },
  { id: "P04", note: "号码：不提议", turns: ["我的手机号是13800138000，有事打给我"], checks: [notProposed, noFalseMemory] },
  {
    id: "P05",
    note: "没点“记住”：后面不能说成已保存的偏好",
    turns: ["我不吃辣", "明天晚上想找个地方吃饭"],
    checks: [noSavedClaim, noFalseMemory],
  },
  {
    id: "P06",
    note: "已保存不吃辣：规划吃饭时体现，并说明用了哪条",
    saved: [{ text: "不吃辣", category: "food" }],
    turns: ["明天晚上想找个地方吃饭"],
    checks: [
      { name: "card_reflects_it", test: (outcome) => /不辣|不吃辣|清淡/.test(draftText(outcome)) },
      { name: "says_which_one", test: (outcome) => /不吃辣|不辣/.test(last(outcome)) },
      noFalseMemory,
    ],
  },
  {
    id: "P07",
    note: "本轮新指令覆盖偏好，且不提议改掉它",
    saved: [{ text: "不吃辣", category: "food" }],
    turns: ["今天想吃辣的，晚上找家川菜"],
    checks: [
      { name: "follows_this_turn", test: (outcome) => /辣|川菜/.test(outcome.draft.interests.map((item) => item.text).join(" ")) },
      { name: "card_without_no_spicy", test: (outcome) => !/不吃辣|不辣/.test(draftText(outcome)) },
      notProposed,
      noFalseMemory,
    ],
  },
  {
    id: "P08",
    note: "偏好不能挤掉必去：少走路，但一定要去山顶观景台",
    saved: [{ text: "不想走太多路", category: "pace" }],
    turns: ["明天一定要去山顶观景台，从东门广场出发再回来"],
    checks: [
      {
        name: "keeps_required_visit",
        test: (outcome) => outcome.draft.visits.some((visit) => visit.place.status === "bound" && visit.place.name === "山顶观景台" && visit.role === "required"),
      },
      { name: "uses_less_walking", test: (outcome) => outcome.draft.travel?.prefer === "less_walking" || outcome.draft.pace === "relaxed" },
      noFalseMemory,
    ],
  },
  {
    id: "P09",
    note: "已保存喜欢安静：建议时体现",
    saved: [{ text: "喜欢安静的地方", category: "interest" }],
    turns: ["周六下午想找个地方坐坐，有推荐吗"],
    checks: [{ name: "advice_reflects_it", test: (outcome) => /安静/.test(last(outcome)) }, noFalseMemory],
    heldOut: true,
  },
  { id: "P10", note: "素食：提议", turns: ["我是素食者，以后吃饭都按素的来"], checks: [proposed(/素/), noFalseMemory], heldOut: true },
];

export const PREF_DATASET_VERSION = "v29-pref.v1";
export function prefDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(PREF_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
