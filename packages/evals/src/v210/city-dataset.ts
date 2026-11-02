import { createHash } from "node:crypto";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { YUNLING } from "../v21/world";
import { explains, guided, notOnCard } from "../v211/daily-city-dataset";

/**
 * V2.10 城市理解与资料库过滤（stages/V2.10.md §4.2），在评测世界里端到端跑（杭州世界 + 虚构的云岭市、
 * 邻市岚溪）。检查的是卡片上的城市、绑定的地点和回复，不看实现细节。写在任何城市代码之前，锁定后
 * 不改；用现在的产品跑基线（预期：卡片没有城市，云岭的地点按杭州搜不到）。
 */
const HANGZHOU = { adcode: "330100", name: "杭州市" } as const;
const last = (outcome: ConversationOutcome) => outcome.replies.at(-1) ?? "";
/** 卡片上的城市；没有就是杭州（旧草稿缺省杭州）。 */
const cityOf = (outcome: ConversationOutcome) => (outcome.draft as { city?: { adcode?: string } }).city?.adcode ?? HANGZHOU.adcode;
const placeNames = (outcome: ConversationOutcome) => [
  outcome.draft.start, outcome.draft.end, ...outcome.draft.visits.map((visit) => visit.place),
].flatMap((place) => (place && place.status === "bound" ? [place.name] : []));

/** 卡片上提到某一带（绑定的地点或兴趣）：“去湖滨步行街逛逛”按规则是兴趣，不一定绑定地点。 */
const onCard = (name: string, pattern: RegExp): ConversationCheck => ({
  name: `on_card_${name}`,
  test: (outcome) => placeNames(outcome).some((place) => pattern.test(place)) || outcome.draft.interests.some((item) => pattern.test(item.text)),
});
const city = (adcode: string): ConversationCheck => ({ name: "card_city", test: (outcome) => cityOf(outcome) === adcode });
const bound = (name: string): ConversationCheck => ({ name: `bound_${name}`, test: (outcome) => placeNames(outcome).includes(name) });
const changed: ConversationCheck = { name: "card_changed", test: (outcome) => outcome.cardChanged };
/** 在云岭说话时，回复不该把这里说成杭州（提示词去杭州化）。 */
const notHangzhou: ConversationCheck = { name: "not_called_hangzhou", test: (outcome) => !/杭州/.test(outcome.replies.join("\n")) };
/** 没有用杭州的地点凑数（云岭的规划卡片上不该出现杭州世界的地点）。 */
const noHangzhouPlaces: ConversationCheck = {
  name: "no_hangzhou_places",
  test: (outcome) => !placeNames(outcome).some((name) => /东门广场|湖滨|城东|老街|戏曲小剧场|越剧陈列馆/.test(name)),
};
/** 没有出发位置：不能编一个起点，回复里要说从哪出发或请求位置。 */
const asksStart: ConversationCheck = {
  name: "asks_for_start",
  test: (outcome) => outcome.draft.start?.status !== "bound" &&
    /从哪(里|儿)?出发|允许.{0,6}(位置|定位)|获取.{0,6}位置|开启定位|告诉我.{0,8}(出发|在哪)|出发地/.test(last(outcome)),
};

const c = (id: string, note: string, turns: readonly string[], checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns, checks, ...extra });

