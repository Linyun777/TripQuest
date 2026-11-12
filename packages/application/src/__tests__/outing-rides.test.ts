import { describe, expect, it } from "vitest";
import { applyDraftPatch, draftMissing, emptyOutingDraft, type DraftPlace, type OutingTransport, type RequirementsDraft } from "../conversation";
import { applyRides, pickPendingChoices, planRides, rideHints, type RideStation } from "../outing-rides";

// Invented cities, IDs and names; no provider data.
const HOME = "990001";
const SEA = "990002";
const PINE = "990003";
const at = (externalId: string, name: string, city: string): DraftPlace => ({ status: "bound", externalId, name, city });
const homeStation = at("S-HOME", "合成东站", HOME);
const seaStation: RideStation = { externalId: "S-SEA", name: "海合站", city: SEA };
const seaNorth: RideStation = { externalId: "S-SEA-N", name: "海合北站", city: SEA };

function trip(change: Partial<RequirementsDraft> = {}, transports: OutingTransport[] = [], days = 3): RequirementsDraft {
  const draft = emptyOutingDraft({ adcode: SEA, name: "海合市", source: "said" });
  return {
    ...draft,
    start: homeStation,
    end: homeStation,
    interests: [{ id: "i1", text: "看海" }],
    ...change,
    outing: { ...draft.outing!, dates: { from: "2026-10-20", to: `2026-10-${19 + days}` }, transports },
  };
}
const ride = (id: string, day: number, from: DraftPlace | null, to: DraftPlace | null, extra: Partial<OutingTransport> = {}): OutingTransport =>
  ({ id, day, mode: "train", from, to, departAt: null, arriveAt: null, arriveDay: "same", ...extra });
const found = (stations: readonly RideStation[], key = `train@${SEA}`) => new Map([[key, stations]]);
const fill = (draft: RequirementsDraft, texts: readonly string[], stations = [seaStation, seaNorth]) => {
  const plan = planRides(draft, texts);
  return plan ? applyRides(draft, plan, found(stations)) : null;
};

