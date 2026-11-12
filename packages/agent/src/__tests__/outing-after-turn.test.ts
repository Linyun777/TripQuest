import { describe, expect, it } from "vitest";
import { emptyOutingDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import { afterOutingTurn, withAfterTurn } from "../outing-after-turn";

const evidence = { provider: "synthetic", sourceKind: "fixture" as const, retrievedAt: "2026-10-15T00:00:00.000Z", attribution: "手写虚构" };
const CITIES: Record<string, { adcode: string; name: string }> = {
  海澄: { adcode: "990300", name: "海澄市" },
  松州: { adcode: "990400", name: "松州市" },
  上海: { adcode: "310000", name: "上海市" },
  杭州: { adcode: "330100", name: "杭州市" },
};
/** 每个城市一个火车站（编号 S-城市编码）。 */
const STATIONS: Record<string, string> = { "990300": "海澄站", "990400": "松州站", "310000": "上海站", "330100": "杭州东站" };
const lookups: string[] = [];
const provider = {
  async searchPlaces(request: { scope: { kind: string; cityAdcode?: string } }) {
    const city = request.scope.cityAdcode ?? "";
    const items = STATIONS[city] ? [{
      ref: { provider: "synthetic", externalId: `S-${city}` }, name: STATIONS[city]!, cityAdcode: city, categoryCode: "150200",
      location: { longitude: 120, latitude: 30, coordinateSystem: "gcj02" as const },
    }] : [];
    return { status: "ok" as const, data: { items, truncated: false }, evidence };
  },
  async resolveCity(name: string) {
    lookups.push(name);
    const city = CITIES[name.replace(/市$/, "")];
    return city
      ? { status: "ok" as const, data: city, evidence }
      : { status: "failure" as const, failure: { code: "invalid_request" as const, retry: "never" as const, safeMessage: "不是城市" }, evidence };
  },
};
const empty = emptyOutingDraft({ adcode: "330100", name: "杭州市", source: "located" });
const dated = (draft: RequirementsDraft): RequirementsDraft => ({ ...draft, outing: { ...draft.outing!, dates: { from: "2026-10-24", to: "2026-10-27" } } });
const turn = (draft: RequirementsDraft, texts: readonly string[], previous: RequirementsDraft) =>
  afterOutingTurn(draft, texts, provider, new AbortController().signal, { changed: true, previous });

describe("V4.3 after each outing turn", () => {
  it("writes the stays on the card and says so after the reply; a town is not a city", async () => {
    lookups.length = 0;
    const said = "开车去海澄住一晚，第二天去松州住两晚，最后回杭州";
    const done = await turn(dated(empty), [said], dated(empty));
    expect(done.draft.outing!.stays).toEqual([
      { nights: [1], city: CITIES["海澄"], source: "said" },
      { nights: [2, 3], city: CITIES["松州"], source: "said" },
    ]);
    expect(done.note).toBe("住宿按第 1 晚海澄、第 2–3 晚松州记在卡片上，可改。");
    expect(lookups).toEqual(["海澄", "松州"]);
    // 同样的话再说一遍：城市名对得上的不再查，卡片不变、不再说。
    const again = await turn(done.draft, [said, said], done.draft);
    expect(again.draft).toBe(done.draft);
    expect(again.note).toBeNull();
    expect(lookups).toEqual(["海澄", "松州"]);
    const town = await turn(dated(empty), ["先去青石古镇住一晚，再去松州住两晚"], dated(empty));
    expect(town.draft.outing!.stays).toEqual([{ nights: [2, 3], city: CITIES["松州"], source: "said" }]);
  });

  it("reads the earlier sentence when the dates come later, but does not bring back stays the user removed", async () => {
    const first = "开车去海澄住一晚，再去松州住两晚";
    // 第一句没日期：不知道几晚，不认；第二句给了日期，回头认第一句。
    expect((await turn(empty, [first], empty)).draft.outing!.stays).toBeUndefined();
    const later = await turn(dated(empty), [first, "10月24日出发，27日回来"], empty);
    expect(later.draft.outing!.stays?.map((item) => item.nights)).toEqual([[1], [2, 3]]);
    // 用户在卡片上删了：之后的话没再说住哪，就不加回来。
    const removed: RequirementsDraft = { ...later.draft, outing: { ...later.draft.outing!, stays: undefined } };
    delete removed.outing!.stays;
    const next = await turn(removed, [first, "10月24日出发，27日回来", "想去海边吃海鲜"], removed);
    expect(next.draft.outing!.stays).toBeUndefined();
  });

  it("adds the leg the user named that the chat did not record, and fills a ride that has only its end", async () => {
    // O04 的样子（城市换成能查到的）：对话只记了一趟“第 4 天 → 杭州东站”，出发站空着；上海那段没记。
    const base = dated(empty);
    const draft: RequirementsDraft = {
      ...base,
      outing: { ...base.outing!, transports: [{
        id: "t1", day: 4, mode: "train", from: null, to: { status: "bound", externalId: "S-330100", name: "杭州东站", city: "330100" },
        departAt: null, arriveAt: null, arriveDay: "same",
      }] },
    };
    const done = await turn(draft, ["开车去海澄住一晚，第二天去松州住两晚，最后坐高铁去上海玩一天再坐高铁回杭州"], draft);
    const rides = done.draft.outing!.transports.map((ride) => [ride.day, ride.from?.status === "bound" ? ride.from.name : null, ride.to?.status === "bound" ? ride.to.name : null]);
    expect(rides).toEqual([[4, "上海站", "杭州东站"], [4, "松州站", "上海站"]]);
    expect(done.note).toContain("坐高铁的第 4 天 松州站 → 上海站");
  });
});


describe("V4.4 nights against the dates", () => {
  it("asks once, in a fixed sentence, when the nights are more than the user's dates, and keeps only that question in the reply", async () => {
    const given: RequirementsDraft = {
      ...empty,
      outing: { ...empty.outing!, dates: { from: "2026-10-20", to: "2026-10-22" } },
      saidDates: { from: "2026-10-20", to: "2026-10-22" },
    };
    const done = await turn(given, ["10月20日到22日，先去海澄住两晚，再去松州住两晚，开车去"], empty);
    expect(done.draft.outing!.stays).toBeUndefined();
    expect(done.ask).toBe("你说 10月20日–22日，可海澄两晚加松州两晚一共四晚，这趟只有两晚，是延长到 10月24日，还是少住两晚？");
    expect(withAfterTurn("好的，日期记上了。要把结束日改到24日吗？住宿先留空。", done))
      .toBe(`好的，日期记上了。住宿先留空。\n\n${done.ask}`);
  });

  it("dates the end by the nights when only the start was given, before reading the stays", async () => {
    const started: RequirementsDraft = {
      ...empty,
      outing: { ...empty.outing!, dates: { from: "2026-10-24", to: "2026-10-28" } },
      saidDates: { from: "2026-10-24", to: null },
    };
    const done = await turn(started, ["下周六开车去海澄住一晚，第二天去松州住两晚，然后开车回杭州"], empty);
    expect(done.draft.outing!.dates).toEqual({ from: "2026-10-24", to: "2026-10-27" });
    expect(done.draft.outing!.stays?.map((item) => item.nights)).toEqual([[1], [2, 3]]);
    expect(done.note).toMatch(/^按住宿算是 4 天，到 10月27日，可改。住宿按第 1 晚海澄、第 2–3 晚松州记在卡片上/);
  });
});
