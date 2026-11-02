import { describe, expect, it } from "vitest";
import { DeepSeekSearchProvider } from "../server/deepseek-search";

// V2.7: invented pages only; the shape follows DeepSeek's documented response (2026-10-18).
const page = {
  rerank_score: 2.3,
  title: "城东博物馆参观公告",
  url: "https://example.invalid/notice",
  snippet: "短摘要",
  summary: "常规参观需提前一天实名预约。",
  content: "",
  site_name: "城东博物馆",
  site_icon: null,
  date: "2026-09-20T00:00:00+00:00",
  authority: 3,
};

function provider(responses: (() => Response)[]) {
  const calls: { body: unknown; auth: string | null }[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
    return responses[calls.length - 1]();
  }) as typeof globalThis.fetch;
  const search = new DeepSeekSearchProvider({ key: "test-key", fetch, now: () => "2026-10-18T00:00:00Z", retryGapMs: 0 });
  return { search, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe("DeepSeek search provider", () => {
  it("sends the query and the question, never a location, and keeps what we can cite", async () => {
    const { search, calls } = provider([json({ results: [page, { ...page, url: "javascript:alert(1)" }, { ...page, date: null, authority: -1, summary: "" }] })]);
    const result = await search.searchWeb({ query: "城东博物馆 预约", question: "要预约吗" });
    expect(calls[0]).toEqual({ body: { query: "城东博物馆 预约", count: 5, ori_question: "要预约吗" }, auth: "Bearer test-key" });
    expect(result.status === "ok" && result.data.results).toEqual([
      { title: "城东博物馆参观公告", url: "https://example.invalid/notice", site: "城东博物馆", date: "2026-09-20", summary: "常规参观需提前一天实名预约。", authority: 3 },
      { title: "城东博物馆参观公告", url: "https://example.invalid/notice", site: "城东博物馆", date: null, summary: "短摘要", authority: null },
    ]);
  });

  it("retries once on a rate limit, not on a missing balance, and reports a broken body", async () => {
    const limited = provider([json({ error: {} }, 429), json({ results: [] })]);
    expect((await limited.search.searchWeb({ query: "灯光秀" })).status).toBe("ok");
    expect(limited.calls).toHaveLength(2);
    const broke = provider([json({ error: {} }, 402)]);
    const failed = await broke.search.searchWeb({ query: "灯光秀" });
    expect(failed.status === "failure" && failed.failure.code).toBe("quota_exceeded");
    expect(broke.calls).toHaveLength(1);
    const odd = provider([() => new Response("not json")]);
    const malformed = await odd.search.searchWeb({ query: "灯光秀" });
    expect(malformed.status === "failure" && malformed.failure.code).toBe("malformed_response");
  });
});
