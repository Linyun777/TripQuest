import { rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createDayPlanningProblem, type DayPlanningResult } from "@tripquest/application/day-planning";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { planningRequirementsSchema } from "@tripquest/application/planning";
import type { InitialRealDayDraft, RealDayRepository } from "@tripquest/application/real-day";
import { createDayPlanningRunner, createDayScriptedModel } from "@tripquest/agent/day-planning";
import type { MobilityProvider, PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import { createDraftSaveOffer } from "../../planning/new/draft-receipt";
import { readGenerationConfig } from "../../planning/new/generation-config";
import { createConfirmDayHandler } from "../../api/planning/confirm/confirm-handler";
import { meteredAmap, type Usage } from "../../usage/usage";
import { readRealPlaceMode } from "../real-mode";
import { asTestUser } from "../../../test-support/users";

// Synthetic "Amap" places and routes only; no captured provider data.
const t0 = Date.parse("2026-10-15T01:00:00Z");
const realEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "amap",
  REAL_PLACE_SAVE_ENABLED: "true",
  AMAP_WEB_SERVICE_KEY: "synthetic-amap-key",
  PLANNING_PLACE_TOKEN_SECRET: "s55-place-token-secret-0123456789abcdef-xyz",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_AMAP_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "scripted",
  PLANNING_SAVE_ENABLED: "true",
  PLANNING_DRAFT_RECEIPT_SECRET: "s55-draft-receipt-secret-0123456789abcdef-xyz",
};
const evidence = (): ProviderEvidence => ({
  provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: new Date(t0).toISOString(),
});
const place = (index: number, name: string): PlaceSummary => ({
  ref: { provider: "amap", externalId: `SYN${index}` },
  name,
  address: `合成路 ${index} 号`,
  cityAdcode: "330100",
  location: { longitude: 120 + index / 1000, latitude: 30 + index / 1000, coordinateSystem: "gcj02" },
});
const WORLD = [place(0, "合成起点"), place(1, "合成博物馆"), place(2, "合成公园"), place(3, "合成餐厅")];
const fakeRoutes = (slower = 0): MobilityProvider => ({
  async searchPlaces() {
    return { status: "ok", data: { items: [], truncated: false }, evidence: evidence() };
  },
  async findRoutes(request) {
    const from = WORLD.findIndex((item) => item.ref.externalId === request.origin.place.externalId);
    const to = WORLD.findIndex((item) => item.ref.externalId === request.destination.place.externalId);
    return {
      status: "ok",
      routes: [{ mode: "walking", durationSeconds: 300 + Math.abs(to - from) * 240 + slower, distanceMeters: 500 }],
      evidence: evidence(),
    };
  },
});

/** Runs the real S5.2 graph (rules policy) over synthetic Amap data, like the dev page does. */
async function realDraft() {
  const selection = (item: PlaceSummary) => ({ place: item, evidence: evidence() });
  const requirements = planningRequirementsSchema.parse({
    schemaVersion: "planning-requirements.v1", cityAdcode: "330100", timeZone: "Asia/Shanghai",
    travelMode: "walking", date: "2026-10-16", window: { startsAt: "09:00", endsAt: "18:00" },
    startPlace: selection(WORLD[0]), endPlace: selection(WORLD[3]), interests: [], pace: "standard",
    visits: [
      { place: selection(WORLD[1]), role: "required", stayMinutes: 90 },
      { place: selection(WORLD[2]), role: "fixed", startsAt: "13:00", endsAt: "14:00" },
    ],
  });
  const problem = createDayPlanningProblem({
    requirements,
    runId: "22222222-2222-4222-8222-222222222222",
    requirementsFingerprint: fingerprintRequirements(requirements),
    nowMs: t0,
  });
  let snapshot: DayDraftConfirmationSnapshot | null = null;
  const result: DayPlanningResult = await createDayPlanningRunner({
    provider: fakeRoutes(), model: createDayScriptedModel(), now: () => t0,
  }).run(problem, {
    signal: new AbortController().signal,
    onProgress: () => {},
    onDraftReady: (ready) => (snapshot = ready),
  });
  if (result.status !== "completed" || result.outcome !== "draft") throw new Error("expected a draft");
  return { snapshot: snapshot!, result };
}

class MemoryRealDays implements RealDayRepository {
  saved: InitialRealDayDraft[] = [];
  async findRealDayCreation(runId: string) {
    const found = this.saved.find((item) => item.creationRunId === runId);
    return found ? { journeyId: found.journeyId, intentFingerprint: found.creationIntentFingerprint } : null;
  }
  async createRealDay(draft: InitialRealDayDraft) {
    this.saved.push(draft);
    return { status: "saved" as const, journeyId: draft.journeyId, planVersion: 1 as const };
  }
}

const confirmRequest = (receipt: string) => new Request("http://localhost:3355/api/planning/confirm", {
  method: "POST",
  headers: { origin: "http://localhost:3355", host: "localhost:3355", "content-type": "application/json" },
  body: JSON.stringify({ receipt, title: "合成真实行程", acknowledgeUnknowns: true }),
});

