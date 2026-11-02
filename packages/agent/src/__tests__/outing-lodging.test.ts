import { describe, expect, it } from "vitest";
import { emptyOutingDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import { lodgingSegments, outingFrames } from "@tripquest/application/outing-allocation";
import type { PlaceSearchRequest, PlaceSummary } from "@tripquest/providers";
import { PlanningFixtureProvider, planningFixtureEvidence, planningFixturePlaces } from "@tripquest/providers/planning-fixture";
import { createDayPlanningRunner } from "../day-graph";
import { createDayScriptedModel } from "../day-scripted";
import { resolveOutingChange } from "../outing-change";
import { generateWithState } from "../outing-graph";
import type { OutingInput } from "../outing-generate";
import { chooseLodging, isLodgingCategory, type LodgingChoice } from "../outing-lodging";

/**
 * V3.3 暂定住处（stages/V3.3.md §3.3–3.4、§6）：按中心点挑最近的住宿、只留住宿类和这个城市的、3 公里没有再找 10 公里、
 * 区域按名字绑定；总控图把定下的住处写进这次的输入（第 1 天回这家、第 2 天从这家出发），卡片上已有的不再选，找不到
 * 照实说按哪里估计。演示地点、脚本一日规划器，“酒店”搜索由下面的假搜索回答，不发真实请求。
 */
const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const places = planningFixturePlaces();
const summary = (id: string) => places.find((place) => place.ref.externalId === id)!;
const at = (id: string) => ({ place: summary(id), evidence: planningFixtureEvidence(now()) });
const fixture = new PlanningFixtureProvider(now);
const signal = () => new AbortController().signal;
/** 演示地点当成住宿（换上住宿的分类码），路线照样能查。 */
const asHotel = (id: string, code = "100100"): PlaceSummary => ({ ...summary(id), categoryCode: code });
/** 用户给的住处（真的是住宿；演示地点本来的分类是餐饮，会被当成“只是个区域”）。 */
const stay = (id: string) => ({ place: asHotel(id), evidence: planningFixtureEvidence(now()) });

/** 搜“酒店”时按给的结果回答（并记下每次的范围），其余照演示地点。 */
function searching(answer: (request: PlaceSearchRequest) => PlaceSummary[]) {
  const asked: PlaceSearchRequest[] = [];
  const provider = {
    findRoutes: fixture.findRoutes.bind(fixture),
    searchPlaces: async (request: PlaceSearchRequest) => {
      asked.push(request);
      if (request.query !== "酒店") return fixture.searchPlaces(request);
      return { status: "ok" as const, data: { items: answer(request), truncated: false }, evidence: planningFixtureEvidence(now()) };
    },
  };
  return { provider, asked };
}

const input: OutingInput = {
  dates: { from: "2026-10-15", to: "2026-10-16" },
  dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
  start: { place: at("DEMO-START"), at: null },
  end: { place: at("DEMO-START"), at: null },
  lodging: [null],
  transports: [],
  visits: [
    { key: "v1", place: at("DEMO-MUSEUM-A"), role: "required", stayMinutes: 60, day: 1 },
    { key: "v2", place: at("DEMO-PARK"), role: "required", stayMinutes: 60, day: 2 },
  ],
  interests: [],
  travel: { allowed: ["walking"], prefer: "balanced" },
  pace: "standard",
  cityAdcode: "330100",
};
const allocation = { days: [{ day: 1, visits: ["v1"], interests: [] }, { day: 2, visits: ["v2"], interests: [] }] };
const runner = () => createDayPlanningRunner({ provider: fixture, model: createDayScriptedModel(), now });
const choose = (given: OutingInput, provider: ReturnType<typeof searching>["provider"]) =>
  chooseLodging(lodgingSegments(given), given, allocation, outingFrames(given), provider, signal());

describe("V3.3 lodging", () => {
  it("knows Amap's lodging codes, including joined ones, and nothing else", () => {
    expect(["100000", "100105", "100200|100100", "060000|100000"].every(isLodgingCategory)).toBe(true);
    expect(["110100", "060000", "1001", undefined].some(isLodgingCategory)).toBe(false);
  });

  it("picks the lodging nearest the stay's places, keeps two others, and skips shops and other cities", async () => {
    const elsewhere = { ...asHotel("DEMO-GARDEN"), cityAdcode: "990100" };
    const { provider, asked } = searching(() => [asHotel("DEMO-FOOD"), summary("DEMO-WALK"), elsewhere, asHotel("DEMO-CAFE"), asHotel("DEMO-START", "100200")]);
    const [choice] = await choose(input, provider);
    // 中心点是两天的地点（博物馆、公园步行街）的平均；演示餐饮小馆离它最近。
    expect(choice).toMatchObject({ nights: [1], from: "search", center: "visits" });
    expect(choice!.place?.place.ref.externalId).toBe("DEMO-CAFE");
    expect(choice!.candidates.map((item) => item.place.ref.externalId)).toEqual(["DEMO-FOOD", "DEMO-START"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ query: "酒店", scope: { kind: "nearby", radiusMeters: 3000 } });
  });

  it("V3.4: with only interests, centres on each interest's first city-wide result, and falls back to the station without one", async () => {
    const onlyInterests: OutingInput = {
      ...input,
      visits: [],
      interests: [{ id: "i1", text: "看熊猫" }, { id: "i2", text: "每晚喝一杯", perDay: true }],
      transports: [{ day: 1, mode: "train", from: at("DEMO-START"), to: at("DEMO-MUSEUM-A"), departAt: "08:00", arriveAt: "09:00", arriveDay: "same" }],
    };
    const interestsOnly = { days: [{ day: 1, visits: [], interests: ["i1", "i2"] }, { day: 2, visits: [], interests: ["i2"] }] };
    const asked: PlaceSearchRequest[] = [];
    const provider = (found: boolean) => ({
      findRoutes: fixture.findRoutes.bind(fixture),
      searchPlaces: async (request: PlaceSearchRequest) => {
        asked.push(request);
        const items = request.query === "酒店" ? [asHotel("DEMO-FOOD")] : found && request.query === "看熊猫" ? [summary("DEMO-PARK")] : [];
        return { status: "ok" as const, data: { items, truncated: false }, evidence: planningFixtureEvidence(now()) };
      },
    });
    const pick = (found: boolean) =>
      chooseLodging(lodgingSegments(onlyInterests), onlyInterests, interestsOnly, outingFrames(onlyInterests), provider(found), signal());
    const [byInterest] = await pick(true);
    expect(byInterest).toMatchObject({ center: "interests" });
    // 每天都要的“喝一杯”不拿去定位；兴趣只按城市搜一次，住处在它的结果附近找。
    expect(asked.map((item) => [item.query, item.scope.kind])).toEqual([["看熊猫", "city"], ["酒店", "nearby"]]);
    expect(asked[1]!.scope).toMatchObject({ center: summary("DEMO-PARK").location });
    asked.length = 0;
    const [byStation] = await pick(false);
    expect(byStation).toMatchObject({ center: "station" });
    expect(asked[1]!.scope).toMatchObject({ center: summary("DEMO-MUSEUM-A").location });
  });

  it("looks 10 km out when nothing is within 3 km, binds a said area by name, and follows a night the user gave", async () => {
    const wide = searching((request) => (request.scope.kind === "nearby" && request.scope.radiusMeters === 3000 ? [] : [asHotel("DEMO-FOOD")]));
    const [far] = await choose(input, wide.provider);
    expect(far!.place?.place.ref.externalId).toBe("DEMO-FOOD");
    expect(wide.asked.map((item) => (item.scope.kind === "nearby" ? item.scope.radiusMeters : 0))).toEqual([3000, 10_000]);
    // “住演示公园附近”：绑定到名字对得上的演示公园步行街，住处在它附近找。
    const area = searching(() => [asHotel("DEMO-FOOD")]);
    const [near] = await choose({ ...input, lodgingAreas: [{ text: "演示公园" }] }, area.provider);
    expect(near).toMatchObject({ center: "area", area: "演示公园" });
    expect(area.asked[0]).toMatchObject({ query: "演示公园", scope: { kind: "city" } });
    // 用户给了第 1 晚：第 2 晚同城跟它同一家，不搜。
    const three = { ...input, dates: { from: "2026-10-15", to: "2026-10-17" }, lodging: [stay("DEMO-CAFE"), null] };
    const follow = searching(() => [asHotel("DEMO-FOOD")]);
    const [followed] = await chooseLodging(lodgingSegments(three), three, allocation, outingFrames(three), follow.provider, signal());
    expect(followed).toMatchObject({ nights: [2], from: "follow" });
    expect(followed!.place?.place.ref.externalId).toBe("DEMO-CAFE");
    expect(follow.asked).toEqual([]);
  });

  it("plans the days around the pick, does not pick again once the card has it, and says so when nothing is found", async () => {
    const { provider, asked } = searching(() => [asHotel("DEMO-FOOD")]);
    let picked: readonly LodgingChoice[] = [];
    const first = await generateWithState(input, allocation, { runner: runner(), provider, now }, {
      signal: signal(),
      onLodging: (choices) => {
        picked = choices;
      },
    });
    expect(picked.map((choice) => [choice.nights, choice.place?.place.ref.externalId])).toEqual([[[1], "DEMO-FOOD"]]);
    expect(first.generated.map((day) => [day.frame.start.place.ref.externalId, day.frame.end.place.ref.externalId]))
      .toEqual([["DEMO-START", "DEMO-FOOD"], ["DEMO-FOOD", "DEMO-START"]]);
    expect(first.generated.every((day) => day.result.status === "draft")).toBe(true);
    // 卡片上已经有了（暂定写进卡片后，重排某一天）：不再搜。
    const searches = asked.length;
    let again = false;
    await generateWithState({ ...input, lodging: [stay("DEMO-FOOD")] }, allocation, { runner: runner(), provider, now }, {
      signal: signal(),
      days: [2],
      onLodging: () => {
        again = true;
      },
    });
    expect(again).toBe(false);
    expect(asked).toHaveLength(searches);
    // 搜不到：不编，第 1 天的终点按起点估计，方案上照实说。
    const none = searching(() => []);
    const empty = await generateWithState(input, allocation, { runner: runner(), provider: none.provider, now }, { signal: signal() });
    const day = empty.generated[0]!;
    expect(day.frame.end.place.ref.externalId).toBe("DEMO-START");
    expect(day.result.status === "draft" && day.result.notes[0]).toBe("第 1 晚住处未定，按演示起点附近估计。");
  });

  it("keeps the system's picks through a change: a new train time keeps both nights, changing night 1 keeps night 2", async () => {
    const bound = (id: string) => ({ status: "bound" as const, externalId: id, name: summary(id).name, city: "330100" });
    const card: RequirementsDraft = {
      ...emptyOutingDraft({ adcode: "330100", name: "杭州市" }),
      start: bound("DEMO-START"),
      end: bound("DEMO-START"),
      outing: {
        dates: { from: "2026-10-15", to: "2026-10-17" },
        startAt: null,
        endAt: null,
        dailyWindow: { startsAt: "09:00", endsAt: "18:00" },
        lodging: [1, 2].map((night) => ({ night, place: bound("DEMO-CAFE"), source: "suggested" as const })),
        transports: [{ id: "t1", day: 3, mode: "train", from: bound("DEMO-START"), to: bound("DEMO-FOOD"), departAt: "16:00", arriveAt: "17:00", arriveDay: "same" }],
        allocation: { days: [1, 2, 3].map((day) => ({ day, visits: [], interests: [] })), source: "rules", problems: [] },
      },
    };
    const three = { ...input, dates: { from: "2026-10-15", to: "2026-10-17" }, lodging: [stay("DEMO-CAFE"), stay("DEMO-CAFE")], visits: [] };
    const toInput = async () => three;
    const lodgingOf = (resolved: Awaited<ReturnType<typeof resolveOutingChange>>) => (resolved.status === "ready"
      ? resolved.draft.outing!.lodging.map((item) => [item.night, item.place?.status === "bound" ? item.place.externalId : null, item.source ?? "user"])
      : resolved.detail);
    // 保存后只改回程车次的时间：两晚的暂定住处都还在。
    const retimed = await resolveOutingChange(card, { transport: { id: "t1", departAt: "15:00" } }, { today: 0, done: [] }, { toInput });
    expect(lodgingOf(retimed)).toEqual([[1, "DEMO-CAFE", "suggested"], [2, "DEMO-CAFE", "suggested"]]);
    // 单独改第 1 晚：第 1 晚换成用户说的那家，第 2 晚的暂定照留。
    const night1 = await resolveOutingChange(card, { lodging: { night: 1, mention: "演示餐饮终点" } }, { today: 0, done: [] }, {
      toInput,
      lodging: { externalId: "DEMO-FOOD", name: "演示餐饮终点", cityAdcode: "330100" },
    });
    expect(lodgingOf(night1)).toEqual([[1, "DEMO-FOOD", "user"], [2, "DEMO-CAFE", "suggested"]]);
  });
});
