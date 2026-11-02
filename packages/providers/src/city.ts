/**
 * V2.10 全国通用（stages/V2.10.md §3.1–3.2）：卡片上的“城市”是地级市这一级（含直辖市、省直辖县级市），
 * 用行政区编码表示。高德地点自带的是区县编码，这里换算成它所属的城市：
 * - 直辖市（北京、天津、上海、重庆）：前 2 位 + "0000"（110108 → 110000）；
 * - 省直辖县级市（中间两位是 90，如湖北仙桃 429004、海南五指山 469001）：保留完整编码；
 * - 其余：前 4 位 + "00"（330106 → 330100）。
 * 城市只用编码和名称（行政区信息，不是高德地点数据）。
 */
export interface CityRef {
  readonly adcode: string;
  readonly name: string;
}

export const HANGZHOU: CityRef = { adcode: "330100", name: "杭州市" };

const MUNICIPALITIES = new Set(["11", "12", "31", "50"]);

export function isAdcode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

/** 区县（或城市）编码所属的城市编码。 */
export function cityAdcodeOf(adcode: string): string {
  if (MUNICIPALITIES.has(adcode.slice(0, 2))) return `${adcode.slice(0, 2)}0000`;
  if (adcode.slice(2, 4) === "90") return adcode;
  return `${adcode.slice(0, 4)}00`;
}

/** 两个编码是否属于同一个城市（任一边可以是区县编码）。 */
export function sameCity(a: string, b: string): boolean {
  return cityAdcodeOf(a) === cityAdcodeOf(b);
}

export function isMunicipality(adcode: string): boolean {
  return MUNICIPALITIES.has(adcode.slice(0, 2));
}
