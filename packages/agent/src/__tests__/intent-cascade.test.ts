import { describe, expect, it } from "vitest";
import { createRegexCascadeRouter, unsureReason, type IntentInput, type IntentRouter } from "../intent";
import { deepSeekIntentRouter } from "../intent-live";
import { DecisionModelError } from "../contracts";

/**
 * V4.1 级联分流（stages/V4.1.md §3.1–3.2、§6）：锁定的“拿不准”规则各自命中与不命中；级联只在拿不准时问模型；
 * 模型出错时退回正则。不发真实请求。
 */
const input = (text: string, extra: Partial<IntentInput> = {}): IntentInput => ({ text, hasTrip: false, cardEmpty: true, ...extra });

describe("V4.1 regex + DeepSeek cascade", () => {
  it("is unsure only for safety-net questions and messages it recognised nothing in", () => {
    // guessed：像问句，词表没认出是哪种。
    expect(unsureReason(input("晚上整两杯？"))).toBe("guessed");
    expect(unsureReason(input("灵峰古寺要预约吗"))).toBeNull();
    expect(unsureReason(input("不是要去，就问问那边好玩吗"))).toBeNull();
    // nothing：什么都没认出、只按规划兜底；卡片上的跟进（短回复）不算。
    expect(unsureReason(input("哎呀今天太晒了"))).toBe("nothing");
    expect(unsureReason(input("好的"))).toBeNull();
    expect(unsureReason(input("那就第二个吧"))).toBeNull();
    expect(unsureReason(input("明天想去西湖边走走"))).toBeNull();
  });

  it("asks the model only when the regex is unsure, and keeps the regex result otherwise", async () => {
    const asked: string[] = [];
    const model: IntentRouter = {
      name: "deepseek",
      async route(value) {
        asked.push(value.text);
        return {
          flags: { planning: true, adjust: false, ask_timely: false, ask_knowledge: false, advice: false, chitchat: false, preference: false },
          confidence: { planning: 1, adjust: 0, ask_timely: 0, ask_knowledge: 0, advice: 0, chitchat: 0, preference: 0 },
          router: "deepseek",
          fallback: [],
          latencyMs: 1,
        };
      },
    };
    const cascade = createRegexCascadeRouter(model);
    const signal = new AbortController().signal;
    const sure = await cascade.route(input("灵峰古寺要预约吗"), { signal });
    expect(sure).toMatchObject({ router: "regex", flags: { ask_timely: true } });
    expect(sure.unsure).toBeUndefined();
    const unsure = await cascade.route(input("晚上整两杯？"), { signal });
    expect(unsure).toMatchObject({ router: "deepseek", unsure: "guessed", flags: { planning: true, ask_timely: false } });
    expect(asked).toEqual(["晚上整两杯？"]);
  });

  it("falls back to the regex when the model fails", async () => {
    const failing = deepSeekIntentRouter(async () => {
      throw new DecisionModelError("timeout");
    });
    const routed = await createRegexCascadeRouter(failing).route(input("晚上整两杯？"), { signal: new AbortController().signal });
    expect(routed).toMatchObject({ router: "deepseek->regex", unsure: "guessed", failure: "timeout", flags: { ask_timely: true, ask_knowledge: true } });
  });
});
