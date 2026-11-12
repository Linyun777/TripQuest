import { createHash } from "node:crypto";
import { outingDays, type RequirementsDraft } from "@tripquest/application/conversation";
import type { ConversationCase, ConversationCheck } from "../v29/conversation-run";
import { nightCities } from "../v43/stays-dataset";
import { HAICHENG, SONGZHOU, V21_TODAY } from "../v21/world";

/**
 * V4.4 日期以用户说的为准（stages/V4.4.md §4.1）：只走对话（加每轮之后代码补卡片）的题，看卡片上的日期是不是用户说的、
 * 晚数和日期对不上时问了没有、只给出发日时天数按晚数、没给日期时说清用了哪天。城市是评测世界里的海澄、松州。
 * 评测“今天”是 2026-10-15（周四）：“下周六”是 10 月 24 日，“这个周六”是 17 日，“明天”是 16 日。
 * 2026-11-07 写在实现之前，锁定后不改；D09、D10 留出。
 */
const HZ = "330100";
const HC = HAICHENG.adcode;
const SZ = SONGZHOU.adcode;
const HANGZHOU = { adcode: HZ, name: "杭州市" } as const;

const datesOf = (draft: RequirementsDraft): { from: string; to: string } | null =>
  draft.mode === "outing" ? draft.outing?.dates ?? null : draft.date ? { from: draft.date, to: draft.date } : null;

/** 最后卡片上的日期正好是这几天。 */
const dates = (from: string, to: string): ConversationCheck => ({
  name: `dates_${from.slice(5)}_${to.slice(5)}`,
  test: (outcome) => JSON.stringify(datesOf(outcome.draft)) === JSON.stringify({ from, to }),
});
/** 出游一共几天、第一天是给的几天之一（“下周六”有人理解成这个周六，这里不考）。 */
const length = (days: number, starts: readonly string[]): ConversationCheck => ({
  name: `days_${days}`,
  test: (outcome) => {
    const outing = outcome.draft.mode === "outing" ? outcome.draft.outing : undefined;
    return !!outing?.dates && starts.includes(outing.dates.from) && outingDays(outing) === days;
  },
});
/** 有一轮回复问了晚数和日期怎么对上（延长还是少住）。 */
const askedNights: ConversationCheck = {
  name: "asked_nights",
  test: (outcome) => outcome.replies.some((reply) => /[？?]/.test(reply) && /晚/.test(reply) &&
    /延长|延到|延后|推迟|少住|多住|少一晚|多一晚|多一天|加一天|对不上|不够|改到|改成|还是/.test(reply)),
};
/**
 * 没给日期：卡片上没有日期且有一轮问了哪天，或者卡片上有日期、回复里说了是哪天（“10月15日”“15日”“15号”，
 * 或“先按明天到后天”这样说了先按哪天）。
 */
const datesExplained: ConversationCheck = {
  name: "dates_explained",
  test: (outcome) => {
    const found = datesOf(outcome.draft);
    if (!found) return outcome.replies.some((reply) => /[？?]/.test(reply) && /哪天|几号|日期|什么时候|哪几天/.test(reply));
    const month = Number(found.from.slice(5, 7));
    const day = Number(found.from.slice(8, 10));
    const said = new RegExp(`(${month}\\s*月\\s*)?${day}\\s*(日|号)`);
    const offset = Math.round((Date.parse(found.from) - Date.parse(V21_TODAY)) / 86_400_000);
    const word = ["今天", "明天", "后天"][offset];
    return outcome.replies.some((reply) => said.test(reply) || (!!word && reply.includes(word) && /先|暂/.test(reply)));
  },
};
const nights = (expected: readonly string[]): ConversationCheck => ({
  name: "night_cities",
  test: (outcome) => JSON.stringify(nightCities(outcome.draft)) === JSON.stringify(expected),
});

const c = (
  id: string,
  note: string,
  turns: readonly string[],
  checks: readonly ConversationCheck[],
  extra: Partial<ConversationCase> = {},
): ConversationCase => ({ id, note, turns, checks, located: HANGZHOU, outing: true, ...extra });

const daily = (id: string, note: string, turns: readonly string[], checks: readonly ConversationCheck[]): ConversationCase =>
  ({ id, note, turns, checks, located: HANGZHOU });

export const DATES_DATASET_VERSION = "v44-dates.v1";

export const DATES_CASES: readonly ConversationCase[] = [
  c("D01", "给了日期、晚数更多（S06 类）：日期不变、问一句", [
    "10月20日到22日，先去松州住两晚，再去海澄住两晚，坐高铁去",
    "杭州东站出发，回杭州东站",
  ], [dates("2026-10-20", "2026-10-22"), askedNights]),
  c("D02", "给了日期、晚数正好：照常", [
    "10月20日到23日，开车先去海澄住一晚，再去松州住两晚，最后开车回杭州",
    "从杭州东站开车出发，回杭州东站",
  ], [dates("2026-10-20", "2026-10-23"), nights([HC, SZ, SZ])]),
  c("D03", "第二轮用户自己改日期：照常改", [
    "10月24日到25日去海澄玩两天，坐高铁，杭州东站出发回杭州东站",
    "日期改成25号到26号吧",
  ], [dates("2026-10-25", "2026-10-26")]),
  c("D04", "第二轮加住宿、晚数超出：日期不变、问一句", [
    "10月24日到25日去松州玩两天，坐高铁，杭州东站出发回杭州东站",
    "第一晚住松州，然后想再去海澄住一晚",
  ], [dates("2026-10-24", "2026-10-25"), askedNights]),
  c("D05", "第二轮说多玩一天（没说日期）：照常延长", [
    "10月24日到25日去海澄玩两天，坐高铁，杭州东站出发回杭州东站",
    "再多玩一天吧",
  ], [dates("2026-10-24", "2026-10-26")]),
  c("D06", "只给出发日、说了住几晚：一共 4 天", [
    "下周六开车去海澄住一晚，第二天去松州住两晚，然后开车回杭州",
    "从杭州东站开车出发，回杭州东站",
  ], [length(4, ["2026-10-17", "2026-10-24"]), nights([HC, SZ, SZ])]),
  c("D07", "没给日期：卡片上的日期在回复里说清（或者问了哪天）", [
    "去松州玩两天，坐高铁，想逛老街",
    "杭州东站出发，回杭州东站",
  ], [datesExplained]),
  daily("D08", "日常“明天”：第二轮说别的，日期不变", [
    "明天9点从东门广场出发，想去看展，下午5点回来",
    "再加个喝茶的地方",
  ], [dates("2026-10-16", "2026-10-16")]),
  c("D09", "留出：相对日期“下周六到周日”，第二轮说别的", [
    "下周六到周日去海澄玩，坐高铁，杭州东站出发回杭州东站",
    "想看灯塔，再找个吃海鲜的地方",
  ], [dates("2026-10-24", "2026-10-25")], { heldOut: true }),
  c("D10", "留出：单日出游“这个周六”", [
    "这个周六坐高铁去松州玩一天，当天回杭州",
    "杭州东站出发，回杭州东站",
  ], [dates("2026-10-17", "2026-10-17")], { heldOut: true }),
];

export function datesDigest(): string {
  return createHash("sha256").update(JSON.stringify(DATES_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
