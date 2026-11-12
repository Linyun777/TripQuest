import { describe, expect, it } from "vitest";
import { INTENT_FLAGS, regexIntent, unsureReason, UNSURE_RULES } from "@tripquest/agent/intent";
import { ROUTE_CASES } from "../v29/route-dataset";
import { V292_ROUTE_CASES } from "../v292/route-holdout";

/**
 * V4.1 第 1 步（stages/V4.1.md §3.1、结果 8.1）：正则“拿不准”的规则离线定下后锁定。这里核对锁定的规则在带标准答案的
 * 分流题（V2.9 含留出 + V2.9.2 新说法留出）上仍满足事先定的标准：有把握部分准确率 ≥ 95%，拿不准的 ≤ 30%。不花钱。
 */
describe("V4.1 the locked rules for when the regex router is unsure", () => {
  it("keeps the sure part at least 95% exact and the unsure part at most 30%", () => {
    expect(UNSURE_RULES).toEqual(["guessed", "nothing"]);
    const labelled = [...ROUTE_CASES, ...V292_ROUTE_CASES];
    const exact = (item: (typeof labelled)[number]) => {
      const flags = regexIntent(item);
      return INTENT_FLAGS.every((flag) => flags[flag] === item.truth.includes(flag));
    };
    const sure = labelled.filter((item) => !unsureReason(item));
    const unsure = labelled.length - sure.length;
    expect(sure.filter(exact).length / sure.length).toBeGreaterThanOrEqual(0.95);
    expect(unsure / labelled.length).toBeLessThanOrEqual(0.3);
    expect([sure.filter(exact).length, sure.length, unsure]).toEqual([67, 70, 11]);
  });
});
