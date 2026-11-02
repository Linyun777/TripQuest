import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { searchLivePlaces, findLiveWalkingRoute } from "../actions";
import { liveConfiguration } from "../live-config";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(["production", "test"])("denies direct actions in %s even with enabled Key", async (env) => {
  vi.stubEnv("NODE_ENV", env); vi.stubEnv("AMAP_LIVE_ENABLED", "true"); vi.stubEnv("AMAP_WEB_SERVICE_KEY", "synthetic-secret");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(liveConfiguration()).toBe("unavailable");
  expect(await searchLivePlaces("合成")).toMatchObject({ status: "unavailable" });
  expect(await findLiveWalkingRoute({}, {})).toMatchObject({ status: "unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("disabled and missing Key return configuration without live evidence", async () => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("AMAP_LIVE_ENABLED", "false"); vi.stubEnv("AMAP_WEB_SERVICE_KEY", "");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(liveConfiguration()).toBe("disabled");
  expect(await searchLivePlaces("合成")).not.toHaveProperty("result");
  vi.stubEnv("AMAP_LIVE_ENABLED", "true"); expect(liveConfiguration()).toBe("missing_key");
  expect(await findLiveWalkingRoute({}, {})).not.toHaveProperty("result"); expect(fetcher).not.toHaveBeenCalled();
});
it("validates browser payloads before fetch and uses request time", async () => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("AMAP_LIVE_ENABLED", "true"); vi.stubEnv("AMAP_WEB_SERVICE_KEY", "synthetic-secret");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "1", infocode: "10000", route: { paths: [] } })));
  vi.stubGlobal("fetch", fetcher);
  for (const q of [null, {}, "", "x".repeat(81)]) expect(await searchLivePlaces(q)).toMatchObject({ status: "unavailable" });
  const p = { cityAdcode: "330100", ref: { provider: "amap", externalId: "SYNTHETIC-A" }, location: { longitude: 120, latitude: 30, coordinateSystem: "gcj02" } };
  for (const bad of [null, {}, { ...p, cityAdcode: "330200" }, { ...p, ref: { provider: "fixture", externalId: "B" } }]) expect(await findLiveWalkingRoute(bad, p)).toMatchObject({ status: "unavailable" });
  expect(await findLiveWalkingRoute(p, p)).toMatchObject({ status: "unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
  const result = await findLiveWalkingRoute(p, { ...p, ref: { provider: "amap", externalId: "SYNTHETIC-B" } });
  expect(result).toMatchObject({ status: "result", result: { status: "no_route" } });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(fetcher).toHaveBeenCalledTimes(1);
});
