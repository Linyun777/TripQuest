import { describe, expect, it, vi } from "vitest";
import type { PlaceSearchRequest, RouteRequest } from "../contracts";
import { PlanningFixtureProvider, planningFixturePlaces } from "../planning-fixture";
import { AmapMobilityProvider } from "../server/amap";

const now = "2026-10-08T03:00:00.000Z";
const center = { longitude: 120.1, latitude: 30.2, coordinateSystem: "gcj02" as const };
const nearby: PlaceSearchRequest = {
  query: "博物馆",
  scope: { kind: "nearby", cityAdcode: "330100", center, radiusMeters: 3000 },
  limit: 5,
};
const city: PlaceSearchRequest = {
  query: "博物馆",
  scope: { kind: "city", cityAdcode: "330100" },
  limit: 5,
};
const route: RouteRequest = {
  origin: { place: { provider: "amap", externalId: "B0ORIGIN" }, location: center },
  destination: {
    place: { provider: "amap", externalId: "B0DEST" },
    location: { ...center, longitude: 120.11 },
  },
  mode: "walking",
  departureAt: "2026-10-15T10:00:00+08:00",
  cityAdcode: "330100",
};

function amap(fetch: typeof globalThis.fetch, timeoutMs?: number) {
  return new AmapMobilityProvider({
    key: "synthetic-amap-key",
    fetch,
    now: () => now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function pois(entries: readonly [id: string, location: string, adcode?: string][]) {
  return new Response(
    JSON.stringify({
      status: "1",
      info: "OK",
      infocode: "10000",
      count: String(entries.length),
      pois: entries.map(([id, location, adcode = "330106"]) => ({
        id,
        name: `合成地点 ${id}`,
        adcode,
        location,
      })),
    }),
  );
}

describe("S5.2 provider extensions", () => {
  it("searches nearby through the around endpoint and keeps hits within the radius, in any city (V2.10)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      pois([
        ["NEAR", "120.101000,30.201000"],
        ["FAR", "120.140000,30.200000"],
        ["NINGBO", "120.100500,30.200500", "330200"],
      ]),
    );
    const reply = await amap(fetch).searchPlaces(nearby);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe("/v5/place/around");
    expect(Object.fromEntries(["location", "radius", "page_size", "city_limit"].map((name) => [
      name,
      url.searchParams.get(name),
    ]))).toEqual({
      location: "120.100000,30.200000",
      radius: "3000",
      page_size: "5",
      city_limit: null,
    });
    if (reply.status !== "ok") throw new Error(JSON.stringify(reply));
    // 附近搜索不限城市：旁边属于另一个城市的地点照样留下，超出半径的才剔除。
    expect(reply.data.items.map((item) => item.ref.externalId)).toEqual(["NEAR", "NINGBO"]);
    expect(reply.data.excludedCount).toBe(1);

    const broken = vi.fn<typeof globalThis.fetch>(async () =>
      pois([["NEAR", "120.101000,30.201000"], ["BAD", "not-a-point"]]),
    );
    expect(await amap(broken).searchPlaces(nearby)).toMatchObject({
      status: "failure",
      failure: { code: "malformed_response" },
    });

    const unused = vi.fn<typeof globalThis.fetch>();
    for (const request of [
      { ...nearby, scope: { ...nearby.scope, radiusMeters: 5000 } },
      { ...nearby, limit: 6 },
    ] as PlaceSearchRequest[]) {
      expect(await amap(unused).searchPlaces(request)).toMatchObject({
        failure: { code: "invalid_request" },
      });
    }
    expect(unused).not.toHaveBeenCalled();

    const text = vi.fn<typeof globalThis.fetch>(async () => pois([["CITY", "120.101000,30.201000"]]));
    await amap(text).searchPlaces(city);
    const cityUrl = new URL(String(text.mock.calls[0][0]));
    expect([cityUrl.pathname, cityUrl.searchParams.get("page_size")]).toEqual(["/v5/place/text", "6"]);
  });

  it("reports a caller abort as cancelled and its own deadline as timeout, even when fetch ignores signals", async () => {
    const never = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
    const before = new AbortController();
    before.abort();
    expect(await amap(never).searchPlaces(city, { signal: before.signal })).toMatchObject({
      failure: { code: "cancelled" },
    });
    expect(never).not.toHaveBeenCalled();

    const caller = new AbortController();
    const pending = amap(never).findRoutes(route, { signal: caller.signal });
    caller.abort();
    expect(await pending).toMatchObject({ status: "failure", failure: { code: "cancelled" } });

    expect(await amap(never, 20).searchPlaces(city)).toMatchObject({
      failure: { code: "timeout" },
    });
  });

  it("serves directional, non-zero fictional routes and refuses stale coordinates", async () => {
    const fixture = new PlanningFixtureProvider(() => Date.parse(now));
    const [start, museum] = planningFixturePlaces();
    const endpoint = (place: typeof start) => ({ place: place.ref, location: place.location });
    const leg = (from: typeof start, to: typeof start) =>
      fixture.findRoutes({ ...route, origin: endpoint(from), destination: endpoint(to) });

    const outbound = await leg(start, museum);
    const back = await leg(museum, start);
    const same = await leg(start, start);
    if (outbound.status !== "ok" || back.status !== "ok" || same.status !== "ok") {
      throw new Error("fixture route missing");
    }
    expect(outbound.routes[0].durationSeconds).not.toBe(back.routes[0].durationSeconds);
    expect(same.routes[0].durationSeconds).toBeGreaterThan(0);
    expect(outbound.evidence.datasetVersion).toBe("planning-fixture.v2");

    const moved = { ...start, location: { ...start.location, longitude: 121 } };
    expect(await leg(moved, museum)).toMatchObject({ failure: { code: "invalid_request" } });

    const close = await fixture.searchPlaces({
      ...nearby,
      query: "演示博物馆",
      scope: { kind: "nearby", cityAdcode: "330100", center: start.location, radiusMeters: 300 },
    });
    expect(close).toMatchObject({ status: "ok", data: { items: [], excludedCount: 2 } });

    const stop = new AbortController();
    stop.abort();
    expect(await fixture.findRoutes(route, { signal: stop.signal })).toMatchObject({
      failure: { code: "cancelled" },
    });
  });
});
