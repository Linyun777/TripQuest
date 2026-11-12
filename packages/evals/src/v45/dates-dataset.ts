import { createHash } from "node:crypto";
import { outingDays, type RequirementsDraft } from "@tripquest/application/conversation";
import type { ConversationCase, ConversationCheck } from "../v29/conversation-run";

/**
 * V4.5 日期的两个收尾（stages/V4.5.md §4）：只走对话（加每轮之后代码补卡片）的出游题。一是只给出发日、说了住几晚时，
 * 模型回复里写的日子和卡片一致（V4.4 的 O04 回复里还写着多出的一天）；二是周末类说法、写清日子又带“周末”的、元旦这类
 * 固定日期的节日认得出、受保护。城市是评测世界里的海澄、松州、云岭。评测“今天”是 2026-10-15（周四）：
 * “这周六周日”是 17–18 日，“下周末”是 24–25 日，“元旦”是 2027-01-01。
 * 2026-11-07 写在实现之前，锁定后不改；E06 留出。
 */
const HANGZHOU = { adcode: "330100", name: "杭州市" } as const;

const datesOf = (draft: RequirementsDraft) => (draft.mode === "outing" ? draft.outing?.dates ?? null : null);

/** 最后卡片上的日期正好是这几天。 */
const dates = (from: string, to: string): ConversationCheck => ({
  name: `dates_${from.slice(5)}_${to.slice(5)}`,
  test: (outcome) => JSON.stringify(datesOf(outcome.draft)) === JSON.stringify({ from, to }),
});
/** 第一天是这一天，结束日不考。 */
const startsOn = (from: string): ConversationCheck => ({
  name: `starts_${from}`,
  test: (outcome) => datesOf(outcome.draft)?.from === from,
});
/** 一共几天、第一天是给的几天之一（“下周六”有人理解成这个周六，这里不考）。 */
const length = (days: number, starts: readonly string[]): ConversationCheck => ({
  name: `days_${days}`,
  test: (outcome) => {
    const outing = outcome.draft.mode === "outing" ? outcome.draft.outing : undefined;
    return !!outing?.dates && starts.includes(outing.dates.from) && outingDays(outing) === days;
  },
});
/**
 * 模型写的回复（代码加在后面的说明不算，说明在空行之后）里提到的日子都不晚于卡片上的结束日：模型说“28日从云岭回”、
 * 卡片却是 27 日，算对不上。没写月份的几号按卡片结束日的月份算。
 */
const replyMatchesCard: ConversationCheck = {
  name: "reply_end_matches_card",
  test: (outcome) => {
    const found = datesOf(outcome.draft);
    if (!found) return false;
    const year = found.to.slice(0, 4);
    const month = Number(found.to.slice(5, 7));
    return outcome.replies.every((reply) => {
      const model = reply.split("\n\n")[0] ?? "";
      return [...model.matchAll(/(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号](?![线楼门口])/g)].every((match) => {
        const day = `${year}-${String(match[1] ? Number(match[1]) : month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
        return day <= found.to;
      });
    });
  },
};

const c = (
  id: string,
  note: string,
  turns: readonly string[],
  checks: readonly ConversationCheck[],
  extra: Partial<ConversationCase> = {},
): ConversationCase => ({ id, note, turns, checks, located: HANGZHOU, outing: true, ...extra });

export const DATES45_DATASET_VERSION = "v45-dates.v1";

export const DATES45_CASES: readonly ConversationCase[] = [
  c("E01", "像 O04：只给出发日、最后一站玩一天再回，回复里的结束日和卡片一致", [
    "下周六开车去海澄住一晚，第二天去松州住两晚，最后坐高铁去云岭玩一天再坐高铁回杭州",
    "从杭州东站开车出发，最后回杭州东站",
  ], [length(4, ["2026-10-17", "2026-10-24"]), replyMatchesCard]),
  c("E02", "“这周六周日”，第二轮加住宿、晚数超出：日期不变", [
    "这周六周日去海澄玩，坐高铁，杭州东站出发回杭州东站",
    "第一晚住海澄，第二晚想去松州住",
  ], [dates("2026-10-17", "2026-10-18")]),
  c("E03", "“下周末”，第二轮加住宿、晚数超出：日期不变", [
    "下周末去松州玩两天，坐高铁，杭州东站出发回杭州东站",
    "第一晚住松州，然后想再去海澄住一晚",
  ], [dates("2026-10-24", "2026-10-25")]),
  c("E04", "写清日子又带“周末”，第二轮加住宿、晚数超出：日期不变", [
    "10月24日到25日周末去海澄，高铁来回，杭州东站出发回杭州东站",
    "第一晚住海澄，第二晚想去松州住",
  ], [dates("2026-10-24", "2026-10-25")]),
  c("E05", "“元旦去”：开始日是 1 月 1 日，第二轮说别的", [
    "元旦去海澄玩两天，坐高铁，杭州东站出发回杭州东站",
    "想看灯塔，再找个吃海鲜的地方",
  ], [startsOn("2027-01-01")]),
  c("E06", "留出：“周末两天”，第二轮加住宿、晚数超出", [
    "周末两天去松州逛老街，坐高铁，杭州东站出发回杭州东站",
    "第一晚住松州，然后想再去海澄住一晚",
  ], [dates("2026-10-17", "2026-10-18")], { heldOut: true }),
];

export function dates45Digest(): string {
  return createHash("sha256").update(JSON.stringify(DATES45_CASES.map((item) => ({ ...item, checks: item.checks.map((check) => check.name) })))).digest("hex");
}
