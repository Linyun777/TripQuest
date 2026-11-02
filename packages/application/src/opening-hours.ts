/**
 * V2.5: today's opening hours from Amap ("10:00-17:00", "11:00-14:00 17:00-21:00", overnight
 * "17:00-02:00") as planner windows. Only the day they were read for, only for planning in
 * this request; never stored (D-046). Anything we cannot read stays unknown.
 */

export type PlaceHours = {
  /** China (Beijing time) date the hours were read for. */
  readonly date: string;
  readonly windows: readonly { readonly startsAt: number; readonly endsAt: number }[];
};

const LAST_MINUTE = 1439;

export function parseOpenToday(text: string): PlaceHours["windows"] | null {
  const ranges = text.trim().split(/\s+/).filter(Boolean);
  if (!ranges.length || ranges.length > 6) return null;
  const windows: { startsAt: number; endsAt: number }[] = [];
  for (const range of ranges) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range);
    if (!match) return null;
    const [opensH, opensM, closesH, closesM] = match.slice(1).map(Number);
    if (opensH > 24 || closesH > 24 || opensM > 59 || closesM > 59) return null;
    const opens = Math.min(opensH * 60 + opensM, LAST_MINUTE);
    const closes = closesH * 60 + closesM;
    // "00:00-24:00" and overnight hours run to the end of today.
    const end = closes <= opens || closes > LAST_MINUTE ? LAST_MINUTE : closes;
    if (end <= opens) return null;
    windows.push({ startsAt: opens, endsAt: end });
  }
  return windows.sort((a, b) => a.startsAt - b.startsAt);
}

/** The China (Beijing time) date of a provider answer. */
export function chinaDate(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Planner opening for a place on the plan's date: known only when read for that date. */
export function openingFor(hours: PlaceHours | undefined, date: string) {
  return hours && hours.date === date
    ? { status: "known" as const, date, windows: hours.windows.map((window) => ({ ...window })) }
    : { status: "unknown" as const };
}
