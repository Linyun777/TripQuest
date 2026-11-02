import { describe, expect, it } from "vitest";
import type { PlanningPlace } from "../planning-requirements";
import type { DayDraft } from "../day-planning";
import { checkTransferDay, idleNotes, splitDay, timeTransfer, timeTransfers, type DayTransfer, type TransferDayPart } from "../transfer-day";

// 虚构地点：杭州一侧 longitude 120.1，云岭一侧 longitude 125（相距约 480 公里）。
const at = (id: string, city: string, longitude: number, categoryCode?: string): PlanningPlace => ({
  place: {
    ref: { provider: "synthetic", externalId: id }, name: id, cityAdcode: city,
    location: { longitude, latitude: 30.2, coordinateSystem: "gcj02" }, ...(categoryCode ? { categoryCode } : {}),
  },
  evidence: { provider: "synthetic", sourceKind: "fixture", retrievedAt: "2026-10-15T00:00:00.000Z", attribution: "手写虚构" },
});
const HZ = "330100";
const YL = "990100";
const square = at("广场", HZ, 120.1);
const museum = at("博物馆", HZ, 120.11);
const east = at("东站", HZ, 120.12, "150200");
const south = at("南站", YL, 125, "150200");
const town = at("古镇", YL, 125.02);
const train = (extra: Partial<DayTransfer> = {}): DayTransfer => ({
  mode: "train", from: east, to: south, departAt: "12:00", arriveAt: "14:30", arriveDay: "same", ...extra,
});

