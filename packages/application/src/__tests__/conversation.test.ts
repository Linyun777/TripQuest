import { describe, expect, it } from "vitest";
import {
  applyCurrentLocation,
  applyDraftPatch,
  draftMissing,
  interestWindowConflicts,
  emptyDraft,
  emptyOutingDraft,
  messageBodySchemas,
  switchDraftMode,
  type RequirementsDraft,
} from "../conversation";

// Invented IDs and names; no provider data.
const candidates = new Map([
  ["c1", { externalId: "SYN-START", name: "合成广场" }],
  ["c2", { externalId: "SYN-MALL", name: "合成湖滨商场" }],
  ["c3", { externalId: "SYN-STREET", name: "合成湖滨步行街" }],
  ["c4", { externalId: "SYN-MUSEUM", name: "合成博物馆" }],
]);

function apply(draft: RequirementsDraft, patch: Parameters<typeof applyDraftPatch>[1]) {
  const result = applyDraftPatch(draft, patch, candidates);
  if (result.status !== "ok") throw new Error(result.code);
  return result.draft;
}

describe("V2.1 requirements draft", () => {
  it("builds a complete draft from one patch and lists nothing missing", () => {
    const draft = apply(emptyDraft(), {
      date: "2026-10-14",
      startsAt: "09:00",
      endsAt: "18:00",
      start: { candidate: "c1" },
      end: { choose: { mention: "湖滨", candidates: ["c2", "c3"] } },
      addVisits: [{ place: { candidate: "c4" }, role: "fixed", startsAt: "14:00", endsAt: "15:30" }],
      addInterests: ["越剧相关", "安静的书店"],
      pace: "relaxed",
    });
    expect(draft.start).toEqual({ status: "bound", externalId: "SYN-START", name: "合成广场" });
    expect(draft.end).toMatchObject({ status: "choose", mention: "湖滨" });
    expect(draft.interests).toEqual([{ id: "i1", text: "越剧相关" }, { id: "i2", text: "安静的书店" }]);
    expect(draftMissing(draft)).toEqual(["选择结束地点"]);

    // Picking from the offered choices settles it; a place that was not offered is refused.
    expect(applyDraftPatch(draft, { choose: [{ target: "end", externalId: "SYN-START" }] }, candidates))
      .toEqual({ status: "invalid", code: "unknown_choice" });
    const chosen = apply(draft, { choose: [{ target: "end", externalId: "SYN-MALL" }] });
    expect(chosen.end).toEqual({ status: "bound", externalId: "SYN-MALL", name: "合成湖滨商场" });
    expect(draftMissing(chosen)).toEqual([]);
    // The chat agent picks by the option number it was shown.
    expect(apply(draft, { choose: [{ target: "end", option: 2 }] }).end).toMatchObject({ name: "合成湖滨步行街" });
    expect(applyDraftPatch(draft, { choose: [{ target: "end", option: 3 }] }, candidates))
      .toEqual({ status: "invalid", code: "unknown_choice" });
  });

  it("refuses contradictions instead of storing them", () => {
    const base = apply(emptyDraft(), { startsAt: "09:00", endsAt: "18:00" });
    const refused = (patch: Parameters<typeof applyDraftPatch>[1]) => {
      const result = applyDraftPatch(base, patch, candidates);
      return result.status === "invalid" ? result.code : "accepted";
    };
    expect(refused({ endsAt: "08:00" })).toBe("window_order");
    expect(refused({ addVisits: [{ place: { candidate: "c4" }, role: "fixed", startsAt: "17:30", endsAt: "19:00" }] }))
      .toBe("fixed_outside_window");
    expect(refused({ addVisits: [{ place: { candidate: "c9" }, role: "optional" }] })).toBe("unknown_candidate");
    expect(refused({
      addVisits: [
        { place: { candidate: "c4" }, role: "optional" },
        { place: { candidate: "c4" }, role: "required" },
      ],
    })).toBe("duplicate_place");
    expect(refused({ removeVisits: ["v7"] })).toBe("unknown_visit");
  });

  it("keeps visit keys and interest ids stable across removals", () => {
    let draft = apply(emptyDraft(), {
      addVisits: [{ place: { candidate: "c2" }, role: "optional" }, { place: { candidate: "c4" }, role: "optional" }],
      addInterests: ["茶"],
    });
    draft = apply(draft, { removeVisits: ["v1"], removeInterests: ["i1"], addInterests: ["书店"] });
    draft = apply(draft, { addVisits: [{ place: { candidate: "c3" }, role: "required", stayMinutes: 60 }] });
    expect(draft.visits.map((visit) => visit.key)).toEqual(["v2", "v3"]);
    expect(draft.interests).toEqual([{ id: "i1", text: "书店" }]);
    expect(applyDraftPatch(draft, { pace: "standard" }, candidates)).toMatchObject({ status: "ok", changed: false });
  });

  it("V2.11: marks only an estimated stay; a later change without a source is what the user said", () => {
    let draft = apply(emptyDraft(), {
      addVisits: [
        { place: { candidate: "c2" }, role: "required", stayMinutes: 480, staySource: "estimate", kind: "big_scenic" },
        { place: { candidate: "c4" }, role: "optional", stayMinutes: 90, staySource: "user" },
      ],
    });
    expect(draft.visits.map((visit) => [visit.stayMinutes, visit.staySource, visit.kind])).toEqual([
      [480, "estimate", "big_scenic"], [90, undefined, undefined],
    ]);
    draft = apply(draft, { updateVisits: [{ key: "v1", stayMinutes: 300 }] });
    expect(draft.visits[0]).toMatchObject({ stayMinutes: 300 });
    expect(draft.visits[0]).not.toHaveProperty("staySource");
  });

  it("stores only IDs and names: card bodies reject coordinates or addresses", () => {
    const draft = apply(emptyDraft(), { start: { candidate: "c1" } });
    expect(messageBodySchemas.requirements_card.safeParse({ draft }).success).toBe(true);
    const leaked = { ...draft, start: { ...draft.start, location: { longitude: 120, latitude: 30 } } };
    expect(messageBodySchemas.requirements_card.safeParse({ draft: leaked }).success).toBe(false);
    const withAddress = { ...draft, start: { ...draft.start, address: "合成路 1 号" } };
    expect(messageBodySchemas.requirements_card.safeParse({ draft: withAddress }).success).toBe(false);
  });
});

