import { describe, expect, it } from "vitest";
import { emptyDraft, emptyOutingDraft, type DraftPlace, type RequirementsDraft } from "../conversation";
import { stayPhrases, tripNights, tripWords } from "../outing-stays";
import { dateWords, datesByNights, nightOutsideHint, nightsQuestion, nightsToFix, settleDates, withoutNightsOutside } from "../said-dates";

// 评测世界的“今天”：2026-10-15，周四。
const TODAY = "2026-10-15";
const station = (name: string, city: string): DraftPlace => ({ status: "bound", externalId: `S-${city}`, name, city });

/** 出游卡片：日期、用户给的日期按题给。 */
function outing(dates: { from: string; to: string } | null, extra: Partial<RequirementsDraft> = {}): RequirementsDraft {
  const draft = emptyOutingDraft({ adcode: "330100", name: "杭州市", source: "located" });
  return { ...draft, outing: { ...draft.outing!, dates }, ...extra };
}

describe("V4.4 dates the user gave, read from their words", () => {
  it("reads absolute and relative dates, a lone start or end, and leaves what it cannot pin down to the model", () => {
    const read = (text: string) => dateWords(text, TODAY);
    expect(read("10月20日到22日，先去海澄住两晚")).toEqual({ kind: "dates", from: "2026-10-20", to: "2026-10-22" });
    expect(read("11月30日到12月2日去松州")).toEqual({ kind: "dates", from: "2026-11-30", to: "2026-12-02" });
    expect(read("下周六到周日去海澄玩")).toEqual({ kind: "dates", from: "2026-10-24", to: "2026-10-25" });
    expect(read("这个周六坐高铁去松州玩一天")).toEqual({ kind: "dates", from: "2026-10-17", to: null });
    expect(read("明天9点从东门广场出发")).toEqual({ kind: "dates", from: "2026-10-16", to: null });
    expect(read("10月24日出发，27日回来")).toEqual({ kind: "dates", from: "2026-10-24", to: "2026-10-27" });
    expect(read("延长到24日吧")).toEqual({ kind: "dates", from: null, to: "2026-10-24" });
    // 说了天数或日子，但算不出来：这一轮由模型定。
    expect(read("再多玩一天吧")).toEqual({ kind: "loose", anchored: false });
    expect(read("10月10日去")).toEqual({ kind: "loose", anchored: true });
    // 不是日期：地铁线、楼号、钟点、晚数。
    for (const text of ["坐地铁1号线去", "住3号楼附近", "下午3点到5点", "少住一晚吧", "杭州东站出发，回杭州东站"]) {
      expect(read(text)).toEqual({ kind: "none" });
    }
  });
});

describe("V4.5 weekends and holidays", () => {
  const read = (text: string) => dateWords(text, TODAY);

  it("reads weekend words as that week's Saturday to Sunday", () => {
    for (const text of ["周末去海澄", "这个周末去海澄", "这周末去海澄", "本周末去海澄", "这周六周日去海澄", "周六周日去海澄", "周末两天去松州"]) {
      expect(read(text)).toEqual({ kind: "dates", from: "2026-10-17", to: "2026-10-18" });
    }
    for (const text of ["下周末去松州", "下个周末去松州", "下周六周日去松州"]) {
      expect(read(text)).toEqual({ kind: "dates", from: "2026-10-24", to: "2026-10-25" });
    }
    // 今天已经是周六：今天到明天；今天是周日：今天一天。
    expect(dateWords("这个周末去海澄", "2026-10-17")).toEqual({ kind: "dates", from: "2026-10-17", to: "2026-10-18" });
    expect(dateWords("这个周末去海澄", "2026-10-18")).toEqual({ kind: "dates", from: "2026-10-18", to: "2026-10-18" });
  });

  it("keeps the dates written out when the sentence also says weekend, even if they are not a weekend", () => {
    expect(read("10月24日到25日周末去海澄，高铁来回")).toEqual({ kind: "dates", from: "2026-10-24", to: "2026-10-25" });
    expect(read("周末，也就是22号到23号，去松州")).toEqual({ kind: "dates", from: "2026-10-22", to: "2026-10-23" });
  });

  it("reads only the first day of National Day, May Day and New Year, and leaves lunar holidays and vague months to the model", () => {
    expect(read("元旦去海澄玩两天")).toEqual({ kind: "dates", from: "2027-01-01", to: null });
    expect(read("国庆去北京")).toEqual({ kind: "dates", from: "2027-10-01", to: null });
    expect(read("五一去苏州")).toEqual({ kind: "dates", from: "2027-05-01", to: null });
    expect(dateWords("十一假期去成都", "2026-09-20")).toEqual({ kind: "dates", from: "2026-10-01", to: null });
    for (const text of ["春节去哈尔滨", "中秋回家", "清明去扫墓", "月底去上海", "下个月去厦门", "春节10月1日去"]) {
      expect(read(text)).toEqual({ kind: "loose", anchored: true });
    }
  });
});

