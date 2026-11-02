import { describe, expect, it } from "vitest";
import { jevIntentRouter, JEV_INTENT_QUESTIONS } from "../intent-jev";
import { JevError, type JevAnswer, type JevClient } from "../jev";
import type { PickContext } from "../short-candidates";
import { createJevPicker, rankFromReply, templateReason } from "../short-jev";

/** 记录收到的 state，按给定的“是”的概率回答每个 noul 问题；choice 一律选 60。 */
function fakeJev(yesFor: (name: string) => number | Error): JevClient & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    model: "jev-1.14.0",
    states,
    async ask(state, questions) {
      states.push(state);
      const answers: Record<string, JevAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const value = yesFor(name);
        if (value instanceof Error) throw value;
        answers[name] = question.type === "noul"
          ? { type: "noul", noul: value }
          : { type: "choice", choice: "60", confidence: 0.6, probabilities: { "60": 0.6 } };
      }
      return { model: "jev-1.14.0", answers, inputTokens: 100 };
    },
  };
}
const route = (client: JevClient, text: string, extra: { hasTrip?: boolean; previous?: string } = {}) =>
  jevIntentRouter(client).route({
    text,
    hasTrip: extra.hasTrip ?? false,
    cardEmpty: true,
    ...(extra.previous ? { previous: extra.previous } : {}),
  }, { signal: new AbortController().signal });

describe("Jev routing", () => {
  it("decides confident flags itself, fills unsure ones from regex, and keeps the question safety net", async () => {
    // planning 0.9（有把握）、chitchat 0.55（拿不准，用正则补）、其他 0.05。
    const client = fakeJev((name) => (name === "planning" ? 0.9 : name === "chitchat" ? 0.55 : 0.05));
    const result = await route(client, "明天想去灵隐寺看看");
    expect(Object.keys(JEV_INTENT_QUESTIONS)).toHaveLength(7);
    expect(result).toMatchObject({ router: "jev", fallback: ["chitchat"], model: "jev-1.14.0", inputTokens: 100 });
    expect(result.flags).toMatchObject({ planning: true, chitchat: false, ask_timely: false });
    // 像问句但两种提问都没判出：两种都给。
    const asked = await route(fakeJev(() => 0.05), "那边要排队吗");
    expect(asked.flags).toMatchObject({ ask_timely: true, ask_knowledge: true });
  });

  it("falls back to regex as a whole on failure, and never sends where the user lives", async () => {
    const failed = await route(fakeJev(() => new JevError("rate_limited")), "明天想去灵隐寺看看");
    expect(failed).toMatchObject({ router: "jev->regex", failure: "rate_limited", flags: { planning: true } });
    const client = fakeJev(() => 0.9);
    const privately = await route(client, "我住东门小区3栋，明天从家出发");
    expect(privately).toMatchObject({ router: "jev->regex", failure: "private" });
    expect(client.states).toHaveLength(0);
    // 上一条回复转述了住处：本条照常发，但不带上一条。
    await route(client, "那就这么定", { previous: "好的，明天从东门小区3栋出发" });
    await route(client, "那就这么定", { previous: "好的，明天先去灵隐寺" });
    expect(client.states).toEqual([
      { message: "那就这么定", hasSavedTrip: false, cardEmpty: true },
      { message: "那就这么定", previousReply: "好的，明天先去灵隐寺", hasSavedTrip: false, cardEmpty: true },
    ]);
  });
});

const CONTEXT: PickContext = {
  interest: { text: "吃点辣的" },
  anchor: { name: "东门广场", isStart: true },
  found: [
    { id: "c1", name: "粤式茶餐厅", meters: 150, keytag: "粤菜" },
    { id: "c2", name: "川味小厨", meters: 240, keytag: "川菜", rating: 4.1 },
    { id: "c3", name: "麻辣小馆", meters: 240, keytag: "川菜", rating: 4.6 },
    { id: "c4", name: "江南小馆", meters: 300, keytag: "杭帮菜" },
  ],
};

describe("Jev picking", () => {
  it("orders fitting places by distance then rating, gives only those (no padding), and writes template reasons", async () => {
    const fits = new Set(["fit_c2", "fit_c3"]);
    const client = fakeJev((name) => (fits.has(name) ? 0.9 : 0.1));
    const { answer } = await createJevPicker(client).pick(CONTEXT, new AbortController().signal);
    // 起点名称不发出去（从当前位置出发时它近乎精确位置）。
    expect(client.states[0]).toMatchObject({ anchor: { isStart: true } });
    expect(JSON.stringify(client.states[0])).not.toContain("东门广场");
    expect(answer?.picks.map((pick) => pick.id)).toEqual(["c3", "c2"]);
    expect(answer?.picks[0]).toEqual({ id: "c3", reason: "川菜，离你约 200 米", stayMinutes: 60 });
    expect(templateReason({ id: "c9", name: "x", meters: 60 }, false)).toBe("离上一站不到 100 米");
  });

  it("says none when nothing fits, keeps at most five, and hands over to the model when Jev fails", async () => {
    const none = await createJevPicker(fakeJev(() => 0.1)).pick(CONTEXT, new AbortController().signal);
    expect(none.answer).toEqual({ picks: [] });
    const many = { ...CONTEXT, found: Array.from({ length: 7 }, (_, index) => ({ id: `c${index + 1}`, name: `店${index + 1}`, meters: 100 * (index + 1) })) };
    const all = await fakeJev(() => 0.9).ask({}, {}, { signal: new AbortController().signal });
    expect(rankFromReply(many, { ...all, answers: Object.fromEntries(many.found.map((place) => [`fit_${place.id}`, { type: "noul", noul: 0.9 }])) }).picks).toHaveLength(5);

    // Jev 出错：返回 null 和原因，由候选流程改用模型挑（见 short-candidates.test.ts）。
    const failing = createJevPicker(fakeJev(() => new JevError("timeout")));
    expect(await failing.pick(CONTEXT, new AbortController().signal)).toEqual({ answer: null, failure: "timeout" });
  });
});