export const CITY_CASES: readonly ConversationCase[] = [
  c("Y01", "定位在云岭：按云岭找，回复不说杭州", ["明天想吃火锅，再逛逛小吃街"], [city(YUNLING.adcode), changed, noHangzhouPlaces, notHangzhou], { located: YUNLING }),
  c("Y02", "没有定位：缺省杭州，照常用杭州的地点", ["明天想去湖滨步行街逛逛"], [city(HANGZHOU.adcode), onCard("湖滨", /湖滨/)]),
  c("Y03", "定位在杭州，明说去云岭：V2.11 起引导到出游", ["下周六去云岭市玩一天，想爬云岭山"], [city(HANGZHOU.adcode), guided(/云岭/), explains], { located: HANGZHOU }),
  c("Y04", "点名的地点在别的城市：V2.11 起不进卡片，引导到出游", ["明天从云岭站出发去云岭山爬山"], [
    city(HANGZHOU.adcode), guided(/云岭/), notOnCard(/云岭/),
  ], { located: HANGZHOU }),
  c("Y05", "邻市的地点：V2.11 起不进卡片，引导到出游", ["明天从云岭站出发，去岚溪花海玩一天"], [
    city(YUNLING.adcode), guided(/岚溪花海/), notOnCard(/岚溪花海/),
  ], { located: YUNLING }),
  c("Y06", "没有定位也没说从哪出发：不编起点，问从哪出发", ["明天想吃点好吃的"], [asksStart]),
  c("Y07", "中途说去别的城市：V2.11 起引导到出游，原来的不悄悄删", ["明天去湖滨步行街逛逛", "算了，改成去云岭市玩，想去云岭博物馆"], [
    city(HANGZHOU.adcode),
    guided(/云岭/),
    notOnCard(/云岭博物馆/),
    {
      name: "old_place_kept_or_mentioned",
      test: (outcome) => placeNames(outcome).some((name) => /湖滨/.test(name)) ||
        outcome.draft.interests.some((item) => /湖滨/.test(item.text)) || /湖滨/.test(last(outcome)),
    },
  ], { located: HANGZHOU }),
  c("Y08", "说到杭州但不是要去杭州：城市不变", ["想找个像杭州那样的茶馆坐坐"], [city(YUNLING.adcode)], { located: YUNLING }),
  c("Y09", "早出发看日出：5 点出发", ["明天看日出，早上5点从云岭站出发去云岭山顶"], [
    city(YUNLING.adcode),
    bound("云岭山顶"),
    { name: "starts_at_five", test: (outcome) => outcome.draft.startsAt === "05:00" },
  ], { located: YUNLING }),
  c("Y10", "人在云岭，说要回杭州玩：V2.11 起引导到出游", ["这周六想回杭州，去湖滨步行街走走"], [
    city(YUNLING.adcode), guided(/杭州|湖滨/), notOnCard(/湖滨/),
  ], { located: YUNLING, heldOut: true }),
  c("Y11", "留出：云岭的古镇 + 海鲜", ["带爸妈去青石古镇走走，然后吃点海鲜"], [city(YUNLING.adcode), bound("青石古镇"), noHangzhouPlaces, notHangzhou], { located: YUNLING, heldOut: true }),
  c("Y12", "留出：点名邻市的地点，V2.11 起引导到出游", ["后天去岚溪水乡玩"], [
    city(HANGZHOU.adcode), guided(/岚溪水乡/), notOnCard(/岚溪水乡/),
  ], { located: HANGZHOU, heldOut: true }),
];

/**
 * 资料库过滤：在云岭问背景，资料库里只有杭州的资料，不能拿来回答（应转联网，或说没查到）；
 * 杭州照旧引用资料库。假资料库会按字面把“寺、茶、戏”命中到杭州那几段，模拟语义检索的误命中。
 */
const noHangzhouKnowledge: ConversationCheck = {
  name: "no_hangzhou_passages",
  test: (outcome) => !outcome.sourceKinds.includes("kb") && !/灵隐|龙井|越剧|西湖|杭州/.test(last(outcome)),
};
const webOrNothing: ConversationCheck = {
  name: "web_or_says_nothing",
  test: (outcome) => outcome.webQueries.length > 0 || /没(有)?(查|搜|找)到|查不到|暂无|没有(相关|这方面)/.test(last(outcome)),
};
export const KB_CITY_CASES: readonly ConversationCase[] = [
  c("B01", "云岭问古寺来历：不能引用灵隐寺", ["云岭古寺有什么来历"], [noHangzhouKnowledge, webOrNothing], { located: YUNLING, cityKnowledge: true }),
  c("B02", "云岭问茶：不能引用龙井", ["这边的茶叶有什么讲究"], [noHangzhouKnowledge, webOrNothing], { located: YUNLING, cityKnowledge: true }),
  c("B03", "云岭问戏曲：不能引用越剧", ["当地有什么传统戏曲"], [noHangzhouKnowledge, webOrNothing], { located: YUNLING, cityKnowledge: true }),
  c("B04", "对照：杭州问灵隐寺，照旧引用资料库", ["灵隐寺是谁建的"], [
    { name: "cites_knowledge_base", test: (outcome) => outcome.sourceKinds.includes("kb") },
  ], { cityKnowledge: true }),
];

/** v2（基线后、任何实现前的判分修正）：“去湖滨步行街逛逛”按规则是兴趣，Y02、Y07、Y10 改成卡片上提到湖滨即可。 */
/**
 * v3（V2.11，规则变化不是调题，D-072）：日常只做单城市，Y03、Y04、Y05、Y07、Y10、Y12 从“跨城市照样排”
 * 改成“引导到出游”；这几类在出游题集里重新出现。
 */
export const CITY_DATASET_VERSION = "v210-city.v3";
export function cityDatasetDigest(): string {
  const shape = (cases: readonly ConversationCase[]) => cases.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) }));
  return createHash("sha256").update(JSON.stringify([shape(CITY_CASES), shape(KB_CITY_CASES)])).digest("hex");
}
