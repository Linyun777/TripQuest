import { describe, expect, it, vi } from "vitest";
import { AmapMobilityProvider } from "../server";
import { selectedRouteToTravelLeg, unavailableRouteToTravelLeg } from "../domain-mapper";
import type { PlaceSearchRequest, RouteRequest } from "../contracts";

// Entirely synthetic payloads: no captured API response or real POI.
const key = "synthetic-secret-canary";
const now = () => "2026-09-26T00:00:00Z";
const poi = (adcode = "330102", id = "SYNTHETIC-A") => ({ id, name: "合成同名地点", location: "120.000001,30.000001", adcode, citycode: "0571", cityname: "杭州市" });
const search: PlaceSearchRequest = { query: " 合成 &key=override ", limit: 1, scope: { kind: "city", cityAdcode: "330100" } };
const endpoint = { place: { provider: "amap", externalId: "SYNTHETIC-A" }, location: { longitude: 120.0000001, latitude: 30, coordinateSystem: "gcj02" as const } };
const route: RouteRequest = { origin: endpoint, destination: { ...endpoint, place: { provider: "amap", externalId: "SYNTHETIC-B" } }, cityAdcode: "330100", mode: "walking", departureAt: now() };
const success = <T extends object>(data: T) => ({ status: "1", infocode: "10000", ...data });
const make = (body: unknown, status = 200, headers = {}) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { status, headers }));
  return { fetcher, provider: new AmapMobilityProvider({ key, fetch: fetcher, now }) };
};
const path = (duration: unknown = "61", distance: unknown = "80") => success({ route: { paths: [{ distance, cost: { duration } }] } });

describe("V2.4 business facts for candidates", () => {
  it("asks for business facts only when requested, keeps the few we show, and drops the rest", async () => {
    const business = { rating: "4.6", cost: "120.00", keytag: "火锅", opentime_today: "10:00-21:00", tel: "0571-00000000", tag: "双人餐" };
    const asked = make(success({ count: "1", pois: [{ ...poi(), business }] }));
    const result = await asked.provider.searchPlaces({ ...search, withBusiness: true });
    expect(new URL(String(asked.fetcher.mock.calls[0][0])).searchParams.get("show_fields")).toBe("business");
    expect(result).toMatchObject({ status: "ok", data: { items: [{ business: { rating: 4.6, costYuan: 120, keytag: "火锅", openToday: "10:00-21:00" } }] } });
    if (result.status !== "ok") throw new Error("search");
    expect(JSON.stringify(result.data.items[0])).not.toContain("0571-00000000");
    // Not asked: no field requested and nothing attached, so planning stays as before.
    const plain = make(success({ count: "1", pois: [{ ...poi(), business }] }));
    const quiet = await plain.provider.searchPlaces(search);
    expect(new URL(String(plain.fetcher.mock.calls[0][0])).searchParams.has("show_fields")).toBe(false);
    expect(quiet.status === "ok" && quiet.data.items[0]).not.toHaveProperty("business");
    // Odd values are left out rather than shown.
    const odd = make(success({ count: "1", pois: [{ ...poi(), business: { rating: "9.9", cost: "[]", keytag: "", opentime_today: "<b>" } }] }));
    const cleaned = await odd.provider.searchPlaces({ ...search, withBusiness: true });
    expect(cleaned.status === "ok" && cleaned.data.items[0]).not.toHaveProperty("business");
  });
});