describe("V4.4 the model may not quietly change the user's dates", () => {
  it("puts the user's 20–22 back after the model made it 20–24, pulling the ride home onto the last day and dropping the extra nights", () => {
    const before = outing(null);
    const after = outing({ from: "2026-10-20", to: "2026-10-24" }, {});
    after.outing!.transports = [{ id: "t1", day: 5, mode: "train", from: station("海澄站", "990300"), to: station("杭州东站", "330100"), departAt: null, arriveAt: null, arriveDay: "same" }];
    after.outing!.lodging = [{ night: 3, place: null }, { night: 4, place: null }];
    const settled = settleDates(before, after, dateWords("10月20日到22日，先去海澄住两晚，再去松州住两晚", TODAY));
    expect(settled.draft.outing!.dates).toEqual({ from: "2026-10-20", to: "2026-10-22" });
    expect(settled.draft.outing!.transports[0]!.day).toBe(3);
    expect(settled.draft.outing!.lodging).toEqual([]);
    expect(settled.draft.saidDates).toEqual({ from: "2026-10-20", to: "2026-10-22" });
    expect(settled.note).toBe("日期按你说的 10月20日–22日 没改。");
    // 下一轮用户说别的，模型又改：照样改回。
    const later = settleDates(settled.draft, { ...settled.draft, outing: { ...settled.draft.outing!, dates: { from: "2026-10-21", to: "2026-10-23" } } }, dateWords("想看灯塔", TODAY));
    expect(later.draft.outing!.dates).toEqual({ from: "2026-10-20", to: "2026-10-22" });
  });

  it("follows the user's own new dates, and a 'stay a day longer' the code cannot pin down; a question about tomorrow's weather is not a date change", () => {
    const given = outing({ from: "2026-10-24", to: "2026-10-25" }, { saidDates: { from: "2026-10-24", to: "2026-10-25" } });
    const moved = (from: string, to: string) => ({ ...given, outing: { ...given.outing!, dates: { from, to } } });
    const changed = settleDates(given, moved("2026-10-25", "2026-10-26"), dateWords("日期改成25号到26号吧", TODAY));
    expect([changed.draft.outing!.dates, changed.draft.saidDates, changed.note]).toEqual([
      { from: "2026-10-25", to: "2026-10-26" }, { from: "2026-10-25", to: "2026-10-26" }, null,
    ]);
    const longer = settleDates(given, moved("2026-10-24", "2026-10-26"), dateWords("再多玩一天吧", TODAY));
    expect([longer.draft.outing!.dates, longer.draft.saidDates]).toEqual([{ from: "2026-10-24", to: "2026-10-26" }, { from: "2026-10-24", to: "2026-10-26" }]);
    const weather = settleDates(given, given, dateWords("明天下雨吗", TODAY));
    expect([weather.draft, weather.note]).toEqual([given, null]);
    // 日常的一天同样受保护。
    const day = { ...emptyDraft(), date: "2026-10-16", saidDates: { from: "2026-10-16", to: null } };
    expect(settleDates(day, { ...day, date: "2026-10-15" }, dateWords("再加个喝茶的地方", TODAY)).draft.date).toBe("2026-10-16");
  });

  it("marks dates the user never gave as tentative and says so once", () => {
    const first = settleDates(outing(null), outing({ from: "2026-10-16", to: "2026-10-17" }), dateWords("去松州玩两天，坐高铁", TODAY));
    expect(first.draft.datesGuessed).toBe(true);
    expect(first.note).toBe("日期先按 10月16日–17日 记，可改。");
    const again = settleDates(first.draft, first.draft, dateWords("杭州东站出发，回杭州东站", TODAY));
    expect([again.draft.datesGuessed, again.note]).toEqual([true, null]);
  });
});

