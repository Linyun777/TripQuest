import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// V2.12：动作先取当前用户；这里固定一个用户（会话本身由 Better Auth 管）。
vi.mock("../../../auth/session", async () => ({ pageUser: async () => (await import("../../../../test-support/users")).TEST_USER }));
const { reserveRequest, createBudget } = vi.hoisted(() => {
  const reserveRequest = vi.fn<() => Promise<void>>();
  return {
    reserveRequest,
    createBudget: vi.fn(() => ({ reserveRequest })),
  };
});
vi.mock("../live-budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("../live-budget")>(),
  s52LedgerPath: () => "synthetic-search-ledger",
  createS52LiveBudget: createBudget,
}));
import { searchPlanningPlaces } from "../actions";

const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "amap",
  PLANNING_PLACE_TOKEN_SECRET: "search-test-secret-0123456789abcdef",
  AMAP_WEB_SERVICE_KEY: "synthetic-search-key",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_AMAP_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "live",
  PLANNING_LIVE_ROUND: "developer",
  PLANNING_AMAP_MODEL_ENABLED: "true",
  AGENT_LIVE_ENABLED: "true",
  AGENT_MODEL_PROFILE: "synthetic-profile",
};
function configure(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  for (const [key, value] of Object.entries({ ...environment, ...overrides })) {
    vi.stubEnv(key, value);
  }
}
const fetcher = vi.fn(async () => new Response(JSON.stringify({
  status: "1",
  infocode: "10000",
  count: "0",
  pois: [],
})));

beforeEach(() => {
  configure();
  reserveRequest.mockReset().mockResolvedValue(undefined);
  createBudget.mockClear();
  fetcher.mockClear();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("manual search action budget", () => {
  it("reserves despite closed model gates, and rejects an exhausted budget before HTTP", async () => {
    const closedModelGates: Partial<NodeJS.ProcessEnv>[] = [
      { PLANNING_AMAP_MODEL_ENABLED: "false" },
      { AGENT_LIVE_ENABLED: "false" },
      {
        AGENT_MODEL_PROFILE: undefined,
        PLANNING_LIVE_ROUND: "independent-test",
      },
    ];
    for (const [index, overrides] of closedModelGates.entries()) {
      configure(overrides);
      expect(await searchPlanningPlaces("合成测试地点")).toMatchObject({ status: "ok" });
      expect(reserveRequest).toHaveBeenCalledTimes(index + 1);
      expect(createBudget).toHaveBeenLastCalledWith(
        "synthetic-search-ledger",
        overrides.PLANNING_LIVE_ROUND ?? "developer",
      );
      expect(reserveRequest).toHaveBeenLastCalledWith(
        expect.stringMatching(/^manual-/),
        "search",
        true,
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(3);

    reserveRequest.mockRejectedValueOnce(new Error("synthetic budget denial"));
    expect(await searchPlanningPlaces("合成测试地点")).toMatchObject({ status: "error" });
    expect(reserveRequest).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("blocks missing, disabled and invalid S5.2 rounds before the provider", async () => {
    for (const round of [undefined, "disabled", "invalid-round"]) {
      configure({ PLANNING_LIVE_ROUND: round });
      expect(await searchPlanningPlaces("合成测试地点"), String(round))
        .toMatchObject({ status: "error" });
    }
    expect(createBudget).not.toHaveBeenCalled();
    expect(reserveRequest).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps ordinary S5.1 searches and fixture searches outside the S5.2 live budget", async () => {
    const ordinarySearches: Partial<NodeJS.ProcessEnv>[] = [
      { PLANNING_GENERATION_ENABLED: "false" },
      { PLANNING_AMAP_GENERATION_ENABLED: "false" },
      { PLANNING_PLACE_SOURCE: "fixture" },
    ];
    for (const overrides of ordinarySearches) {
      configure({ ...overrides, PLANNING_LIVE_ROUND: "disabled" });
      expect(await searchPlanningPlaces("演示起点")).toMatchObject({ status: "ok" });
    }
    expect(createBudget).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
