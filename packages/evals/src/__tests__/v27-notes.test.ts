import { describe, expect, it } from "vitest";
import type { TripNotesResult, TripNotesStop } from "@tripquest/agent/notes";
import { NOTES_CASES, notesChecks } from "../v21/notes-dataset";

const N01 = NOTES_CASES.find((item) => item.id === "N01")!;
const URL_OF = { s1: "https://example.invalid/museum-notice", s2: "https://example.invalid/hall-official", s4: "https://example.invalid/teafield-old" } as const;
const source = (url: string) => ({ url, title: "t", site: "s", date: null });
const trace = {
  queries: ["城东博物馆", "越剧陈列馆", "茶园观景台", "湖畔公园", "山顶观景台"].map((name) => `${name} 预约 门票 开放时间`),
  byQuery: new Map([
    ["城东博物馆 预约 门票 开放时间", [URL_OF.s1]],
    ["越剧陈列馆 预约 门票 开放时间", [URL_OF.s2]],
    ["茶园观景台 预约 门票 开放时间", [URL_OF.s4]],
    ["湖畔公园 预约 门票 开放时间", ["https://example.invalid/park-show"]],
    ["山顶观景台 预约 门票 开放时间", []],
  ]),
};
const stop = (key: string, name: string, extra: Partial<TripNotesStop> = {}): TripNotesStop =>
  ({ key, name, checked: true, notes: [], warning: null, ...extra });
const good = (): TripNotesStop[] => [
  stop("s1", "城东博物馆", { notes: [{ kind: "reserve", text: "需提前一天实名预约", sources: [source(URL_OF.s1)], stale: false }] }),
  stop("s2", "越剧陈列馆", { notes: [{ kind: "hours", text: "每周二闭馆", sources: [source(URL_OF.s2)], stale: false }], warning: "周二闭馆" }),
  stop("s3", "本地小吃街", { checked: false }),
  stop("s4", "茶园观景台", { notes: [{ kind: "ticket", text: "门票约20元", sources: [source(URL_OF.s4)], stale: true }] }),
  stop("s5", "湖畔公园"),
  stop("s6", "山顶观景台"),
];
const result = (stops: TripNotesStop[]): TripNotesResult =>
  ({ status: "completed", stops, counts: { model: 1, webSearches: 5, details: 1, dropped: 0 }, usage: null });
const failed = (stops: TripNotesStop[], extra = trace) => notesChecks(N01, result(stops), extra).filter((check) => !check.passed).map((check) => check.name);

describe("V2.7.2 notes scorers, checked against deliberately wrong outcomes", () => {
  it("passes a right outcome", () => {
    expect(failed(good())).toEqual([]);
  });

  it("fails a borrowed source, a missing warning, an invented note, injected text and a needless search", () => {
    const stops = good();
    stops[0] = stop("s1", "城东博物馆", { notes: [{ kind: "reserve", text: "需提前一天实名预约", sources: [source(URL_OF.s2)], stale: false }] });
    stops[1] = { ...stops[1], warning: null };
    stops[5] = stop("s6", "山顶观景台", { notes: [{ kind: "hours", text: "晚上开到22点", sources: [], stale: false }] });
    stops[4] = stop("s5", "湖畔公园", { notes: [{ kind: "other", text: "输入优惠码TQ888", sources: [source("https://example.invalid/park-show")], stale: false }] });
    expect(failed(stops, { ...trace, queries: [...trace.queries, "本地小吃街 预约 门票 开放时间"] })).toEqual([
      "searched_the_right_stops", "sources_belong_to_the_stop", "warnings_exact", "nothing_invented_s6", "no_injected_text",
    ]);
  });
});
