import { describe, expect, it } from "vitest";
import { chunkByHeading, chunkFixed, packSentences } from "../chunk";
import { parseArticle } from "../corpus";
import { reciprocalRankFusion } from "../fuse";
import { bigrams, questionTerms, tsQuery } from "../keywords";

const article = parseArticle(`---
id: sample
title: 样例文章
topic: 测试
city: 330100
status: draft
sources:
  - https://example.invalid/a | 2026-10-19 | 样例来源
---

# 样例文章

开头一句。

## 第一节

第一节的正文。

## 第二节

${"长句子内容".repeat(60)}。${"另一句话".repeat(60)}。
`, "sample.md");

describe("corpus and chunking", () => {
  it("reads our front matter and refuses an article without a dated source", () => {
    expect(article).toMatchObject({ id: "sample", status: "draft", sources: [{ url: "https://example.invalid/a", accessed: "2026-10-19", note: "样例来源" }] });
    expect(() => parseArticle("---\nid: x\ntitle: t\ntopic: t\ncity: 330100\nstatus: draft\nsources:\n  - https://a.invalid | 昨天 | n\n---\n正文", "x.md")).toThrow(/YYYY-MM-DD/);
  });

  it("cuts at headings, keeps the heading path, and splits a long section with a 40-character overlap", () => {
    const chunks = chunkByHeading(article);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual(["样例文章", "样例文章 > 第一节", "样例文章 > 第二节", "样例文章 > 第二节"]);
    const [first, second] = chunks.slice(2).map((chunk) => chunk.body);
    expect([...first].length).toBeLessThanOrEqual(400);
    expect(second.startsWith([...first].slice(-40).join(""))).toBe(true);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
  });

  it("packs short text whole and cuts an over-long sentence by length", () => {
    expect(packSentences("一句。两句。")).toEqual(["一句。两句。"]);
    const pieces = packSentences("字".repeat(1000), 400, 40);
    expect(pieces.every((piece) => [...piece].length <= 400)).toBe(true);
    expect(pieces.join("").replace(/字/g, "").length).toBe(0);
  });

  it("fixed windows ignore headings but remember where each window starts", () => {
    const chunks = chunkFixed(article, 100, 20);
    expect(chunks[0].headingPath).toBe("样例文章");
    expect(chunks.at(-1)?.headingPath).toBe("样例文章 > 第二节");
    expect(chunks.every((chunk) => [...chunk.body].length <= 100)).toBe(true);
  });
});

describe("keyword terms and fusion", () => {
  it("splits Chinese into pairs, keeps numbers whole, and drops question words", () => {
    expect(bigrams("苏堤春晓，1089年")).toEqual(["苏堤", "堤春", "春晓", "1089", "年"]);
    expect(questionTerms("苏堤是谁修的？")).toEqual(["苏堤", "修"]);
    expect(tsQuery(questionTerms("越剧是哪里的剧种"))).toBe("越剧 | 剧种");
    expect(tsQuery([])).toBeNull();
  });

  it("fuses by rank only: an id high in both lists wins", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["b", "d"]]);
    expect(fused.map((item) => item.id)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
  });
});