describe("S5.5 real-place mode switches", () => {
  it("needs development, amap source, the switch and a key", () => {
    expect(readRealPlaceMode(realEnvironment).enabled).toBe(true);
    const changes: Record<string, string>[] = [
      { NODE_ENV: "production" }, { PLANNING_PLACE_SOURCE: "fixture" },
      { REAL_PLACE_SAVE_ENABLED: "false" }, { AMAP_WEB_SERVICE_KEY: " " },
    ];
    for (const change of changes) {
      expect(readRealPlaceMode({ ...realEnvironment, ...change } as NodeJS.ProcessEnv).enabled).toBe(false);
    }
  });

  it("lets real places + rules generate without a one-off round only in personal mode", () => {
    expect(readGenerationConfig(realEnvironment)).toMatchObject({ enabled: true, personal: true });
    expect(readGenerationConfig({ ...realEnvironment, REAL_PLACE_SAVE_ENABLED: "false" })).toMatchObject({ enabled: false });
  });

  it("lets a live model plan over real places in personal mode without a one-off round (D-051)", () => {
    const live = { ...realEnvironment, PLANNING_MODEL_MODE: "live", AGENT_LIVE_ENABLED: "true", AGENT_MODEL_PROFILE: "synthetic" };
    expect(readGenerationConfig(live)).toMatchObject({ enabled: true, personal: true, modelMode: "live", round: "disabled" });
    expect(readGenerationConfig({ ...live, REAL_PLACE_SAVE_ENABLED: "false" })).toMatchObject({ enabled: false });
  });
});

describe("S5.5 saving a real draft", () => {
  it("offers a receipt only in personal mode and saves only the minimal record", async () => {
    const { snapshot, result } = await realDraft();
    expect(await createDraftSaveOffer(snapshot, result, {
      environment: { ...realEnvironment, REAL_PLACE_SAVE_ENABLED: "false" }, now: t0,
    })).toEqual({ status: "unavailable", reason: "source_not_allowed" });
    const offer = await createDraftSaveOffer(snapshot, result, { environment: realEnvironment, now: t0 });
    if (offer.status !== "available") throw new Error(`no offer: ${JSON.stringify(offer)}`);

    const repository = new MemoryRealDays();
    const handler = createConfirmDayHandler({ user: asTestUser,
      environment: realEnvironment,
      now: () => t0 + 60_000,
      realRepository: () => repository,
      realRoutes: fakeRoutes(),
    });
    const response = await handler(confirmRequest(offer.receipt));
    expect(response.status).toBe(201);
    const stored = JSON.stringify(repository.saved[0].realDay);
    expect(stored).not.toMatch(/location|address|合成路|durationSeconds|distanceMeters|retrievedAt|evidence/);
    expect(repository.saved[0].realDay.places.map((item) => item.externalId).sort()).toEqual(["SYN0", "SYN1", "SYN2", "SYN3"]);
  });

  it("refuses the same receipt once personal mode is off, and a changed route", async () => {
    const { snapshot, result } = await realDraft();
    const offer = await createDraftSaveOffer(snapshot, result, { environment: realEnvironment, now: t0 });
    if (offer.status !== "available") throw new Error("no offer");
    const off = createConfirmDayHandler({ user: asTestUser,
      environment: { ...realEnvironment, REAL_PLACE_SAVE_ENABLED: "false" },
      now: () => t0 + 60_000,
      realRepository: () => new MemoryRealDays(),
      realRoutes: fakeRoutes(),
    });
    const refused = await off(confirmRequest(offer.receipt));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ status: "source_not_allowed" });
    const changed = createConfirmDayHandler({ user: asTestUser,
      environment: realEnvironment,
      now: () => t0 + 60_000,
      realRepository: () => new MemoryRealDays(),
      realRoutes: fakeRoutes(120),
    });
    const response = await changed(confirmRequest(offer.receipt));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "draft_changed" });
  });
});

describe("V2.1 daily local usage ledger", () => {
  let directory: string | undefined;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("reserves before each request and refuses past the daily limit without a network call", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      status: "1", infocode: "10000", count: "0", pois: [],
    })));
    vi.stubGlobal("fetch", fetcher);
    // V2.12：上限本身在数据库账本里（packages/db 的用量测试）；这里只看包装：先预留，被拒就不发请求。
    const reserved: string[] = [];
    let full = false;
    const usage: Usage = {
      async reserve(pool, kind) {
        if (full) throw new Error("limit");
        reserved.push(`${pool}:${kind}`);
      },
    };
    const amap = meteredAmap({ key: "synthetic-amap-key", usage, purpose: "test", now: () => t0 });
    expect(await amap.findPlacesById(["SYN1"])).toMatchObject({ status: "ok", data: { missing: ["SYN1"] } });
    expect(reserved).toEqual(["amap:detail"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    full = true;
    expect(await amap.findPlacesById(["SYN1"])).toMatchObject({ status: "failure", failure: { code: "quota_exceeded" } });
    expect(await amap.getWeatherForecast("330100")).toMatchObject({ status: "failure", failure: { code: "quota_exceeded" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
