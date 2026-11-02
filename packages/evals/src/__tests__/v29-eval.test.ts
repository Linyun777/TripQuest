import { describe, expect, it } from "vitest";
import { emptyDraft } from "@tripquest/application/conversation";
import type { ConversationOutcome } from "../v29/conversation-run";
import { ROUTE_CASES, harmfulErrors, truthFlags } from "../v29/route-dataset";
import { currentProductRouter, runRouteCase, summarizeRoute } from "../v29/route-run";
import { mentionedWorldNames, TALK_CASES } from "../v29/talk-dataset";
import { PREF_CASES } from "../v29/pref-dataset";
import { FIX_CASES } from "../v29/fix-dataset";
import { ROUTE_E2E_CASES } from "../v293/route-e2e";
import { DAILY_CITY_CASES } from "../v211/daily-city-dataset";
import { OUTING_INTAKE_CASES } from "../v211/outing-intake-dataset";
import { CITY_CASES, KB_CITY_CASES } from "../v210/city-dataset";

const route = (id: string) => ROUTE_CASES.find((item) => item.id === id)!;
const outcome = (reply: string, extra: Partial<ConversationOutcome> = {}): ConversationOutcome => ({
  replies: [reply],
  failed: false,
  draft: emptyDraft(),
  cardChanged: false,
  adjusted: false,
  searches: ["咖啡"],
  candidates: ["转角咖啡馆", "安静书房"],
  webQueries: [],
  knowledgeQuestions: [],
  sources: 0,
  places: [],
  turnPlaces: [],
  summaries: [],
  proposals: [],
  cache: { hit: 0, miss: 0 },
  failures: [],
  turnMs: [],
  routeTokens: 0,
  sourceKinds: [],
  outside: [],
  turnTokens: [],
  turnAsks: [],
  turnAgents: [],
  modelRequests: 0,
  ...extra,
});
const failed = (cases: typeof TALK_CASES, id: string, value: ConversationOutcome) =>
  cases.find((item) => item.id === id)!.checks.filter((check) => !check.test(value)).map((check) => check.name);

