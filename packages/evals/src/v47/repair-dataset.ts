import { createHash } from "node:crypto";
import type { ReviewCase } from "../v32/review-dataset";

/**
 * V4.7 修复效果题集（stages/V4.7.md §4.2）：每题一张卡片加一份分得不好的分配（不经模型分配），需求写在卡片、备注、用户原话或长期
 * 偏好里，判定由代码按最后的方案查，不用 outing-judge 打分。地点用评测世界的编号。
 * 判定看**建议都采纳之后**的方案：能直接留下的范围没有扩大，加兴趣、去掉地点这类只能建议，采纳后才落到方案上（single 和 agent 同一口径）。
 * 一题算过：这一边 2 轮都过。Q11、Q12 留出。2026-11-09 在接进 Agent 之前写好并锁定，之后不改。
 */
export interface FinalDay {
  readonly day: number;
  readonly outcome: string;
  /** 这天的站（世界编号）和开始时刻（分钟）。 */
  readonly stops: readonly { readonly id: string; readonly from: number }[];
}

export interface RepairCheck {
  readonly name: string;
  readonly test: (days: readonly FinalDay[]) => boolean;
}

export interface RepairCase extends ReviewCase {
  /** 用户原话（只进判断）。 */
  readonly said?: readonly string[];
  /** 用户保存的长期偏好。 */
  readonly saved?: readonly string[];
  readonly notes?: string;
  readonly checks: readonly RepairCheck[];
}

const on = (day: number, id: string): RepairCheck => ({
  name: `${id}_on_d${day}`,
  test: (days) => !!days.find((item) => item.day === day)?.stops.some((stop) => stop.id === id),
});
const notOn = (day: number, id: string): RepairCheck => ({
  name: `${id}_not_on_d${day}`,
  test: (days) => days.find((item) => item.day === day)?.outcome === "draft" && !days.find((item) => item.day === day)!.stops.some((stop) => stop.id === id),
});
const nowhere = (id: string): RepairCheck => ({
  name: `no_${id}`,
  test: (days) => days.every((item) => item.outcome === "draft" && !item.stops.some((stop) => stop.id === id)),
});
const anywhere = (id: string): RepairCheck => ({
  name: `has_${id}`,
  test: (days) => days.some((item) => item.stops.some((stop) => stop.id === id)),
});
const onBetween = (day: number, id: string, from: string, to: string): RepairCheck => {
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return {
    name: `${id}_d${day}_${from}_${to}`,
    test: (days) => !!days.find((item) => item.day === day)?.stops.some((stop) => stop.id === id && stop.from >= minute(from) && stop.from <= minute(to)),
  };
};
const atMost = (day: number, count: number): RepairCheck => ({
  name: `d${day}_at_most_${count}`,
  test: (days) => {
    const found = days.find((item) => item.day === day);
    return found?.outcome === "draft" && found.stops.filter((stop) => stop.id !== "transfer").length <= count;
  },
});
const notAllOnOneDay = (ids: readonly string[]): RepairCheck => ({
  name: "not_all_on_one_day",
  test: (days) => days.every((item) => item.outcome === "draft") && days.every((item) => ids.some((id) => !item.stops.some((stop) => stop.id === id))),
});

const BY_CAR = { allowed: ["walking", "taxi", "driving"], prefer: "balanced" } as const;
const WALK_TAXI = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;
const two = { from: "2026-10-17", to: "2026-10-18" } as const;
const stormy = { from: "2026-10-15", to: "2026-10-17" } as const;
const station = { place: "Y-STATION", at: "09:00" } as const;
const back = { place: "Y-STATION", at: "20:00" } as const;
const YL = "990100";
const base = { dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [], forecast: "dry", expect: {} } as const;
const stay = (place: string, stayMinutes: number) => ({ place, role: "optional", stayMinutes }) as const;

export const REPAIR_DATASET_VERSION = "v47-repair.v1";

