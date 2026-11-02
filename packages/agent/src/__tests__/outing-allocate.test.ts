import { describe, expect, it } from "vitest";
import type { OutingPlanInput } from "@tripquest/application/outing-allocation";
import { allocateOuting } from "../outing-allocate";

const at = (id: string, longitude: number) => ({
  place: { ref: { provider: "synthetic", externalId: id }, name: id, cityAdcode: "990100", location: { longitude, latitude: 30.2, coordinateSystem: "gcj02" as const } },
  evidence: { provider: "synthetic", sourceKind: "fixture" as const, retrievedAt: "2026-10-15T00:00:00.000Z", attribution: "手写虚构" },
});
const input: OutingPlanInput = {
  dates: { from: "2026-10-17", to: "2026-10-18" },
  dailyWindow: { startsAt: "09:00", endsAt: "20:00" },
  start: { place: at("南站", 125), at: null },
  end: { place: at("南站", 125), at: null },
  lodging: [at("酒店", 125.01)],
  transports: [],
  visits: [{ key: "v1", place: at("山门", 125.02), role: "required", stayMinutes: 300 }, { key: "v2", place: at("古镇", 125.03), role: "required", stayMinutes: 150 }],
  interests: [],
  travel: { allowed: ["walking", "taxi"], prefer: "balanced" },
};
const answers = (...replies: unknown[]) => {
  const seen: string[] = [];
  return {
    seen,
    request: async (_system: string, content: string) => {
      seen.push(content);
      return { decision: replies.shift(), usage: null } as never;
    },
  };
};
const run = (request: ReturnType<typeof answers>["request"]) => allocateOuting(input, { request, signal: new AbortController().signal });

describe("V2.11 the model splits an outing into days, checked by code", () => {
  it("uses a split that passes; sends the problems back once; falls back to the rules after two bad splits", async () => {
    const good = { days: [{ day: 1, visits: ["v1"], interests: [], reason: "山门离酒店近" }, { day: 2, visits: ["v2"], interests: [] }] };
    const missing = { days: [{ day: 1, visits: ["v1"], interests: [] }, { day: 2, visits: [], interests: [] }] };
    expect(await run(answers(good).request)).toMatchObject({ source: "model", repairs: 0, allocation: good });
    const fixed = answers(missing, good);
    expect(await run(fixed.request)).toMatchObject({ source: "model", repairs: 1 });
    expect(fixed.seen[1]).toContain("v2 (古镇) is missing");
    expect(await run(answers(missing, missing).request)).toMatchObject({ source: "rules", repairs: 1, modelRequests: 2 });
  });
});
