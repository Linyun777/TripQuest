import { describe, expect, it } from "vitest";
import type { PlaceLookupProvider, ProviderEvidence, WebSearchProvider, WebSearchResult } from "@tripquest/providers";
import { createTripNotesRunner, type NotesDecisionContext, type NotesDecisionModel } from "../notes-index";

// Invented places and pages only.
const evidence: ProviderEvidence = { provider: "fixture", sourceKind: "fixture", retrievedAt: "2026-10-18T00:00:00Z", attribution: "test" };
const place = (id: string, name: string, categoryCode: string) => ({
  ref: { provider: "amap", externalId: id }, name, cityAdcode: "330100",
  location: { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" as const }, categoryCode,
});
const places: PlaceLookupProvider = {
  async findPlacesById() {
    return { status: "ok", data: { items: [place("M", "合成博物馆", "140100"), place("F", "合成面馆", "050100"), place("P", "合成公园", "110101")], missing: [] }, evidence };
  },
};
const page = (url: string, summary: string, authority: number, date = "2026-09-01"): WebSearchResult =>
  ({ title: "页面", url, site: "合成站", date, summary, authority });
function web() {
  const queries: string[] = [];
  const provider: WebSearchProvider = {
    async searchWeb(request) {
      queries.push(request.query);
      const results = request.query.startsWith("合成博物馆")
        ? [page("https://example.invalid/m1", "需提前一天实名预约，每周二闭馆", 3), page("https://example.invalid/m2", "每周一闭馆，免预约", 1, "2024-01-01")]
        : [page("https://example.invalid/p1", "公园全天开放", 2)];
      return { status: "ok", data: { results }, evidence };
    },
  };
  return { provider, queries };
}
function scripted(decisions: unknown[]) {
  const seen: NotesDecisionContext[] = [];
  const model: NotesDecisionModel = {
    mode: "scripted", provider: "test", model: "scripted",
    async decide(context) {
      seen.push(structuredClone(context));
      return { decision: decisions.shift() ?? { stops: [] }, usage: null };
    },
  };
  return { model, seen };
}
const stops = [
  { key: "s1", externalId: "M", name: "合成博物馆" },
  { key: "s2", externalId: "F", name: "合成面馆" },
  { key: "s3", externalId: "P", name: "合成公园" },
];
const run = (model: NotesDecisionModel, search: WebSearchProvider, date = "2026-10-20") =>
  createTripNotesRunner({ model, places, web: search, searchGapMs: 0 }).run({ date, today: "2026-10-18", stops }, { signal: new AbortController().signal });

describe("V2.7.2 trip notes", () => {
  it("searches culture and scenic stops by name, asks the model once and keeps only notes citing their own stop", async () => {
    const { provider, queries } = web();
    const { model, seen } = scripted([{
      stops: [
        { key: "s1", notes: [{ kind: "reserve", text: "需提前一天实名预约", sources: ["w1"] }, { kind: "hours", text: "公园全天开放", sources: ["w3"] }] },
        { key: "s3", notes: [] },
      ],
    }]);
    const result = await run(model, provider);
    expect(queries.sort()).toEqual(["合成公园 预约 门票 开放时间", "合成博物馆 预约 门票 开放时间"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].stops.map((stop) => stop.results.map((r) => r.id))).toEqual([["w1", "w2"], ["w3"]]);
    if (result.status !== "completed") throw new Error(result.code);
    expect(result.stops.map((stop) => [stop.key, stop.checked, stop.notes.map((note) => note.text)])).toEqual([
      ["s1", true, ["需提前一天实名预约"]],
      ["s2", false, []],
      ["s3", true, []],
    ]);
    expect(result.counts.dropped).toBe(1);
  });

  it("warns of a closing day any page names, and says so when pages disagree", async () => {
    const tuesday = await run(scripted([{ stops: [] }]).model, web().provider, "2026-10-20");
    const monday = await run(scripted([{ stops: [] }]).model, web().provider, "2026-10-19");
    const wednesday = await run(scripted([{ stops: [] }]).model, web().provider, "2026-10-21");
    expect(tuesday.status === "completed" && tuesday.stops[0].warning).toMatch(/周二，有来源说这里周二闭馆，说法不一/);
    expect(monday.status === "completed" && monday.stops[0].warning).toMatch(/周一，有来源说这里周一闭馆，说法不一/);
    expect(wednesday.status === "completed" && wednesday.stops[0].warning).toBeNull();
  });

  it("asks again once on a wrong shape, then gives up honestly", async () => {
    const fixed = scripted([{ notes: "x" }, { stops: [{ key: "s1", notes: [{ kind: "reserve", text: "要预约", sources: ["w2"] }] }] }]);
    const result = await run(fixed.model, web().provider);
    expect(fixed.seen[1].feedback?.code).toMatch(/^invalid_shape/);
    expect(result.status === "completed" && result.stops[0].notes[0]).toMatchObject({ text: "要预约", stale: true });
    const broken = await run(scripted([{ x: 1 }, { y: 2 }]).model, web().provider);
    expect(broken).toMatchObject({ status: "failed", code: "invalid_output" });
  });
});
