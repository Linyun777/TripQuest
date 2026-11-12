import { applyDraftPatch, DRAFT_LIMITS, outingDays, type DraftPatch, type RequirementsDraft } from "./conversation";
import { stayText, tripNights, tripWords } from "./outing-stays";

/**
 * V4.4 日期以用户说的为准（stages/V4.4.md §3.1、§3.4；V4.5 §3.2 加周末、节日）：代码从用户原话认出日期（“10月20日到22日”“下周六到周日”
 * “明天”“24号出发，27号回来”），模型在用户没说新日期的一轮里改了卡片上的日期就打回、仍改则改回；用户从来没说过日期、
 * 卡片上的日期是模型定的，标“暂定”。只算，不查地图；不改提示词。
 */

/** 用户这句话里的日期：none 没说；dates 认出了（只给出发或只给回来的那头为 null）；loose 说到了日期或天数、但代码定不下来。 */
export type DateWords =
  | { readonly kind: "none" }
  | { readonly kind: "dates"; readonly from: string | null; readonly to: string | null }
  /** anchored：说了具体的日子（“周末”“国庆”“下个月”），只是代码算不出来；否则只是说多玩几天、推迟这类。 */
  | { readonly kind: "loose"; readonly anchored: boolean };

export type SaidDates = NonNullable<RequirementsDraft["saidDates"]>;

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const RELATIVE: Record<string, number> = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 明早: 1, 后天: 2, 大后天: 3 };
/** “10月20日到22日”“20到22号”“11月30日-12月2日”：前一个可以不带日、号。 */
const RANGE = /(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]?\s*(?:到|至|-|—|–|~|～)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号](?![线楼门口馆厅站])/g;
const SINGLE = /(?<![\d第])(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号](?![线楼门口馆厅站])/g;
const DAY_WORD = /大后天|后天|明天|今天|今晚|明晚|明早/g;
const WEEK_WORD = /(?<!上)(下下个?|下个|下|这个|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/g;
/** V4.5：“周末”“这周六周日”“下个周末”“周末两天”——那一周的周六到周日。 */
const WEEKEND = /(?<!上)(下下个?|下个|下|这个|这|本)?(?:周末|(?:周|星期|礼拜)六(?:和|、|，|,)?(?:(?:周|星期|礼拜)?[日天]))(?:两天)?/g;
/** V4.5：放假日子每年不同的节日只认开始那天（国庆 10 月 1 日、五一 5 月 1 日、元旦 1 月 1 日）。 */
const HOLIDAY = /国庆|十一(?:假期|长假|黄金周)|五一|元旦/g;
const HOLIDAY_DAY = (word: string) => (word === "五一" ? [5, 1] : word === "元旦" ? [1, 1] : [10, 1]) as [number, number];
/** 说了具体的日子，代码算不出来（春节、中秋这类按农历的节日；V4.5 起周末、国庆、五一、元旦认得出）。 */
const ANCHORED = /春节|中秋|端午|清明|月底|月初|月中|下个?月|年底|[〇一二三四五六七八九十]{1,3}\s*[月日号](?![线楼门口])|\d{1,2}\s*月(?!\s*\d)/;
/** 说到要改天数或挪日子，没说是哪天（“再多玩一天”“推迟两天”“玩三天吧”）。少住 / 多住说的是晚数，不算。 */
const SHIFT = /多玩|多待|多呆|少玩|少待|延长|缩短|推迟|提前|往后挪|往前挪|[晚早][一两1-2]天|(?:玩|待|呆|逛)[一二两三四五六七1-7]天|[一二两三四五六七1-7]天[一二两三四五六1-6]晚|一日游|改日期|换日期|换个日子|改天/;
/** 单个日期后面跟着这些是回来那天。 */
const ENDS_AFTER = /^\s*(?:再|就)?(?:回|返|结束)/;
const ENDS_BEFORE = /(?:到|至)\s*$/;

interface Mention {
  readonly start: number;
  readonly end: number;
  readonly from: string;
  readonly to?: string;
  /** V4.5：周末、节日；句子里还有写清的日期时只作说明（“10月24日到25日周末”）。 */
  readonly note?: true;
}

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (year: number, month: number, day: number): string | null => {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
};
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** 周一是 1，周日是 7。 */
const weekdayOf = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay() || 7;

/**
 * 没写月份的几号：今天之前的算下个月。写了月份的几月几日在今天之前时算不出来（null，可能说错了，不当成明年）；
 * after 给了（“11月30日到12月2日”的后一个）就从那天往后算。
 */
function monthDay(today: string, month: number | null, day: number, after?: string): string | null {
  const base = after ?? today;
  const [year, thisMonth, thisDay] = base.split("-").map(Number) as [number, number, number];
  if (month === null) {
    const same = iso(year, thisMonth, day);
    if (same && day >= thisDay) return same;
    return thisMonth === 12 ? iso(year + 1, 1, day) : iso(year, thisMonth + 1, day);
  }
  const same = iso(year, month, day);
  if (!same) return null;
  return same >= base ? same : after ? iso(year + 1, month, day) : null;
}

/** “下周六”是下一个自然周的周六；只说“周六”是今天起最近的那个周六（after 给了就从那天起算，“下周六到周日”的周日）。 */
function weekDate(today: string, prefix: string | undefined, target: number, after?: string): string {
  if (after && !prefix) return addDays(after, ((target - weekdayOf(after)) + 7) % 7);
  const now = weekdayOf(today);
  if (!prefix) return addDays(today, target >= now ? target - now : 7 - now + target);
  const weeks = prefix.startsWith("下下") ? 2 : prefix.startsWith("下") ? 1 : 0;
  return addDays(today, weeks * 7 + target - now);
}

/** 那一周（weeks 周之后）的周末：今天是周六就是今天到明天，今天是周日、说的是这周就是今天一天。 */
function weekendOf(today: string, weeks: number): { from: string; to: string } {
  const now = weekdayOf(today);
  if (now === 7 && !weeks) return { from: today, to: today };
  const saturday = addDays(today, weeks * 7 + 6 - now);
  return { from: saturday, to: addDays(saturday, 1) };
}

/** 节日今天之后最近的一次（今天就是也算）。 */
function holidayDate(today: string, word: string): string {
  const [month, day] = HOLIDAY_DAY(word);
  const year = Number(today.slice(0, 4));
  const same = iso(year, month, day)!;
  return same >= today ? same : iso(year + 1, month, day)!;
}

/** 一句话里认出的日期说法（按出现的先后），“A 到 B”合成一段。算不出来（日子不存在）的为 null。 */
function mentions(text: string, today: string): Mention[] | null {
  const found: Mention[] = [];
  const taken = (start: number, end: number) => found.some((item) => start < item.end && end > item.start);
  for (const match of text.matchAll(WEEKEND)) {
    const prefix = match[1];
    const weeks = !prefix ? 0 : prefix.startsWith("下下") ? 2 : prefix.startsWith("下") ? 1 : 0;
    found.push({ start: match.index!, end: match.index! + match[0].length, ...weekendOf(today, weeks), note: true });
  }
  for (const match of text.matchAll(RANGE)) {
    if (taken(match.index!, match.index! + match[0].length)) continue;
    const fromMonth = match[1] ? Number(match[1]) : null;
    const from = monthDay(today, fromMonth, Number(match[2]));
    if (!from) return null;
    const to = monthDay(today, match[3] ? Number(match[3]) : fromMonth ?? Number(from.slice(5, 7)), Number(match[4]), from);
    if (!to) return null;
    found.push({ start: match.index!, end: match.index! + match[0].length, from, to });
  }
  const singles: { start: number; end: number; at: (after?: string) => string | null }[] = [];
  for (const match of text.matchAll(HOLIDAY)) {
    found.push({ start: match.index!, end: match.index! + match[0].length, from: holidayDate(today, match[0]), note: true });
  }
  for (const match of text.matchAll(SINGLE)) {
    singles.push({ start: match.index!, end: match.index! + match[0].length, at: () => monthDay(today, match[1] ? Number(match[1]) : null, Number(match[2])) });
  }
  for (const match of text.matchAll(DAY_WORD)) {
    singles.push({ start: match.index!, end: match.index! + match[0].length, at: () => addDays(today, RELATIVE[match[0]]!) });
  }
  for (const match of text.matchAll(WEEK_WORD)) {
    singles.push({ start: match.index!, end: match.index! + match[0].length, at: (after) => weekDate(today, match[1], WEEKDAY[match[2]!]!, after) });
  }
  singles.sort((a, b) => a.start - b.start);
  for (let index = 0; index < singles.length; index += 1) {
    const first = singles[index]!;
    if (taken(first.start, first.end)) continue;
    const from = first.at();
    if (!from) return null;
    // “下周六到周日”“明天到后天”：两个日子之间只有“到”，合成一段；后一个从前一个起算。
    const second = singles[index + 1];
    if (second && /^\s*(?:到|至|-|—|–|~|～)\s*$/.test(text.slice(first.end, second.start))) {
      const to = second.at(from);
      if (!to) return null;
      found.push({ start: first.start, end: second.end, from, to });
      index += 1;
      continue;
    }
    found.push({ start: first.start, end: first.end, from });
  }
  // 写清了日子的，周末、节日只作说明，按写清的日子认（对不上也按写清的）。
  const plain = found.filter((item) => !item.note);
  return (plain.length ? plain : found).sort((a, b) => a.start - b.start);
}

/** 用户这句话里的日期（today 是北京时间的今天）。 */
export function dateWords(text: string, today: string): DateWords {
  const found = mentions(text, today);
  if (found === null) return { kind: "loose", anchored: true };
  if (!found.length) {
    if (ANCHORED.test(text)) return { kind: "loose", anchored: true };
    return SHIFT.test(text) ? { kind: "loose", anchored: false } : { kind: "none" };
  }
  // 按农历的节日和算得出来的混在一起：不定。
  if (/春节|中秋|端午|清明/.test(text)) return { kind: "loose", anchored: true };
  const ranges = found.filter((item) => item.to);
  let from: string | null = null;
  let to: string | null = null;
  if (ranges.length) {
    if (found.length > 1) return { kind: "loose", anchored: true };
    from = ranges[0]!.from;
    to = ranges[0]!.to!;
  } else {
    for (const item of found) {
      const ends = ENDS_AFTER.test(text.slice(item.end, item.end + 4)) || ENDS_BEFORE.test(text.slice(Math.max(0, item.start - 3), item.start));
      if (ends ? to : from) return { kind: "loose", anchored: true };
      if (ends) to = item.from;
      else from = item.from;
    }
  }
  if ((from && from < today) || (to && to < today) || (from && to && from > to)) return { kind: "loose", anchored: true };
  return { kind: "dates", from, to };
}

/**
 * 这一轮卡片上的日期应该是什么：用户这一轮说了就按这一轮的（只说了一头的，另一头沿用之前用户给的；只改了出发那天时
 * 回来那天不再管），没说就按之前用户给的；说到了日期又定不下来时不管（undefined）。
 */
export function expectedDates(said: SaidDates | undefined, words: DateWords): SaidDates | undefined {
  if (words.kind === "none") return said;
  if (words.kind === "loose") return undefined;
  return { from: words.from ?? said?.from ?? null, to: words.to ?? (words.from ? null : said?.to ?? null) };
}

/** 卡片上现在的日期（日常是那一天）。 */
export function cardDates(draft: RequirementsDraft): { from: string; to: string } | null {
  if (draft.mode === "outing") return draft.outing?.dates ?? null;
  return draft.date ? { from: draft.date, to: draft.date } : null;
}

/**
 * 这一轮模型改了（或第一次写了）卡片上的日期、又和用户给的对不上时，应改回的日期；模型没动日期（“明天下雨吗”这类话里
 * 的日子不是在说这趟的日期）、对得上、或拼不出合法的日期时为 null。日常只看那一天。
 */
export function datesToRestore(
  before: RequirementsDraft,
  after: RequirementsDraft,
  expected: SaidDates | undefined,
): { from: string; to: string } | null {
  const card = cardDates(after);
  if (!expected || !card || after.mode === "short" || sameDates(cardDates(before), card)) return null;
  if (after.mode !== "outing") return expected.from && expected.from !== card.from ? { from: expected.from, to: expected.from } : null;
  const target = { from: expected.from ?? card.from, to: expected.to ?? card.to };
  if (target.from > target.to) return null;
  return sameDates(target, card) ? null : target;
}

const sameDates = (a: { from: string; to: string } | null, b: { from: string; to: string } | null) =>
  a?.from === b?.from && a?.to === b?.to;

/**
 * 把卡片的日期改成 target（改回用户给的，或 V4.4 §3.3 按晚数算的结束日期）：超出新天数的交通放到最后一天、地点和兴趣
 * 去掉第几天（固定事项放到最后一天），再走和卡片编辑一样的补丁（超出的住处、住在哪一起去掉，分配作废）。改不了时为 null。
 */
export function withDates(draft: RequirementsDraft, target: { from: string; to: string }): RequirementsDraft | null {
  if (draft.mode !== "outing") {
    const result = applyDraftPatch(draft, { date: target.from });
    return result.status === "ok" ? result.draft : null;
  }
  const next = structuredClone(draft);
  const days = Math.round((Date.parse(target.to) - Date.parse(target.from)) / 86_400_000) + 1;
  for (const ride of next.outing!.transports) if (ride.day > days) ride.day = days;
  for (const visit of next.visits) {
    if ((visit.day ?? 0) <= days) continue;
    if (visit.role === "fixed") visit.day = days;
    else delete visit.day;
  }
  for (const item of next.interests) if ((item.day ?? 0) > days) delete item.day;
  const result = applyDraftPatch(next, { dates: target });
  return result.status === "ok" ? result.draft : null;
}

const dayText = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
/** “10月20日–22日”“10月30日–11月1日”“10月16日”。 */
export function datesText(dates: { from: string; to: string }): string {
  if (dates.from === dates.to) return dayText(dates.from);
  const sameMonth = dates.from.slice(0, 7) === dates.to.slice(0, 7);
  return `${dayText(dates.from)}–${sameMonth ? `${Number(dates.to.slice(8, 10))}日` : dayText(dates.to)}`;
}

/** 给模型的打回提示（同 V2.10 removed_silently 的做法，不改提示词）。 */
export function datesChangedHint(target: { from: string; to: string }, outing: boolean): string {
  const given = outing ? `${target.from} to ${target.to}` : target.from;
  return `dates_changed: the user said ${given}; set the dates back to exactly that with update_requirements, do not extend or shorten them yourself; ` +
    "if the nights or plans do not fit, say so in the reply and leave the choice to the user";
}

/**
 * 一轮结束时（§3.1、§3.4）：模型仍改了用户给的日期就改回，并记下用户给的日期、没给日期时标暂定。返回新卡片和加在回复
 * 后面的说明（没有为 null）。before 是这一轮之前的卡片。
 */
export function settleDates(
  before: RequirementsDraft,
  after: RequirementsDraft,
  words: DateWords,
): { readonly draft: RequirementsDraft; readonly note: string | null } {
  if (after.mode === "short") return { draft: after, note: null };
  const expected = expectedDates(before.saidDates, words);
  const target = datesToRestore(before, after, expected);
  const restored = target ? withDates(after, target) : null;
  const next: RequirementsDraft = structuredClone(restored ?? after);
  const card = cardDates(next);
  // 记下用户给的：模型这一轮没动日期时照旧；动了时，用户这一轮说了就按说的；说到了日期又定不下来时，用户之前给过、
  // 或说了具体的日子（“周末”），就按模型照这句话写的。
  const moved = !sameDates(cardDates(before), cardDates(after));
  let said = before.saidDates;
  if (moved && words.kind === "dates") said = expected;
  if (moved && words.kind === "loose") said = card && (before.saidDates || words.anchored) ? { from: card.from, to: card.to } : undefined;
  if (said && next.mode !== "outing") said = { from: said.from, to: null };
  if (card && said && (said.from || said.to)) next.saidDates = said;
  else delete next.saidDates;
  // 暂定只在模型这一轮写了日期时标上，之后沿用（V4.4 之前的卡片没有这两项，不因此都变成暂定）。
  const guessed = !!card && !next.saidDates && (moved || !!before.datesGuessed);
  if (guessed) next.datesGuessed = true;
  else delete next.datesGuessed;
  const notes: string[] = [];
  if (restored && target) notes.push(`日期按你说的 ${datesText(target)} 没改。`);
  const earlier = cardDates(before);
  if (guessed && card && (!before.datesGuessed || !sameDates(earlier, card))) notes.push(`日期先按 ${datesText(card)} 记，可改。`);
  const unchanged = JSON.stringify(next) === JSON.stringify(after);
  return { draft: unchanged ? after : next, note: notes.length ? notes.join("") : null };
}

/** 用户在卡片上自己改了日期：就是用户给的，不再暂定。 */
export function datesFromCard(draft: RequirementsDraft): RequirementsDraft {
  const card = cardDates(draft);
  if (!card || draft.mode === "short") return draft;
  const next = structuredClone(draft);
  next.saidDates = { from: card.from, to: draft.mode === "outing" ? card.to : null };
  delete next.datesGuessed;
  return next;
}

/**
 * §3.3：用户没给回来那天（只给了出发日，或日期是模型定的），又说了在各处住几晚：结束日期是出发日加晚数之和（最后一天
 * 坐车回、或当天玩完回）。和卡片上的不一样时按晚数改；超过 7 天、改不了时为 null。
 */
export function datesByNights(draft: RequirementsDraft, nights: number): { readonly draft: RequirementsDraft; readonly note: string } | null {
  const target = nightsEnd(draft, nights);
  const next = target ? withDates(draft, target) : null;
  return next && target ? { draft: next, note: `按住宿算是 ${nights + 1} 天，到 ${dayText(target.to)}，可改。` } : null;
}

/** 按晚数卡片应有的日期（出发日不变）；用户给了回来那天、对得上、超过 7 天时为 null。 */
function nightsEnd(draft: RequirementsDraft, nights: number, saidTo = draft.saidDates?.to): { from: string; to: string } | null {
  const card = cardDates(draft);
  if (draft.mode !== "outing" || !card || saidTo || nights + 1 > DRAFT_LIMITS.outingDays) return null;
  const to = addDays(card.from, nights);
  return to === card.to ? null : { from: card.from, to };
}

/**
 * V4.5 §3.1：回复之前就按晚数查结束日期（V4.4 只在回复之后由代码改，模型的回复里还写着多出的一天）。userTexts 是到这一轮
 * 为止用户说的话，读法同每轮之后的补卡片（stayText）；before 是这一轮之前的卡片，expected 是这一轮用户给的日期。要改时
 * 返回应有的日期和天数。
 */
export function nightsToFix(
  before: RequirementsDraft,
  draft: RequirementsDraft,
  userTexts: readonly string[],
  expected: SaidDates | undefined,
): { readonly from: string; readonly to: string; readonly days: number } | null {
  if (draft.mode !== "outing" || !draft.outing?.dates) return null;
  const datesJustSet = !(before.mode === "outing" && before.outing?.dates);
  const text = stayText(userTexts, datesJustSet);
  const words = text ? tripWords(text) : null;
  const nights = words ? tripNights(words) : null;
  const target = nights ? nightsEnd(draft, nights, expected?.to ?? null) : null;
  return target && nights ? { ...target, days: nights + 1 } : null;
}

/** 回复之前按晚数打回的提示（代码给的反馈，不改提示词）。 */
export function nightsHint(target: { readonly from: string; readonly to: string; readonly days: number }): string {
  return `dates_by_nights: by the nights the user named the trip is ${target.days} days, ${target.from} to ${target.to}; ` +
    `set the dates to that with update_requirements (move rides or places on later days to day ${target.days}) and use these dates in the reply`;
}

/** V4.6：补丁里住处越过行程的那几晚，以及这趟的日期、晚数和住下这几晚要延长到哪天；没有越界或没有日期时为 null。 */
function nightsOutside(draft: RequirementsDraft, patch: DraftPatch, lodging: readonly number[]) {
  const dates = patch.dates === undefined ? draft.outing?.dates : patch.dates;
  if (!dates) return null;
  const nights = Math.round((Date.parse(dates.to) - Date.parse(dates.from)) / 86_400_000);
  const outside = [...new Set(lodging)].filter((night) => night > nights).sort((a, b) => a - b);
  if (!outside.length) return null;
  const trip = nights
    ? `the trip is ${dates.from} to ${dates.to}, so it has ${nights} night${nights > 1 ? "s" : ""} (night 1${nights > 1 ? `-${nights}` : ""})`
    : `the trip is one day, ${dates.from}, so it has no night`;
  return { nights, outside, trip, extend: addDays(dates.from, outside.at(-1)!) };
}

const nightList = (outside: readonly number[]) => `night ${outside.join(", ")}`;

/**
 * V4.6：住处写到了行程外那晚、补丁被拒时的打回提示，写明这趟几晚、哪晚越界、怎么办（只给笼统的说明时模型常重发同样的补丁，
 * 纠错额度用完整轮失败）。结束日是用户给的：只记行程内的晚、回复里问；不是：可以同一补丁里延长并说明。算不出时为 null。
 */
export function nightOutsideHint(draft: RequirementsDraft, patch: DraftPatch): string | null {
  const lodging = [...(patch.setLodging ?? []).flatMap((item) => item.nights), ...(draft.outing?.lodging ?? []).map((item) => item.night)];
  const found = nightsOutside(draft, patch, lodging);
  if (!found) return null;
  const way = draft.saidDates?.to
    ? "keep these dates (the user gave them): set lodging only for nights inside the trip, " +
      `and in the reply ask the user whether to extend the trip to ${found.extend} or stay fewer nights`
    : `either set dates.to to ${found.extend} in the same patch and say so in the reply, ` +
      "or set lodging only for nights inside the trip and ask the user";
  return `night_outside_dates: ${found.trip}; ${nightList(found.outside)} ${found.outside.length > 1 ? "are" : "is"} outside it; ${way}`;
}

/**
 * V4.6：结束日是用户给的时，补丁里越过行程那几晚的住处由代码去掉、其余照写，并告诉模型回复里问延长还是少住。只靠打回提示时
 * 模型常照样重发那一晚（`v45-dates.v1` 的 E03、E04、E06 各有一次整轮失败）。没有越界或日期不是用户给的时为 null。
 */
export function withoutNightsOutside(draft: RequirementsDraft, patch: DraftPatch): { readonly patch: DraftPatch; readonly refused: string } | null {
  if (draft.mode !== "outing" || !draft.saidDates?.to || !patch.setLodging?.length) return null;
  const found = nightsOutside(draft, patch, patch.setLodging.flatMap((item) => item.nights));
  if (!found) return null;
  const setLodging = patch.setLodging
    .map((item) => ({ ...item, nights: item.nights.filter((night) => night <= found.nights) }))
    .filter((item) => item.nights.length);
  const kept: DraftPatch = { ...patch, setLodging };
  if (!setLodging.length) delete kept.setLodging;
  return {
    patch: kept,
    refused: `night_outside_dates: ${found.trip} (the user's dates); lodging for ${nightList(found.outside)} was not saved; ` +
      `in the reply ask the user whether to extend the trip to ${found.extend} or stay fewer nights`,
  };
}

const COUNT_WORD = ["零", "一", "两", "三", "四", "五", "六", "七"];
const countWord = (count: number) => COUNT_WORD[count] ?? String(count);

/**
 * §3.2：用户给了起止日期，说的住几晚加起来又超过这趟的晚数：问一句（代码写好的固定句式，带具体数字），不替用户决定。
 * 对得上、或日期不全是用户给的时为 null。
 */
export function nightsQuestion(draft: RequirementsDraft, phrases: readonly { readonly name: string; readonly count: number }[]): string | null {
  const card = cardDates(draft);
  if (draft.mode !== "outing" || !draft.outing || !card || !draft.saidDates?.from || !draft.saidDates.to) return null;
  const nights = Math.max(0, outingDays(draft.outing) - 1);
  const total = phrases.reduce((sum, item) => sum + item.count, 0);
  if (total <= nights) return null;
  const parts = phrases.map((item) => `${item.name}${countWord(item.count)}晚`).join("加");
  return `你说 ${datesText(card)}，可${parts}一共${countWord(total)}晚，这趟只有${countWord(nights)}晚，` +
    `是延长到 ${dayText(addDays(card.from, total))}，还是少住${countWord(total - nights)}晚？`;
}
