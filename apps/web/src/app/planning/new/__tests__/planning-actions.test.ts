import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// V2.12：动作先取当前用户；这里固定一个用户（会话本身由 Better Auth 管）。
vi.mock("../../../auth/session", async () => ({ pageUser: async () => (await import("../../../../test-support/users")).TEST_USER }));
import { searchPlanningPlaces, reviewPlanningRequirements } from "../actions";
import { readPlanningConfig } from "../planning-config";
import { createPlanningService } from "../planning-service";
import { PLACE_TOKEN_TTL } from "../place-token";

const secret = "synthetic-planning-only-secret-32-bytes";
const now = Date.parse("2026-10-08T00:00:00Z");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function config(
  source = "fixture",
  nodeEnv: "development" | "production" | "test" = "test",
) {
  return readPlanningConfig({
    NODE_ENV: nodeEnv,
    PLANNING_PLACE_SOURCE: source,
    PLANNING_PLACE_TOKEN_SECRET: secret,
    AMAP_WEB_SERVICE_KEY: "synthetic-amap-key",
  });
}
function submission(token: string) {
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-08",
    window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: token,
    endPlace: token,
    interests: ["culture"],
    pace: "relaxed",
    visits: [],
  };
}
describe("planning server actions and service boundary", () => {
  it.each(["production", "test"])(
    "denies direct amap calls in %s before any network",
    async (env) => {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("PLANNING_PLACE_SOURCE", "amap");
      vi.stubEnv("PLANNING_PLACE_TOKEN_SECRET", secret);
      vi.stubEnv("AMAP_WEB_SERVICE_KEY", "synthetic-amap-key");
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(await searchPlanningPlaces("博物馆")).toMatchObject({
        status: "error",
      });
      expect(
        await reviewPlanningRequirements(submission("forged")),
      ).toMatchObject({ status: "unavailable" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("disables missing, short or reused secrets and never enables solely from Key", () => {
    expect(
      readPlanningConfig({
        NODE_ENV: "test",
        AMAP_WEB_SERVICE_KEY: "available",
      }).enabled,
    ).toBe(false);
    for (const key of ["", "short", secret]) {
      expect(
        readPlanningConfig({
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "fixture",
          PLANNING_PLACE_TOKEN_SECRET: key,
          AMAP_WEB_SERVICE_KEY: secret,
        }).enabled,
      ).toBe(false);
    }
  });
  it("handles fixture same-name ambiguity, empty results, and valid empty-visit requirements without network", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const service = createPlanningService({ config: config(), now: () => now });
    const search = await service.search("演示博物馆");
    expect(search.status).toBe("ok");
    if (search.status !== "ok") return;
    expect(search.items).toHaveLength(2);
    expect(search.items[0].selection.place.ref).not.toEqual(
      search.items[1].selection.place.ref,
    );
    expect(await service.search("不存在的虚构地点")).toMatchObject({
      status: "ok",
      items: [],
    });
    expect(service.review(submission(search.items[0].token))).toMatchObject({
      status: "ready",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects browser place claims, oversized submissions, expiry and mode switches with field paths", async () => {
    const service = createPlanningService({ config: config(), now: () => now });
    const search = await service.search("演示起点");
    if (search.status !== "ok") throw new Error("fixture unavailable");
    const input = submission(search.items[0].token);
    expect(service.review({ ...input, verified: true })).toMatchObject({
      status: "invalid",
    });
    expect(
      service.review({ ...input, startPlace: search.items[0].selection }),
    ).toMatchObject({ status: "invalid" });
    expect(
      service.review({ ...input, extra: "x".repeat(65536) }),
    ).toMatchObject({ status: "invalid" });
    const expired = createPlanningService({
      config: config(),
      now: () => now + PLACE_TOKEN_TTL,
    });
    expect(expired.review(input)).toMatchObject({
      status: "invalid",
      fieldErrors: { startPlace: [expect.stringContaining("过期")] },
    });
    const switched = createPlanningService({
      config: config("amap", "development"),
      now: () => now,
    });
    expect(switched.review(input)).toMatchObject({
      status: "invalid",
      fieldErrors: { startPlace: expect.any(Array) },
    });
  });
  it("forwards one request and preserves failures without retries or fixture fallback", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "0", infocode: "10003" })),
      );
    vi.stubGlobal("fetch", fetcher);
    const service = createPlanningService({
      config: config("amap", "development"),
      now: () => now,
    });
    expect(await service.search("博物馆")).toMatchObject({ status: "error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("region")).toBe("330100");
    expect(url.searchParams.get("city_limit")).toBe("true");
    expect(await service.search(" ")).toMatchObject({ status: "error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
