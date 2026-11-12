import { createHash } from "node:crypto";
import { outingDays, type DraftPlace, type OutingTransport, type RequirementsDraft } from "@tripquest/application/conversation";
import type { ConversationCase, ConversationCheck, ConversationOutcome } from "../v29/conversation-run";
import { HAICHENG, LANXI, SONGZHOU, YUNLING } from "../v21/world";

/**
 * V4.3 多城出游记对每晚住在哪个城市（stages/V4.3.md §4.1）：只走对话（加每轮之后代码补卡片）的出游题，看卡片上每晚的
 * 城市和交通的日子对不对、用户给的车没被改、没有编造城市。照 O04（“开车去乌镇住一晚，第二天去苏州住两晚，最后坐高铁……”）
 * 的样子写，不用它的原句；城市是评测世界里的海澄、松州、云岭、岚溪。评测“今天”是 2026-10-15（周四）。
 * 2026-11-04 写在实现之前，锁定后不改；S10–S12 留出。
 *
 * 每晚的城市按卡片算（评测这边自己算，不用产品的结果）：这晚的住处 → “住在哪”（stays，V4.3 之前没有）→ 这天坐车
 * 到达的城市 → 这天的地点 → 前一晚（第 1 晚之前是出发城市）。和产品定每晚城市的先后一样，只是没有分到各天这一步。
 */
const HZ = "330100";
const HC = HAICHENG.adcode;
const SZ = SONGZHOU.adcode;
const YL = YUNLING.adcode;
const LX = LANXI.adcode;
const HANGZHOU = { adcode: HZ, name: "杭州市" } as const;

const outingOf = (outcome: ConversationOutcome) => (outcome.draft.mode === "outing" ? outcome.draft.outing : undefined);
const rides = (outcome: ConversationOutcome): readonly OutingTransport[] =>
  (outingOf(outcome)?.transports ?? []).filter((item) => item.mode !== "other");
const cityOf = (place: DraftPlace | null | undefined): string | null => {
  if (place?.status === "bound") return place.city ?? null;
  if (place?.status !== "choose") return null;
  const cities = new Set(place.choices.map((choice) => choice.city));
  return cities.size === 1 ? [...cities][0] ?? null : null;
};
/** V4.3 的卡片字段；之前的卡片没有，读出来是空的。 */
const staysOf = (draft: RequirementsDraft): readonly { nights: readonly number[]; city: { adcode: string } }[] =>
  ((draft.outing as { stays?: readonly { nights: readonly number[]; city: { adcode: string } }[] } | undefined)?.stays) ?? [];

/** 每晚在哪个城市（上面说的先后）。没有日期时是空的。 */
export function nightCities(draft: RequirementsDraft): (string | null)[] {
  const outing = draft.mode === "outing" ? draft.outing : undefined;
  if (!outing?.dates) return [];
  const nights = Math.max(0, outingDays(outing) - 1);
  let previous = cityOf(draft.start) ?? draft.city?.adcode ?? null;
  const result: (string | null)[] = [];
  for (let night = 1; night <= nights; night += 1) {
    const lodging = outing.lodging.find((item) => item.night === night);
    const stay = staysOf(draft).find((item) => item.nights.includes(night));
    const landed = outing.transports.filter((item) => item.day === night && item.arriveDay !== "next").map((item) => cityOf(item.to)).filter(Boolean).at(-1);
    const visited = draft.visits.filter((visit) => visit.day === night).map((visit) => cityOf(visit.place)).filter(Boolean).at(-1);
    const city = cityOf(lodging?.place) ?? stay?.city.adcode ?? landed ?? visited ?? previous;
    result.push(city);
    previous = city;
  }
  return result;
}

const nights = (expected: readonly string[]): ConversationCheck => ({
  name: "night_cities",
  test: (outcome) => JSON.stringify(nightCities(outcome.draft)) === JSON.stringify(expected),
});
/** 这一天有一趟从 from 城市到 to 城市的车（方式不限，两端按城市看）。 */
const rideOn = (day: number, from: string, to: string): ConversationCheck => ({
  name: `ride_d${day}_${from}_${to}`,
  test: (outcome) => rides(outcome).some((item) => item.day === day && cityOf(item.from) === from && cityOf(item.to) === to),
});
/** 用户给了时刻的那趟车：日子和时刻都没被改。 */
const userRide = (day: number, from: string, departAt: string): ConversationCheck => ({
  name: "user_ride_kept",
  test: (outcome) => rides(outcome).some((item) => item.day === day && cityOf(item.from) === from && item.departAt === departAt),
});
/** “住在哪”里的城市都是题目里说过的城市（没有编造）。 */
const noInvented = (allowed: readonly string[]): ConversationCheck => ({
  name: "no_invented_city",
  test: (outcome) => staysOf(outcome.draft).every((item) => allowed.includes(item.city.adcode)),
});
/** 不认：卡片上没有“住在哪”。 */
const noStays: ConversationCheck = { name: "no_stays", test: (outcome) => staysOf(outcome.draft).length === 0 };