describe("V2.2 current location and travel", () => {
  it("waits for the device location, then binds both ends to the nearest place", () => {
    const draft = apply(emptyDraft(), {
      date: "2026-10-16", startsAt: "09:00", endsAt: "18:00",
      start: { current: true }, end: { current: true },
      addInterests: ["看展"],
      travel: { allowed: ["walking", "transit"], prefer: "cheap" },
    });
    expect(draft.start).toEqual({ status: "current" });
    // One location request settles both ends, so it is listed once.
    expect(draftMissing(draft)).toEqual(["允许定位（或告诉我出发地点）"]);
    const located = applyCurrentLocation(draft, { externalId: "SYN-NEAR", name: "合成地铁站" });
    expect(located.start).toEqual({ status: "bound", externalId: "SYN-NEAR", name: "合成地铁站", nearby: true });
    expect(located.end).toEqual(located.start);
    expect(located.travel).toEqual({ allowed: ["walking", "transit"], prefer: "cheap" });
    expect(draftMissing(located)).toEqual([]);
    // No coordinates anywhere in what is stored.
    expect(JSON.stringify(located)).not.toMatch(/longitude|latitude|location/);
  });

  it("keeps the current location for the ends only", () => {
    expect(applyDraftPatch(emptyDraft(), { addVisits: [{ place: { current: true }, role: "optional" }] }, candidates))
      .toEqual({ status: "invalid", code: "current_only_for_ends" });
  });
});


