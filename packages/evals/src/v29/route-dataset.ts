import { createHash } from "node:crypto";

/**
 * V2.9 意图分流评测（stages/V2.9.md §4.1）：每条消息标注 7 个可以同时成立的判断。
 * 真值按产品规则手写，在任何分流实现跑之前定下；留出题只在阶段最后跑。
 * 消息来自已有评测（需求理解、调整、信息问答、资料库）的问法，加新写的闲聊、建议、偏好、
 * 混合意图、否定和指代；包含 V2.8 漏掉的问法与 I29 那类“像提问的规划消息”。
 */
export const ROUTE_FLAGS = ["planning", "adjust", "ask_timely", "ask_knowledge", "advice", "chitchat", "preference"] as const;
export type RouteFlag = (typeof ROUTE_FLAGS)[number];
export type RouteFlags = Readonly<Record<RouteFlag, boolean>>;

export interface RouteInput {
  readonly text: string;
  /** 上一条助手消息（理解“那个呢”这类指代）。 */
  readonly previous?: string;
  /** 这个对话已有保存的今天行程。 */
  readonly hasTrip: boolean;
  /** 需求卡片还是空的。 */
  readonly cardEmpty: boolean;
}

export interface RouteCase extends RouteInput {
  readonly id: string;
  readonly note: string;
  /** 为真的判断；没列出的为假。 */
  readonly truth: readonly RouteFlag[];
  readonly heldOut?: boolean;
}

const c = (
  id: string,
  text: string,
  truth: readonly RouteFlag[],
  note: string,
  extra: Partial<Pick<RouteCase, "previous" | "hasTrip" | "cardEmpty" | "heldOut">> = {},
): RouteCase => ({ id, text, truth, note, hasTrip: false, cardEmpty: true, ...extra });

