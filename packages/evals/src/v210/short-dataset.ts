import { createHash } from "node:crypto";
import type { ShortCase } from "../v21/short-dataset";

/**
 * V2.10 云岭市的短途（stages/V2.10.md §4.2）：城区一例与杭州对照，其余从山门、海滩、古镇出发——
 * 这些地方 3 公里内没有合适的店，要扩大搜索范围（10 公里、30 公里），而不是说“附近没有”。
 * 用 V2.4 的短途评测跑（用户每次选第一个推荐），真值手写，锁定后不改。
 */
export const YUNLING_SHORT_CASES: readonly ShortCase[] = [
  {
    id: "S21",
    note: "云岭城区：吃火锅，再喝杯咖啡",
    start: "Y-STATION",
    interests: [{ id: "i1", text: "吃火锅" }, { id: "i2", text: "喝杯咖啡" }],
    satisfiedBy: { i1: ["Y-HOTPOT"], i2: ["Y-CAFE"] },
  },
  {
    id: "S22",
    note: "爬完山在山门想吃饭：最近的农家菜在 7 公里外",
    start: "Y-GATE",
    interests: [{ id: "i1", text: "吃顿饭" }],
    satisfiedBy: { i1: ["Y-FARM", "Y-NOODLE"] },
  },
  {
    id: "S23",
    note: "海滩边吃海鲜：就在旁边",
    start: "Y-BEACH",
    interests: [{ id: "i1", text: "吃海鲜" }],
    satisfiedBy: { i1: ["Y-SEAFOOD"] },
  },
  {
    id: "S24",
    note: "古镇出来想吃小吃：小吃街在 18 公里外的城区",
    start: "Y-TOWN",
    interests: [{ id: "i1", text: "吃点小吃" }],
    satisfiedBy: { i1: ["Y-SNACK"] },
  },
  {
    id: "S25",
    note: "（留出）山门想吃碗面：面馆在 9 公里外",
    start: "Y-GATE",
    interests: [{ id: "i1", text: "吃碗面" }],
    satisfiedBy: { i1: ["Y-NOODLE"] },
    heldOut: true,
  },
  {
    id: "S26",
    note: "（留出）云岭城区：喝一杯，再找个茶馆",
    start: "Y-STATION",
    interests: [{ id: "i1", text: "喝一杯" }, { id: "i2", text: "找个茶馆" }],
    satisfiedBy: { i1: ["Y-BAR"], i2: ["Y-TEA"] },
    heldOut: true,
  },
];

export const YUNLING_SHORT_VERSION = "v210-short.v1";
export function yunlingShortDigest(): string {
  return createHash("sha256").update(JSON.stringify(YUNLING_SHORT_CASES)).digest("hex");
}