describe("V2.3 time of day and number of stops", () => {
  const day = { date: "2026-10-16", startsAt: "09:00", endsAt: "18:00" };

  it("adds interests with a time of day and a count, and stores only what differs from the default", () => {
    const draft = apply(emptyDraft(), {
      ...day,
      endsAt: "22:00",
      addInterests: ["看展", { text: "喝点酒", when: "evening" }, { text: "逛书店", when: "any", count: 3 }],
    });
    expect(draft.interests).toEqual([
      { id: "i1", text: "看展" },
      { id: "i2", text: "喝点酒", when: "evening" },
      { id: "i3", text: "逛书店", count: 3 },
    ]);
    // A later turn or a card edit changes them; "any" and 1 go back to the defaults.
    const edited = apply(draft, { updateInterests: [{ id: "i2", when: "any" }, { id: "i3", count: 1 }, { id: "i1", when: "morning" }] });
    expect(edited.interests).toEqual([
      { id: "i1", text: "看展", when: "morning" },
      { id: "i2", text: "喝点酒" },
      { id: "i3", text: "逛书店" },
    ]);
    expect(applyDraftPatch(edited, { updateInterests: [{ id: "i9", count: 2 }] })).toEqual({ status: "invalid", code: "unknown_interest" });
  });

  it("takes the time of day from an interest's leading time word when none is given, except on a short trip (V2.10)", () => {
    const draft = apply(emptyDraft(), {
      ...day,
      endsAt: "22:00",
      addInterests: ["晚上喝一杯", "下午喝茶", "白天逛逛", { text: "晚上看夜景", when: "any" }],
    });
    expect(draft.interests).toEqual([
      { id: "i1", text: "晚上喝一杯", when: "evening" },
      { id: "i2", text: "下午喝茶", when: "afternoon" },
      { id: "i3", text: "白天逛逛" },
      // 模型明说了不限时段就照它说的。
      { id: "i4", text: "晚上看夜景" },
    ]);
    const short = apply(emptyDraft(), { mode: "short", addInterests: ["晚上喝一杯"] });
    expect(short.interests).toEqual([{ id: "i1", text: "晚上喝一杯" }]);
  });

  it("lists a time of day the window cannot hold, without refusing the edit", () => {
    const evening = apply(emptyDraft(), { ...day, addInterests: [{ text: "喝点酒", when: "evening" }] });
    expect(interestWindowConflicts(evening)).toEqual([
      { id: "i1", text: "喝点酒", when: "evening", label: "晚上", needs: { endsAt: "22:00" } },
    ]);
    expect(draftMissing(evening)).toContain("时间范围要包含晚上（“喝点酒”）");
    const morning = apply(emptyDraft(), { ...day, startsAt: "13:00", addInterests: [{ text: "爬山", when: "morning" }] });
    expect(interestWindowConflicts(morning)[0].needs).toEqual({ startsAt: "09:00" });
    // Widening the window settles it.
    expect(interestWindowConflicts(apply(evening, { endsAt: "22:00" }))).toEqual([]);
  });
});

describe("V2.4 short trips", () => {
  const now = Date.parse("2026-10-15T06:43:00Z"); // 14:43 in Hangzhou

  it("goes now: today, from the next five minutes for four hours, from here, with no way back", () => {
    const draft = applyDraftPatch(emptyDraft(), { mode: "short", addInterests: ["吃点辣的", "喝瑞幸"] }, new Map(), { nowMs: now });
    if (draft.status !== "ok") throw new Error(draft.code);
    expect(draft.draft).toMatchObject({
      mode: "short", date: "2026-10-15", startsAt: "14:45", endsAt: "18:45", start: { status: "current" }, end: null,
    });
    // Waiting only for the device location; no end place is asked for.
    expect(draftMissing(draft.draft)).toEqual(["允许定位（或告诉我出发地点）"]);
    // What the user said stays; going back to a day plan asks for an end again.
    const evening = applyDraftPatch(emptyDraft(), { mode: "short", endsAt: "20:00" }, new Map(), { nowMs: now });
    expect(evening.status === "ok" && evening.draft.endsAt).toBe("20:00");
    const day = apply(draft.draft, { mode: "day" });
    expect(day).not.toHaveProperty("mode");
    expect(draftMissing(day)).toContain("结束地点");
  });

  it("V2.5: a later start today is kept; one already past starts now", () => {
    const tonight = applyDraftPatch(emptyDraft(), { mode: "short", startsAt: "18:00" }, new Map(), { nowMs: now });
    expect(tonight.status === "ok" && tonight.draft).toMatchObject({ date: "2026-10-15", startsAt: "18:00", endsAt: "22:00" });
    const past = applyDraftPatch(emptyDraft(), { mode: "short", startsAt: "09:00", endsAt: "11:00" }, new Map(), { nowMs: now });
    expect(past.status === "ok" && past.draft).toMatchObject({ startsAt: "14:45", endsAt: "18:45" });
  });

  it("keeps named places for day plans, and stores only IDs, names and reasons for candidates", () => {
    const named = apply({ ...emptyDraft(), mode: "short" }, { addVisits: [{ place: { candidate: "c4" }, role: "optional" }] });
    expect(draftMissing(named)).toContain("短途只按想做的事挑地方，具体地点请切到一日规划");
    const choices = {
      tripId: "70000000-0000-4000-8000-000000000001", step: 1, interestId: "i1", anchor: null, round: 1, chosen: null,
      options: [{ externalId: "SYN-A", name: "合成川菜馆", reason: "偏辣，离你近", stayMinutes: 60 }],
    };
    expect(messageBodySchemas.choices.safeParse(choices).success).toBe(true);
    for (const extra of [{ distanceMeters: 650 }, { rating: 4.6 }, { costYuan: 95 }]) {
      const leaked = { ...choices, options: [{ ...choices.options[0], ...extra }] };
      expect(messageBodySchemas.choices.safeParse(leaked).success).toBe(false);
    }
  });
});

