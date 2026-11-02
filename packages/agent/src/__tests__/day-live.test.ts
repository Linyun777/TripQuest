import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDayPlanningProblem } from "@tripquest/application/day-planning";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";
import { DayRunError, type DayPlanningDecisionModel } from "../day-contracts";
import { createDayPlanningRunner } from "../day-graph";
import { createDayLiveModel } from "../day-live";

const now = () => Date.parse("2026-10-08T10:00:00+08:00");
const [start, end] = planningFixturePlaces();
const problem = createDayPlanningProblem({
  runId: "synthetic-live-run",
  requirementsFingerprint: "a".repeat(64),
  nowMs: now(),
  requirements: {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-15",
    window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: { place: start, evidence: planningFixtureEvidence(now()) },
    endPlace: { place: end, evidence: planningFixtureEvidence(now()) },
    interests: ["culture"],
    pace: "relaxed",
    visits: [],
  },
});
function model(beforeRequest: () => Promise<void>) {
  return createDayLiveModel({
    config: {
      version: 1,
      profiles: {
        synthetic: {
          providerId: "synthetic",
          adapter: "chat_completions",
          baseURL: "https://synthetic.invalid",
          model: "synthetic",
          apiKeyEnv: "SYNTHETIC_KEY",
          jsonMode: "json_object",
          thinkingMode: "omit",
          temperature: 0,
          outputTokenLimit: 512,
        },
      },
    },
    profileId: "synthetic",
    environment: { SYNTHETIC_KEY: "synthetic-key" },
    beforeRequest,
  });
}
function run(model: DayPlanningDecisionModel, signal = new AbortController().signal) {
  return createDayPlanningRunner({
    provider: new PlanningFixtureProvider(now),
    model,
    now,
  }).run(problem, { signal, onProgress: () => {} });
}
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("day live request guards", () => {
  it("reports budget denial without HTTP or implicit retries", async () => {
    const reserve = vi.fn(async () => {});
    reserve.mockRejectedValueOnce(new DayRunError("live_budget"));
    const live = model(reserve);

    expect(await run(live)).toMatchObject({ status: "failed", code: "live_budget" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(live.getRequestCount?.()).toBe(0);

  });

  it("keeps cancellation ahead of a simultaneous budget denial", async () => {
    const controller = new AbortController();
    const live = model(async () => {
      controller.abort();
      throw new DayRunError("live_budget");
    });
    expect(await run(live, controller.signal)).toMatchObject({ status: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(live.getRequestCount?.()).toBe(0);
  });

  it("still reports provider HTTP errors as model errors without retrying", async () => {
    fetcher.mockResolvedValueOnce(new Response("synthetic failure", { status: 503 }));
    const reserve = vi.fn(async () => {});
    const live = model(reserve);
    expect(await run(live)).toMatchObject({ status: "failed", code: "model_error" });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(live.getRequestCount?.()).toBe(1);
  });
});