const c = (
  id: string,
  note: string,
  turns: readonly string[],
  checks: readonly ConversationCheck[],
  extra: Partial<ConversationCase> = {},
): ConversationCase => ({ id, note, turns, checks, located: HANGZHOU, outing: true, ...extra });

export const STAYS_DATASET_VERSION = "v43-stays.v1";

export const STAYS_CASES: readonly ConversationCase[] = [
  c("S01", "多城自驾：先去 A 住一晚，再去 B 住两晚", [
    "10月24日到27日开车出去玩四天，先去海澄住一晚，再去松州住两晚，最后开车回杭州",
    "从杭州东站开车出发，最后回杭州东站",
  ], [nights([HC, SZ, SZ]), noInvented([HC, SZ])]),
  c("S02", "像 O04：开车去 A 住一晚，第二天去 B 住两晚，最后坐高铁回来（车应在第 4 天）", [
    "10月24日到27日，开车去海澄住一晚，第二天去松州住两晚，最后坐高铁回杭州",
    "从杭州东站开车出发，最后回杭州东站",
  ], [nights([HC, SZ, SZ]), rideOn(4, SZ, HZ), noInvented([HC, SZ])]),
  c("S03", "坐高铁两城：A 住两晚、B 住一晚，中间那趟车在第 3 天", [
    "10月20日到23日，坐高铁去海澄住两晚，然后坐高铁去松州住一晚，最后坐高铁回杭州",
    "杭州东站出发，回杭州东站",
  ], [nights([HC, HC, SZ]), rideOn(1, HZ, HC), rideOn(3, HC, SZ), rideOn(4, SZ, HZ), noInvented([HC, SZ])]),
  c("S04", "用户给了时刻的车和住宿对不上：不挪", [
    "10月20日到22日去海澄住两晚，21号下午3点从海澄站坐高铁去松州",
    "从杭州东站出发，最后回杭州东站",
  ], [userRide(2, HC, "15:00"), noInvented([HC, SZ])]),
  c("S05", "只说玩三天、没说住哪：不认", [
    "10月20日到22日去松州玩三天，坐高铁，想逛老街",
    "杭州东站出发，回杭州东站",
  ], [noStays, nights([SZ, SZ])]),
  c("S06", "晚数加起来超过行程：不认", [
    "10月20日到22日先去海澄住两晚，再去松州住两晚，开车去",
    "从杭州东站开车出发，回杭州东站",
  ], [noStays]),
  c("S07", "单城出游：不受影响", [
    "10月24日到25日去海澄玩两天，坐高铁，想看灯塔",
    "杭州东站出发，回杭州东站",
  ], [nights([HC]), rideOn(1, HZ, HC), rideOn(2, HC, HZ), noInvented([HC])]),
  c("S08", "地名不是城市（古镇）：那晚不认，后面的城市照认", [
    "10月20日到22日从云岭开车出发，先去青石古镇住一晚，再去岚溪住一晚",
    "从云岭中心广场出发，最后回云岭中心广场",
  ], [nights([YL, LX]), noInvented([LX])], { located: YUNLING }),
  c("S09", "坐高铁到 A 住两天，再去 B 住一晚", [
    "10月20日到23日坐高铁去松州住两天，再去海澄住一晚，然后坐高铁回杭州",
    "杭州东站出发，回杭州东站",
  ], [nights([SZ, SZ, HC]), rideOn(3, SZ, HC), rideOn(4, HC, HZ), noInvented([HC, SZ])]),
  c("S10", "留出：用“在”说，自驾", [
    "11月1日到4日自驾出去，在海澄住一晚，在松州住两晚，然后回杭州",
    "从杭州东站开车出发，回杭州东站",
  ], [nights([HC, SZ, SZ]), noInvented([HC, SZ])], { heldOut: true }),
  c("S11", "留出：第二句才给日期", [
    "开车去海澄住一晚，再去松州住两晚，最后开车回杭州",
    "10月24日出发，27日回来，从杭州东站出发回杭州东站",
  ], [nights([HC, SZ, SZ]), noInvented([HC, SZ])], { heldOut: true }),
  c("S12", "留出：用“到”说，坐高铁三段", [
    "10月20日到23日，坐高铁先到松州住一晚，再到海澄住两晚，最后坐高铁回杭州",
    "杭州东站出发，回杭州东站",
  ], [nights([SZ, HC, HC]), rideOn(1, HZ, SZ), rideOn(2, SZ, HC), rideOn(4, HC, HZ), noInvented([HC, SZ])], { heldOut: true }),
];

export function staysDigest(): string {
  return createHash("sha256").update(JSON.stringify(STAYS_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
