import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkArticle } from "../chunk";
import { loadCorpus } from "../corpus";
import { RECALL_CASES } from "../recall-dataset";
import { answers, chooseThreshold, scoreRows } from "../recall-eval";

describe("V2.8 recall eval", () => {
  it("every marked passage exists in its article and survives both chunkings whole", async () => {
    const articles = await loadCorpus(fileURLToPath(new URL("../../corpus", import.meta.url)));
    for (const item of RECALL_CASES) {
      if (!item.expect) continue;
      const article = articles.find((candidate) => candidate.id === item.expect!.document);
      expect(article, item.id).toBeDefined();
      for (const strategy of ["heading", "fixed"] as const) {
        const hit = chunkArticle(article!, strategy).some((chunk) => answers({ documentId: article!.id, body: chunk.body }, item.expect!));
        expect(hit, `${item.id} ${strategy}`).toBe(true);
      }
    }
  });

  it("picks the cut with the fewest mistakes, preferring fewer false accepts", () => {
    expect(chooseThreshold([0.9, 0.8, 0.7], [0.3, 0.4])).toEqual({ threshold: 0.55, falseRejects: 0, falseAccepts: 0 });
    // Overlap: one mistake is unavoidable; reject the answerable 0.5 rather than accept the 0.6.
    expect(chooseThreshold([0.9, 0.5], [0.6, 0.2])).toEqual({ threshold: 0.75, falseRejects: 1, falseAccepts: 0 });
  });
});

describe("V2.8 held-out recall rows", () => {
  it("scores held-out rows with the threshold picked elsewhere", () => {
    const row = (id: string, answerable: boolean, rank: number | null, best: number) => ({ id, answerable, heldOut: true, rank, best, top: [] });
    expect(scoreRows([row("R1", true, 1, 0.9), row("R2", true, 3, 0.5), row("U1", false, null, 0.7)], 0.6))
      .toEqual({ hitAt5: 2, mrr: 0.667, answerable: 2, falseRejects: 1, falseAccepts: 1 });
  });
});