export const ROUTE_CASES: readonly RouteCase[] = [
  // 规划
  c("T01", "明天9点从东门广场出发，想看展、喝茶，晚上6点回来", ["planning"], "纯规划"),
  c("T02", "明天白天逛逛湖滨，晚上找个地方喝一杯", ["planning"], "I29：像提问的规划"),
  c("T03", "现在想去喝杯咖啡", ["planning"], "短途"),
  c("T04", "周六带孩子玩一天，少走路", ["planning"], "规划带软要求"),
  c("T05", "我晚上想吃铁板烧然后去喝点酒", ["planning"], "今天晚些时候的短途"),
  c("T06", "后天去湖滨逛逛", ["planning"], "有行程时说另一天：仍是规划", { hasTrip: true, cardEmpty: false }),
  // 调整已保存的行程
  c("T07", "博物馆逛完了，越剧也不去了", ["adjust"], "完成与跳过", { hasTrip: true, cardEmpty: false }),
  c("T08", "我会晚到半小时", ["adjust"], "晚到", { hasTrip: true, cardEmpty: false }),
  c("T09", "茶馆换成喝咖啡", ["adjust"], "替换", { hasTrip: true, cardEmpty: false }),
  c("T10", "今天走累了，后面的少安排点", ["adjust"], "本次状态走调整", { hasTrip: true, cardEmpty: false }),
  // 时效信息
  c("T11", "灵隐寺要提前预约吗", ["ask_timely"], "预约"),
  c("T12", "这周末有越剧演出吗", ["ask_timely"], "演出"),
  c("T13", "浙江省博物馆周一开门吗", ["ask_timely"], "闭馆日"),
  c("T14", "宋城门票多少钱", ["ask_timely"], "门票"),
  // 背景知识
  c("T15", "苏堤是谁修的", ["ask_knowledge"], "V2.8 漏过的“谁”"),
  c("T16", "越剧有哪些代表剧目", ["ask_knowledge"], "V2.8 漏过的“有哪些”"),
  c("T17", "讲讲龙井茶的历史", ["ask_knowledge"], "讲讲"),
  c("T18", "西湖十景是怎么来的", ["ask_knowledge"], "由来"),
  c("T19", "雷峰塔为什么会倒", ["ask_knowledge"], "为什么"),
  // 混合
  c("T20", "明天去灵隐寺，要预约吗", ["planning", "ask_timely"], "规划 + 时效"),
  c("T21", "明天想去六和塔，顺便讲讲它的来历", ["planning", "ask_knowledge"], "规划 + 知识"),
  c("T22", "明天去越剧陈列馆看看，它周二开门吗", ["planning", "ask_timely"], "V2.7 Q10"),
  // 建议
  c("T23", "下雨天有什么适合去的地方", ["advice"], "建议"),
  c("T24", "推荐个安静点的咖啡馆", ["advice"], "建议，无问号"),
  c("T25", "附近有什么好吃的", ["advice"], "建议"),
  c("T26", "带老人去哪儿比较好", ["advice"], "建议"),
  c("T27", "晚上去哪里看夜景好", ["advice"], "建议"),
  // 闲聊
  c("T28", "今天好累啊", ["chitchat"], "情绪（没有行程）"),
  c("T29", "谢谢你", ["chitchat"], "寒暄"),
  c("T30", "你好", ["chitchat"], "寒暄"),
  c("T31", "哈哈哈你真有意思", ["chitchat"], "闲聊"),
  c("T32", "杭州的秋天真舒服", ["chitchat"], "闲聊"),
  // 长期偏好
  c("T33", "我从来不吃辣", ["preference"], "饮食偏好"),
  c("T34", "我膝盖不好，一直不太能走路", ["preference"], "体力偏好"),
  c("T35", "以后都别给我排太早，我起不来", ["preference"], "节奏偏好"),
  c("T36", "我比较喜欢安静的地方", ["preference"], "兴趣偏好"),
  // 否定与“只是问问”
  c("T37", "不是要去，就问问灵隐寺要不要预约", ["ask_timely"], "否定：不规划"),
  c("T38", "只是好奇，岳王庙是什么时候建的", ["ask_knowledge"], "只是问问"),
  // 指代
  c("T39", "第一家要排队吗", ["ask_timely"], "指代上一条的推荐", { previous: "老街茶馆和转角咖啡馆都不错，看你想喝茶还是咖啡。" }),
  c("T40", "好啊，就排明天", ["planning"], "接受上一条的提议", { previous: "要我把西湖十景排进明天的行程吗？" }),
  c("T41", "就去这个", ["planning"], "接受推荐", { previous: "推荐你去湖畔公园看日落，离这儿不远。" }),
  // 混合闲聊、偏好、建议
  c("T42", "好累啊，下午找个地方坐坐", ["planning", "chitchat"], "情绪 + 短途"),
  c("T43", "我不吃辣，晚上帮我找个吃饭的地方", ["planning", "preference"], "偏好 + 规划"),
  c("T44", "有什么推荐的？明天想去城东逛逛", ["planning", "advice"], "建议 + 规划"),
  c("T45", "谢谢，明天的行程就这样吧", ["chitchat"], "结束语，不改卡片", { cardEmpty: false }),
  // 留出（只在最后跑）
  c("H01", "下午三点从安静书房出发去看展", ["planning"], "留出：规划", { heldOut: true }),
  c("H02", "老街茶馆已经喝完了", ["adjust"], "留出：完成", { heldOut: true, hasTrip: true, cardEmpty: false }),
  c("H03", "戏曲小剧场这周六演什么", ["ask_timely"], "留出：演出", { heldOut: true }),
  c("H04", "六和塔为什么叫六和塔", ["ask_knowledge"], "留出：知识", { heldOut: true }),
  c("H05", "胡庆余堂是谁开的", ["ask_knowledge"], "留出：知识", { heldOut: true }),
  c("H06", "想找个适合拍照的地方，有推荐吗", ["advice"], "留出：建议", { heldOut: true }),
  c("H07", "今天天气真好呀", ["chitchat"], "留出：闲聊", { heldOut: true }),
  c("H08", "我是素食者", ["preference"], "留出：偏好", { heldOut: true }),
  c("H09", "明天去西湖，顺便问下断桥残雪的由来", ["planning", "ask_knowledge"], "留出：混合", { heldOut: true }),
  c("H10", "不去了，就随便问问雷峰塔要门票吗", ["ask_timely"], "留出：否定", { heldOut: true }),
  c("H11", "晚上能不能找个清吧小酌一下", ["planning"], "留出：像提问的规划", { heldOut: true }),
  c("H12", "第二家要排队吗", ["ask_timely"], "留出：指代", { heldOut: true, previous: "湖畔餐厅和老街火锅都不错。" }),
  c("H13", "我一般不喜欢人多的地方，周末去哪玩好", ["advice", "preference"], "留出：建议 + 偏好", { heldOut: true }),
  c("H14", "累死了", ["chitchat"], "留出：情绪", { heldOut: true }),
  c("H15", "下一站换个不辣的吃的", ["adjust"], "留出：调整（这次不辣，不是长期偏好）", { heldOut: true, hasTrip: true, cardEmpty: false }),
];

export const truthFlags = (item: RouteCase): RouteFlags =>
  Object.fromEntries(ROUTE_FLAGS.map((flag) => [flag, item.truth.includes(flag)])) as RouteFlags;

export interface RouteError {
  readonly kind: "planning_missed" | "chitchat_as_change" | "adjust_missed" | "knowledge_unoffered";
}

/**
 * 有害错误（§4.1）：规划消息没判出 planning；只是闲聊却判成规划或调整；调整没判出；
 * 知识问题两种提问都没判出（资料库和联网都不会提供）。
 */
export function harmfulErrors(item: RouteCase, predicted: RouteFlags): RouteError["kind"][] {
  const truth = truthFlags(item);
  const errors: RouteError["kind"][] = [];
  if (truth.planning && !predicted.planning) errors.push("planning_missed");
  if (truth.chitchat && !truth.planning && !truth.adjust && (predicted.planning || predicted.adjust)) errors.push("chitchat_as_change");
  if (truth.adjust && !predicted.adjust) errors.push("adjust_missed");
  if (truth.ask_knowledge && !predicted.ask_knowledge && !predicted.ask_timely) errors.push("knowledge_unoffered");
  return errors;
}

export const ROUTE_DATASET_VERSION = "v29-route.v1";
export function routeDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(ROUTE_CASES)).digest("hex");
}