describe("V3.6 rides filled by code", () => {
  it("fills the empty arrival station of a round trip with the first station found, keeps the others to swap, and adds the return", () => {
    const draft = trip({}, [ride("t1", 1, homeStation, null)]);
    const filled = fill(draft, ["去海合玩三天，坐高铁"])!;
    const [out, back] = filled.draft.outing!.transports;
    expect(out).toMatchObject({ id: "t1", to: { externalId: "S-SEA" }, suggested: { to: { others: [{ name: "海合北站" }] } } });
    expect(out!.suggested?.ride).toBeUndefined();
    // 回到起点那一端直接用起点的车站，不用搜。
    expect(back).toMatchObject({ day: 3, mode: "train", from: { externalId: "S-SEA" }, to: { externalId: "S-HOME" }, suggested: { ride: true } });
    expect(draftMissing(filled.draft)).toEqual([]);
    expect(filled.note).toContain("回程按同样的方式估计");
    expect(filled.note).toContain("车站先按海合站估计");
  });

  it("adds the outbound when only the return was recorded", () => {
    const draft = trip({}, [ride("t1", 3, at("S-SEA", "海合站", SEA), homeStation, { departAt: "18:00", arriveAt: "20:00" })]);
    const filled = fill(draft, ["第三天晚上6点的高铁回去"])!;
    const [out, back] = filled.draft.outing!.transports;
    expect(out).toMatchObject({ day: 1, from: { externalId: "S-HOME" }, to: { externalId: "S-SEA" }, suggested: { ride: true } });
    expect(back).toMatchObject({ id: "t1", departAt: "18:00", arriveAt: "20:00" });
    expect(back!.suggested).toBeUndefined();
    expect(filled.note).toBe("去程按同样的方式估计（第 1 天 合成东站 → 海合站），可改。");
  });

  it("adds the outbound and return when the user said train but nothing was recorded, and not when they drive", () => {
    const filled = fill(trip(), ["下周去海合", "我们坐高铁过去"])!;
    expect(filled.draft.outing!.transports.map((item) => [item.day, item.from?.status === "bound" && item.from.name, item.to?.status === "bound" && item.to.name]))
      .toEqual([[1, "合成东站", "海合站"], [3, "海合站", "合成东站"]]);
    expect(planRides(trip(), ["坐高铁去海合，到了开车转转"])).toBeNull();
    expect(planRides(trip({ travel: { allowed: ["driving"], prefer: "balanced" } }), ["坐高铁去海合"])).toBeNull();
    expect(planRides(trip(), ["不坐高铁，想去海合"])).toBeNull();
  });

  it("never changes what the user gave: stations, times and complete rides stay as they are", () => {
    const given = [
      ride("t1", 1, homeStation, at("S-SEA-N", "海合北站", SEA), { departAt: "09:00", arriveAt: "11:00" }),
      ride("t2", 3, at("S-SEA-N", "海合北站", SEA), homeStation, { departAt: "17:00", arriveAt: "19:00" }),
    ];
    const draft = trip({}, given);
    expect(planRides(draft, ["坐高铁"])).toBeNull();
    const oneWay = trip({ end: at("S-SEA-N", "海合北站", SEA) }, [given[0]!]);
    expect(planRides(oneWay, ["坐高铁去海合，不回来了"])).toBeNull();
  });

  it("does not complete a ride whose known station does not fit its day", () => {
    // 模型把第 1 天记成“海合站 → 空”（记反了）：按城市会对上最后一段（海合 → 松合），但那是最后一天的事。
    const draft = trip({ end: at("S-PINE", "松合东站", PINE) }, [
      ride("t1", 1, at("S-SEA", "海合站", SEA), null),
      ride("t2", 3, at("S-SEA", "海合站", SEA), at("S-PINE", "松合东站", PINE)),
    ]);
    expect(planRides(draft, ["坐高铁"])).toBeNull();
    // 终点也没记（按回到出发城市算，海合 → 松合成了中间一段）：第 1 天照样对不上。
    const roundTrip = trip({}, [ride("t1", 1, at("S-SEA", "海合站", SEA), null), ride("t2", 3, null, at("S-PINE", "松合东站", PINE))]);
    expect(planRides(roundTrip, ["坐高铁"])?.needs.map((item) => item.ride)).toEqual(["t2"]);
  });

  it("follows a different end city for the last leg", () => {
    const draft = trip({ end: at("S-PINE", "松合东站", PINE) }, [ride("t1", 1, homeStation, null)]);
    const plan = planRides(draft, ["坐高铁"])!;
    expect(plan.needs.map((item) => [item.ride, item.end, item.city])).toEqual([["t1", "to", SEA], ["new0", "from", SEA], ["new0", "to", PINE]]);
    expect(plan.adds).toMatchObject([{ day: 3, from: SEA, to: PINE }]);
  });

  it("leaves the end empty when no station is found, and does nothing when the cities cannot be worked out", () => {
    const draft = trip({}, [ride("t1", 1, homeStation, null)]);
    const none = fill(draft, ["坐高铁"], [])!;
    expect(none.draft).toBe(draft);
    expect(none.note).toBeNull();
    // 不知道从哪出发（没有起点也没有定位）。
    expect(planRides(trip({ start: null, end: null }, [ride("t1", 1, null, null)]), ["坐高铁"])).toBeNull();
  });

  it("does not add rides between cities of a multi-city trip, only hints at the missing legs", () => {
    const pine = at("P-OLD", "松合老街", PINE);
    const draft = trip({
      visits: [
        { key: "v1", place: at("H-LIGHT", "海合灯塔", SEA), role: "required", stayMinutes: null, startsAt: null, endsAt: null, day: 1 },
        { key: "v2", place: pine, role: "required", stayMinutes: null, startsAt: null, endsAt: null, day: 3 },
      ],
    }, [ride("t1", 1, homeStation, at("S-SEA", "海合站", SEA))], 4);
    expect(planRides(draft, ["坐高铁"])).toBeNull();
    expect(rideHints(draft)).toEqual(["海合到松合老街怎么去？", "松合老街到合成东站怎么去？"]);
  });

  it("keeps a guessed station swappable on the card, and a station the user changes is theirs", () => {
    const filled = fill(trip({}, [ride("t1", 1, homeStation, null)]), ["坐高铁"])!;
    const swapped = applyDraftPatch(filled.draft, { choose: [{ target: "t1:to", externalId: "S-SEA-N" }] });
    expect(swapped.status).toBe("ok");
    const out = swapped.status === "ok" ? swapped.draft.outing!.transports[0]! : null;
    expect(out?.to).toMatchObject({ externalId: "S-SEA-N", name: "海合北站" });
    expect(out?.suggested).toBeUndefined();
    // 改了时间的那趟补上的回程，就是用户的了（不再写暂定）；车站没改的那端还是暂定。
    const back = filled.draft.outing!.transports[1]!;
    const timed = applyDraftPatch(filled.draft, { updateTransports: [{ id: back.id, departAt: "16:00" }] });
    const changed = timed.status === "ok" ? timed.draft.outing!.transports[1]! : null;
    expect(changed?.suggested).toEqual({ from: { others: [{ externalId: "S-SEA-N", name: "海合北站", city: SEA }] }, to: { others: [] } });
    // 只有暂定的站能换成候选，别的站不行。
    expect(applyDraftPatch(filled.draft, { choose: [{ target: "t1:from", externalId: "S-SEA-N" }] }).status).toBe("invalid");
  });

  it("replaces a guessed station when the model records the station the user named", () => {
    const filled = fill(trip({}, [ride("t1", 1, homeStation, null)]), ["坐高铁"])!;
    const result = applyDraftPatch(filled.draft, {
      addTransports: [{ day: 1, mode: "train", to: { candidate: "c1" } }],
    }, new Map([["c1", { externalId: "S-SEA-N", name: "海合北站", cityAdcode: SEA }]]));
    const rides = result.status === "ok" ? result.draft.outing!.transports : [];
    expect(rides).toHaveLength(2);
    expect(rides[0]).toMatchObject({ id: "t1", to: { externalId: "S-SEA-N" } });
    expect(rides[0]!.suggested).toBeUndefined();
  });
});

