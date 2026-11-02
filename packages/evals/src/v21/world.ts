import { emptyDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import type { PlanningPlace } from "@tripquest/application/planning";
import type {
  CityRef,
  CityResolver,
  MobilityProvider,
  PlaceLookupData,
  PlaceLookupProvider,
  PlaceSearchData,
  PlaceSearchRequest,
  PlaceSummary,
  ProviderResult,
  RouteRequest,
  RouteResult,
  WeatherDay,
  WeatherForecastData,
  WeatherProvider,
} from "@tripquest/providers";
import { planningFixtureEvidence } from "@tripquest/providers/planning-fixture";

/**
 * V2.1 evaluation world: invented places in an invented district, each tagged with search
 * keywords, the interests it truly satisfies (the ground truth for scoring) and whether it
 * is indoors. No real place, address or coordinate is used (D-046).
 */
export const V21_NOW = Date.parse("2026-10-15T01:00:00Z"); // 09:00 in Hangzhou, a Thursday
export const V21_TODAY = "2026-10-15";

export interface WorldPlace {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly indoor: boolean;
  /** Grid position in units of ~100 m. */
  readonly x: number;
  readonly y: number;
  /** V2.5: today's opening hours as Amap writes them; absent = unknown. */
  readonly hours?: string;
  /** V2.10: the place's city (evaluation adcode); absent = Hangzhou "330100". */
  readonly city?: string;
  /** V2.10: no bus or metro reaches it (a mountain gate). */
  readonly noTransit?: true;
  /**
   * V2.10: Amap category code, set only for 云岭's outdoor places (风景名胜 110200, 广场 110105) so the
   * outdoor weather alert can be tested; the Hangzhou world stays as it was. V3.3: lodging places carry theirs too.
   */
  readonly category?: string;
}

export const WORLD: readonly WorldPlace[] = [
  { id: "V21-SQUARE", name: "东门广场", tags: ["广场", "东门"], indoor: false, x: 0, y: 0 },
  { id: "V21-METRO", name: "东门广场(地铁站)", tags: ["地铁", "东门"], indoor: true, x: 0, y: 1 },
  { id: "V21-MALL", name: "湖滨终点商场", tags: ["商场", "湖滨", "购物"], indoor: true, x: 22, y: 4 },
  { id: "V21-STREET", name: "湖滨步行街", tags: ["步行街", "湖滨", "散步"], indoor: false, x: 21, y: 9 },
  { id: "V21-MUSEUM", name: "城东博物馆", tags: ["博物馆", "展览", "看展", "文化", "历史"], indoor: true, x: 8, y: 6 },
  { id: "V21-MUSEUM-WEST", name: "城东博物馆(西馆)", tags: ["博物馆", "展览", "看展"], indoor: true, x: 30, y: 20 },
  { id: "V21-OPERA", name: "戏曲小剧场", tags: ["越剧", "剧院", "剧场", "戏曲", "演出"], indoor: true, x: 5, y: 3 },
  { id: "V21-OPERA-HALL", name: "越剧陈列馆", tags: ["越剧", "陈列馆", "戏曲", "展览", "博物馆"], indoor: true, x: 12, y: 2 },
  { id: "V21-BOOKS", name: "安静书房", tags: ["书店", "书房", "阅读", "安静", "咖啡"], indoor: true, x: 3, y: 5 },
  { id: "V21-BOOKMALL", name: "连锁大书城", tags: ["书店", "书城"], indoor: true, x: 18, y: 2 },
  { id: "V21-TEA", name: "老街茶馆", tags: ["茶馆", "喝茶", "茶", "茶室"], indoor: true, x: 14, y: 6 },
  { id: "V21-TEAFIELD", name: "茶园观景台", tags: ["茶园", "茶", "观景", "户外"], indoor: false, x: 26, y: 14 },
  { id: "V21-PARK", name: "湖畔公园", tags: ["公园", "散步", "湖", "日落", "观景", "自然"], indoor: false, x: 19, y: 7 },
  { id: "V21-HILL", name: "山顶观景台", tags: ["观景", "日落", "山", "爬山", "自然"], indoor: false, x: 16, y: 12 },
  { id: "V21-SNACK", name: "本地小吃街", tags: ["小吃", "美食", "餐饮", "本地", "吃"], indoor: false, x: 10, y: 1 },
  { id: "V21-VEG", name: "清心素斋馆", tags: ["素斋", "素食", "餐厅", "素"], indoor: true, x: 7, y: 9 },
  { id: "V21-SCIENCE", name: "少儿科技馆", tags: ["科技", "亲子", "孩子", "科学", "儿童"], indoor: true, x: 11, y: 10 },
  { id: "V21-CRAFT", name: "文创市集", tags: ["文创", "市集", "手作", "购物"], indoor: false, x: 15, y: 4 },
  // V2.2: a western district 10–14 km out — too far to walk to and back in a day.
  { id: "V22-TEMPLE", name: "灵峰古寺", tags: ["古寺", "寺庙", "禅寺", "烧香"], indoor: false, x: -110, y: 20 },
  { id: "V22-WETLAND", name: "西郊湿地", tags: ["湿地", "观鸟"], indoor: false, x: -100, y: 60 },
  { id: "V22-NOODLE", name: "西郊面馆", tags: ["面馆", "拉面", "吃面"], indoor: true, x: -104, y: 28 },
  { id: "V22-TOWN", name: "运河古镇", tags: ["古镇", "水乡", "运河"], indoor: false, x: 40, y: 120 },
  // V2.2: an eastern campus 24 km out, where "current location" can put the start and end.
  { id: "V22-CAMPUS", name: "东郊大学城", tags: ["大学", "校区"], indoor: false, x: 240, y: 0 },
  // V2.3: evening and meal places, so "one bar, after dark" and "a proper lunch" can be checked.
  { id: "V23-BAR-A", name: "江畔小酒馆", tags: ["酒馆", "小酒馆", "喝酒", "小酌"], indoor: true, x: 6, y: 4 },
  { id: "V23-BAR-B", name: "精酿酒吧", tags: ["酒吧", "精酿", "喝酒", "啤酒"], indoor: true, x: 9, y: 7 },
  { id: "V23-BAR-C", name: "屋顶清吧", tags: ["清吧", "酒吧", "喝酒", "小酌"], indoor: false, x: 13, y: 3 },
  { id: "V23-NIGHT", name: "城东夜景台", tags: ["夜景", "夜晚", "灯光"], indoor: false, x: 17, y: 11 },
  { id: "V23-DINNER", name: "湖畔餐厅", tags: ["餐厅", "正餐", "杭帮菜", "饭店"], indoor: true, x: 20, y: 5 },
  { id: "V23-HOTPOT", name: "老街火锅", tags: ["火锅", "餐厅"], indoor: true, x: 11, y: 8 },
  { id: "V23-CAFE", name: "转角咖啡馆", tags: ["咖啡", "咖啡馆", "坐坐"], indoor: true, x: 4, y: 7 },
  { id: "V23-BOOKS", name: "旧书店", tags: ["书店", "二手书"], indoor: true, x: 16, y: 9 },
  // V2.4: spicy food and one coffee chain with branches spread out, so "coffee after lunch"
  // shows whether the coffee was looked for near the restaurant or near the start.
  { id: "V24-SPICY-A", name: "川味小馆", tags: ["川菜", "辣", "麻辣"], indoor: true, x: 14, y: 4 },
  { id: "V24-SPICY-B", name: "湘里人家", tags: ["湘菜", "辣"], indoor: true, x: 22, y: 14 },
  { id: "V24-SPICY-C", name: "麻辣香锅店", tags: ["麻辣", "辣", "香锅"], indoor: true, x: 6, y: 16 },
  { id: "V24-LUCKIN-A", name: "瑞幸咖啡(东门店)", tags: ["瑞幸", "咖啡"], indoor: true, x: -2, y: -1 },
  { id: "V24-LUCKIN-B", name: "瑞幸咖啡(城东店)", tags: ["瑞幸", "咖啡"], indoor: true, x: 15, y: 5 },
  { id: "V24-LUCKIN-C", name: "瑞幸咖啡(湖滨店)", tags: ["瑞幸", "咖啡"], indoor: true, x: 23, y: 15 },
  { id: "V24-LUCKIN-D", name: "瑞幸咖啡(北街店)", tags: ["瑞幸", "咖啡"], indoor: true, x: 6, y: 17 },
  // V2.5: shops with today's hours, used only by the flower cases (S07, S08).
  { id: "V25-FLOWER-A", name: "街角花店", tags: ["花店", "鲜花", "买花"], indoor: true, x: 1, y: 1, hours: "09:00-14:30" },
  { id: "V25-FLOWER-B", name: "小院花房", tags: ["花店", "鲜花", "买花"], indoor: true, x: 3, y: 2, hours: "10:00-20:00" },
  { id: "V25-FLOWER-C", name: "花市小铺", tags: ["花店", "鲜花", "买花"], indoor: true, x: 12, y: 6 },
  { id: "V25-FLOWER-D", name: "转角花艺", tags: ["花店", "鲜花", "买花"], indoor: true, x: 15, y: 5, hours: "10:00-16:00" },
];

/**
 * V2.10 second evaluation city “云岭市” (invented; evaluation-only adcode 990100) about 500 km east of the
 * Hangzhou world, and its neighbour “岚溪市” (990200) 80 km further. It covers what the Hangzhou world
 * does not: a mountain that takes most of a day (food 7–9 km from the gate, no public transport), a
 * beach, an old town, a theme park open 09:00–21:00, city food and drink, and a sight across the city
 * line. Searches scoped to a city only return that city's places, like the real provider.
 */
export const YUNLING = { adcode: "990100", name: "云岭市" } as const;
/**
 * 杭州的回归题按“打开页面时定位在杭州”跑：V2.10 之前起点一直向设备要位置，相当于允许定位；
 * 拒绝定位的情况由城市理解题（Y06）单独覆盖。
 */
export const HANGZHOU_LOCATED = { adcode: "330100", name: "杭州市", source: "located" } as const;
export const locatedDraft = (): RequirementsDraft => ({ ...emptyDraft(), city: HANGZHOU_LOCATED });
export const LANXI = { adcode: "990200", name: "岚溪市" } as const;
const Y = YUNLING.adcode;
export const YUNLING_WORLD: readonly WorldPlace[] = [
  { id: "Y-STATION", name: "云岭站", tags: ["车站", "火车站", "云岭站"], indoor: true, x: 5000, y: 0, city: Y },
  { id: "Y-SQUARE", name: "云岭中心广场", tags: ["广场", "市中心"], indoor: false, x: 5005, y: 3, city: Y, category: "110105" },
  { id: "Y-SNACK", name: "云岭小吃街", tags: ["小吃", "美食", "吃", "本地"], indoor: false, x: 5008, y: 5, city: Y },
  { id: "Y-HOTPOT", name: "云岭老火锅", tags: ["火锅", "辣", "餐厅"], indoor: true, x: 5010, y: 2, city: Y },
  { id: "Y-CAFE", name: "山城咖啡", tags: ["咖啡", "咖啡馆", "坐坐"], indoor: true, x: 5006, y: 6, city: Y },
  { id: "Y-TEA", name: "云雾茶舍", tags: ["茶馆", "喝茶", "茶"], indoor: true, x: 5007, y: 9, city: Y },
  { id: "Y-BAR", name: "河畔酒吧", tags: ["酒吧", "喝酒", "小酌", "喝一杯"], indoor: true, x: 5012, y: 8, city: Y },
  { id: "Y-MUSEUM", name: "云岭博物馆", tags: ["博物馆", "展览", "看展", "历史"], indoor: true, x: 5004, y: 10, city: Y },
  { id: "Y-TEMPLE", name: "云岭古寺", tags: ["古寺", "寺庙", "寺"], indoor: false, x: 5015, y: 15, city: Y },
  { id: "Y-GATE", name: "云岭山(山门)", tags: ["山", "爬山", "登山", "徒步", "云岭山", "景区"], indoor: false, x: 5300, y: 100, city: Y, noTransit: true, category: "110200" },
  { id: "Y-CABLE", name: "云岭山索道站", tags: ["索道", "云岭山"], indoor: false, x: 5302, y: 104, city: Y, noTransit: true, category: "110200" },
  { id: "Y-PEAK", name: "云岭山顶", tags: ["山顶", "日出", "看日出", "观景", "云岭山"], indoor: false, x: 5310, y: 120, city: Y, noTransit: true, category: "110200" },
  { id: "Y-FARM", name: "山下农家菜", tags: ["农家菜", "餐厅", "吃饭", "午饭", "美食"], indoor: true, x: 5370, y: 110, city: Y },
  { id: "Y-NOODLE", name: "山脚面馆", tags: ["面馆", "吃面", "面"], indoor: true, x: 5300, y: 190, city: Y },
  { id: "Y-BEACH", name: "金沙湾海滩", tags: ["海边", "海滩", "沙滩", "看海", "海"], indoor: false, x: 5100, y: -200, city: Y, category: "110200" },
  { id: "Y-SEAFOOD", name: "渔港海鲜", tags: ["海鲜", "餐厅", "吃海鲜"], indoor: true, x: 5105, y: -195, city: Y },
  { id: "Y-TOWN", name: "青石古镇", tags: ["古镇", "水乡", "老街"], indoor: false, x: 4900, y: 150, city: Y, category: "110200" },
  { id: "Y-PARK", name: "云岭欢乐谷", tags: ["主题乐园", "游乐园", "乐园", "游乐场", "欢乐谷"], indoor: false, x: 5050, y: -50, city: Y, hours: "09:00-21:00" },
  { id: "L-FLOWER", name: "岚溪花海", tags: ["花海", "赏花", "花"], indoor: false, x: 5800, y: 0, city: LANXI.adcode, category: "110200" },
  { id: "L-TOWN", name: "岚溪水乡", tags: ["古镇", "水乡"], indoor: false, x: 5810, y: 10, city: LANXI.adcode, category: "110200" },
];
/**
 * V2.11 出游（stages/V2.11.md §4）：两个高铁站、一个机场、两处住处。放在最后，尽量不挤占以前题目的搜索结果。
 * 杭州东站到云岭南站约 500 公里：只能坐高铁或开车（公交、地铁不跨城）。
 */
export const OUTING_WORLD: readonly WorldPlace[] = [
  { id: "V21-HZ-EAST", name: "杭州东站", tags: ["高铁站", "火车站", "杭州东站"], indoor: true, x: 40, y: 12, category: "150200" },
  { id: "Y-SOUTH", name: "云岭南站", tags: ["高铁站", "火车站", "云岭南站"], indoor: true, x: 5000, y: -80, city: YUNLING.adcode, category: "150200" },
  // 离云岭山居酒店约 4.5 公里（F02 早班飞机：6 点从酒店出发、8 点起飞前 90 分钟进站来得及；最初放在 48 公里外，题目本身走不通）。
  { id: "Y-AIRPORT", name: "云岭机场", tags: ["机场", "飞机", "云岭机场"], indoor: true, x: 5270, y: 70, city: YUNLING.adcode, category: "150100" },
  // V3.3：住宿类补上高德的分类码（宾馆酒店 1001xx、旅馆招待所 1002xx），选暂定住处时按它过滤。
  { id: "Y-HOTEL", name: "云岭山居酒店", tags: ["酒店", "住宿", "山居"], indoor: true, x: 5290, y: 95, city: YUNLING.adcode, category: "100100" },
  { id: "Y-INN", name: "青石客栈", tags: ["客栈", "住宿", "民宿"], indoor: true, x: 4905, y: 150, city: YUNLING.adcode, category: "100200" },
];
/**
 * V2.11 验收复测修正（R01）：同一家连锁酒店在云岭有两家分店，对话里要让用户选住哪家。只用店名做标签，
 * 不加“酒店”“住宿”，免得挤进以前题目的搜索结果。
 */
export const ACCEPT_FIX_WORLD: readonly WorldPlace[] = [
  { id: "Y-HOTEL-TOWN", name: "山月酒店(青石古镇店)", tags: ["山月酒店"], indoor: true, x: 4902, y: 148, city: YUNLING.adcode, category: "100100" },
  { id: "Y-HOTEL-SOUTH", name: "山月酒店(云岭南站店)", tags: ["山月酒店"], indoor: true, x: 5002, y: -78, city: YUNLING.adcode, category: "100100" },
];
/**
 * V3.3 住处推荐（stages/V3.3.md §4.1）：杭州、云岭各几家住宿（有的离景点近、有的远），岚溪故意没有住宿（找不到时退回车站）。
 * 标签只用“酒店宾馆”，不用“酒店”“住宿”：名字里带“酒店”的照样能被“酒店”搜到，又不会因为标签被以前题目里
 * 含“酒店”的地名（“云岭山居酒店”）搜出来；名字也避开以前题目搜的词（湖滨、城东、中心、河畔、西郊）。
 */
export const LODGING_WORLD: readonly WorldPlace[] = [
  { id: "V33-HZ-HOTEL", name: "栖云酒店", tags: ["酒店宾馆"], indoor: true, x: 19, y: 6, category: "100100" },
  { id: "V33-HZ-BIZ", name: "途安商务酒店", tags: ["酒店宾馆"], indoor: true, x: 42, y: 14, category: "100105" },
  { id: "V33-HZ-HOSTEL", name: "白鹭青年旅舍", tags: ["酒店宾馆"], indoor: true, x: 6, y: 2, category: "100200" },
  { id: "V33-Y-GRAND", name: "望山大酒店", tags: ["酒店宾馆"], indoor: true, x: 5007, y: 5, city: YUNLING.adcode, category: "100100" },
  { id: "V33-Y-BOUTIQUE", name: "临河精品酒店", tags: ["酒店宾馆"], indoor: true, x: 5013, y: 9, city: YUNLING.adcode, category: "100102" },
  { id: "V33-Y-PINE", name: "松林宾馆", tags: ["酒店宾馆"], indoor: true, x: 4960, y: 40, city: YUNLING.adcode, category: "100100" },
  { id: "L-STATION", name: "岚溪站", tags: ["岚溪站"], indoor: true, x: 5795, y: -5, city: LANXI.adcode, category: "150200" },
];
/**
 * V3.4 搜索兜底（stages/V3.4.md §3.7、§4.1）：照真实高德在成都东站附近搜“熊猫”的样子，云岭南站旁有三家名字带
 * “丹顶鹤”的店（不是景点），真正的丹顶鹤繁育基地在二十公里外；按城市搜时基地排在前面（放在店之前）。基地旁有
 * 一家住宿。关键词“丹顶鹤”以前的题目都没用过；店名、住宿名避开以前搜过的词（酒馆、民宿、文创、南站……）。
 * V3.5 修正（用户 2026-11-01 同意）：三家店补上分类码（照高德常见写法：邮局 070400、旅行社 070100 是生活服务，手信店 060000 是购物），
 * 真实高德的结果都带分类码，原来漏写了，按地点类型过滤测不出来；旧代码不读 06、07 类，结果不变。
 */
export const SPLIT_WORLD: readonly WorldPlace[] = [
  { id: "V34-Y-CRANE", name: "丹顶鹤繁育基地", tags: ["丹顶鹤", "鹤"], indoor: false, x: 4880, y: -260, city: YUNLING.adcode, category: "110200" },
  { id: "V34-Y-CRANE-POST", name: "丹顶鹤邮局快闪店", tags: ["丹顶鹤"], indoor: true, x: 5003, y: -78, city: YUNLING.adcode, category: "070400" },
  { id: "V34-Y-CRANE-TRAVEL", name: "丹顶鹤旅行社", tags: ["丹顶鹤"], indoor: true, x: 4997, y: -83, city: YUNLING.adcode, category: "070100" },
  { id: "V34-Y-CRANE-GIFT", name: "丹顶鹤手信店", tags: ["丹顶鹤"], indoor: true, x: 5005, y: -84, city: YUNLING.adcode, category: "060000" },
  { id: "V34-Y-CRANE-INN", name: "鹤乡客舍", tags: ["酒店宾馆"], indoor: true, x: 4884, y: -255, city: YUNLING.adcode, category: "100200" },
];
/** Every place the evaluation provider knows: Hangzhou first (unchanged), then 云岭 and 岚溪, then V2.11's, V3.3's lodging, V3.4's. */
const ALL_PLACES: readonly WorldPlace[] = [...WORLD, ...YUNLING_WORLD, ...OUTING_WORLD, ...ACCEPT_FIX_WORLD, ...LODGING_WORLD, ...SPLIT_WORLD];
const cityOf = (place: WorldPlace) => place.city ?? "330100";

const BASE = { longitude: 120.1, latitude: 30.2 };
/** Like Amap: business facts only when asked for (searches) and always on a detail lookup. */
const withHours = (place: WorldPlace, summary: PlaceSummary): PlaceSummary =>
  place.hours ? { ...summary, business: { openToday: place.hours } } : summary;
const toSummary = (place: WorldPlace): PlaceSummary => ({
  ref: { provider: "tripquest-planning-fixture", externalId: place.id },
  name: place.name,
  address: `虚构评测区 ${place.x}-${place.y}`,
  cityAdcode: cityOf(place),
  ...(place.category ? { categoryCode: place.category } : {}),
  location: {
    longitude: Number((BASE.longitude + place.x * 0.001).toFixed(6)),
    latitude: Number((BASE.latitude + place.y * 0.0009).toFixed(6)),
    coordinateSystem: "gcj02",
  },
});

export function worldPlace(id: string): WorldPlace {
  const found = ALL_PLACES.find((place) => place.id === id);
  if (!found) throw new Error(`Unknown V2.1 world place ${id}`);
  return found;
}

/** V2.11：按名称找评测世界里的地点（方案里只有名称）。 */
export function worldPlaceByName(name: string): WorldPlace | undefined {
  return ALL_PLACES.find((place) => place.name === name);
}

export function worldSelection(id: string): PlanningPlace {
  return { place: toSummary(worldPlace(id)), evidence: planningFixtureEvidence(V21_NOW) };
}

/** Keyword search: a place matches when a query word and one of its tags or its name overlap. */
function matches(place: WorldPlace, query: string): boolean {
  const words = query.split(/[\s,，、]+/).map((word) => word.trim()).filter(Boolean);
  return words.some((word) =>
    place.name.includes(word) || place.tags.some((tag) => tag.includes(word) || word.includes(tag)));
}

/** Directed walking minutes from grid distance (~80 m/min), plus a small turn penalty. */
function walkSeconds(from: WorldPlace, to: WorldPlace): number {
  const meters = (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * 100;
  return Math.round(meters / 80) * 60 + (from.id < to.id ? 60 : 120);
}

/**
 * V2.2 estimates for the other modes, from grid distance. Invented, but shaped like the
 * real ones: transit has a fixed walk-and-wait part and a capped fare; taxi has a flag fall.
 */
function otherMode(mode: RouteRequest["mode"], meters: number) {
  if (mode === "transit") {
    // V2.11：公交、地铁不跨城（城市之间要坐高铁或开车）。
    if (meters < 800 || meters > 100_000) return null;
    return {
      mode,
      durationSeconds: (10 + Math.round(meters / 450)) * 60,
      distanceMeters: meters,
      fareYuan: Math.min(2 + Math.ceil(Math.max(0, meters - 4000) / 4000), 7),
      walkingMeters: 700,
      summary: meters > 6000 ? "评测地铁1号线" : "评测公交5路",
    };
  }
  if (mode === "taxi" || mode === "driving") {
    return {
      mode,
      // V2.11：100 公里以上走高速（约 90 公里/小时）；以内照旧（V2.10 的岚溪 80 公里不变）。
      durationSeconds: (meters > 100_000 ? 20 + Math.round(meters / 1500) : 4 + Math.round(meters / 520)) * 60,
      distanceMeters: meters,
      ...(mode === "taxi" ? { fareYuan: Math.round((13 + Math.max(0, meters / 1000 - 3) * 2.5) * 10) / 10 } : {}),
    };
  }
  if (mode === "bicycling") return { mode, durationSeconds: (2 + Math.round(meters / 220)) * 60, distanceMeters: meters };
  return null;
}

/** Search, details, routes in every mode and a per-case forecast over the invented world. */
export class V21World implements MobilityProvider, PlaceLookupProvider, WeatherProvider, CityResolver {
  searches: string[] = [];
  routes = 0;
  routeModes: string[] = [];
  details = 0;
  weatherCalls = 0;
  /** V2.10: which city each forecast was asked for. */
  weatherCities: string[] = [];

  constructor(private readonly forecast: readonly WeatherDay[] = []) {}

  private evidence() {
    return planningFixtureEvidence(V21_NOW);
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<ProviderResult<PlaceSearchData>> {
    this.searches.push(request.query);
    // V2.2: a nearby search keeps to its radius, like the real one (grid units are ~100 m).
    // V2.10: a city search keeps to that city; any other scope (nationwide) has no limit.
    const scope = request.scope as { kind: string; cityAdcode?: string; center?: { longitude: number; latitude: number }; radiusMeters?: number };
    const inScope = (place: WorldPlace) => scope.kind === "city" ? cityOf(place) === scope.cityAdcode
      : scope.kind === "nearby" && scope.center ? Math.hypot(
        place.x - (scope.center.longitude - BASE.longitude) / 0.001,
        place.y - (scope.center.latitude - BASE.latitude) / 0.0009,
      ) * 100 <= (scope.radiusMeters ?? 0)
        : true;
    const items = ALL_PLACES.filter((place) => inScope(place) && matches(place, request.query))
      .slice(0, request.limit ?? 5)
      .map((place) => (request.withBusiness ? withHours(place, toSummary(place)) : toSummary(place)));
    return { status: "ok", data: { items, truncated: false, excludedCount: 0 }, evidence: this.evidence() };
  }

  async findPlacesById(ids: readonly string[]): Promise<ProviderResult<PlaceLookupData>> {
    this.details += 1;
    const items = ALL_PLACES.filter((place) => ids.includes(place.id)).map((place) => withHours(place, toSummary(place)));
    return {
      status: "ok",
      data: { items, missing: ids.filter((id) => !items.some((item) => item.ref.externalId === id)) },
      evidence: this.evidence(),
    };
  }

  async findRoutes(request: RouteRequest): Promise<RouteResult> {
    this.routes += 1;
    this.routeModes.push(request.mode);
    const from = ALL_PLACES.find((place) => place.id === request.origin.place.externalId);
    const to = ALL_PLACES.find((place) => place.id === request.destination.place.externalId);
    if (!from || !to) return { status: "no_route", reason: "no_path", evidence: this.evidence() };
    const meters = (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * 100;
    if (request.mode !== "walking") {
      // V2.10: no bus or metro reaches a mountain gate (the real provider finds no transit route).
      if (request.mode === "transit" && (from.noTransit || to.noTransit)) {
        return { status: "no_route", reason: "no_path", evidence: this.evidence() };
      }
      const route = otherMode(request.mode, meters);
      return route
        ? { status: "ok", routes: [route], evidence: this.evidence() }
        : { status: "no_route", reason: "no_path", evidence: this.evidence() };
    }
    return {
      status: "ok",
      routes: [{ mode: "walking", durationSeconds: walkSeconds(from, to), distanceMeters: meters }],
      evidence: this.evidence(),
    };
  }

  /** V2.10: city names (or codes) the evaluation knows; anything else is not a city. */
  async resolveCity(name: string): Promise<ProviderResult<CityRef>> {
    const key = name.trim().replace(/市$/, "");
    const city = [YUNLING, LANXI, { adcode: "330100", name: "杭州市" }]
      .find((item) => item.adcode === key || item.name.replace(/市$/, "") === key);
    return city
      ? { status: "ok", data: { adcode: city.adcode, name: city.name }, evidence: this.evidence() }
      : { status: "failure", failure: { code: "invalid_request", retry: "never", safeMessage: "不是城市" }, evidence: this.evidence() };
  }

  /** V2.10: 云岭 and 岚溪 have their own forecast (a thunderstorm tomorrow); every other code gets the case's. */
  async getWeatherForecast(cityAdcode = "330100"): Promise<ProviderResult<WeatherForecastData>> {
    this.weatherCalls += 1;
    this.weatherCities.push(cityAdcode);
    const days = cityAdcode === YUNLING.adcode || cityAdcode === LANXI.adcode ? FORECASTS.yunling : this.forecast;
    return {
      status: "ok",
      data: { cityAdcode, reportedAt: "2026-10-15T08:00:00+08:00", days },
      evidence: this.evidence(),
    };
  }
}

const day = (date: string, dayWeather: string, high: number, low: number): WeatherDay => ({
  date,
  dayWeather,
  nightWeather: dayWeather,
  highCelsius: high,
  lowCelsius: low,
  wet: /雨|雪|雹/.test(dayWeather),
});

/** Four-day forecasts like the provider returns: dry, or rain from tomorrow on. */
export const FORECASTS = {
  dry: [day("2026-10-15", "晴", 26, 17), day("2026-10-16", "多云", 25, 17), day("2026-10-17", "晴", 27, 18), day("2026-10-18", "多云", 24, 16)],
  rainy: [day("2026-10-15", "多云", 24, 17), day("2026-10-16", "中雨", 20, 15), day("2026-10-17", "小雨", 21, 15), day("2026-10-18", "阴", 22, 16)],
  /** V2.10 云岭市: sunny today, a thunderstorm tomorrow (outdoor alerts), then fair. */
  yunling: [day("2026-10-15", "晴", 24, 15), day("2026-10-16", "雷阵雨", 22, 16), day("2026-10-17", "晴", 25, 16), day("2026-10-18", "多云", 23, 15)],
} as const;
