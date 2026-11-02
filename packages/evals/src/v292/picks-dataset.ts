import { createHash } from "node:crypto";

/**
 * V2.9.2 短途挑地点（stages/V2.9.2.md §3.3）：每题是一批固定候选（已按直线距离从近到远排好），
 * 只考“挑”这一步，不调高德。候选名称、类型标签、距离全是手写的，不放真实高德数据（D-046）。
 * 每个候选标注是否满足这一步的兴趣；`stay` 是这类地方合理的停留分钟区间。真值在写 Jev 代码之前定下。
 */
export interface PickCandidate {
  readonly name: string;
  readonly meters: number;
  readonly keytag?: string;
  readonly rating?: number;
  readonly costYuan?: number;
  /** 满足兴趣（只给判分用，不发给挑选实现）。 */
  readonly fits: boolean;
}

export interface PickCase {
  readonly id: string;
  readonly note: string;
  readonly interest: { readonly text: string; readonly when?: string };
  readonly anchor: { readonly name: string; readonly isStart: boolean };
  readonly wet?: boolean;
  readonly found: readonly PickCandidate[];
  readonly stay: readonly [number, number];
  readonly heldOut?: boolean;
}

const yes = (name: string, meters: number, keytag: string, extra: Partial<PickCandidate> = {}): PickCandidate =>
  ({ name, meters, keytag, fits: true, ...extra });
const no = (name: string, meters: number, keytag: string, extra: Partial<PickCandidate> = {}): PickCandidate =>
  ({ name, meters, keytag, fits: false, ...extra });
const START = { name: "东门广场", isStart: true } as const;
const AFTER = { name: "城东博物馆", isStart: false } as const;
const MEAL = [30, 120] as const;
const DRINK = [15, 90] as const;
const BAR = [45, 180] as const;
const VISIT = [45, 180] as const;
const SHOP = [20, 120] as const;

const p = (
  id: string,
  note: string,
  interest: PickCase["interest"],
  found: readonly PickCandidate[],
  stay: readonly [number, number],
  extra: Partial<Pick<PickCase, "anchor" | "wet" | "heldOut">> = {},
): PickCase => ({ id, note, interest, anchor: START, found: [...found].sort((a, b) => a.meters - b.meters), stay, ...extra });

