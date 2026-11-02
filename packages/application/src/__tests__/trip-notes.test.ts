import { describe, expect, it } from "vitest";
import { closedThatDay, closedWeekdays, isStale, noteEligible, noteQuery } from "../trip-notes";

describe("V2.7.2 trip notes rules", () => {
  it("looks up scenic, culture and theatre stops only, by name", () => {
    expect([noteEligible("110202"), noteEligible("140100"), noteEligible("080601"), noteEligible("050000"), noteEligible(undefined)])
      .toEqual([true, true, true, false, false]);
    expect(noteQuery("合成博物馆")).toBe("合成博物馆 预约 门票 开放时间");
  });

  it("reads closing weekdays, and nothing from 'not closed'", () => {
    expect(closedWeekdays("开放时间9:00–17:00，每周二闭馆，法定节假日除外")).toEqual([2]);
    expect(closedWeekdays("逢周一、周二闭馆")).toEqual([1, 2]);
    expect(closedWeekdays("星期一休馆维护")).toEqual([1]);
    expect(closedWeekdays("開放時間：週二至週日 9:00–16:30，每週一固定閉館")).toEqual([1]);
    expect(closedWeekdays("周一不闭馆，照常开放")).toEqual([]);
    expect(closedWeekdays("周二至周日开放")).toEqual([]);
  });

  it("warns only when the plan's weekday is a closing day; flags year-old sources", () => {
    expect(closedThatDay("2026-10-20", ["每周二闭馆"])).toBe("你排的 10 月 20 日是周二，这里周二闭馆");
    expect(closedThatDay("2026-10-21", ["每周二闭馆"])).toBeNull();
    // A source naming another day makes it a warning to check, not silence.
    expect(closedThatDay("2026-10-20", ["每周一闭馆", "每周二为闭馆日", "简介"])).toBe("你排的 10 月 20 日是周二，有来源说这里周二闭馆，说法不一，出发前确认");
    expect([isStale("2025-04-06", "2026-10-18"), isStale("2026-01-28", "2026-10-18"), isStale(null, "2026-10-18")]).toEqual([true, false, false]);
  });
});
