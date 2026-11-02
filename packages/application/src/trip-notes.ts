/**
 * V2.7.2 "出发须知": which stops are worth looking up, what is searched, and whether a source
 * says the place is closed on the plan's weekday. Pure, so the rules are code, not prompt.
 */

/** Scenic spots (11), museums and culture (14), theatres (0806): rules and closing days matter. */
export const NOTE_CATEGORIES = /^(11|14|0806)/;
export const NOTE_MAX_STOPS = 5;
/** A source older than this may be outdated. */
export const NOTE_STALE_DAYS = 365;

export function noteEligible(categoryCode: string | undefined): boolean {
  return !!categoryCode && NOTE_CATEGORIES.test(categoryCode);
}

/** The search for one stop: its name and what we ask, never where the user is. */
export function noteQuery(name: string): string {
  return `${name.slice(0, 40)} 预约 门票 开放时间`;
}

const DAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as const;
const NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * Weekdays a text says the place is closed: "每周二闭馆", "周一、周二闭馆", "逢周一闭馆（节假日除外）",
 * "星期一休馆", "每周二为闭馆日". "不闭馆" and "照常开放" say nothing.
 */
export function closedWeekdays(raw: string): number[] {
  // Some pages (tw.trip.com) are in traditional characters: "每週一固定閉館".
  const text = raw.replace(/週/g, "周").replace(/閉/g, "闭").replace(/館/g, "馆").replace(/開/g, "开").replace(/園/g, "园");
  const days = new Set<number>();
  const pattern = /(?:每|逢)?(?:周|星期)([一二三四五六日天])((?:[、和及至]?(?:周|星期)?[一二三四五六日天])*)\s*(?:为|是|固定|例行)?(?:全天)?(?:闭馆|休馆|闭园|不开放|停止开放)/g;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 2), match.index);
    if (/不|非/.test(before)) continue;
    for (const char of (match[1] + match[2]).replace(/周|星期|[、和及至]/g, "")) days.add(DAY[char as keyof typeof DAY]);
  }
  return [...days].sort();
}

/**
 * "你排的 10 月 20 日是周二，这里周二闭馆" when any of the stop's sources says the plan's day is a
 * closing day; "有来源说……，说法不一" when other sources name another day. Missing a closure
 * costs a wasted trip, a needless check costs a minute, so one source is enough (V2.7.2: the
 * page saying 周二 had a lower authority than the pages saying 周一).
 */
export function closedThatDay(date: string, texts: readonly string[]): string | null {
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const said = texts.map(closedWeekdays).filter((days) => days.length);
  if (!said.some((days) => days.includes(weekday))) return null;
  const [, month, day] = date.split("-").map(Number);
  const head = `你排的 ${month} 月 ${day} 日是${NAMES[weekday]}`;
  return said.every((days) => days.includes(weekday))
    ? `${head}，这里${NAMES[weekday]}闭馆`
    : `${head}，有来源说这里${NAMES[weekday]}闭馆，说法不一，出发前确认`;
}

/** A source dated more than a year before today. */
export function isStale(sourceDate: string | null, today: string): boolean {
  if (!sourceDate) return false;
  return (Date.parse(today) - Date.parse(sourceDate)) / 86_400_000 > NOTE_STALE_DAYS;
}
