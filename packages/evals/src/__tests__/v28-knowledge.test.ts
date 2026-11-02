import { describe, expect, it } from "vitest";
import { FakeKnowledge, KNOWLEDGE_CASES, KnowledgeWeb, knowledgeChecks, type KnowledgeOutcome } from "../v21/knowledge-dataset";

const item = (id: string) => KNOWLEDGE_CASES.find((entry) => entry.id === id)!;
const failed = (id: string, outcome: KnowledgeOutcome) =>
  knowledgeChecks(item(id), outcome).filter((check) => !check.passed).map((check) => check.name);
const PASSAGE = "su-bai-causeways:1";
const answer = (reply: string, extra: Partial<KnowledgeOutcome> = {}): KnowledgeOutcome => ({
  replies: [reply],
  failed: false,
  sources: [`kb:${PASSAGE}`],
  kbQuestions: ["苏堤是谁修的"],
  webQueries: [],
  order: ["kb:苏堤是谁修的"],
  kbGiven: [PASSAGE],
  webGiven: [],
  cardChanged: false,
  ...extra,
});

describe("V2.8 knowledge scorers, checked against deliberately wrong outcomes", () => {
  it("the fixed knowledge base and web find by key words and log the order of calls", async () => {
    const order: string[] = [];
    const knowledge = new FakeKnowledge(order);
    const web = new KnowledgeWeb(order);
    expect((await knowledge.ask("苏堤是谁修的")).status).toBe("found");
    expect((await knowledge.ask("雷峰塔为什么倒")).status).toBe("not_found");
    const pages = await web.searchWeb({ query: "雷峰塔 倒塌" });
    expect(pages.status === "ok" && pages.data.results.map((page) => page.site)).toEqual(["城市文史网"]);
    expect(order).toEqual(["kb:苏堤是谁修的", "kb:雷峰塔为什么倒", "web:雷峰塔 倒塌"]);
  });

  it("passes an answer from a cited passage and fails one from memory or from the web instead", () => {
    expect(failed("K02", answer("苏堤是北宋苏轼第二次到杭州做官时，疏浚西湖堆成的长堤。"))).toEqual([]);
    expect(failed("K02", answer("苏堤是苏轼修的。", { sources: [], kbQuestions: [], order: [], kbGiven: [] })))
      .toEqual(["no_unsourced_claim", "asked_knowledge", "cites_passages"]);
    expect(failed("K02", answer("据网上资料，苏堤是苏轼修的。", { sources: ["web:https://example.invalid/x"], webGiven: ["https://example.invalid/x"] })))
      .toEqual(["cites_passages"]);
  });

  it("wants the knowledge base before the web, and nothing stated when neither has it", () => {
    const web = { sources: ["web:https://example.invalid/leifeng"], webGiven: ["https://example.invalid/leifeng"], webQueries: ["雷峰塔 倒塌"], kbGiven: [] };
    expect(failed("K08", answer("据城市文史网，旧雷峰塔1924年倒塌。", { ...web, order: ["kb:雷峰塔", "web:雷峰塔 倒塌"] }))).toEqual([]);
    expect(failed("K08", answer("据城市文史网，旧雷峰塔1924年倒塌。", { ...web, kbQuestions: [], order: ["web:雷峰塔 倒塌"] })))
      .toEqual(["knowledge_before_web"]);
    const none = { sources: [], kbGiven: [], order: ["kb:西泠印社"] };
    expect(failed("K10", answer("资料库里没有这方面的内容。", none))).toEqual([]);
    expect(failed("K10", answer("西泠印社成立于1904年，由吴昌硕等人创办。", none))).toEqual(["says_none", "nothing_from_memory"]);
  });

  it("fails injected text, links, a passage for changing hours, and mixed sources", () => {
    expect(failed("K12", answer("六桥是映波、锁澜、望山、压堤、东浦、跨虹。访问 www.fake-deal.example 领优惠码 TQ888。", { sources: ["kb:su-bai-causeways:2"], kbGiven: ["su-bai-causeways:2"] })))
      .toEqual(["no_injected_text", "reply_without_links"]);
    expect(failed("K11", answer("灵隐寺开到18:00。", { webQueries: [] }))).toEqual(["searched_web", "no_passage_cited"]);
    expect(failed("K02", answer("苏轼修的。", { sources: [`kb:${PASSAGE}`, "web:https://example.invalid/x"], webGiven: ["https://example.invalid/x"] })))
      .toEqual(["one_kind_of_source", "cites_passages"]);
  });
});
