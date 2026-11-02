import { describe, expect, it } from "vitest";
import { DashScopeEmbeddingProvider, DashScopeRerankProvider } from "../server/dashscope";

// V2.8: shapes follow the live responses seen on 2026-10-19 (`index`, not `text_index`).
function fetchOf(responses: (() => Response)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return responses[calls.length - 1]();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const common = { key: "test-key", now: () => "2026-10-19T00:00:00Z", retryGapMs: 0 };
const vector = (value: number) => [value, 0, 0];

describe("DashScope embedding provider", () => {
  it("embeds queries with text_type and the instruction, documents without it, in input order", async () => {
    const { fetch, calls } = fetchOf([
      json({ output: { embeddings: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] }, usage: { total_tokens: 9 } }),
      json({ output: { embeddings: [{ text_index: 0, embedding: vector(3) }] }, usage: { total_tokens: 4 } }),
    ]);
    const embedder = new DashScopeEmbeddingProvider({ ...common, fetch, model: "m", dimensions: 3, instruct: "Retrieve passages" });
    const query = await embedder.embed({ texts: ["苏堤是谁修的", "越剧"], kind: "query" });
    expect(query.status === "ok" && query.data).toEqual({ vectors: [vector(1), vector(2)], tokens: 9 });
    expect(calls[0].body).toEqual({
      model: "m",
      input: { texts: ["苏堤是谁修的", "越剧"] },
      parameters: { dimension: 3, text_type: "query", instruct: "Retrieve passages" },
    });
    await embedder.embed({ texts: ["段落"], kind: "document" });
    expect(calls[1].body.parameters).toEqual({ dimension: 3, text_type: "document" });
  });

  it("refuses a missing or wrong-sized vector, and retries a rate limit once but not arrears", async () => {
    const short = fetchOf([json({ output: { embeddings: [{ index: 0, embedding: [1, 0] }] } })]);
    const shortResult = await new DashScopeEmbeddingProvider({ ...common, fetch: short.fetch, model: "m", dimensions: 3 })
      .embed({ texts: ["a"], kind: "document" });
    expect(shortResult.status === "failure" && shortResult.failure.code).toBe("malformed_response");

    const limited = fetchOf([json({ code: "Throttling" }, 429), json({ output: { embeddings: [{ index: 0, embedding: vector(1) }] } })]);
    const ok = await new DashScopeEmbeddingProvider({ ...common, fetch: limited.fetch, model: "m", dimensions: 3 })
      .embed({ texts: ["a"], kind: "query" });
    expect(ok.status).toBe("ok");
    expect(limited.calls).toHaveLength(2);

    const owed = fetchOf([json({ code: "Arrearage", message: "Access denied" }, 400)]);
    const owedResult = await new DashScopeEmbeddingProvider({ ...common, fetch: owed.fetch, model: "m", dimensions: 3 })
      .embed({ texts: ["a"], kind: "query" });
    expect(owedResult.status === "failure" && owedResult.failure.code).toBe("quota_exceeded");
    expect(owed.calls).toHaveLength(1);
  });
});

describe("DashScope rerank provider", () => {
  it("returns every document's score best first and rejects duplicates", async () => {
    const { fetch, calls } = fetchOf([
      json({ output: { results: [{ index: 2, relevance_score: 0.2 }, { index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.5 }] }, usage: { total_tokens: 30 } }),
      json({ output: { results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }] } }),
    ]);
    const reranker = new DashScopeRerankProvider({ ...common, fetch, model: "r" });
    const ranked = await reranker.rerank({ query: "苏堤", documents: ["a", "b", "c"] });
    expect(ranked.status === "ok" && ranked.data.ranking.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(calls[0].body).toEqual({ model: "r", input: { query: "苏堤", documents: ["a", "b", "c"] }, parameters: { top_n: 3, return_documents: false } });
    const broken = await reranker.rerank({ query: "苏堤", documents: ["a", "b"] });
    expect(broken.status === "failure" && broken.failure.code).toBe("malformed_response");
  });
});
