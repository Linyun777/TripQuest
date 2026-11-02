import { rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { EmbeddingProvider } from "@tripquest/providers";
import { knowledgeBase, type KnowledgeStore } from "@tripquest/rag";
import { readKnowledgePassage } from "../knowledge-service";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("V2.8 knowledge base in the web app", () => {
  it("opens a cited passage with its article's sources, and refuses a malformed id without a query", async () => {
    const passage = vi.fn(async (id: string) => (id === "causeway:1"
      ? { id, documentId: "causeway", seq: 1, title: "合成湖的长堤", headingPath: "合成湖的长堤 > 北堤", body: "北堤由合成知府主持修筑。", sources: [{ url: "https://example.invalid/a", accessed: "2026-10-19", note: "合成志" }] }
      : null));
    const store = () => ({ passage });
    expect(await readKnowledgePassage("causeway:1", store)).toEqual({
      status: "ok",
      passage: { chunkId: "causeway:1", title: "合成湖的长堤", headingPath: "合成湖的长堤 > 北堤", text: "北堤由合成知府主持修筑。", sources: [{ url: "https://example.invalid/a", note: "合成志", accessed: "2026-10-19" }] },
    });
    expect(await readKnowledgePassage("causeway:9", store)).toEqual({ status: "not_found" });
    expect(await readKnowledgePassage("../etc", store)).toEqual({ status: "not_found" });
    expect(passage).toHaveBeenCalledTimes(2);
  });

  // V2.12：资料库的每日上限由数据库账本管（packages/db 的用量测试）；这里只看被拒时不发请求。
  it("a refused embedding sends nothing", async () => {
    const embed = vi.fn();
    const base = knowledgeBase({
      store: {} as KnowledgeStore,
      embedder: { model: "m", dimensions: 3, embed } as unknown as EmbeddingProvider,
      reranker: null,
      reserve: async () => false,
    });
    expect(await base.ask("苏堤是谁修的", { signal: new AbortController().signal })).toEqual({ status: "failed", code: "daily_limit" });
    expect(embed).not.toHaveBeenCalled();
  });
});
