import { describe, expect, it } from "vitest";
import { decide, regexIntent, regexRouter, type IntentFlag } from "../intent";
import { deepSeekIntentRouter } from "../intent-live";
import { createEmbeddingIntentRouter, voteNeighbours } from "../intent-embedding";

const on = (text: string, extra: { hasTrip?: boolean; previous?: string } = {}) => {
  const flags = regexIntent({ text, hasTrip: extra.hasTrip ?? false, cardEmpty: true, ...(extra.previous ? { previous: extra.previous } : {}) });
  return (Object.keys(flags) as IntentFlag[]).filter((flag) => flags[flag]);
};
const signal = new AbortController().signal;
const scores = (high: readonly IntentFlag[], middle: readonly IntentFlag[] = []) => ({
  planning: 0, adjust: 0, ask_timely: 0, ask_knowledge: 0, advice: 0, chitchat: 0, preference: 0,
  ...Object.fromEntries(high.map((flag) => [flag, 0.9])),
  ...Object.fromEntries(middle.map((flag) => [flag, 0.5])),
});

describe("V2.9 intent routing", () => {
  it("regex: plans by default, tells questions, advice, small talk and preferences apart", () => {
    expect(on("明天白天逛逛湖滨，晚上找个地方喝一杯")).toEqual(["planning"]);
    expect(on("不是要去，就问问灵隐寺要不要预约")).toEqual(["ask_timely"]);
    expect(on("苏堤是谁修的")).toEqual(["ask_knowledge"]);
    expect(on("推荐个安静点的咖啡馆")).toEqual(["advice"]);
    expect(on("今天好累啊")).toEqual(["chitchat"]);
    expect(on("我从来不吃辣")).toEqual(["preference"]);
    expect(on("博物馆逛完了", { hasTrip: true })).toEqual(["adjust"]);
    // Another day is a plan, not an adjustment, even with a saved trip.
    expect(on("后天去湖滨逛逛", { hasTrip: true })).toEqual(["planning"]);
  });

  it("decide: sure scores win, the uncertain band takes the regex answer, and no trip means no adjust", () => {
    const input = { text: "今天好累啊", hasTrip: false, cardEmpty: true };
    const result = decide(scores(["adjust"], ["chitchat"]), input, { low: 0.35, high: 0.65 });
    expect(result.flags.chitchat).toBe(true);
    expect(result.flags.adjust).toBe(false);
    expect(result.fallback).toEqual(["chitchat"]);
  });

  it("deepseek: reads the scores, and falls back to regex on a bad reply or a failure", async () => {
    const ok = deepSeekIntentRouter(async () => ({ decision: scores(["planning", "ask_timely"]), usage: null }));
    const route = await ok.route({ text: "明天去灵隐寺，要预约吗", hasTrip: false, cardEmpty: true }, { signal });
    expect(route).toMatchObject({ router: "deepseek", fallback: [], flags: { planning: true, ask_timely: true, advice: false } });

    const odd = deepSeekIntentRouter(async () => ({ decision: { planning: "yes" }, usage: null }));
    expect((await odd.route({ text: "今天好累啊", hasTrip: false, cardEmpty: true }, { signal })).router).toBe("deepseek->regex");
    const down = deepSeekIntentRouter(async () => { throw new Error("timeout"); });
    const fallen = await down.route({ text: "今天好累啊", hasTrip: false, cardEmpty: true }, { signal });
    expect(fallen).toMatchObject({ router: "deepseek->regex", flags: { chitchat: true } });
    expect((await regexRouter.route({ text: "你好", hasTrip: false, cardEmpty: true }, { signal })).confidence.chitchat).toBe(1);
  });
});

describe("V2.9 vector routing and the cascade", () => {
  const exemplars = [
    { text: "今天好累啊", flags: ["chitchat"] as const },
    { text: "谢谢你", flags: ["chitchat"] as const },
    { text: "苏堤是谁修的", flags: ["ask_knowledge"] as const },
  ];
  // Fake embeddings: the first character picks an axis, so equal first characters are close.
  const embedder = () => {
    const sent: string[] = [];
    const vector = (text: string) => { const v = [0, 0, 0]; v[text.startsWith("苏") ? 2 : text.startsWith("谢") ? 1 : 0] = 1; return v; };
    return {
      sent,
      provider: {
        model: "fake", dimensions: 3,
        async embed(request: { texts: readonly string[] }) {
          sent.push(...request.texts);
          return { status: "ok" as const, data: { vectors: request.texts.map(vector), tokens: 1 }, evidence: { provider: "fake", sourceKind: "fixture" as const, retrievedAt: "2026-10-21T00:00:00Z", attribution: "test" } };
        },
      },
    };
  };

  it("votes by similarity among the nearest k", () => {
    const vote = voteNeighbours([
      { similarity: 0.9, flags: ["chitchat"] },
      { similarity: 0.3, flags: ["planning"] },
      { similarity: 0.1, flags: ["advice"] },
    ], 2);
    expect(vote.best).toBe(0.9);
    expect(vote.scores.chitchat).toBeCloseTo(0.75);
    expect(vote.scores.advice).toBe(0);
  });

  it("asks DeepSeek only when unsure, and never embeds a message with where the user lives", async () => {
    const { provider, sent } = embedder();
    let asked = 0;
    const deepseek = { name: "deepseek", async route() { asked += 1; return regexRouter.route({ text: "x", hasTrip: false, cardEmpty: true }, { signal }); } };
    const cascade = createEmbeddingIntentRouter({ embedder: provider, exemplars, escalate: deepseek, settings: { k: 1, minSimilarity: 0.5, band: { low: 0.25, high: 0.75 } } });
    const sure = await cascade.route({ text: "今天真冷", hasTrip: false, cardEmpty: true }, { signal });
    expect(sure).toMatchObject({ router: "cascade", flags: { chitchat: true } });
    expect(asked).toBe(0);
    await cascade.route({ text: "我住在东门小区3幢", hasTrip: false, cardEmpty: true }, { signal });
    expect(asked).toBe(1);
    expect(sent.some((text) => text.includes("小区"))).toBe(false);
  });
});