describe("V2.8 cited sources", () => {
  it("reads a V2.7 source without a kind as a web page, and keeps a knowledge passage by id only", () => {
    const old = { url: "https://example.invalid/a", title: "公告", site: "官网", date: "2026-09-01" };
    const passage = { kind: "kb", documentId: "west-lake", chunkId: "west-lake:2", title: "西湖十景", headingPath: "西湖十景 > 由来" };
    const parsed = messageBodySchemas.text.parse({ text: "答复", sources: [old, passage] });
    expect(parsed.sources).toEqual([{ kind: "web", ...old }, passage]);
    // The passage text is never stored with the message.
    expect(messageBodySchemas.text.safeParse({ text: "答复", sources: [{ ...passage, text: "段落原文" }] }).success).toBe(false);
  });
});

describe("V2.11 outing card", () => {
  const stations = new Map([
    ["c1", { externalId: "SYN-HZ", name: "合成东站", cityAdcode: "330100" }],
    ["c2", { externalId: "SYN-YL", name: "云合南站", cityAdcode: "990100" }],
    ["c3", { externalId: "SYN-HOTEL", name: "云合酒店", cityAdcode: "990100" }],
  ]);
  const patch = (draft: ReturnType<typeof emptyOutingDraft>, change: Parameters<typeof applyDraftPatch>[1]) => applyDraftPatch(draft, change, stations);
  const ok = (result: ReturnType<typeof applyDraftPatch>) => {
    if (result.status !== "ok") throw new Error(result.code);
    return result.draft;
  };

  it("keeps dates, lodging and transports; an overnight train makes that night on board and waits for the user's confirmation", () => {
    let draft = ok(patch(emptyOutingDraft(), {
      dates: { from: "2026-10-17", to: "2026-10-19" },
      start: { candidate: "c1" },
      setLodging: [{ nights: [1, 2], place: { candidate: "c3" } }],
      addInterests: [{ text: "喝一杯", when: "evening", perDay: true }],
      addTransports: [{ day: 1, mode: "train", from: { candidate: "c1" }, to: { candidate: "c2" }, departAt: "21:30", arriveAt: "06:10" }],
    }));
    expect(draft.outing!.transports[0]).toMatchObject({ id: "t1", arriveDay: "next" });
    // 那一晚在车上：住处换成“车上”，不能再填。
    expect(draft.outing!.lodging).toEqual([{ night: 1, place: null, onBoard: true }, { night: 2, place: { status: "bound", externalId: "SYN-HOTEL", name: "云合酒店", city: "990100" } }]);
    expect(patch(draft, { setLodging: [{ nights: [1], place: { candidate: "c3" } }] })).toEqual({ status: "invalid", code: "night_on_board" });
    expect(draftMissing(draft)).toEqual(["确认第 1 晚在车上过夜"]);
    draft = ok(patch(draft, { confirmOvernight: ["t1"] }));
    expect(draftMissing(draft)).toEqual([]);
    // 改了时间要重新确认。
    draft = ok(patch(draft, { updateTransports: [{ id: "t1", departAt: "22:00" }] }));
    expect(draftMissing(draft)).toEqual(["确认第 1 晚在车上过夜"]);
    // 最后一天坐夜车回去：不占行程里的哪一晚，日期改短时多出的住处一起去掉。
    const back = ok(patch(draft, { dates: { from: "2026-10-17", to: "2026-10-18" }, addTransports: [{ day: 2, mode: "train", arriveDay: "next" }] }));
    expect(back.outing!.lodging).toEqual([{ night: 1, place: null, onBoard: true }]);
    // 先记下“第 2 天坐高铁”，查到车站后又加一次：补全原来那段，不多出一段。
    const filled = ok(patch(back, { addTransports: [{ day: 2, mode: "train", from: { candidate: "c2" } }] }));
    expect(filled.outing!.transports.map((item) => [item.id, item.from?.status])).toEqual([["t1", "bound"], ["t2", "bound"]]);
  });

  it("keeps modes apart, days inside the dates, and asks how to get between cities", () => {
    const outing = ok(patch(emptyOutingDraft(), { dates: { from: "2026-10-17", to: "2026-10-18" } }));
    expect(patch(outing, { mode: "day" })).toEqual({ status: "invalid", code: "mode_is_users" });
    expect(patch(outing, { date: "2026-10-17" })).toEqual({ status: "invalid", code: "day_only" });
    expect(applyDraftPatch(emptyDraft(), { dates: { from: "2026-10-17", to: "2026-10-18" } })).toEqual({ status: "invalid", code: "outing_only" });
    expect(patch(outing, { addVisits: [{ place: { candidate: "c3" }, role: "optional", day: 3 }] })).toEqual({ status: "invalid", code: "day_outside_dates" });
    expect(patch(outing, { addVisits: [{ place: { candidate: "c3" }, role: "fixed", startsAt: "14:00", endsAt: "16:00" }] })).toEqual({ status: "invalid", code: "fixed_needs_day" });
    const apart = ok(patch(outing, { start: { candidate: "c1" }, addVisits: [{ place: { candidate: "c3" }, role: "required", day: 2 }], travel: { allowed: ["walking", "transit"], prefer: "balanced" } }));
    expect(draftMissing(apart)).toEqual(["城市之间怎么去（高铁、飞机或开车）"]);
    expect(draftMissing(ok(patch(apart, { travel: { allowed: ["walking", "driving"], prefer: "balanced" } })))).toEqual([]);
  });

  it("V3.3: a wish to stay in an area is kept as a lodging area, not an interest; a system pick goes only when where you are changes", () => {
    const draft = ok(patch(emptyOutingDraft(), {
      dates: { from: "2026-10-17", to: "2026-10-19" },
      addInterests: ["住春熙路附近", "住在乌镇", "住得舒服点", "住民宿", "吃火锅"],
    }));
    expect(draft.outing!.lodgingAreas).toEqual([{ text: "春熙路" }, { text: "乌镇" }]);
    expect(draft.interests.map((item) => item.text)).toEqual(["住得舒服点", "住民宿", "吃火锅"]);
    expect(ok(patch(draft, { removeLodgingAreas: ["乌镇"] })).outing!.lodgingAreas).toEqual([{ text: "春熙路" }]);
    // 系统暂定的住处：加地点、只改车次时间、单独改第 2 晚都留着；改日期、换交通的终点（人在哪变了）才作废；用户给的照留。
    const picked = {
      ...draft,
      outing: {
        ...draft.outing!,
        lodging: [
          { night: 1, place: { status: "bound" as const, externalId: "SYN-HOTEL", name: "云合酒店" }, source: "suggested" as const },
          { night: 2, place: { status: "bound" as const, externalId: "SYN-HOTEL", name: "云合酒店" } },
        ],
      },
    };
    const nights = (change: Parameters<typeof applyDraftPatch>[1], from = picked) => ok(patch(from, change)).outing!.lodging
      .map((item) => [item.night, item.place?.status === "bound" ? item.place.externalId : null, item.source ?? "user"]);
    expect(nights({ addVisits: [{ place: { candidate: "c3" }, role: "optional" }] })).toEqual([[1, "SYN-HOTEL", "suggested"], [2, "SYN-HOTEL", "user"]]);
    const riding = ok(patch(picked, { addTransports: [{ day: 3, mode: "train", from: { candidate: "c2" }, to: { candidate: "c1" } }] }));
    const kept = { ...riding, outing: { ...riding.outing!, lodging: picked.outing.lodging } };
    expect(nights({ updateTransports: [{ id: "t1", departAt: "16:00", arriveAt: "20:30" }] }, kept)[0]).toEqual([1, "SYN-HOTEL", "suggested"]);
    expect(nights({ updateTransports: [{ id: "t1", to: { candidate: "c3" } }] }, kept).map((item) => item[0])).toEqual([2]);
    expect(nights({ dates: { from: "2026-10-18", to: "2026-10-20" } }).map((item) => item[0])).toEqual([2]);
  });
});