export const PICK_CASES: readonly PickCase[] = [
  p("K01", "品牌：喝瑞幸时别的咖啡不算", { text: "喝瑞幸" }, [
    no("星巴克(东街店)", 120, "咖啡厅", { rating: 4.5 }), yes("瑞幸咖啡(东街店)", 300, "咖啡厅", { rating: 4.3 }),
    no("Manner咖啡", 400, "咖啡厅"), yes("瑞幸咖啡(北口店)", 900, "咖啡厅"), no("库迪咖啡", 1100, "咖啡厅"),
  ], DRINK),
  p("K02", "口味：吃点辣的", { text: "吃点辣的" }, [
    no("粤式茶餐厅", 150, "粤菜"), yes("川味小厨", 200, "川菜", { rating: 4.4, costYuan: 68 }), no("江南小馆", 300, "杭帮菜"),
    yes("湘里人家", 500, "湘菜"), yes("麻辣烫小铺", 700, "麻辣烫"),
  ], MEAL),
  p("K03", "名字像但类型不是：咖啡色美甲、咖啡豆批发", { text: "喝杯咖啡" }, [
    no("咖啡色美甲", 100, "美甲"), yes("喵星球猫咖", 200, "咖啡厅"), yes("转角咖啡", 350, "咖啡厅"),
    no("咖啡豆批发部", 500, "批发市场"), yes("书房咖啡角", 800, "咖啡厅"),
  ], DRINK),
  p("K04", "全都不合适：找酒吧", { text: "找个酒吧" }, [
    no("如家酒店", 150, "经济型酒店"), no("酒水批发部", 300, "批发市场"), no("酒酿圆子铺", 450, "小吃"),
  ], BAR),
  p("K05", "只有一个合适，而且最远", { text: "逛书店" }, [
    no("晨光文具", 100, "文具店"), no("快印图文", 200, "打印店"), no("墨香书法培训", 400, "培训机构"), yes("晓风书屋", 1800, "书店"),
  ], SHOP),
  p("K06", "下雨天看展：露天的不算", { text: "看看展" }, [
    no("周末露天市集", 200, "集市"), no("公园雕塑长廊", 300, "公园"), yes("城东美术馆", 900, "美术馆"), yes("城市规划展览馆", 1500, "展览馆"),
  ], VISIT, { wet: true }),
  p("K07", "中英混写：Haidilao", { text: "吃火锅" }, [
    no("锅包肉东北菜", 200, "东北菜"), no("火锅食材超市", 300, "超市"), yes("小龙坎火锅", 400, "火锅"), yes("Haidilao 海底捞(东站店)", 600, "火锅"),
  ], MEAL),
  p("K08", "奶茶：茶庄不算", { text: "喝奶茶" }, [
    no("龙井茶庄", 100, "茶叶店"), yes("茶颜悦色", 200, "奶茶"), yes("CoCo都可", 500, "奶茶"), no("奶茶杯批发", 700, "批发市场"),
  ], DRINK),
  p("K09", "看越剧：服装租赁不算", { text: "想看越剧" }, [
    no("越剧服装租赁", 300, "服装店"), yes("戏曲小剧场", 800, "剧场"), yes("越剧艺术中心", 1200, "剧场"),
  ], VISIT, { anchor: AFTER }),
  p("K10", "吃面：面包、面膜不算", { text: "吃碗面" }, [
    no("面膜体验店", 50, "美容"), no("面包工坊", 100, "面包店"), yes("老字号面馆", 200, "面馆"), yes("片儿川面馆", 400, "面馆"), yes("拉面说", 600, "面馆"),
  ], MEAL),
  p("K11", "茶馆：奶茶店、茶叶市场不算", { text: "找个茶馆坐坐" }, [
    no("茶百道", 150, "奶茶"), no("茶叶市场", 250, "批发市场"), yes("龙井茶室", 300, "茶馆"), yes("湖畔茶楼", 700, "茶馆"),
  ], DRINK),
  p("K12", "吃素：素描、蔬果超市不算", { text: "吃素" }, [
    no("素描画室", 100, "培训机构"), no("蔬果超市", 200, "超市"), yes("清心素斋", 500, "素食"), yes("素食自助", 900, "素食"),
  ], MEAL),
  p("K13", "带孩子玩", { text: "带孩子玩一会儿" }, [
    no("少儿英语培训", 100, "培训机构"), no("母婴用品店", 200, "母婴店"), yes("儿童乐园", 400, "游乐场"), yes("少儿科技馆", 800, "科技馆"), yes("欢乐游乐场", 1500, "游乐场"),
  ], VISIT),
  p("K14", "品牌：喝星巴克", { text: "喝星巴克" }, [
    no("瑞幸咖啡(南门店)", 100, "咖啡厅"), no("星星咖啡", 200, "咖啡厅"), yes("Starbucks 星巴克(湖滨店)", 400, "咖啡厅"), yes("星巴克臻选(银泰店)", 900, "咖啡厅"),
  ], DRINK),
  p("K15", "买伴手礼", { text: "买点伴手礼" }, [
    no("便利蜂", 100, "便利店"), yes("杭州特产店", 300, "特产店"), yes("龙井茶叶礼品店", 500, "茶叶店"), no("丝绸博物馆", 800, "博物馆"),
  ], SHOP),
  p("K16", "日料：理发、文具不算", { text: "吃日料" }, [
    no("日式理发", 100, "理发店"), no("日杂文具", 200, "文具店"), yes("居酒屋·鸟", 400, "日本料理"), yes("寿司郎", 600, "日本料理"),
  ], MEAL),
  p("K17", "看日落：名字带“日落”的酒馆不算", { text: "看日落", when: "dusk" }, [
    no("日光浴室", 100, "洗浴"), no("日落小酒馆", 300, "酒吧"), yes("湖畔观景台", 1200, "观景台"), yes("山顶公园", 2000, "公园"),
  ], [20, 120]),
  p("K18", "早饭：夜宵烧烤不算", { text: "吃早饭", when: "morning" }, [
    yes("包子铺", 100, "早餐"), no("夜宵烧烤", 200, "烧烤"), yes("早点铺", 300, "早餐"), yes("豆浆油条", 500, "早餐"),
  ], [10, 60]),
  p("K19", "都合适：看远近顺序", { text: "喝咖啡" }, [
    yes("小巷咖啡", 250, "咖啡厅"), yes("街角咖啡", 600, "咖啡厅"), yes("湖边咖啡", 1300, "咖啡厅", { rating: 4.8 }),
  ], DRINK, { anchor: AFTER }),
  p("K20", "中英混写的酒吧", { text: "喝一杯" }, [
    no("酒仙网仓库", 200, "仓储"), yes("Hidden Bar 隐", 400, "酒吧"), yes("Craft Beer 精酿", 600, "酒吧"), yes("Wine House 红酒馆", 900, "酒吧"),
  ], BAR),
  p("K21", "否定口味：不辣的", { text: "吃点不辣的" }, [
    no("川菜馆", 100, "川菜"), no("麻辣香锅", 200, "麻辣香锅"), yes("粤菜馆", 300, "粤菜"), yes("杭帮菜馆", 500, "杭帮菜"),
  ], MEAL),
  p("K22", "下雨天找室内能逛的：露天的不算", { text: "找个室内能逛的地方" }, [
    no("滨江露天公园", 100, "公园"), yes("银泰商场", 300, "购物中心"), yes("室内攀岩馆", 700, "运动场馆"), no("西郊植物园", 900, "植物园"),
  ], VISIT, { wet: true }),
  // 留出（只在最后跑）
  p("K23", "留出：品牌，一个都没有", { text: "喝瑞幸" }, [
    no("星巴克(北街店)", 100, "咖啡厅"), no("Manner咖啡(北街店)", 300, "咖啡厅"), no("库迪咖啡(北街店)", 600, "咖啡厅"),
  ], DRINK, { heldOut: true }),
  p("K24", "留出：中英混写的辣", { text: "吃辣的" }, [
    no("甜品站", 100, "甜品"), no("日式拉面", 200, "日本料理"), yes("重庆小面", 300, "面馆"), yes("Spicy Hunan 湘味馆", 500, "湘菜"),
  ], MEAL, { heldOut: true }),
  p("K25", "留出：看展", { text: "看展览" }, [
    no("展览设备租赁", 100, "租赁"), yes("Gallery 9 画廊", 400, "画廊"), yes("城东博物馆(西馆)", 1500, "博物馆"),
  ], VISIT, { heldOut: true, anchor: AFTER }),
  p("K26", "留出：茶餐厅不是茶馆", { text: "去茶馆喝茶" }, [
    no("港式茶餐厅", 100, "茶餐厅"), no("茶具专卖", 300, "家居用品"), yes("老街茶馆", 600, "茶馆"),
  ], DRINK, { heldOut: true }),
  p("K27", "留出：买书，图书馆不卖书", { text: "买本书" }, [
    no("书包专卖", 100, "箱包店"), no("区图书馆", 400, "图书馆"), yes("二手书店", 800, "书店"), yes("连锁大书城", 1100, "书店"),
  ], SHOP, { heldOut: true }),
  p("K28", "留出：带老人吃清淡的", { text: "带老人吃点清淡的" }, [
    no("烧烤大排档", 100, "烧烤"), no("麻辣烫", 200, "麻辣烫"), yes("粥铺", 300, "粥店"), yes("淮扬菜馆", 600, "淮扬菜"),
  ], MEAL, { heldOut: true }),
  p("K29", "留出：夜宵", { text: "吃夜宵", when: "evening" }, [
    no("晨光早餐铺", 100, "早餐"), yes("烧烤摊", 300, "烧烤"), yes("小龙虾馆", 500, "小龙虾"),
  ], MEAL, { heldOut: true }),
  p("K30", "留出：笼统的“喝点东西”", { text: "想喝点东西" }, [
    yes("街口咖啡", 100, "咖啡厅"), yes("一点点奶茶", 200, "奶茶"), no("五金店", 300, "五金"), yes("巷子茶馆", 400, "茶馆"),
  ], DRINK, { heldOut: true }),
];

export const PICKS_DATASET_VERSION = "v292-picks.v1";
export function picksDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(PICK_CASES)).digest("hex");
}