describe("V2.9 scorers, checked against deliberately wrong outcomes", () => {
  it("routing: counts harmful errors and scores the current product as it behaves today", async () => {
    const none = { ...truthFlags(route("T01")), planning: false };
    expect(harmfulErrors(route("T01"), none)).toEqual(["planning_missed"]);
    expect(harmfulErrors(route("T28"), { ...truthFlags(route("T28")), planning: true })).toEqual(["chitchat_as_change"]);
    expect(harmfulErrors(route("T15"), { ...truthFlags(route("T15")), ask_knowledge: false })).toEqual(["knowledge_unoffered"]);
    const rows = await Promise.all(["T15", "T24", "T28"].map((id) => runRouteCase(route(id), currentProductRouter)));
    // "苏堤是谁修的" offers both kinds of question; "推荐个安静点的咖啡馆" is not seen as advice.
    expect(rows.map((row) => row.predicted)).toEqual([
      ["planning", "ask_timely", "ask_knowledge"],
      ["planning"],
      ["planning"],
    ]);
    expect(summarizeRoute(rows).perFlag.advice).toEqual({ precision: null, recall: 0 });
  });

  it("advice: passes a recommendation of this turn's candidates, fails invented or unsearched ones", () => {
    expect(mentionedWorldNames("东门广场(地铁站)旁边就是东门广场")).toEqual(["东门广场(地铁站)", "东门广场"]);
    expect(failed(TALK_CASES, "A02", outcome("推荐去转角咖啡馆坐坐，比较安静。"))).toEqual([]);
    expect(failed(TALK_CASES, "A02", outcome("推荐星巴克，安静书房也可以，人均40元。", { searches: [], candidates: [] }))).toEqual([
      "searched_first", "places_from_candidates", "recommends_a_candidate", "no_invented_places", "hours_and_prices_sourced",
    ]);
    // Saying the hours could not be found is not stating hours.
    expect(failed(TALK_CASES, "A06", outcome("可以考虑转角咖啡馆，营业到几点我没查到可靠信息，建议出发前确认。"))).toEqual([]);
    expect(failed(TALK_CASES, "A06", outcome("可以考虑转角咖啡馆，营业到22点。"))).toEqual(["hours_and_prices_sourced"]);
    expect(failed(TALK_CASES, "C01", outcome("辛苦啦！要不要我帮你找个地方歇歇？", { searches: [], cardChanged: true }))).toEqual(["card_untouched"]);
  });

  it("preferences: wants a proposal, never one with a phone number, and no claim of a saved one", () => {
    expect(failed(PREF_CASES, "P01", outcome("好的，记下啦。"))).toEqual(["proposes_it"]);
    expect(failed(PREF_CASES, "P04", outcome("好的。", { proposals: [{ text: "电话 13800138000", category: "other" }] }))).toEqual(["does_not_propose"]);
    expect(failed(PREF_CASES, "P05", outcome("按你记住的偏好，选了不辣的。"))).toEqual(["no_saved_claim"]);
  });

  it("V2.11 daily city: guidance counts only when the outside place is listed, kept off the card and pointed to 出游", () => {
    expect(failed(DAILY_CITY_CASES, "D01", outcome("岚溪花海在岚溪市，日常只规划杭州市，去外地可以切到出游。", { outside: ["岚溪花海"] }))).toEqual([]);
    expect(failed(DAILY_CITY_CASES, "D01", outcome("好的，已经加上岚溪花海了。"))).toEqual(["guided_to_outing", "reply_points_to_outing"]);
  });

  it("V2.11 outing intake: reads the outing card's dates and lodging; a daily card fails", () => {
    const hotel = { status: "bound", externalId: "Y-HOTEL", name: "云岭山居酒店" };
    const outing = { ...emptyDraft(), mode: "outing", outing: { dates: { from: "2026-10-17", to: "2026-10-19" }, lodging: [{ night: 1, place: hotel }, { night: 2, place: hotel }] } };
    expect(failed(OUTING_INTAKE_CASES, "O02", outcome("好的。", { draft: outing as never }))).toEqual([]);
    expect(failed(OUTING_INTAKE_CASES, "O02", outcome("好的。"))).toEqual(["outing_card", "dates_10-17_10-19", "lodging"]);
  });

  it("V2.10 cities: a card without a city counts as Hangzhou; 云岭 replies must not say 杭州 or cite Hangzhou passages", () => {
    const yunling = { ...emptyDraft(), city: { adcode: "990100", name: "云岭市" } } as ReturnType<typeof emptyDraft>;
    expect(failed(CITY_CASES, "Y08", outcome("好的。", { draft: yunling }))).toEqual([]);
    expect(failed(CITY_CASES, "Y08", outcome("好的。"))).toEqual(["card_city"]);
    expect(failed(CITY_CASES, "Y01", outcome("明天在杭州吃火锅。", { draft: yunling, cardChanged: true }))).toEqual(["not_called_hangzhou"]);
    expect(failed(KB_CITY_CASES, "B01", outcome("据资料，灵隐寺始建于东晋。", { searches: [], sourceKinds: ["kb"] }))).toEqual(["no_hangzhou_passages", "web_or_says_nothing"]);
    expect(failed(KB_CITY_CASES, "B01", outcome("没查到云岭古寺的可靠资料。", { searches: [], webQueries: ["云岭古寺 来历"] }))).toEqual([]);
  });

  it("V2.9.3 end-to-end routing: a timely answer needs a web search and no unsourced hours; a preference is proposed, not claimed", () => {
    expect(failed(ROUTE_E2E_CASES, "E03", outcome("需要实名预约，提前一天。", { searches: [], webQueries: ["灵峰古寺 预约"], sources: 1 }))).toEqual([]);
    expect(failed(ROUTE_E2E_CASES, "E03", outcome("需要预约。", { searches: [] }))).toEqual(["web_answer"]);
    expect(failed(ROUTE_E2E_CASES, "E05", outcome("没查到可靠信息，大概晚上10点打烊。", { searches: [], webQueries: ["转角咖啡馆 营业"] }))).toEqual(["web_answer"]);
    expect(failed(ROUTE_E2E_CASES, "E10", outcome("好的，记住了。", { searches: [], proposals: [{ text: "不吃海鲜", category: "food" }] }))).toEqual(["no_false_memory"]);
  });

  it("V2.9.1 fixes: the picked place is the one recommended at that position; summaries keep no address or phone", () => {
    const visit = (name: string) => ({
      key: "v1",
      place: { status: "bound" as const, externalId: "x", name },
      role: "optional" as const,
      stayMinutes: null,
      startsAt: null,
      endsAt: null,
    });
    const card = (name: string) => ({ ...emptyDraft(), visits: [visit(name)] });
    const pickedSecond = { turnPlaces: [["转角咖啡馆", "安静书房"], []], draft: card("安静书房") };
    expect(failed(FIX_CASES, "F07", outcome("好的，加上了。", pickedSecond))).toEqual([]);
    expect(failed(FIX_CASES, "F07", outcome("好的，加上了。", { ...pickedSecond, draft: card("转角咖啡馆") }))).toEqual(["adds_the_picked_place"]);
    expect(failed(FIX_CASES, "F07", outcome("好的。", { turnPlaces: [["转角咖啡馆"], []] }))).toEqual(["adds_the_picked_place"]);
    expect(failed(FIX_CASES, "F11", outcome("可以去湖畔餐厅。", { summaries: ["四人同行，想看展"] }))).toEqual([]);
    expect(failed(FIX_CASES, "F11", outcome("可以去湖畔餐厅。", { summaries: ["住东门小区3栋502"] }))).toEqual(["summary_private"]);
    expect(failed(FIX_CASES, "F09", outcome("好的，今晚吃川菜。", { draft: { ...emptyDraft(), notes: "不吃辣" } }))).toEqual(["points_to_page", "follows_new_wish"]);
  });
});
