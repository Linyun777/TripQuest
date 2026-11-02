import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { emptyDraft, type RequirementsDraft } from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";
import { createCandidateRunner, createShortScriptedModel } from "@tripquest/agent/short";
import type { PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import { createPlanService, type PlanEvent } from "../plan-service";
import { MemoryConversations } from "./memory-conversations";

// V2.4 short trips through the plan service: synthetic places only, no provider data.
const NOW = Date.parse("2026-10-15T06:43:00Z"); // 14:43 in Hangzhou
const evidence: ProviderEvidence = { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: new Date(NOW).toISOString() };
const at = (externalId: string, name: string, longitude: number, latitude: number): PlaceSummary => ({
  ref: { provider: "amap", externalId }, name, cityAdcode: "330100", location: { longitude, latitude, coordinateSystem: "gcj02" },
});
const PLACES = [
  at("SYN-HOME", "合成家", 120.1, 30.2),
  at("SYN-SPICY-1", "合成川菜馆", 120.102, 30.2),
  at("SYN-SPICY-2", "合成湘菜馆", 120.103, 30.201),
  at("SYN-COFFEE-1", "合成瑞幸(甲店)", 120.1025, 30.2005),
  at("SYN-COFFEE-2", "合成瑞幸(乙店)", 120.104, 30.202),
];
const amap = {
  async searchPlaces(request: { query: string }) {
    const items = PLACES.filter((place) => (/瑞幸/.test(request.query) ? /瑞幸/ : /川菜|湘菜/).test(place.name));
    return { status: "ok" as const, data: { items, truncated: false, excludedCount: 0 }, evidence };
  },
  async findPlacesById(ids: readonly string[]) {
    const items = PLACES.filter((place) => ids.includes(place.ref.externalId));
    return { status: "ok" as const, data: { items, missing: [] }, evidence };
  },
  async findRoutes(request: { mode: string }) {
    return request.mode === "walking"
      ? { status: "ok" as const, routes: [{ mode: "walking" as const, durationSeconds: 300, distanceMeters: 400 }], evidence }
      : { status: "no_route" as const, reason: "unsupported_mode" as const, evidence };
  },
  async getWeatherForecast() {
    return { status: "failure" as const, failure: { code: "unknown" as const, retry: "never" as const, safeMessage: "x" }, evidence };
  },
};

function setup() {
  const repository = new MemoryConversations();
  const draft: RequirementsDraft = {
    ...emptyDraft(), mode: "short", date: "2026-10-15", startsAt: "14:45", endsAt: "18:45",
    start: { status: "bound", externalId: "SYN-HOME", name: "合成家" }, end: null,
    interests: [{ id: "i1", text: "吃点辣的" }, { id: "i2", text: "喝瑞幸" }],
    travel: { allowed: ["walking"], prefer: "balanced" },
  };
  repository.conversations.set("c1", { id: "c1", title: "现在出发", status: "active", journeyId: null, draft, messageCount: 0, createdAt: "", updatedAt: "" });
  repository.messages.set("c1", []);
  const model = createShortScriptedModel((context) => context.stage === "queries"
    ? { queries: [/瑞幸/.test(context.interest.text) ? "瑞幸咖啡" : "川菜"] }
    : { picks: (context.found ?? []).map((item) => ({ id: item.id, reason: "合适", stayMinutes: 45 })) });
  const service = createPlanService({
    now: () => NOW,
    repository: () => repository,
    amap: () => amap as never,
    runner: async () => { throw new Error("no day planner in short trips"); },
    candidates: async (provider) => createCandidateRunner({ provider, model }),
  });
  const run = async (call: (emit: (event: PlanEvent) => void) => Promise<void>) => {
    const events: PlanEvent[] = [];
    await call((event) => events.push(event));
    return events.at(-1)!;
  };
  return { repository, service, run, print: fingerprint(draft) };
}

describe("V2.4 short trips in the plan service", () => {
  it("offers each step around the last pick, refuses stale answers, and plans the picks in order", async () => {
    const { repository, service, run, print } = setup();
    const signal = new AbortController().signal;
    const first = await run((emit) => service.plan("c1", print, emit, signal));
    if (first.type !== "done" || first.messages[0].kind !== "choices") throw new Error(JSON.stringify(first));
    const step1 = first.messages[0];
    expect(step1).toMatchObject({ step: 1, total: 2, interest: "吃点辣的", anchorName: "你的位置", open: true });
    expect(step1.options.map((option) => option.externalId)).toEqual(["SYN-SPICY-1", "SYN-SPICY-2"]);
    expect(step1.options[0]).toMatchObject({ travel: { mode: "walking", minutes: 5 } });
    expect(first.mapStops.map((stop) => stop.label)).toEqual(["起", "1", "2"]);
    // Stored without distances, routes or ratings.
    expect(JSON.stringify(repository.messages.get("c1"))).not.toMatch(/meters|travel|rating|minutes/);

    const choose = (messageId: string, pick?: string) =>
      run((emit) => service.choose("c1", { tripId: step1.tripId, messageId, fingerprint: print, ...(pick ? { pick } : {}) }, emit, signal));
    const second = await choose(step1.id, "SYN-SPICY-1");
    if (second.type !== "done" || second.messages[0].kind !== "choices") throw new Error(JSON.stringify(second));
    expect(second.updated).toMatchObject({ id: step1.id, chosen: "SYN-SPICY-1", open: false });
    const step2 = second.messages[0];
    expect(step2).toMatchObject({ step: 2, interest: "喝瑞幸", anchorName: "合成川菜馆" });
    // Nearest to the restaurant first.
    expect(step2.options.map((option) => option.externalId)).toEqual(["SYN-COFFEE-1", "SYN-COFFEE-2"]);

    // The first step is answered: picking there again is refused.
    expect(await choose(step1.id, "SYN-SPICY-2")).toMatchObject({ type: "refused", status: "conflict" });
    // "换一批" with nothing new nearby says so honestly; the step stays answerable.
    expect(await choose(step2.id)).toMatchObject({ type: "done", messages: [{ kind: "notice", text: expect.stringContaining("附近没找到合适的“喝瑞幸”") }] });

    const last = await choose(step2.id, "SYN-COFFEE-1");
    if (last.type !== "done" || !last.plan) throw new Error(JSON.stringify(last));
    expect(last.plan.stops.map((stop) => stop.name)).toEqual(["合成川菜馆", "合成瑞幸(甲店)"]);
    expect(last.plan.endName).toBe("合成瑞幸(甲店)");
    expect(last.messages.map((message) => message.kind)).toEqual(["plan_card"]);
  });

  it("refuses answers once the card changed", async () => {
    const { repository, service, run, print } = setup();
    const signal = new AbortController().signal;
    const first = await run((emit) => service.plan("c1", print, emit, signal));
    if (first.type !== "done" || first.messages[0].kind !== "choices") throw new Error("start");
    const conversation = repository.conversations.get("c1")!;
    repository.conversations.set("c1", { ...conversation, draft: { ...conversation.draft, interests: [{ id: "i1", text: "吃火锅" }] } });
    const step1 = first.messages[0];
    expect(await run((emit) => service.choose("c1", { tripId: step1.tripId, messageId: step1.id, fingerprint: print, pick: "SYN-SPICY-1" }, emit, signal)))
      .toMatchObject({ type: "refused", status: "conflict" });
  });
});
