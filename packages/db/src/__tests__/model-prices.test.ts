import { describe, expect, it } from "vitest";
import { estimate, type Price, type ModelReceipt } from "../model-prices";

const price: Price = {
  channel: "fixture",
  provider: "fixture",
  model: "one",
  aliases: ["alias"],
  from: "2020-01-01T00:00:00Z",
  currency: "CNY",
  source: "fixture",
  hit: "0.5",
  miss: "2",
  output: "8",
};
const call: ModelReceipt = {
  sent: true,
  provider: "fixture",
  requested: "alias",
  usage: { input: 1000, output: 100, hit: null, miss: 400 },
};
const calculate = (receipt: ModelReceipt, rates = price) =>
  estimate([rates], "fixture", new Date("2026-11-01"), receipt)?.amount;

describe("receipt pricing", () => {
  it("uses the explicit request alias only when the returned model is absent", () => {
    expect(calculate(call)).toBe("0.00190000000000");
    expect(calculate({ ...call, returned: "unlisted" })).toBeUndefined();
    expect(calculate({ ...call, returned: null })).toBeUndefined();
    expect(calculate(call, { ...price, channel: "another-account" })).toBeUndefined();
  });
  it("accepts total-only usage for flat input prices and rejects incomplete split usage", () => {
    const usage = { input: 1000, output: 100, hit: null, miss: null };
    const flat = { ...price, hit: undefined, miss: undefined, input: "2" };
    expect(calculate({ ...call, usage }, flat)).toBe("0.00280000000000");
    expect(calculate({ ...call, usage })).toBeUndefined();
    expect(calculate({ ...call, usage: { ...usage, hit: 800, miss: 400 } })).toBeUndefined();
  });
});