describe("V4.4 nights and dates", () => {
  it("asks when the nights are more than the dates the user gave, and dates the end by the nights when only the start was given", () => {
    const words = "10月20日到22日，先去海澄住两晚，再去松州住两晚";
    const given = outing({ from: "2026-10-20", to: "2026-10-22" }, { saidDates: { from: "2026-10-20", to: "2026-10-22" } });
    expect(nightsQuestion(given, stayPhrases(words)!)).toBe("你说 10月20日–22日，可海澄两晚加松州两晚一共四晚，这趟只有两晚，是延长到 10月24日，还是少住两晚？");
    // “第一晚住松州”也算一晚（D04）。
    expect(stayPhrases("第一晚住松州，然后想再去海澄住一晚")).toEqual([{ name: "松州", count: 1 }, { name: "海澄", count: 1 }]);
    // 只给了出发日（下周六）：乌镇一晚、苏州两晚、上海玩一天，一共三晚、四天。
    const o04 = tripWords("下周六开车去乌镇住一晚，第二天去苏州住两晚，最后坐高铁去上海玩一天再坐高铁回杭州")!;
    expect(tripNights(o04)).toBe(3);
    const started = outing({ from: "2026-10-24", to: "2026-10-28" }, { saidDates: { from: "2026-10-24", to: null } });
    const fixed = datesByNights(started, 3);
    expect([fixed?.draft.outing!.dates, fixed?.note]).toEqual([{ from: "2026-10-24", to: "2026-10-27" }, "按住宿算是 4 天，到 10月27日，可改。"]);
    expect(datesByNights(given, 4)).toBeNull();
  });
});

describe("V4.5 the end date by the nights, before the reply", () => {
  it("tells what the dates should be when only the start was said, and not when the user gave the end", () => {
    const said = "下周六开车去海澄住一晚，第二天去松州住两晚，最后坐高铁去云岭玩一天再坐高铁回杭州";
    const five = outing({ from: "2026-10-24", to: "2026-10-28" });
    expect(nightsToFix(outing(null), five, [said], { from: "2026-10-24", to: null })).toEqual({ from: "2026-10-24", to: "2026-10-27", days: 4 });
    expect(nightsToFix(outing(null), outing({ from: "2026-10-24", to: "2026-10-27" }), [said], { from: "2026-10-24", to: null })).toBeNull();
    // 用户给了起止日期（S06）：晚数对不上是问，不改。
    expect(nightsToFix(outing(null), five, ["10月24日到28日，先去海澄住一晚，再去松州住两晚"], { from: "2026-10-24", to: "2026-10-28" })).toBeNull();
  });
});

describe("V4.6 lodging on a night outside the trip", () => {
  it("says how many nights the trip has, which night is outside, and asks when the user gave the dates or extends when they did not", () => {
    const patch = { setLodging: [{ nights: [1], place: null }, { nights: [2], place: null }] };
    const given = outing({ from: "2026-10-24", to: "2026-10-25" }, { saidDates: { from: "2026-10-24", to: "2026-10-25" } });
    expect(nightOutsideHint(given, patch)).toBe(
      "night_outside_dates: the trip is 2026-10-24 to 2026-10-25, so it has 1 night (night 1); night 2 is outside it; " +
      "keep these dates (the user gave them): set lodging only for nights inside the trip, " +
      "and in the reply ask the user whether to extend the trip to 2026-10-26 or stay fewer nights",
    );
    const guessed = outing({ from: "2026-10-24", to: "2026-10-25" });
    expect(nightOutsideHint(guessed, patch)).toContain("either set dates.to to 2026-10-26 in the same patch");
    expect(nightOutsideHint(outing({ from: "2026-10-24", to: "2026-10-24" }), { setLodging: [{ nights: [1], place: null }] }))
      .toContain("the trip is one day, 2026-10-24, so it has no night; night 1 is outside it");
    expect(nightOutsideHint(guessed, { setLodging: [{ nights: [1], place: null }] })).toBeNull();
  });

  it("drops lodging past the user's end date and keeps the rest of the patch, but leaves guessed dates to the model", () => {
    const given = outing({ from: "2026-10-24", to: "2026-10-25" }, { saidDates: { from: "2026-10-24", to: "2026-10-25" } });
    const cut = withoutNightsOutside(given, { notes: "带老人", setLodging: [{ nights: [1, 2], place: null }] });
    expect(cut?.patch).toEqual({ notes: "带老人", setLodging: [{ nights: [1], place: null }] });
    expect(cut?.refused).toBe(
      "night_outside_dates: the trip is 2026-10-24 to 2026-10-25, so it has 1 night (night 1) (the user's dates); " +
      "lodging for night 2 was not saved; in the reply ask the user whether to extend the trip to 2026-10-26 or stay fewer nights",
    );
    expect(withoutNightsOutside(given, { setLodging: [{ nights: [2], place: null }] })?.patch).toEqual({});
    expect(withoutNightsOutside(outing({ from: "2026-10-24", to: "2026-10-25" }), { setLodging: [{ nights: [2], place: null }] })).toBeNull();
    expect(withoutNightsOutside(given, { setLodging: [{ nights: [1], place: null }] })).toBeNull();
  });
});
