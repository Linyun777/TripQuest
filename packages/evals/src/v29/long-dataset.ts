import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "./conversation-run";

/**
 * V2.9 长对话（stages/V2.9.md §4.4）。为控制费用，更早的 24 条消息是固定的对话记录，只有最后
 * 一轮走真实模型；关键内容放在最前面，落在现在“最近 12 条”的窗口之外。最后一轮引用它，看
 * 能不能接上（对照 A：只带最近 12 条；对照 B：加滚动摘要）。关键内容都不在卡片上：卡片、
 * 行程和偏好本来就每轮都在上下文里，会丢的只有这些。
 */
export type Message = { readonly role: "user" | "assistant"; readonly text: string };
export const u = (text: string): Message => ({ role: "user", text });
export const a = (text: string): Message => ({ role: "assistant", text });

/** 中间的寻常规划往来（10 轮），和各题的关键内容无关。 */
export const FILLER: readonly Message[] = [
  u("明天想在城东逛一天"), a("好的，明天在城东逛一天。你想从哪里出发？"),
  u("从东门广场出发吧"), a("好，从东门广场出发。几点出发、几点结束？"),
  u("早上9点出发，下午6点回来"), a("明白，9点到18点，从东门广场出发再回来。"),
  u("想看看展览"), a("可以，我把看展加进兴趣了。"),
  u("中午想吃点本地小吃"), a("好的，中午加上本地小吃。"),
  u("出行的话坐公交和走路就行"), a("好，出行用步行加公交。"),
  u("下午想顺便买点伴手礼"), a("好，下午加上买伴手礼。"),
  u("天气怎么样"), a("明天天气不错，适合出门。"),
  u("下午想喝杯茶"), a("好，下午加上喝茶。"),
  u("差不多了"), a("好的，卡片已经整理好了，看看还缺什么，没问题就点“开始规划”。"),
];

const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const says = (name: string, pattern: RegExp): ConversationCheck => ({ name, test: (outcome) => pattern.test(last(outcome)) });
const onCard = (name: string, place: string): ConversationCheck => ({
  name,
  test: (outcome) =>
    outcome.draft.visits.some((visit) => visit.place.status === "bound" && visit.place.name === place) ||
    outcome.draft.interests.some((item) => item.text.includes(place)),
});

const long = (id: string, note: string, opening: readonly Message[], turn: string, checks: readonly ConversationCheck[], heldOut = false): ConversationCase => ({
  id,
  note,
  history: [...opening, ...FILLER],
  turns: [turn],
  checks,
  ...(heldOut ? { heldOut } : {}),
});

export const LONG_CASES: readonly ConversationCase[] = [
  long("L01", "朋友推荐的茶馆，最后要加进去",
    [u("对了，我朋友推荐过一家叫老街茶馆的地方，先记着，回头再说"), a("好的，记下了，需要的时候告诉我。")],
    "前面我朋友推荐的那家茶馆，帮我加到明天下午",
    [onCard("adds_that_place", "老街茶馆")]),
  long("L02", "你一开始推荐的看日落的地方",
    [u("哪里看日落比较好"), a("可以去湖畔公园，傍晚在湖边看日落很舒服。")],
    "你一开始推荐的那个看日落的地方叫什么来着",
    // v2：只说“湖畔公园”不够，把没推荐过的地方说成当初推荐的也算错（v1 基线里出现过）。
    [{ name: "names_it", test: (outcome) => /湖畔公园/.test(last(outcome)) && !/推荐的是(山顶观景台|城东夜景台)/.test(last(outcome)) }]),
  long("L03", "同行有老人，出行要照顾",
    [u("先说一下，我们一共四个人，其中两个是七十多岁的老人"), a("好的，我会考虑老人的体力。")],
    "出行方式你帮我重新定一下",
    [{ name: "considers_elders", test: (outcome) => outcome.draft.travel?.prefer === "less_walking" || /老人|长辈/.test(last(outcome)) }]),
  long("L04", "提过想看越剧，还没排",
    [u("我其实挺想看越剧的，不过还没想好哪天"), a("好的，想好哪天告诉我，我帮你排进去。")],
    "还有什么我之前提过想做、但还没排进去的吗",
    [says("remembers_opera", /越剧/)]),
  long("L05", "提过的书店",
    [u("上次路过一家叫旧书店的地方挺有意思，这次也想去"), a("好的，想去的话我可以帮你加上。")],
    "把我之前说的那家书店也加上",
    [onCard("adds_that_place", "旧书店")], true),
  long("L06", "提过的忌口",
    [u("先说好，我妈妈不能吃海鲜，吃饭的地方要注意"), a("好的，吃饭时会避开海鲜。")],
    "晚饭帮我找个地方，记得我前面说的忌口",
    [{ name: "remembers_no_seafood", test: (outcome) => /海鲜/.test(last(outcome)) || /海鲜/.test(outcome.draft.notes ?? "") }], true),
];

export const LONG_DATASET_VERSION = "v29-long.v2";
export function longDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(LONG_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