export const REPAIR_CASES: readonly RepairCase[] = [
  { ...base, id: "Q01", note: "原话：第二天爸妈来，那天别爬山；爬山分在第 2 天（能直接挪）", said: ["第二天我爸妈过来，那天别爬山"],
    visits: [stay("Y-MUSEUM", 120), stay("Y-GATE", 180), stay("Y-TOWN", 150)], split: [["Y-MUSEUM"], ["Y-GATE", "Y-TOWN"]], checks: [notOn(2, "Y-GATE")] },
  { ...base, id: "Q02", note: "备注：第一天到了先吃海鲜；海鲜分在第 2 天（能直接挪）", notes: "第一天到了先吃海鲜",
    visits: [stay("Y-MUSEUM", 120), stay("Y-TEA", 60), stay("Y-BEACH", 120), stay("Y-SEAFOOD", 90)], split: [["Y-MUSEUM", "Y-TEA"], ["Y-BEACH", "Y-SEAFOOD"]], checks: [on(1, "Y-SEAFOOD")] },
  { ...base, id: "Q03", note: "原话：海边留到最后一天；海边分在第 1 天（能直接挪）", said: ["金沙湾海滩留到最后一天去"],
    visits: [stay("Y-BEACH", 120), stay("Y-TEA", 60), stay("Y-MUSEUM", 120), stay("Y-TOWN", 150)], split: [["Y-BEACH", "Y-TEA"], ["Y-MUSEUM", "Y-TOWN"]], checks: [on(2, "Y-BEACH")] },
  { ...base, id: "Q04", note: "兴趣写明第二天晚上吃火锅，分在第 1 天（能直接挪）",
    interests: [{ id: "i1", text: "第二天晚上吃火锅", when: "evening", city: YL }],
    visits: [stay("Y-MUSEUM", 120), stay("Y-TOWN", 150)], split: [["Y-MUSEUM", "i1"], ["Y-TOWN"]], checks: [on(2, "Y-HOTPOT")] },
  { ...base, id: "Q05", note: "备注：第一天轻松点，只去两个地方；第 1 天分了三处（能直接挪）", notes: "第一天轻松点，只去两个地方",
    visits: [stay("Y-MUSEUM", 90), stay("Y-TEA", 60), stay("Y-CAFE", 60), stay("Y-TOWN", 150)], split: [["Y-MUSEUM", "Y-TEA", "Y-CAFE"], ["Y-TOWN"]], checks: [atMost(1, 2)] },
  { ...base, id: "Q06", note: "整体问题：第 1 天连着三个博物馆（能直接挪）", travel: WALK_TAXI, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "V21-SQUARE", at: "20:00" }, lodging: ["V21-SQUARE"],
    visits: [stay("V21-MUSEUM", 90), stay("V21-MUSEUM-WEST", 90), stay("V21-OPERA-HALL", 90), stay("V21-STREET", 90), stay("V21-MALL", 90)],
    split: [["V21-MUSEUM", "V21-MUSEUM-WEST", "V21-OPERA-HALL"], ["V21-STREET", "V21-MALL"]], checks: [notAllOnOneDay(["V21-MUSEUM", "V21-MUSEUM-WEST", "V21-OPERA-HALL"])] },
  { ...base, id: "Q07", note: "兴趣写明第一天中午吃面，分在第 2 天（能直接挪）",
    interests: [{ id: "i1", text: "第一天中午吃面", when: "noon", city: YL }],
    visits: [stay("Y-GATE", 180), stay("Y-TOWN", 150)], split: [["Y-GATE"], ["Y-TOWN", "i1"]], checks: [onBetween(1, "Y-NOODLE", "11:00", "14:00")] },
  { ...base, id: "Q08", note: "原话：晚上想去酒吧坐坐，卡片上没有（只能建议加兴趣）", said: ["晚上想去酒吧坐坐"],
    visits: [stay("Y-MUSEUM", 120), stay("Y-TOWN", 150)], split: [["Y-MUSEUM"], ["Y-TOWN"]], checks: [anywhere("Y-BAR")] },
  { ...base, id: "Q09", note: "长期偏好：不喜欢去寺庙，卡片上却有古寺（只能建议去掉）", saved: ["不喜欢去寺庙"],
    visits: [stay("Y-TEMPLE", 90), stay("Y-MUSEUM", 120), stay("Y-TOWN", 150)], split: [["Y-TEMPLE", "Y-MUSEUM"], ["Y-TOWN"]], checks: [nowhere("Y-TEMPLE")] },
  { ...base, id: "Q10", note: "对照（数字也看得出）：晚上吃火锅放在 14 点结束的最后一天", end: { place: "Y-STATION", at: "14:00" },
    interests: [{ id: "i1", text: "吃火锅", when: "evening", city: YL }],
    visits: [stay("Y-MUSEUM", 120)], split: [["Y-MUSEUM"], ["i1"]], checks: [anywhere("Y-HOTPOT")] },
  { ...base, id: "Q11", note: "留出，原话：博物馆放到下雨那天", heldOut: true, dates: stormy, forecast: "yunling", lodging: ["Y-HOTEL", "Y-HOTEL"], said: ["云岭博物馆放到下雨那天去"],
    visits: [stay("Y-MUSEUM", 120), stay("Y-TEA", 60), stay("Y-TOWN", 150)], split: [["Y-MUSEUM"], ["Y-TEA"], ["Y-TOWN"]], checks: [on(2, "Y-MUSEUM")] },
  { ...base, id: "Q12", note: "留出，长期偏好：不爱去游乐园，卡片上却有欢乐谷（只能建议去掉）", heldOut: true, saved: ["不爱去游乐园"],
    visits: [{ place: "Y-PARK", role: "optional", stayMinutes: 240, estimate: true }, stay("Y-MUSEUM", 120), stay("Y-TOWN", 150)], split: [["Y-PARK"], ["Y-MUSEUM", "Y-TOWN"]], checks: [nowhere("Y-PARK")] },
];

export function repairDigest(): string {
  return createHash("sha256").update(JSON.stringify({ version: REPAIR_DATASET_VERSION, cases: REPAIR_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })) })).digest("hex");
}
