import { describe, expect, it } from "vitest";
import { emptyDraft } from "@tripquest/application/conversation";
import type { ConversationOutcome } from "../v29/conversation-run";
import { SPLIT_CHAT_CASES, SPLIT_OUTING_CASES } from "../v34/split-dataset";

const outcome = (replies: readonly string[], extra: Partial<ConversationOutcome> = {}): ConversationOutcome => ({
  replies, failed: false, draft: emptyDraft(), cardChanged: false, adjusted: false, searches: [], candidates: [], webQueries: [],
  knowledgeQuestions: [], sources: 0, places: [], turnPlaces: [], summaries: [], proposals: [], cache: { hit: 0, miss: 0 },
  failures: [], turnMs: [], routeTokens: 0, sourceKinds: [], outside: [], turnTokens: [], turnAsks: [], turnAgents: [], modelRequests: 0,
  ...extra,
});
const failed = (id: string, value: ConversationOutcome) =>
  SPLIT_CHAT_CASES.find((item) => item.id === id)!.checks.filter((check) => !check.test(value)).map((check) => check.name);

describe("V3.4 split dataset", () => {
  it("has 19 cases, 4 held out, and every chat case checks the reply length and one question", () => {
    expect(SPLIT_CHAT_CASES.length + SPLIT_OUTING_CASES.length).toBe(19);
    expect([...SPLIT_CHAT_CASES, ...SPLIT_OUTING_CASES].filter((item) => item.heldOut).map((item) => item.id)).toEqual(["S15", "S16", "S17", "F02"]);
    // 闲聊题：没动卡片、没调工具时只差拼接出来的两个问题和过长的回复。
    expect(failed("S11", outcome(["今天天气好，要不要出去走走？想去哪？"]))).toEqual(["one_question"]);
    expect(failed("S11", outcome(["好".repeat(241)]))).toEqual(["reply_within_240"]);
    expect(failed("S11", outcome(["是呀，天气真好，心情也跟着好起来了。"]))).toEqual([]);
  });

  it("scores a mixed turn on both halves: the card and the sourced answer", () => {
    const card = { ...emptyDraft(), visits: [{ key: "v1", role: "optional", place: { status: "bound", name: "灵峰古寺" } }] } as unknown as ConversationOutcome["draft"];
    expect(failed("S01", outcome(["好的，明天去灵峰古寺。"], { draft: card, cardChanged: true }))).toEqual(["web_answer"]);
    expect(failed("S01", outcome(["好的。据管理处公告需要实名预约。"], { draft: card, cardChanged: true, webQueries: ["灵峰古寺 预约"], sources: 1 }))).toEqual([]);
  });
});
