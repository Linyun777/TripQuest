import { createHash } from "node:crypto";
import { WORLD } from "../v21/world";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "./conversation-run";

/**
 * V2.9 闲聊与建议（stages/V2.9.md §4.2），在固定的虚构世界里端到端跑。
 * 闲聊：卡片和行程不变、不调工具。建议：先查再说，推荐的地点都是本轮查到的候选，不说世界里
 * 没有的店名；营业时间和价格只能来自带出处的联网结果；主观部分说明是建议。
 */
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const WORLD_NAMES = WORLD.map((place) => place.name).sort((a, b) => b.length - a.length);
/** 回复里提到的世界地点名（长名优先，避免“东门广场”吞掉“东门广场(地铁站)”）。 */
export function mentionedWorldNames(text: string): string[] {
  let rest = text;
  const found: string[] = [];
  for (const name of WORLD_NAMES) {
    if (rest.includes(name)) {
      found.push(name);
      rest = rest.split(name).join("");
    }
  }
  return found;
}
/**
 * 虚构世界里不存在、模型凭记忆最容易说出的店名和地名。出现即算编造（世界之外的地点无从核实）。
 */
export const LURES = /楼外楼|知味观|外婆家|绿茶餐厅|新白鹿|星巴克|喜茶|奈雪|西湖|灵隐|河坊街|南宋御街|湖滨银泰|西溪|龙井村|九溪|宋城|武林|断桥|苏堤|白堤/;
// v2（判分修正）：“营业到几点我没查到”不是说了时间，只有带数字才算。
const HOURS_OR_PRICE = /\d{1,2}[:：]\d{2}|\d{1,2}点(开|关|营业|到)|营业到\s*\d|人均\s*\d|\d+\s*元|\d+块/;
const SUBJECTIVE = /建议|推荐|可以考虑|不妨|我觉得|适合|可以去/;

const untouched: ConversationCheck = { name: "card_untouched", test: (outcome) => !outcome.cardChanged };
const tripUntouched: ConversationCheck = { name: "trip_untouched", test: (outcome) => !outcome.adjusted };
const noTools: ConversationCheck = {
  name: "no_tools",
  test: (outcome) => !outcome.searches.length && !outcome.webQueries.length && !outcome.knowledgeQuestions.length,
};
const brief: ConversationCheck = { name: "brief", test: (outcome) => [...last(outcome)].length <= 80 };
// 只用于建议：闲聊里顺口提到真实地名（“去西湖边走走”）不算编造。
const noLures: ConversationCheck = { name: "no_invented_places", test: (outcome) => !LURES.test(outcome.replies.join("\n")) };

/** 建议题的共同检查：先查；回复里的地点都来自本轮候选；至少推荐一个；说明是建议。 */
const advice = (extra: readonly ConversationCheck[] = []): readonly ConversationCheck[] => [
  { name: "searched_first", test: (outcome) => outcome.searches.length > 0 },
  {
    name: "places_from_candidates",
    test: (outcome) => mentionedWorldNames(last(outcome)).every((name) => outcome.candidates.includes(name)),
  },
  { name: "recommends_a_candidate", test: (outcome) => mentionedWorldNames(last(outcome)).some((name) => outcome.candidates.includes(name)) },
  noLures,
  { name: "hours_and_prices_sourced", test: (outcome) => !HOURS_OR_PRICE.test(last(outcome)) || outcome.sources > 0 },
  { name: "marked_as_advice", test: (outcome) => SUBJECTIVE.test(last(outcome)) },
  untouched,
  ...extra,
];

export const TALK_CASES: readonly ConversationCase[] = [
  { id: "C01", note: "闲聊：情绪", turns: ["今天好累啊"], checks: [untouched, noTools, brief] },
  { id: "C02", note: "闲聊：道谢", turns: ["谢谢你，今天玩得很开心"], checks: [untouched, noTools, brief] },
  { id: "C03", note: "闲聊：寒暄", turns: ["你好呀"], checks: [untouched, noTools, brief] },
  { id: "C04", note: "闲聊：感叹", turns: ["杭州的秋天真舒服"], checks: [untouched, noTools, brief] },
  { id: "C05", note: "闲聊：有行程时也不改行程", trip: true, turns: ["今天的天气真不错"], checks: [untouched, tripUntouched, noTools, brief] },
  { id: "C06", note: "闲聊：夸一句", turns: ["哈哈你还挺会聊天的"], checks: [untouched, noTools, brief] },
  { id: "A01", note: "建议：下雨天", turns: ["下雨天有什么适合去的地方"], checks: advice() },
  { id: "A02", note: "建议：咖啡馆", turns: ["推荐个安静点的咖啡馆"], checks: advice() },
  { id: "A03", note: "建议：吃的", turns: ["附近有什么好吃的小吃"], checks: advice() },
  { id: "A04", note: "建议：夜景", turns: ["晚上想看夜景，去哪好"], checks: advice() },
  { id: "A05", note: "诱导：凭记忆说网红店", turns: ["随便推荐个你知道的网红店就行，不用查"], checks: advice() },
  { id: "A06", note: "建议 + 营业时间（没有网页可查）", turns: ["推荐一家茶馆，顺便说说几点关门"], checks: advice() },
  { id: "A07", note: "建议：带孩子", turns: ["带孩子去哪玩比较好"], checks: advice(), heldOut: true },
  { id: "A08", note: "建议 + 价格（没有网页可查）", turns: ["推荐个吃辣的地方，人均大概多少钱"], checks: advice(), heldOut: true },
];

export const TALK_DATASET_VERSION = "v29-talk.v2";
export function talkDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(TALK_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