describe("V2.11 a day with fixed transport", () => {
  it("times a ride the user gave, and estimates one they did not by distance (noon arrival; overnight 21:00 → 07:00)", () => {
    expect(timeTransfer(train())).toMatchObject({ departAt: 720, arriveAt: 870, estimated: false, bufferMinutes: 30 });
    // V3.3：约 470 公里 × 1.3 ÷ 200 公里/时 + 20 分钟 ≈ 3 小时 30 分，12 点到、8:30 出发（以前一律按 2 小时）。
    expect(timeTransfer(train({ departAt: null, arriveAt: null }))).toMatchObject({ departAt: 510, arriveAt: 720, estimated: true, estimate: "distance" });
    expect(timeTransfer(train({ arriveAt: null }))).toMatchObject({ departAt: 720, arriveAt: 930 });
    expect(timeTransfer(train({ departAt: null }))).toMatchObject({ departAt: 660, arriveAt: 870 });
    // 飞机按 700 公里/时再加 60 分钟；其他方式估计不了，还按 2 小时。
    expect(timeTransfer({ ...train({ departAt: null, arriveAt: null }), mode: "flight" })).toMatchObject({ arriveAt: 720, departAt: 720 - 140 });
    expect(timeTransfer({ ...train({ departAt: "08:00", arriveAt: null }), mode: "other" })).toMatchObject({ arriveAt: 600, estimate: "fixed" });
    expect(timeTransfer(train({ departAt: null, arriveAt: null, arriveDay: "next" }))).toMatchObject({ departAt: 1260, arriveAt: 420, nextDay: true });
    expect(timeTransfer({ ...train(), mode: "flight" }).bufferMinutes).toBe(90);
    // 这一天 9 点才开始：从车站出发最早 9:30（进站缓冲），不在车站另留 1 小时去车站。
    expect(timeTransfers([train({ departAt: null, arriveAt: null })], east, 540)[0]).toMatchObject({ departAt: 570, arriveAt: 780 });
    expect(timeTransfers([train({ departAt: null, arriveAt: null })], square, 540)[0]).toMatchObject({ departAt: 630 });
  });

  it("splits around the ride, places each stop in its city's part, and keeps a short part empty", () => {
    const split = splitDay({
      date: "2026-10-17", window: { startsAt: "09:00", endsAt: "19:00" }, start: square, end: town,
      transfers: [train()],
      visits: [{ place: town, role: "required", stayMinutes: 120 }, { place: museum, role: "required", stayMinutes: 90 }],
      interests: [{ id: "i1", text: "吃海鲜", city: YL }],
    });
    // 09:00 → 11:30（12:00 发车前 30 分钟进站）；14:30 到站 → 19:00。
    expect(split.segments.map((segment) => [segment.startsAt, segment.endsAt])).toEqual([[540, 690], [870, 1140]]);
    expect(split.segments.map((segment) => segment.visits.map((visit) => visit.place.place.name))).toEqual([["博物馆"], ["古镇"]]);
    expect(split.segments[1].interests.map((item) => item.id)).toEqual(["i1"]);
    // 8 点的早班：前一段只有半小时，不放地点；必去的放不进就列出来。
    const early = splitDay({
      date: "2026-10-17", window: { startsAt: "07:00", endsAt: "19:00" }, start: square, end: town,
      transfers: [train({ departAt: "08:00", arriveAt: "10:30" })],
      visits: [{ place: museum, role: "required", stayMinutes: 60 }], interests: [],
    });
    expect(early.segments[0].visits).toEqual([]);
    expect(early.unplaced.visits.map((visit) => visit.place.place.name)).toEqual(["博物馆"]);
  });

  it("starts an early arrival at 08:00 with a note, and ends an overnight day at the station", () => {
    const morning = splitDay({
      date: "2026-10-18", window: { startsAt: "06:10", endsAt: "20:00" }, start: south, end: town, transfers: [], visits: [], interests: [],
    });
    expect(morning.segments[0].startsAt).toBe(480);
    expect(morning.notes).toEqual(["到得早，可以先找地方休息或吃早饭。"]);
    const night = splitDay({
      date: "2026-10-17", window: { startsAt: "09:00", endsAt: "23:00" }, start: square, end: east,
      transfers: [train({ departAt: "21:30", arriveAt: "06:10", arriveDay: "next" })], visits: [], interests: [],
    });
    expect(night.segments.map((segment) => [segment.end.place.name, segment.endsAt])).toEqual([["东站", 1260]]);
  });

  it("checks the stitched day: arriving after the boarding time or a moved ride is a problem", () => {
    const split = splitDay({ date: "2026-10-17", window: { startsAt: "09:00", endsAt: "19:00" }, start: square, end: town, transfers: [train()], visits: [], interests: [] });
    const ride: TransferDayPart = { kind: "transfer", mode: "train", from: "东站", to: "南站", departAt: 720, arriveAt: 870, nextDay: false, estimated: false, bufferMinutes: 30 };
    const go = (arrivesAt: number): TransferDayPart => ({ kind: "connect", segment: 0, from: "广场", to: "东站", departsAt: 540, arrivesAt, mode: "taxi" });
    const after: TransferDayPart = { kind: "connect", segment: 1, from: "南站", to: "古镇", departsAt: 870, arrivesAt: 900, mode: "taxi" };
    expect(checkTransferDay([go(600), ride, after], split)).toEqual([]);
    expect(checkTransferDay([go(700), ride, after], split)).toEqual(["late_for_transfer_1"]);
    expect(checkTransferDay([go(600), { ...ride, departAt: 750 }, after], split)).toEqual(["transfer_1_moved"]);
  });

  it("notes 4 hours or more with nothing to do: between two stops, and after the last one (acceptance retest)", () => {
    const split = splitDay({ date: "2026-10-17", window: { startsAt: "09:00", endsAt: "20:00" }, start: square, end: town, transfers: [], visits: [], interests: [] });
    // 9:45–11:45 逛完一处，17:50 出发、18:00 吃饭，19:40 回到住处：中间空着约 6 小时，晚上不到 4 小时不提示。
    const draft = {
      places: [{ placeId: "p1", name: "宽窄巷子" }, { placeId: "p2", name: "火锅店" }],
      activities: [{ placeId: "p1", startsAt: 585, endsAt: 705 }, { placeId: "p2", startsAt: 1080, endsAt: 1170 }],
      legs: [{ travelMinutes: 45, bufferMinutes: 0 }, { travelMinutes: 10, bufferMinutes: 0 }, { travelMinutes: 10, bufferMinutes: 0 }],
      endArrival: 1180,
    } as unknown as DayDraft;
    expect(idleNotes([{ kind: "plan", segment: 0, draft }], split)).toEqual(["11:45 离开宽窄巷子，之后到 17:50 都空着（约 6 小时），可以在对话里加个想去的地方或兴趣。"]);
    // 只是去车站：9:30 到站，等到 17:30。
    const station = splitDay({ date: "2026-10-17", window: { startsAt: "09:00", endsAt: "18:00" }, start: town, end: south, transfers: [], visits: [], interests: [] });
    expect(idleNotes([{ kind: "connect", segment: 0, from: "古镇", to: "南站", departsAt: 540, arrivesAt: 570, mode: "taxi" }], station))
      .toEqual(["09:30 到南站，之后到 18:00 都空着（约 9 小时），可以在对话里加个想去的地方或兴趣。"]);
  });
});