describe("V2.11 switching 日常 / 出游 in a conversation", () => {
  const bound = (externalId: string, name: string, city?: string) => ({ status: "bound" as const, externalId, name, ...(city ? { city } : {}) });
  const visit = (key: string, place: ReturnType<typeof bound>, day?: number) =>
    ({ key, place, role: "required" as const, stayMinutes: 90, startsAt: null, endsAt: null, ...(day ? { day } : {}) });

  it("carries places, interests and the date to an outing, with the places elsewhere the chat came across", () => {
    const daily = {
      ...emptyDraft(),
      city: { adcode: "330100", name: "杭州市", source: "located" as const },
      date: "2026-10-17",
      startsAt: "09:00",
      visits: [visit("v1", bound("HZ-M", "博物馆", "330100"))],
      interests: [{ id: "i1", text: "喝茶" }],
    };
    const switched = switchDraftMode(daily, "outing", [{ externalId: "SH-B", name: "外滩", city: "310100" }]);
    expect(switched.draft).toMatchObject({
      mode: "outing",
      outing: { dates: { from: "2026-10-17", to: "2026-10-17" }, startAt: "09:00" },
      interests: [{ text: "喝茶" }],
    });
    expect(switched.draft.visits.map((item) => item.key)).toEqual(["v1", "v2"]);
    expect(switched.carried).toEqual(["博物馆", "外滩", "喝茶"]);
  });

  it("back to 日常 keeps only the card city's places and interests, and the first day", () => {
    const outing = {
      ...emptyOutingDraft({ adcode: "330100", name: "杭州市", source: "located" }),
      visits: [visit("v1", bound("HZ-M", "博物馆", "330100"), 1), visit("v2", bound("SH-B", "外滩", "310100"), 2)],
      interests: [{ id: "i1", text: "喝茶", perDay: true as const }, { id: "i2", text: "吃小笼", city: { adcode: "310100", name: "上海市" } }],
    };
    const dated = { ...outing, outing: { ...outing.outing!, dates: { from: "2026-10-17", to: "2026-10-18" } } };
    const switched = switchDraftMode(dated, "daily");
    expect(switched.draft.mode).toBeUndefined();
    expect(switched.draft).toMatchObject({ date: "2026-10-17", interests: [{ id: "i1", text: "喝茶" }] });
    expect(switched.draft.visits).toEqual([visit("v1", bound("HZ-M", "博物馆", "330100"))]);
    expect(switched.left).toEqual(["外滩", "吃小笼"]);
  });
});

describe("V2.11 a ride can be given by its date", () => {
  it("works out which day of the outing it is, and refuses a date outside the outing", () => {
    const outing = { ...emptyOutingDraft(), outing: { ...emptyOutingDraft().outing!, dates: { from: "2026-10-27", to: "2026-10-31" } } };
    const added = applyDraftPatch(outing, { addTransports: [{ date: "2026-10-30", mode: "train", departAt: "10:00", arriveAt: "10:30" }] });
    expect(added.status === "ok" && added.draft.outing!.transports.map((ride) => ride.day)).toEqual([4]);
    expect(applyDraftPatch(outing, { addTransports: [{ date: "2026-11-02", mode: "train" }] })).toEqual({ status: "invalid", code: "day_outside_dates" });
    expect(applyDraftPatch(outing, { addTransports: [{ mode: "train" }] })).toEqual({ status: "invalid", code: "transport_day_missing" });
  });
});
