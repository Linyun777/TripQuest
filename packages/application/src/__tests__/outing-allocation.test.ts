import { describe, expect, it } from "vitest";
import { applyDraftPatch, emptyOutingDraft } from "../conversation";
import { allocateByRules, checkAllocation, lodgingSegments, outingFrames, settleAllocation, visitStay, type OutingPlanInput } from "../outing-allocation";
import type { PlanningPlace } from "../planning-requirements";

// 虚构地点：杭州一侧 longitude 120.1，云岭一侧 125（相距约 480 公里）；云岭的几处彼此相距几公里。
const at = (id: string, city: string, longitude: number, latitude = 30.2): PlanningPlace => ({
  place: { ref: { provider: "synthetic", externalId: id }, name: id, cityAdcode: city, location: { longitude, latitude, coordinateSystem: "gcj02" } },
  evidence: { provider: "synthetic", sourceKind: "fixture", retrievedAt: "2026-10-15T00:00:00.000Z", attribution: "手写虚构" },
});
const HZ = "330100";
const YL = "990100";
const square = at("广场", HZ, 120.1);
const museum = at("博物馆", HZ, 120.11);
const east = at("东站", HZ, 120.12);
const south = at("南站", YL, 125);
const hotel = at("酒店", YL, 125.01);
const town = at("古镇", YL, 125.03);
const gate = at("山门", YL, 125.02, 30.22);
const base = (extra: Partial<OutingPlanInput> = {}): OutingPlanInput => ({
  dates: { from: "2026-10-17", to: "2026-10-19" },
  dailyWindow: { startsAt: "09:00", endsAt: "20:00" },
  start: { place: south, at: null },
  end: { place: south, at: "18:00" },
  lodging: [hotel, hotel],
  transports: [],
  visits: [
    { key: "v1", place: gate, role: "required", stayMinutes: 300 },
    { key: "v2", place: town, role: "required", stayMinutes: 150 },
    { key: "v3", place: museum, role: "optional", stayMinutes: 90 },
  ],
  interests: [{ id: "i1", text: "喝一杯", when: "evening", perDay: true }],
  travel: { allowed: ["walking", "taxi"], prefer: "balanced" },
  ...extra,
});

