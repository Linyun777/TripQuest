import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { NotesDecisionModel } from "@tripquest/agent/notes";
import type { ProviderEvidence } from "@tripquest/providers";
import { createTripNotesService } from "../trip-notes-service";

// Synthetic plan, places and pages.
const evidence: ProviderEvidence = { provider: "fixture", sourceKind: "fixture", retrievedAt: "2026-10-18T00:00:00Z", attribution: "test" };
const RUN = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const card = {
  id: "m1", role: "assistant", kind: "plan_card",
  body: { runId: RUN, date: "2026-10-20", stops: [{ externalId: "F", name: "合成面馆" }, { externalId: "M", name: "合成博物馆" }] },
};
const conversations = () => ({ findConversation: async (id: string) => (id === "c1" ? { conversation: {}, messages: [card] } : null) }) as never;
const model: NotesDecisionModel = {
  mode: "scripted", provider: "test", model: "scripted",
  async decide() {
    return { decision: { stops: [{ key: "s2", notes: [{ kind: "reserve", text: "需提前预约", sources: ["w1"] }] }] }, usage: null };
  },
};
const dependencies = async () => ({
  model,
  places: {
    async findPlacesById() {
      const at = { longitude: 120, latitude: 30, coordinateSystem: "gcj02" as const };
      return {
        status: "ok" as const,
        data: {
          items: [
            { ref: { provider: "amap", externalId: "F" }, name: "合成面馆", cityAdcode: "330100", location: at, categoryCode: "050100" },
            { ref: { provider: "amap", externalId: "M" }, name: "合成博物馆", cityAdcode: "330100", location: at, categoryCode: "140100" },
          ],
          missing: [],
        },
        evidence,
      };
    },
  },
  web: {
    async searchWeb() {
      return { status: "ok" as const, data: { results: [{ title: "公告", url: "https://example.invalid/m", site: "合成博物馆", date: "2026-09-01", authority: 3, summary: "需提前预约，每周二闭馆" }] }, evidence };
    },
  },
});

describe("V2.7.2 trip notes service", () => {
  it("answers a plan card in its stops' order, with the closing-day warning from code", async () => {
    const service = createTripNotesService({ conversations, dependencies, now: () => Date.parse("2026-10-18T02:00:00Z") });
    const reply = await service.forPlan("c1", RUN);
    expect(reply.status === "ok" && reply.notes.stops.map((stop) => [stop.id, stop.checked, stop.notes.map((note) => note.text), stop.warning]))
      .toEqual([["F", false, [], null], ["M", true, ["需提前预约"], "你排的 10 月 20 日是周二，这里周二闭馆"]]);
    expect(await service.forPlan("c1", "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toEqual({ status: "not_found" });
  });

  it("is unavailable without a live model, search key or real places", async () => {
    const service = createTripNotesService({ conversations, environment: {} as NodeJS.ProcessEnv });
    expect(await service.forPlan("c1", RUN)).toEqual({ status: "unavailable" });
  });
});
