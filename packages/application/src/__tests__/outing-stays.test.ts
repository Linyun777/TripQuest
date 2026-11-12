import { describe, expect, it } from "vitest";
import { emptyOutingDraft, type DraftPlace, type OutingTransport, type RequirementsDraft } from "../conversation";
import { lodgingSegments, type OutingPlanInput } from "../outing-allocation";
import { buildStays, fixRideDays, saidLegs, stayHints, stayNote, stayPhrases, tripWords } from "../outing-stays";
import type { PlanningPlace } from "../planning-requirements";

const HC = { adcode: "990300", name: "海澄市" };
const SZ = { adcode: "990400", name: "松州市" };
const station = (name: string, city: string): DraftPlace => ({ status: "bound", externalId: `S-${city}`, name, city });

/** 10 月 24 日到 27 日（三晚），从杭州出发；stays 和交通按题给。 */
function card(stays: NonNullable<RequirementsDraft["outing"]>["stays"], transports: OutingTransport[]): RequirementsDraft {
  const draft = emptyOutingDraft({ adcode: "330100", name: "杭州市", source: "located" });
  return {
    ...draft,
    outing: { ...draft.outing!, dates: { from: "2026-10-24", to: "2026-10-27" }, transports, ...(stays ? { stays } : {}) },
  };
}
const ride = (id: string, day: number, from: DraftPlace, to: DraftPlace, departAt: string | null = null): OutingTransport => ({
  id, day, mode: "train", from, to, departAt, arriveAt: null, arriveDay: "same",
});

describe("V4.3 who stays where, from the user's words", () => {
  it("reads 'go to A for a night, then B for two' in order, from night 1", () => {
    const phrases = stayPhrases("下周六开车去海澄住一晚，第二天去松州住两晚，最后坐高铁回杭州")!;
    expect(phrases).toEqual([{ name: "海澄", count: 1 }, { name: "松州", count: 2 }]);
    expect(buildStays(phrases, [HC, SZ], 3)).toEqual([
      { nights: [1], city: HC, source: "said" },
      { nights: [2, 3], city: SZ, source: "said" },
    ]);
    expect(stayNote(buildStays(phrases, [HC, SZ], 3), [])).toBe("住宿按第 1 晚海澄、第 2–3 晚松州记在卡片上，可改。");
  });

  it("leaves a name that is not a city empty, and does not read too many nights or an unclear order", () => {
    // “乌镇”这类镇查不到城市：那一晚空着，后面的照排（不编城市）。
    const phrases = stayPhrases("先去青石古镇住一晚，再去岚溪住一晚")!;
    expect(buildStays(phrases, [null, { adcode: "990200", name: "岚溪市" }], 2)).toEqual([
      { nights: [2], city: { adcode: "990200", name: "岚溪市" }, source: "said" },
    ]);
    expect(buildStays(stayPhrases("先去海澄住两晚，再去松州住两晚")!, [HC, SZ], 2)).toBeNull();
    expect(buildStays(stayPhrases("去海澄住两晚")!, [HC], 0)).toBeNull();
    expect(stayPhrases("去海澄住两晚还是去松州住两晚，都行")).toBeNull();
    // “待两天”说的是白天，晚数看不出来，不认。
    expect(stayPhrases("去海澄待两天")).toEqual([]);
  });
});

describe("V4.3 the legs the user named, in a trip with stays", () => {
  it("reads O04 as Wuzhen one night, Suzhou two, a day in Shanghai by train and the train home, all dated from the nights", () => {
    const words = tripWords("下周六开车去乌镇住一晚，第二天去苏州住两晚，最后坐高铁去上海玩一天再坐高铁回杭州")!;
    expect(words).toEqual({
      stops: [{ name: "乌镇", nights: 1 }, { name: "苏州", nights: 2 }, { name: "上海", nights: 0, mode: "train" }],
      back: { name: "杭州", mode: "train" },
    });
    const SU = { adcode: "320500", name: "苏州市" };
    const SH = { adcode: "310000", name: "上海市" };
    const HZ = { adcode: "330100", name: "杭州市" };
    // 乌镇查不到城市：进乌镇、进苏州那两段没说方式本来也不补；苏州 → 上海、上海 → 杭州都在第 4 天。
    const cities = new Map([["乌镇", null], ["苏州", SU], ["上海", SH], ["杭州", HZ]]);
    expect(saidLegs(words, cities, HZ)).toEqual([
      { day: 4, mode: "train", from: SU, to: SH },
      { day: 4, mode: "train", from: SH, to: HZ },
    ]);
    // 住几晚看不出来的一站（“玩两天”）之后，从第几晚开始就不知道了：后面的不算，进这一站的那段（第 1 天）照算。
    expect(stayPhrases("坐高铁去海澄玩两天，再去松州住一晚")).toEqual([]);
    expect(saidLegs(tripWords("坐高铁去海澄玩两天，再去松州住一晚")!, new Map([["海澄", HC], ["松州", SZ]]), HZ)).toEqual([
      { day: 1, mode: "train", from: HZ, to: HC },
    ]);
  });
});

