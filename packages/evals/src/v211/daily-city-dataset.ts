import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { LANXI, YUNLING } from "../v21/world";

/**
 * V2.11 日常只做单城市（stages/V2.11.md §3.1、§4.1，D-072）。在评测世界里端到端跑：定位在某个城市时，
 * 外地的地点或城市不进卡片、给出“切到出游”的引导（`outside`）、回复不说已经排上；只是说到外地
 * （“成都那种火锅”“北京烤鸭”）不算；没有定位时说“我在云岭”就换城市。写在任何实现之前，锁定后不改。
 */
export const HANGZHOU = { adcode: "330100", name: "杭州市" } as const;
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
const cityOf = (outcome: ConversationOutcome) => (outcome.draft as { city?: { adcode?: string } }).city?.adcode ?? HANGZHOU.adcode;
const placeNames = (outcome: ConversationOutcome) => [
  outcome.draft.start, outcome.draft.end, ...outcome.draft.visits.map((visit) => visit.place),
].flatMap((place) => (place && place.status === "bound" ? [place.name] : []));

export const city = (adcode: string): ConversationCheck => ({ name: "card_city", test: (outcome) => cityOf(outcome) === adcode });
const bound = (name: string): ConversationCheck => ({ name: `bound_${name}`, test: (outcome) => placeNames(outcome).includes(name) });
const changed: ConversationCheck = { name: "card_changed", test: (outcome) => outcome.cardChanged };
/** 页面给出了“切到出游”的引导，并且引导里有这个地点或城市。 */
export const guided = (pattern: RegExp): ConversationCheck => ({
  name: "guided_to_outing",
  test: (outcome) => outcome.outside.some((name) => pattern.test(name)),
});
/** 外地的地点没有进卡片（既没绑定，也没写成兴趣）。 */
export const notOnCard = (pattern: RegExp): ConversationCheck => ({
  name: "outside_not_on_card",
  test: (outcome) => !placeNames(outcome).some((name) => pattern.test(name)) && !outcome.draft.interests.some((item) => pattern.test(item.text)),
});
/** 回复说明了日常只管本市、可以切到出游，没有说已经排上。 */
export const explains: ConversationCheck = {
  name: "reply_points_to_outing",
  test: (outcome) => /出游/.test(last(outcome)) && !/(已经|已|帮你|给你)(加|排|安排)(上|进|好)/.test(last(outcome)),
};
const noGuide: ConversationCheck = { name: "not_guided", test: (outcome) => outcome.outside.length === 0 };

const c = (id: string, note: string, turns: readonly string[], checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns, checks, ...extra });

export const DAILY_CITY_CASES: readonly ConversationCase[] = [
  c("D01", "点名外地地点：不进卡片，引导到出游", ["明天去岚溪花海看花"], [
    city(HANGZHOU.adcode), guided(/岚溪花海/), notOnCard(/岚溪花海/), explains,
  ], { located: HANGZHOU }),
  c("D02", "只说了要去的外地城市：引导到出游", ["这周日想去岚溪市转转"], [
    city(HANGZHOU.adcode), guided(/岚溪/), explains,
  ], { located: HANGZHOU }),
  c("D03", "“成都那种火锅”不是去外地", ["晚上想吃成都那种火锅"], [city(HANGZHOU.adcode), noGuide, changed], { located: HANGZHOU }),
  c("D04", "“北京烤鸭”不是去外地", ["明天中午想吃北京烤鸭"], [city(HANGZHOU.adcode), noGuide, changed], { located: HANGZHOU }),
  c("D05", "本市的照常进卡片，外地的那个引导", ["明天先去青石古镇，再去岚溪水乡"], [
    city(YUNLING.adcode), bound("青石古镇"), guided(/岚溪水乡/), notOnCard(/岚溪水乡/),
  ], { located: YUNLING }),
  c("D06", "没有定位，说“我在云岭”：换城市，照常规划", ["我在云岭，明天想吃火锅"], [city(YUNLING.adcode), noGuide, changed]),
  c("D07", "没有定位，从外地的车站出发：城市跟着换", ["明天从云岭站出发去云岭山顶看日出"], [
    city(YUNLING.adcode), bound("云岭山顶"), noGuide,
  ]),
  c("D08", "点名外地的古镇：引导到出游", ["周六去青石古镇逛逛"], [
    city(HANGZHOU.adcode), guided(/青石古镇/), notOnCard(/青石古镇/), explains,
  ], { located: HANGZHOU }),
  c("D09", "留出：没有定位，人在岚溪", ["我在岚溪，想去花海看看"], [city(LANXI.adcode), noGuide], { heldOut: true }),
  c("D10", "留出：外地的主题乐园", ["后天带娃去云岭欢乐谷"], [
    city(HANGZHOU.adcode), guided(/欢乐谷/), notOnCard(/欢乐谷/), explains,
  ], { located: HANGZHOU, heldOut: true }),
];

export const DAILY_CITY_DATASET_VERSION = "v211-daily-city.v1";
export function dailyCityDatasetDigest(): string {
  const shape = DAILY_CITY_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) }));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
