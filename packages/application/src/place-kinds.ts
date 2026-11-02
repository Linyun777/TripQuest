/**
 * V2.10：地点的大致类型，由规划模型在搜索时估计，只用来给新发现地点的停留一个合理范围、判断是不是户外
 * （stages/V2.10.md §3.4）。类型是估计，不当硬约束；用户说的停留时间不受它限制。
 */
export const PLACE_KINDS = ["city_spot", "big_scenic", "hike", "water", "food", "drink", "shop", "other"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export const KIND_STAYS: Readonly<Record<PlaceKind, readonly [number, number]>> = {
  city_spot: [30, 240],
  big_scenic: [180, 600],
  hike: [180, 600],
  water: [60, 360],
  food: [30, 150],
  drink: [30, 120],
  shop: [30, 180],
  other: [30, 240],
};
/** V2.10：一站最长停留（大景区、主题乐园、爬山可以占大半天）。 */
export const MAX_STAY_MINUTES = 600;

/** 模型给的停留夹到该类型的范围里；没给类型时原样保留。 */
export function stayForKind(kind: PlaceKind | undefined, minutes: number): number {
  if (!kind) return minutes;
  const [min, max] = KIND_STAYS[kind];
  return Math.min(Math.max(minutes, min), max);
}

/**
 * V2.11 验收复测：卡片上没写停留的地点按类型给的估计停留（分钟，在 KIND_STAYS 的范围里，排不下时可以缩到下限）。
 * 以前一律按 60 分钟，熊猫基地 1 小时、一天 12 点就排完了。
 */
export const KIND_TYPICAL_STAYS: Readonly<Record<PlaceKind, number>> = {
  city_spot: 120,
  big_scenic: 240,
  hike: 300,
  water: 150,
  food: 75,
  drink: 60,
  shop: 90,
  other: 90,
};

/**
 * 高德分类码 → 大致类型（多个分类时看第一个）：餐饮 05（咖啡、茶、冷饮、甜品 0505–0509 是 drink）、购物 06
 * （特色商业街 0610 按逛街景点）、公园广场 1101、风景名胜 1102（世界遗产、国家级景点 110201–110202 和动植物园
 * 110102–110103 按大景区，海滩 110208 按水边）、科教文化 14（博物馆、展览馆、美术馆）。其余是 other。
 */
export function kindOfCategory(code: string | undefined): PlaceKind {
  const first = (code ?? "").split("|")[0] ?? "";
  if (/^050[5-9]/.test(first)) return "drink";
  if (first.startsWith("05")) return "food";
  if (first.startsWith("0610")) return "city_spot";
  if (first.startsWith("06")) return "shop";
  if (/^(11020[12]|11010[23])/.test(first)) return "big_scenic";
  if (first.startsWith("110208")) return "water";
  if (first.startsWith("11") || first.startsWith("14")) return "city_spot";
  return "other";
}
