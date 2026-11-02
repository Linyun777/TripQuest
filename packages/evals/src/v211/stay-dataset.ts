import { createHash } from "node:crypto";
import type { PlayCase } from "../v210/play-dataset";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { YUNLING, worldSelection } from "../v21/world";

/**
 * V2.11 停留分“估计 / 用户说的”（stages/V2.11.md §3.2、§4.2）。两类题：
 * - 规划（T01–T03）：卡片上估计的停留排不下时缩短并写明原估计；用户说的不缩，排不下照实说；放得下就不缩。
 * - 对话（T04–T06）：Agent 估的标成估计，用户说的标成用户说的，用户改过的按用户说的。
 * 写在实现之前，锁定后不改。
 */
const SUNNY = "2026-10-15";
const BY_CAR = { allowed: ["walking", "taxi", "driving"], prefer: "balanced" } as const;
const at = (id: string) => worldSelection(id);
const req = (extra: Record<string, unknown>) => ({
  schemaVersion: "planning-requirements.v1",
  cityAdcode: YUNLING.adcode,
  timeZone: "Asia/Shanghai",
  travelMode: "walking",
  date: SUNNY,
  window: { startsAt: "09:00", endsAt: "17:00" },
  startPlace: at("Y-STATION"),
  endPlace: at("Y-STATION"),
  interests: [],
  pace: "standard",
  travel: BY_CAR,
  visits: [],
  ...extra,
});
const park = (stayMinutes: number, estimate: boolean) => ({
  place: at("Y-PARK"), role: "required", stayMinutes, ...(estimate ? { staySource: "estimate", kind: "big_scenic" } : {}),
});
const museum = { place: at("Y-MUSEUM"), role: "required", stayMinutes: 120 };

export const STAY_PLAN_CASES: readonly PlayCase[] = [
  {
    id: "T01", note: "欢乐谷估 6 小时 + 博物馆 2 小时，8 小时窗口放不下：估计的缩短并写明", date: SUNNY,
    requirements: req({ visits: [park(360, true), museum] }),
    satisfiedBy: {}, expect: "draft", shortened: { id: "Y-PARK", below: 360 },
  },
  {
    id: "T02", note: "同样的安排，6 小时是用户说的：不缩，照实说排不开", date: SUNNY,
    requirements: req({ visits: [park(360, false), museum] }),
    satisfiedBy: {}, expect: "no_plan",
  },
  {
    id: "T03", note: "欢乐谷估 5 小时，放得下：不缩", date: SUNNY,
    requirements: req({ window: { startsAt: "09:00", endsAt: "18:00" }, visits: [park(300, true)] }),
    satisfiedBy: {}, expect: "draft", notShortened: true, stays: { "Y-PARK": [300, 300] },
  },
];

const parkVisit = (outcome: ConversationOutcome) => outcome.draft.visits.find((visit) =>
  visit.place.status === "bound" && visit.place.name === "云岭欢乐谷") as
  (ConversationOutcome["draft"]["visits"][number] & { staySource?: string }) | undefined;
const estimated: ConversationCheck = {
  name: "stay_marked_estimate",
  test: (outcome) => parkVisit(outcome)?.staySource === "estimate" && (parkVisit(outcome)?.stayMinutes ?? 0) >= 240,
};
const said = (minutes: number): ConversationCheck => ({
  name: `stay_user_${minutes}`,
  test: (outcome) => parkVisit(outcome)?.stayMinutes === minutes && parkVisit(outcome)?.staySource !== "estimate",
});
const c = (id: string, note: string, turns: readonly string[], checks: readonly ConversationCheck[], extra: Partial<ConversationCase> = {}): ConversationCase =>
  ({ id, note, turns, checks, ...extra });

export const STAY_CHAT_CASES: readonly ConversationCase[] = [
  c("T04", "大景区没说多久：Agent 估计，标成估计", ["明天去云岭欢乐谷玩一天"], [estimated], { located: YUNLING }),
  c("T05", "用户说了玩多久：标成用户说的", ["明天去云岭欢乐谷，玩4个小时"], [said(240)], { located: YUNLING }),
  c("T06", "用户改了估计的时间：之后按用户说的", ["明天去云岭欢乐谷玩一天", "欢乐谷待5个小时就行"], [said(300)], { located: YUNLING }),
];

export const STAY_DATASET_VERSION = "v211-stay.v1";
export function stayDatasetDigest(): string {
  const shape = [
    ...STAY_PLAN_CASES,
    ...STAY_CHAT_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })),
  ];
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