describe("V3.6 acceptance: pending choices are picked before planning", () => {
  const north = { externalId: "S-SEA-N", name: "海合北站", city: SEA };
  const south = { externalId: "S-SEA-S", name: "海合南站", city: SEA };
  const hotels = [
    { externalId: "H-1", name: "海合酒店", city: SEA },
    { externalId: "H-2", name: "海合宾馆", city: SEA },
    { externalId: "H-3", name: "海合客栈", city: SEA },
    { externalId: "H-4", name: "海合旅舍", city: SEA },
  ];
  const waiting = (mention: string, choices: typeof hotels): DraftPlace => ({ status: "choose", mention, choices: choices.slice(0, 3) });
  function pendingTrip(): RequirementsDraft {
    const draft = trip({}, [
      ride("t1", 1, homeStation, waiting("海合的站", [north, south])),
      ride("t2", 3, at("S-SEA", "海合站", SEA), homeStation),
    ]);
    return {
      ...draft,
      outing: {
        ...draft.outing!,
        lodging: [
          { night: 1, place: waiting("海合的酒店", hotels) },
          { night: 2, place: at("H-9", "用户自己订的", SEA) },
        ],
      },
    };
  }

  it("takes the first choice as a suggestion, keeps the rest to swap, and leaves what the user gave", () => {
    const before = pendingTrip();
    expect(draftMissing(before)).toEqual(["选择第 1 晚的住处", "选择第 1 天高铁的到达站"]);
    const { draft, picked } = pickPendingChoices(before);
    expect(picked).toEqual(["t1:to", "n1"]);
    const [out, back] = draft.outing!.transports;
    expect(out).toMatchObject({ to: { status: "bound", name: "海合北站" }, suggested: { to: { others: [south] } } });
    expect(back).toEqual(before.outing!.transports[1]);
    expect(draft.outing!.lodging).toEqual([
      { night: 1, place: { status: "bound", externalId: "H-1", name: "海合酒店", city: SEA }, source: "suggested", others: hotels.slice(1, 3) },
      before.outing!.lodging[1],
    ]);
    expect(draftMissing(draft)).toEqual([]);
    expect(pickPendingChoices(draft).draft).toBe(draft);
  });

  it("lets the card swap a picked hotel, which then is the user's", () => {
    const { draft } = pickPendingChoices(pendingTrip());
    const swapped = applyDraftPatch(draft, { choose: [{ target: "n1", externalId: "H-3" }] });
    expect(swapped.status === "ok" && swapped.draft.outing!.lodging[0]).toEqual({
      night: 1, place: { status: "bound", externalId: "H-3", name: "海合客栈", city: SEA },
    });
    // 用户给的那晚没有候选可换。
    expect(applyDraftPatch(draft, { choose: [{ target: "n2", externalId: "H-3" }] }).status).toBe("invalid");
  });
});
