import { createHash } from "node:crypto";
import type { RouteCase, RouteFlag } from "../v29/route-dataset";

/**
 * V2.9.2 分流新留出题（stages/V2.9.2.md §3.2）：V2.9 的 15 条留出题已经用过两次，正则词表也是
 * 对着题集写的。这里只写正则没见过的说法（口语、方言、错别字、否定、混合意图、指代、像提问的
 * 规划），在写任何 Jev 代码之前定下真值并锁定；每种实现各跑一次正式结果，之后不再调。
 */
const n = (
  id: string,
  text: string,
  truth: readonly RouteFlag[],
  note: string,
  extra: Partial<Pick<RouteCase, "previous" | "hasTrip" | "cardEmpty">> = {},
): RouteCase => ({ id, text, truth, note, hasTrip: false, cardEmpty: true, heldOut: true, ...extra });

const TRIP = { hasTrip: true, cardEmpty: false } as const;

export const V292_ROUTE_CASES: readonly RouteCase[] = [
  n("N01", "明儿个想去西湖边溜达溜达", ["planning"], "方言：明儿个、溜达"),
  n("N02", "后天整点好吃的，再去河坊街晃一圈", ["planning"], "口语：整点、晃一圈"),
  n("N03", "灵隐寺得预约不", ["ask_timely"], "口语问句，没有“吗”"),
  n("N04", "灵引寺要预月吗", ["ask_timely"], "错别字"),
  n("N05", "那家几点打烊", ["ask_timely"], "指代 + 打烊", { previous: "转角咖啡馆环境不错，适合坐一会儿。" }),
  n("N06", "岳庙里头埋的是哪位", ["ask_knowledge"], "口语知识问题"),
  n("N07", "苏小小这个人啥来头", ["ask_knowledge"], "口语：啥来头"),
  n("N08", "能带狗进去的咖啡馆有没有推荐", ["advice"], "建议，条件在前"),
  n("N09", "天阴阴的，去哪儿耍比较巴适", ["advice"], "方言：耍、巴适"),
  n("N10", "海鲜我一口都碰不了", ["preference"], "长期饮食限制，没有“不吃”"),
  n("N11", "我爸妈年纪大了，以后行程都悠着点", ["preference"], "长期节奏偏好"),
  n("N12", "博物馆那站不去了，直接下一个", ["adjust"], "跳过一站", TRIP),
  n("N13", "堵车了，估计得晚个四十分钟", ["adjust"], "晚到，说法不在词表里", TRIP),
  n("N14", "喝完茶了，有点饿", ["adjust"], "完成一站 + 想吃东西", TRIP),
  n("N15", "哎呀今天太晒了", ["chitchat"], "感叹"),
  n("N16", "辛苦你啦，排得挺好", ["chitchat"], "道谢，不改卡片", { cardEmpty: false }),
  n("N17", "明天带娃去动物园，要买票吗，顺便说说动物园以前在哪", ["planning", "ask_timely", "ask_knowledge"], "规划 + 时效 + 知识"),
  n("N18", "晚上整两杯？", ["planning"], "像提问的规划（今晚喝酒）"),
  n("N19", "不是要改行程哈，就想知道雷峰塔晚上开不开", ["ask_timely"], "否定调整，只问时效", TRIP),
  n("N20", "那就第二个吧，明早出发", ["planning"], "指代：接受上一条的推荐", { previous: "可以考虑湖畔公园或山顶观景台看日出。" }),
  n("N21", "我平常不咋爱逛商场，明天想去自然一点的地方", ["planning", "preference"], "偏好 + 规划"),
];

export const V292_ROUTE_DATASET_VERSION = "v292-route-holdout.v1";
export function v292RouteDigest(): string {
  return createHash("sha256").update(JSON.stringify(V292_ROUTE_CASES)).digest("hex");
}