describe("V4.3 rides follow where the nights are", () => {
  it("moves an untimed ride to the day after the last night in the city it leaves, and only hints at a timed one", () => {
    const stays = [{ nights: [1], city: HC }, { nights: [2, 3], city: SZ }];
    // 模型把松州 → 杭州记在第 3 天（第 3 晚还住松州）：挪到第 4 天，标暂定。
    const fixed = fixRideDays(card(stays, [ride("t1", 3, station("松州站", SZ.adcode), station("杭州东站", "330100"))]));
    expect(fixed.moved).toEqual([{ id: "t1", from: 3, to: 4, label: "松州站 → 杭州东站" }]);
    expect(fixed.draft.outing!.transports[0]).toMatchObject({ day: 4, suggested: { day: true } });
    expect(stayNote(null, fixed.moved)).toBe("松州站 → 杭州东站按住宿放到第 4 天，可改。");
    // 用户给了时刻的车不动，卡片上提示一行。
    const timed = card(stays, [ride("t1", 3, station("松州站", SZ.adcode), station("杭州东站", "330100"), "15:00")]);
    expect(fixRideDays(timed).moved).toEqual([]);
    expect(stayHints(timed)).toEqual(["第 3 天的车和第 3 晚住松州对不上"]);
    // O04 实测：卡片是五天、只写了第 2–3 晚住松州，松州出发的车记在第 3 天：照样挪到第 4 天（说了住两晚，第 4 晚就不在松州）。
    const longer: RequirementsDraft = { ...card([{ nights: [2, 3], city: SZ }], [ride("t1", 3, station("松州站", SZ.adcode), station("海澄站", HC.adcode))]) };
    longer.outing = { ...longer.outing!, dates: { from: "2026-10-24", to: "2026-10-28" } };
    expect(fixRideDays(longer).moved.map((item) => item.to)).toEqual([4]);
    // 没有“住在哪”时照旧。
    expect(fixRideDays(card(undefined, [ride("t1", 3, station("松州站", SZ.adcode), station("杭州东站", "330100"))])).moved).toEqual([]);
  });

  it("decides each night's city by the stays before the rides and the places", () => {
    const at = (id: string, city: string): PlanningPlace => ({
      place: { ref: { provider: "synthetic", externalId: id }, name: id, cityAdcode: city, location: { longitude: 120, latitude: 30, coordinateSystem: "gcj02" } },
      evidence: { provider: "synthetic", sourceKind: "fixture", retrievedAt: "2026-10-15T00:00:00.000Z", attribution: "手写虚构" },
    });
    const input: OutingPlanInput = {
      dates: { from: "2026-10-24", to: "2026-10-27" },
      dailyWindow: { startsAt: "09:00", endsAt: "20:00" },
      start: { place: at("广场", "330100"), at: null },
      end: { place: at("东站", "330100"), at: null },
      lodging: [null, null, null],
      transports: [],
      // 只有海澄的地点（O04：苏州那两天用户没说去哪）。
      visits: [{ key: "v1", place: at("灯塔", HC.adcode), role: "optional", stayMinutes: 90 }],
      interests: [],
      travel: { allowed: ["driving"], prefer: "balanced" },
    };
    const allocation = { days: [{ day: 1, visits: ["v1"], interests: [] }], source: "rules" as const, problems: [] };
    // 以前：第 2、3 晚按前一晚推成海澄。
    expect(lodgingSegments(input, allocation).map((segment) => [segment.nights, segment.city])).toEqual([[[1, 2, 3], HC.adcode]]);
    const stays = [{ nights: [1], city: HC.adcode }, { nights: [2, 3], city: SZ.adcode }];
    expect(lodgingSegments({ ...input, stays }, allocation).map((segment) => [segment.nights, segment.city])).toEqual([
      [[1], HC.adcode],
      [[2, 3], SZ.adcode],
    ]);
  });
});