describe("Amap offline mapping", () => {
  it("constrains host/query, one request, trims and encodes keyword; same names remain distinct", async () => {
    const { provider, fetcher } = make(success({ count: "2", pois: [poi(), poi("330113", "SYNTHETIC-B")] }));
    const result = await provider.searchPlaces(search);
    expect(result).toMatchObject({ status: "ok", data: { truncated: true, items: [{ ref: { externalId: "SYNTHETIC-A" }, cityAdcode: "330100" }] }, evidence: { sourceKind: "live", retrievedAt: now() } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://restapi.amap.com/v5/place/text");
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({ key, keywords: search.query.trim(), region: "330100", city_limit: "true", page_size: "2", page_num: "1" });
    expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each(["330100", "330105", "330106", "330108", "330109", "330110", "330111", "330112", "330113", "330114", "330122", "330127", "330182"])("maps verified Hangzhou code %s", async (code) => {
    expect(await make(success({ count: "1", pois: [poi(code)] })).provider.searchPlaces(search)).toMatchObject({ status: "ok", data: { items: [{ cityAdcode: "330100" }] } });
  });
  it("deduplicates IDs, preserves valid empty results, count means page size", async () => {
    expect(await make(success({ count: "2", pois: [poi(), poi()] })).provider.searchPlaces(search)).toMatchObject({ status: "ok", data: { truncated: false, items: [expect.any(Object)] } });
    expect(await make(success({ count: "0", pois: [] })).provider.searchPlaces(search)).toMatchObject({ status: "ok", data: { items: [], truncated: false } });
    expect(await make(success({ count: "100", pois: [] })).provider.searchPlaces(search)).toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
  });
  it("V2.10: a city search keeps to that city (other cities are counted out); any city's district maps to its city", async () => {
    const mixed = await make(success({ count: "2", pois: [poi(), { ...poi("330212", "SYNTHETIC-NB"), citycode: "0574", cityname: "宁波市" }] })).provider
      .searchPlaces({ ...search, limit: 5 });
    expect(mixed).toMatchObject({ status: "ok", data: { items: [{ ref: { externalId: "SYNTHETIC-A" } }], excludedCount: 1 } });
    const chengdu = make(success({ count: "1", pois: [{ ...poi("510104"), citycode: "028", cityname: "成都市" }] }));
    expect(await chengdu.provider.searchPlaces({ ...search, scope: { kind: "city", cityAdcode: "510100" } }))
      .toMatchObject({ status: "ok", data: { items: [{ cityAdcode: "510100" }] } });
    expect(new URL(String(chengdu.fetcher.mock.calls[0][0])).searchParams.get("region")).toBe("510100");
    // 直辖市按前两位，省直辖县级市保留完整编码；全国搜索不带 region。
    expect(await make(success({ count: "1", pois: [{ ...poi("110108"), citycode: "010", cityname: "北京市" }] })).provider
      .searchPlaces({ ...search, scope: { kind: "country" } })).toMatchObject({ status: "ok", data: { items: [{ cityAdcode: "110000" }] } });
    const country = make(success({ count: "1", pois: [{ ...poi("429004"), citycode: "0728", cityname: "仙桃市" }] }));
    expect(await country.provider.searchPlaces({ ...search, scope: { kind: "country" } })).toMatchObject({ status: "ok", data: { items: [{ cityAdcode: "429004" }] } });
    expect(new URL(String(country.fetcher.mock.calls[0][0])).searchParams.has("region")).toBe(false);
  });
  it.each([{ adcode: "33010" }, { pcode: "310000" }, { id: "" }, { location: "" }, { location: "181,30" }, { location: "120,NaN" }, { name: "" }])("rejects invalid POI instead of success empty %j", async (change) => {
    expect(await make(success({ count: "1", pois: [{ ...poi(), ...change }] })).provider.searchPlaces(search)).toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
  });
  it.each([{ query: " " }, { query: "a".repeat(81) }, { limit: 0 }, { limit: 11 }, { scope: { kind: "city", cityAdcode: "3302" } }, { scope: { kind: "nearby", cityAdcode: "330100" } }, { scope: { kind: "region" } }])("invalid search sends zero requests %j", async (change) => {
    const { provider, fetcher } = make({});
    expect(await provider.searchPlaces({ ...search, ...change } as PlaceSearchRequest)).toMatchObject({ status: "failure", failure: { code: "invalid_request", retry: "never" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("asks for cost and POI IDs, does not send departure prediction, explicit selection rounds up", async () => {
    const { provider, fetcher } = make(path());
    const result = await provider.findRoutes(route);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(selectedRouteToTravelLeg("a", "b", result.routes[0]).duration).toEqual({ kind: "known", minutes: 2 });
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(Object.fromEntries(params)).toEqual({ key, output: "json", origin: "120.000000,30.000000", destination: "120.000000,30.000000", origin_id: "SYNTHETIC-A", destination_id: "SYNTHETIC-B", show_fields: "cost,polyline", alternative_route: "1" });
  });
  it.each(["0", "60", "61"])("accepts strict nonnegative integer %s", async (duration) => {
    expect(await make(path(duration)).provider.findRoutes(route)).toMatchObject({ status: "ok", routes: [{ durationSeconds: Number(duration) }] });
  });
  it.each(["", " ", "-1", "1.5", "1e3", "NaN", "Infinity", "9007199254740992", 0, null, undefined])("rejects duration and distance %j", async (bad) => {
    for (const body of [path(bad), path("60", bad)]) {
      // Explicit undefined must omit the field, rather than the helper's default.
      if (bad === undefined) body.route.paths[0].cost = {} as { duration: unknown };
      const result = await make(body).provider.findRoutes(route);
      expect(result).toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
      if (result.status !== "ok") expect(unavailableRouteToTravelLeg("a", "b", result).duration.kind).toBe("unknown");
    }
  });
  it("separates empty path, malformed structure and unsupported mode", async () => {
    expect(await make(success({ route: { paths: [] } })).provider.findRoutes(route)).toMatchObject({ status: "no_route", reason: "no_path" });
    for (const body of [success({}), success({ route: {} }), success({ route: { paths: [{ distance: "20", steps: [{ duration: "60" }] }] } })]) expect(await make(body).provider.findRoutes(route)).toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
    const { provider, fetcher } = make({});
    expect(await provider.findRoutes({ ...route, mode: "boat" as never })).toMatchObject({ status: "failure", failure: { code: "invalid_request" } });
    expect(await provider.findRoutes({ ...route, origin: { ...endpoint, place: { provider: "fixture", externalId: "A" } } })).toMatchObject({ status: "failure", failure: { code: "invalid_request" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([["10001", "authorization_failed", "after_configuration_change"], ["10002", "authorization_failed", "after_configuration_change"], ["10003", "quota_exceeded", "after_quota_reset"], ["10004", "rate_limited", "after_backoff"], ["10009", "authorization_failed", "after_configuration_change"], ["10016", "upstream_unavailable", "after_backoff"], ["20000", "invalid_request", "never"], ["10021", "rate_limited", "after_backoff"], ["20003", "unknown", "after_backoff"], ["40000", "quota_exceeded", "after_configuration_change"], ["99999", "unknown", "after_backoff"]])("normalizes business code %s", async (infocode, code, retry) => {
    const result = await make({ status: "0", infocode, info: key }).provider.findRoutes(route);
    expect(result).toMatchObject({ status: "failure", failure: { code, retry } });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([[429, "rate_limited"], [503, "upstream_unavailable"], [401, "authorization_failed"], [302, "unknown"]])("normalizes HTTP %s without echoing body", async (status, code) => {
    expect(await make(key, Number(status), { "retry-after": "12" }).provider.findRoutes(route)).toMatchObject({ status: "failure", failure: { code, retryAfterSeconds: 12 } });
  });
  it("missing Key makes no request; unbounded Retry-After ignored", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await new AmapMobilityProvider({ key: "", fetch: fetcher, now }).searchPlaces(search)).toMatchObject({ status: "failure", failure: { code: "authorization_failed" } });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await make({}, 429, { "retry-after": "999999" }).provider.findRoutes(route);
    expect(result.status === "failure" && result.failure.retryAfterSeconds).toBeUndefined();
  });
  it("aborts an actual pending request once, sanitizes errors, never logs", async () => {
    const log = vi.spyOn(console, "error");
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new Error(key)));
    }));
    const result = await new AmapMobilityProvider({ key, fetch: fetcher, now, timeoutMs: 10 }).findRoutes(route);
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: "failure", failure: { code: "timeout" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
  it("bounds body, rejects JSON and status anomalies; network errors are sanitized", async () => {
    for (const raw of ["not json", "x".repeat(1_048_577), JSON.stringify({ status: "1", infocode: "10001" }), JSON.stringify({ status: 1, infocode: "10000" })]) {
      const provider = new AmapMobilityProvider({ key, now, fetch: async () => new Response(raw) });
      expect(await provider.findRoutes(route)).toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
    }
    const result = await new AmapMobilityProvider({ key, now, fetch: async () => { throw new Error(key); } }).findRoutes(route);
    expect(result).toMatchObject({ status: "failure", failure: { code: "upstream_unavailable" } });
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe("Amap lookup by ID (S5.5)", () => {
  it("joins IDs into one detail request and reports IDs the provider no longer knows", async () => {
    const { provider, fetcher } = make(success({ count: "1", pois: [poi()] }));
    const result = await provider.findPlacesById(["SYNTHETIC-A", "SYNTHETIC-GONE"]);
    expect(result).toMatchObject({
      status: "ok",
      data: { items: [{ ref: { provider: "amap", externalId: "SYNTHETIC-A" } }], missing: ["SYNTHETIC-GONE"] },
    });
    const parsed = new URL(String(fetcher.mock.calls[0][0]));
    expect(parsed.pathname).toBe("/v5/place/detail");
    expect(parsed.searchParams.get("id")).toBe("SYNTHETIC-A|SYNTHETIC-GONE");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each([[[]], [Array.from({ length: 11 }, (_, i) => `SYNTHETIC-${i}`)], [["SYNTHETIC-A", "SYNTHETIC-A"]], [["bad id|x"]]])(
    "rejects invalid ID lists without a request %#",
    async (ids) => {
      const { provider, fetcher } = make({});
      expect(await provider.findPlacesById(ids)).toMatchObject({ status: "failure", failure: { code: "invalid_request" } });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("treats an unrequested or invalid POI as a malformed response", async () => {
    expect(await make(success({ count: "1", pois: [poi("330102", "SYNTHETIC-OTHER")] })).provider.findPlacesById(["SYNTHETIC-A"]))
      .toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
    expect(await make(success({ count: "1", pois: [{ ...poi(), location: "" }] })).provider.findPlacesById(["SYNTHETIC-A"]))
      .toMatchObject({ status: "failure", failure: { code: "malformed_response" } });
  });
});

describe("Amap weather forecast (V2.1)", () => {
  // Shape copied from a 2026-10-13 live reply; values are synthetic.
  const cast = (date: string, day: string, night = "多云") => ({
    date, week: "3", dayweather: day, nightweather: night, daytemp: "26", nighttemp: "17",
    daywind: "东", nightwind: "东", daypower: "1-3", nightpower: "1-3", daytemp_float: "26.0", nighttemp_float: "17.0",
  });
  const forecast = (casts: unknown[]) => success({
    count: "1",
    forecasts: [{ city: "杭州市", adcode: "330100", province: "浙江", reporttime: "2026-10-13 21:02:21", casts }],
  });

  it("maps the city forecast and marks rain, snow or hail as wet", async () => {
    const { provider, fetcher } = make(forecast([cast("2026-10-14", "晴"), cast("2026-10-15", "小雨", "中雨")]));
    const result = await provider.getWeatherForecast("330100");
    expect(result).toMatchObject({
      status: "ok",
      data: {
        reportedAt: "2026-10-13T21:02:21+08:00",
        days: [
          { date: "2026-10-14", dayWeather: "晴", highCelsius: 26, lowCelsius: 17, wet: false },
          { date: "2026-10-15", dayWeather: "小雨", nightWeather: "中雨", wet: true },
        ],
      },
    });
    const parsed = new URL(String(fetcher.mock.calls[0][0]));
    expect(parsed.pathname).toBe("/v3/weather/weatherInfo");
    expect(parsed.searchParams.get("extensions")).toBe("all");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("refuses a malformed city code without a request and treats broken casts as malformed (V2.10: any city)", async () => {
    const other = make({});
    expect(await other.provider.getWeatherForecast("3101")).toMatchObject({ failure: { code: "invalid_request" } });
    expect(other.fetcher).not.toHaveBeenCalled();
    expect(await make(forecast([{ ...cast("2026-10-14", "晴"), daytemp: "热", daytemp_float: "热" }])).provider
      .getWeatherForecast("330100")).toMatchObject({ failure: { code: "malformed_response" } });
  });
});

describe("Amap weather now (V2.6)", () => {
  // Shape of Amap's `extensions=base` reply (to be rechecked live); values are synthetic.
  const lives = (weather: string, extra: Record<string, unknown> = {}) => success({
    count: "1",
    lives: [{ province: "浙江", city: "杭州市", adcode: "330100", weather, temperature: "23", winddirection: "东", windpower: "≤3", humidity: "80", reporttime: "2026-10-18 17:02:43", ...extra }],
  });

  it("keeps only the weather words and the report time", async () => {
    const { provider, fetcher } = make(lives("小雨"));
    const result = await provider.getLiveWeather("330100");
    expect(result).toEqual({
      status: "ok",
      data: { cityAdcode: "330100", weather: "小雨", reportedAt: "2026-10-18T17:02:43+08:00" },
      evidence: expect.anything(),
    });
    const parsed = new URL(String(fetcher.mock.calls[0][0]));
    expect(parsed.searchParams.get("extensions")).toBe("base");
    expect(await make(lives("<b>x</b>")).provider.getLiveWeather("330100")).toMatchObject({ failure: { code: "malformed_response" } });
    expect(await make(lives("晴", { adcode: "310100" })).provider.getLiveWeather("330100")).toMatchObject({ failure: { code: "malformed_response" } });
  });
});

describe("Amap transit, taxi, cycling and nearest place (V2.2)", () => {
  // Shapes copied from 2026-10-14 live replies; values are synthetic.
  it("takes the first transit with a line: fare, line names, walking and a polyline", async () => {
    // V2.10：先用行政区查询把城市编码换成高德城市代码（每个城市一次），再查公交。
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ districts: [{ adcode: "330100", name: "杭州市", level: "city", citycode: "0571" }] }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
      route: {
        cost: { taxi_fee: "31" },
        transits: [
          { cost: { duration: "900" }, distance: "800", segments: [{ walking: { steps: [] } }] },
          {
            cost: { duration: "4266", transit_fee: "5.0" },
            distance: "9850",
            walking_distance: "1784",
            segments: [
              { walking: { steps: [{ polyline: { polyline: "120.1,30.2;120.11,30.21" } }] } },
              { bus: { buslines: [{ name: "地铁3号线(星桥--石马)", type: "地铁线路", polyline: { polyline: "120.11,30.21;120.2,30.3" } }] } },
            ],
          },
        ],
      },
    }))));
    const provider = new AmapMobilityProvider({ key, fetch: fetcher, now });
    const result = await provider.findRoutes({ ...route, mode: "transit" });
    expect(result).toMatchObject({
      status: "ok",
      routes: [{ mode: "transit", durationSeconds: 4266, distanceMeters: 9850, fareYuan: 5, summary: "地铁3号线", walkingMeters: 1784 }],
    });
    if (result.status === "ok") expect(result.routes[0].path).toHaveLength(4);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/v3/config/district");
    const params = new URL(String(fetcher.mock.calls[1][0])).searchParams;
    expect([params.get("city1"), params.get("city2")]).toEqual(["0571", "0571"]);
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe("/v5/direction/transit/integrated");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("prices a taxi from the driving route; driving itself carries no fare", async () => {
    const body = success({ route: { taxi_cost: "25", paths: [{ distance: "8000", cost: { duration: "2370" }, steps: [{ polyline: "120.1,30.2;120.2,30.3" }] }] } });
    expect(await make(body).provider.findRoutes({ ...route, mode: "taxi" })).toMatchObject({
      status: "ok", routes: [{ mode: "taxi", durationSeconds: 2370, fareYuan: 25 }],
    });
    const driving = await make(body).provider.findRoutes({ ...route, mode: "driving" });
    expect(driving).toMatchObject({ status: "ok", routes: [{ mode: "driving" }] });
    if (driving.status === "ok") expect(driving.routes[0].fareYuan).toBeUndefined();
  });

  it("reads cycling duration from the path and reports no transit as no route", async () => {
    expect(await make(success({ route: { paths: [{ distance: "8479", duration: "2926", steps: [] }] } })).provider
      .findRoutes({ ...route, mode: "bicycling" })).toMatchObject({ status: "ok", routes: [{ mode: "bicycling", durationSeconds: 2926 }] });
    const noTransit = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ districts: [{ adcode: "330100", name: "杭州市", level: "city", citycode: "0571" }] }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ route: { transits: [] } }))));
    expect(await new AmapMobilityProvider({ key, fetch: noTransit, now }).findRoutes({ ...route, mode: "transit" }))
      .toMatchObject({ status: "no_route", reason: "no_path" });
  });

  it("snaps a device point to the nearest place with its city, in any city, and never echoes the point", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ locations: "120.163000,30.274000" }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
        regeocode: {
          addressComponent: { adcode: "330106", city: "杭州市", province: "浙江省", district: "西湖区" },
          pois: [
            { id: "SYNTHETIC-FAR", name: "合成远处", location: "120.1,30.2", distance: "320" },
            // Nearer, but a bank makes a poor "where I am"; the station 40 m on wins.
            { id: "SYNTHETIC-BANK", name: "合成银行", location: "120.163,30.274", distance: "12", type: "金融保险服务;银行;银行" },
            { id: "SYNTHETIC-NEAR", name: "合成地铁站", location: "120.163,30.274", distance: "41.5", type: "交通设施服务;地铁站;地铁站" },
          ],
        },
      }))));
    const provider = new AmapMobilityProvider({ key, fetch: fetcher, now });
    const result = await provider.nearestPlace({ longitude: 120.158123, latitude: 30.276456 });
    expect(result).toMatchObject({
      status: "ok",
      data: { place: { ref: { externalId: "SYNTHETIC-NEAR" }, name: "合成地铁站" }, distanceMeters: 42, city: { adcode: "330100", name: "杭州市" } },
    });
    expect(JSON.stringify(result)).not.toContain("120.158123");
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("coordsys")).toBe("gps");

    // The compound the point stands in names it better than any single POI.
    const inArea = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ locations: "120.163000,30.274000" }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
        regeocode: {
          addressComponent: { adcode: "330106", city: "杭州市", province: "浙江省", district: "西湖区" },
          aois: [{ id: "SYNTHETIC-AOI", name: "合成小区", location: "120.163,30.274", adcode: "330106", distance: "0", area: "5000", type: "120302" }],
          pois: [{ id: "SYNTHETIC-NEAR", name: "合成地铁站", location: "120.163,30.274", distance: "41.5", type: "交通设施服务;地铁站;地铁站" }],
        },
      }))));
    expect(await new AmapMobilityProvider({ key, fetch: inArea, now }).nearestPlace({ longitude: 120.158123, latitude: 30.276456 }))
      .toMatchObject({ status: "ok", data: { place: { ref: { externalId: "SYNTHETIC-AOI" }, name: "合成小区" }, distanceMeters: 0 } });

    // 直辖市的 city 字段为空（高德返回空数组），用省名；城市编码按前两位。
    const shanghai = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ locations: "121.4,31.2" }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
        regeocode: {
          addressComponent: { adcode: "310101", city: [], province: "上海市", district: "黄浦区" },
          pois: [{ id: "SYNTHETIC-SH", name: "合成外滩", location: "121.4,31.2", distance: "30" }],
        },
      }))));
    expect(await new AmapMobilityProvider({ key, fetch: shanghai, now }).nearestPlace({ longitude: 121.4, latitude: 31.2 }))
      .toMatchObject({ status: "ok", data: { place: { cityAdcode: "310000" }, city: { adcode: "310000", name: "上海市" } } });
  });

  it("resolves a city name: cities and municipalities only, not districts or towns (V2.10)", async () => {
    const reply = (districts: unknown[]) => make(success({ districts })).provider;
    expect(await reply([{ adcode: "510100", name: "成都市", level: "city", citycode: "028" }]).resolveCity("成都"))
      .toMatchObject({ status: "ok", data: { adcode: "510100", name: "成都市" } });
    expect(await reply([{ adcode: "110000", name: "北京市", level: "province", citycode: "010" }]).resolveCity("北京"))
      .toMatchObject({ status: "ok", data: { adcode: "110000", name: "北京市" } });
    expect(await reply([{ adcode: "330106", name: "西湖区", level: "district", citycode: "0571" }]).resolveCity("西湖区"))
      .toMatchObject({ status: "failure", failure: { code: "invalid_request" } });
    expect(await reply([]).resolveCity("乌镇")).toMatchObject({ status: "failure", failure: { code: "invalid_request" } });
  });
});