describe("V2.11 splitting an outing into days", () => {
  it("frames each day from last night's lodging to tonight's, and a ride day only counts its city's part for a place there", () => {
    const frames = outingFrames(base({
      start: { place: square, at: "09:00" },
      transports: [{ day: 1, mode: "train", from: east, to: south, departAt: "12:00", arriveAt: "14:30", arriveDay: "same" }],
    }));
    expect(frames.map((frame) => [frame.day, frame.start.place.name, frame.end.place.name])).toEqual([[1, "广场", "酒店"], [2, "酒店", "酒店"], [3, "酒店", "南站"]]);
    // 第 1 天：09:00–11:30 在杭州，14:30–20:00 在云岭；最后一天 18:00 前到南站。
    expect(frames[0].parts.map((part) => [part.city, part.minutes])).toEqual([[HZ, 150], [YL, 330]]);
    expect(frames[2].endsAt).toBe(18 * 60);
  });

  it("without lodging, each day goes on from where the traveller is, not back to where the trip started (V3.3)", () => {
    // 用户实测：杭州东站坐高铁去、住处没定、没填车次——以前每天都被拉回杭州东站，第 1 天“赶不上”。
    const roundTrip = base({
      start: { place: east, at: null },
      end: { place: east, at: null },
      lodging: [null, null],
      transports: [
        { day: 1, mode: "train", from: east, to: south, departAt: null, arriveAt: null, arriveDay: "same" },
        { day: 3, mode: "train", from: south, to: east, departAt: null, arriveAt: null, arriveDay: "same" },
      ],
    });
    const frames = outingFrames(roundTrip);
    expect(frames.map((frame) => [frame.start.place.name, frame.end.place.name])).toEqual([["东站", "南站"], ["南站", "南站"], ["南站", "东站"]]);
    expect(frames.map((frame) => frame.unsettled)).toEqual(["第 1 晚住处未定，按南站附近估计。", "第 2 晚住处未定，按南站附近估计。", undefined]);
    // 没填车次：约 3 小时 30 分，第 1 天从东站上车，8:30 出发、12 点到（这一天从 8:00 进站开始，不被 9 点卡住）。
    // 最后一天不提前：这一天 9 点从南站开始（住处没定，前一晚按南站估计），加进站缓冲 9:30 出发。
    expect(frames[0]!.transfers[0]).toMatchObject({ departAt: 510, arriveAt: 720 });
    expect(frames[0]!.startsAt).toBe(480);
    expect(frames[2]!.transfers[0]).toMatchObject({ departAt: 570, arriveAt: 780 });
    // 两城：杭州一晚、坐高铁到云岭后两晚（以前第 2、3 天回广场）。
    const twoCities = base({
      dates: { from: "2026-10-17", to: "2026-10-20" },
      start: { place: square, at: "09:00" },
      lodging: [null, null, null],
      transports: [{ day: 2, mode: "train", from: east, to: south, departAt: "12:00", arriveAt: "14:30", arriveDay: "same" }],
    });
    expect(outingFrames(twoCities).map((frame) => frame.end.place.name)).toEqual(["广场", "南站", "南站", "南站"]);
  });

  it("groups the open nights into stays: one city in a row is one stay, an overnight ride or a city change starts another (V3.3)", () => {
    const nightsOf = (input: OutingPlanInput) => lodgingSegments(input).map((segment) => [segment.nights, segment.city, segment.given?.place.name ?? null]);
    const twoCities = base({
      dates: { from: "2026-10-17", to: "2026-10-20" },
      start: { place: square, at: "09:00" },
      lodging: [null, null, null],
      transports: [{ day: 2, mode: "train", from: east, to: south, departAt: "12:00", arriveAt: "14:30", arriveDay: "same" }],
    });
    expect(nightsOf(twoCities)).toEqual([[[1], HZ, null], [[2, 3], YL, null]]);
    // 用户给了第 2 晚：同城的第 3 晚跟它同一家，不另找；杭州那晚照常找。
    expect(nightsOf({ ...twoCities, lodging: [null, hotel, null] })).toEqual([[[1], HZ, null], [[3], YL, "酒店"]]);
    // 第 1 晚在过夜车上：不算住处，第 2 晚单独一段。
    expect(nightsOf(base({
      start: { place: square, at: "09:00" },
      lodging: ["onBoard", null],
      transports: [{ day: 1, mode: "train", from: east, to: south, departAt: "21:00", arriveAt: "07:00", arriveDay: "next", overnightConfirmed: true }],
    }))).toEqual([[[2], YL, null]]);
    expect(nightsOf(base())).toEqual([]);
    // 自驾（没有固定交通）：这天分到的地点在哪个城市，那晚就在哪个城市（以前全按出发的城市算，三晚都找在杭州）。
    const driving = base({ start: { place: square, at: "09:00" }, lodging: [null, null] });
    const split = { days: [{ day: 1, visits: ["v3"], interests: [] }, { day: 2, visits: ["v2"], interests: [] }, { day: 3, visits: ["v1"], interests: [] }] };
    expect(lodgingSegments(driving, split).map((segment) => [segment.nights, segment.city])).toEqual([[[1], HZ], [[2], YL]]);
    // 对话把“住春熙路附近”记成了住处（一条街，分类不是住宿）：两晚一段、在它附近找；住宅（朋友家）照用户给的。
    const street = { ...hotel, place: { ...hotel.place, categoryCode: "061000" } };
    expect(lodgingSegments(base({ lodging: [street, null] })).map((segment) => [segment.nights, segment.area?.place.name ?? null]))
      .toEqual([[[1, 2], "酒店"]]);
    const home = { ...hotel, place: { ...hotel.place, categoryCode: "120302" } };
    expect(lodgingSegments(base({ lodging: [home, null] })).map((segment) => [segment.nights, segment.given?.place.name ?? null]))
      .toEqual([[[2], "酒店"]]);
  });

  it("puts big places first on near, roomy days, keeps an every-day interest on every day its time fits, and passes its own check", () => {
    const input = base();
    const frames = outingFrames(input);
    const allocation = allocateByRules(input, frames);
    // 博物馆在 500 公里外的杭州：想去的放不下就不放；山门和古镇各占一天。每晚喝一杯：最后一天 18:00 就到车站，不放。
    expect(allocation.days.map((entry) => entry.visits)).toEqual([["v1"], ["v2"], []]);
    expect(allocation.days.map((entry) => entry.interests)).toEqual([["i1"], ["i1"], []]);
    expect(checkAllocation(input, frames, allocation)).toEqual([]);
  });

  it("keeps a timed interest on a day whose time fits: rules, the model's split (settled by code first) and the check (acceptance retest)", () => {
    // 复测：“晚上吃火锅”只吃一次，最后一天 18:00 前回到车站。前两天各有大半天的地方，最后一天空余最多。
    const input = base({
      visits: [{ key: "v1", place: gate, role: "optional", stayMinutes: 300 }, { key: "v2", place: town, role: "optional", stayMinutes: 300 }],
      interests: [{ id: "i1", text: "晚上吃火锅", when: "evening" }],
    });
    const frames = outingFrames(input);
    const rules = allocateByRules(input, frames);
    expect(rules.days.find((entry) => entry.interests.includes("i1"))?.day).not.toBe(3);
    expect(checkAllocation(input, frames, rules)).toEqual([]);
    // 模型把它放进了每一天：代码先拿掉对不上的第 3 天，剩下两天仍要打回，说清楚哪几天对得上。
    const everyDay = { days: [1, 2, 3].map((day) => ({ day, visits: day === 3 ? [] : [`v${day}`], interests: ["i1"] })) };
    const settled = settleAllocation(input, frames, everyDay);
    expect(settled.days.map((entry) => entry.interests)).toEqual([["i1"], ["i1"], []]);
    expect(checkAllocation(input, frames, settled)).toEqual(["i1 (evening) goes on exactly one day (now on days 1,2); its time fits days 1,2"]);
    // 留空的最后一天由代码补上（不为它打回）；用户把兴趣挪到对不上的那天，卡片上说明。
    const once = settleAllocation(input, frames, { days: [{ day: 1, visits: ["v1"], interests: ["i1"] }, { day: 2, visits: ["v2"], interests: [] }, { day: 3, visits: [], interests: [] }] });
    expect(once.days.map((entry) => entry.visits)).toEqual([[], ["v2"], ["v1"]]);
    expect(checkAllocation(input, frames, once)).toEqual([]);
    expect(checkAllocation(input, frames, { days: [{ day: 1, visits: ["v1"], interests: [] }, { day: 2, visits: ["v2"], interests: [] }, { day: 3, visits: [], interests: ["i1"] }] }, "zh"))
      .toEqual(["“晚上吃火锅”的时间第 3 天排不上（09:00–18:00）"]);
  });

  it("estimates a stay by the place's kind when the card has none, and keeps the one the user gave", () => {
    expect(visitStay({ stayMinutes: null }, "110202")).toEqual({ stayMinutes: 240, floor: 180, kind: "big_scenic" });
    expect(visitStay({ stayMinutes: null }, "140100")).toEqual({ stayMinutes: 120, floor: 30, kind: "city_spot" });
    expect(visitStay({ stayMinutes: null }, "050500")).toMatchObject({ kind: "drink" });
    expect(visitStay({ stayMinutes: 90 }, "110202")).toEqual({ stayMinutes: 90 });
  });

  it("finds what the model must fix: a required place left out, a too-full day, a place far away, a pinned one moved", () => {
    const input = base({ visits: [...base().visits.slice(0, 2), { key: "v3", place: museum, role: "required", stayMinutes: 90, day: 3 }] });
    const frames = outingFrames(input);
    const problems = checkAllocation(input, frames, {
      days: [{ day: 1, visits: ["v1", "v2", "v3"], interests: ["i1"] }, { day: 2, visits: [], interests: ["i1"] }, { day: 3, visits: [], interests: ["i1"] }],
    });
    expect(problems).toEqual(expect.arrayContaining([
      "v3 must stay on day 3",
      expect.stringMatching(/^day 1 is too full/),
      expect.stringMatching(/^v3 is about \d+ minutes from where day 1/),
    ]));
    expect(checkAllocation(input, frames, { days: [{ day: 1, visits: ["v1"], interests: ["i1"] }, { day: 2, visits: [], interests: ["i1"] }, { day: 3, visits: ["v3"], interests: ["i1"] }] }, "zh"))
      .toEqual(expect.arrayContaining(["古镇没有分到哪一天"]));
  });

  it("keeps the allocation on the card when a place is moved (pinning it there), and drops it when the trip changes", () => {
    const outing = { ...emptyOutingDraft(), outing: { ...emptyOutingDraft().outing!, dates: { from: "2026-10-17", to: "2026-10-18" } } };
    const draft = { ...outing, interests: [{ id: "i1", text: "喝一杯" }] };
    const allocated = {
      ...draft,
      outing: { ...draft.outing, allocation: { days: [{ day: 1, visits: [], interests: ["i1"] }, { day: 2, visits: [], interests: [] }], source: "rules" as const, problems: [] } },
    };
    const moved = applyDraftPatch(allocated, { moveToDay: { target: "i1", day: 2 } });
    if (moved.status !== "ok") throw new Error(moved.code);
    expect(moved.draft.interests[0]).toMatchObject({ day: 2 });
    expect(moved.draft.outing!.allocation!.days.map((entry) => entry.interests)).toEqual([[], ["i1"]]);
    const changed = applyDraftPatch(moved.draft, { dates: { from: "2026-10-17", to: "2026-10-19" } });
    expect(changed.status === "ok" && changed.draft.outing!.allocation).toBeUndefined();
  });
});
