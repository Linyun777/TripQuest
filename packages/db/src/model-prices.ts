import { readFileSync } from "node:fs";

export interface ModelUsage {
  input: number;
  output: number;
  hit: number | null;
  miss: number | null;
}

export interface ModelReceipt {
  sent: boolean;
  provider: string;
  requested: string;
  returned?: string | null;
  usage: ModelUsage | null;
}

export interface Price {
  channel: string;
  provider: string;
  model: string;
  aliases?: string[];
  from: string;
  currency: string;
  source: string;
  input?: string;
  hit?: string;
  miss?: string;
  output: string;
}

const identifier = /^[a-zA-Z0-9_.:/-]{1,160}$/;
const rate = (value: unknown) => typeof value === "string" && /^\d{1,9}(\.\d{1,8})?$/.test(value);

export function readPrices(file?: string): Price[] {
  if (!file) return [];
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const versions = new Set<string>();
  if (!Array.isArray(rows)) throw new Error("Invalid model price file");
  for (const row of rows) {
    if (
      !row ||
      ![row.channel, row.provider, row.model].every(
        (v) => typeof v === "string" && identifier.test(v),
      ) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(row.from) ||
      !Number.isFinite(Date.parse(row.from)) ||
      new Date(row.from).toISOString() !== row.from.replace("Z", ".000Z") ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      typeof row.source !== "string" ||
      !row.source.trim() ||
      !rate(row.output) ||
      !(
        (rate(row.input) && row.hit === undefined && row.miss === undefined) ||
        (row.input === undefined && rate(row.hit) && rate(row.miss))
      ) ||
      (row.aliases !== undefined && !Array.isArray(row.aliases))
    )
      throw new Error("Invalid model price");
    for (const model of [row.model, ...(row.aliases ?? [])]) {
      const key = JSON.stringify([row.channel, row.provider, model, row.from]);
      if (typeof model !== "string" || !identifier.test(model) || versions.has(key)) {
        throw new Error("Invalid or overlapping model price");
      }
      versions.add(key);
    }
  }
  return rows;
}

// Rates are exact decimal strings with up to eight places per million tokens.
export function estimate(prices: Price[], channel: string, at: Date, call: ModelReceipt) {
  // A missing model may use a configured request alias. An unusable returned identifier cannot.
  if (call.returned === null) return null;
  const model = call.returned ?? call.requested;
  const price = prices
    .filter(
      (p) =>
        p.channel === channel &&
        p.provider === call.provider &&
        (p.model === model || p.aliases?.includes(model)) &&
        Date.parse(p.from) <= at.getTime(),
    )
    .sort((a, b) => b.from.localeCompare(a.from))[0];
  const u = call.usage;
  if (!price || !u || !call.sent) return null;
  const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (![u.input, u.output].every(valid)) return null;
  const charge = (r: string, n: number) => {
    const [whole, fraction = ""] = r.split(".");
    return BigInt(whole + fraction.padEnd(8, "0")) * BigInt(n);
  };
  let total = charge(price.output, u.output);
  if (price.input !== undefined) total += charge(price.input, u.input);
  else {
    if (u.hit === null && u.miss === null) return null;
    const hit = u.hit ?? u.input - u.miss!;
    const miss = u.miss ?? u.input - hit;
    if (![hit, miss].every(valid) || hit + miss !== u.input) return null;
    total += charge(price.hit!, hit) + charge(price.miss!, miss);
  }
  const digits = total.toString().padStart(15, "0");
  return { price, amount: digits.slice(0, -14) + "." + digits.slice(-14) };
}
