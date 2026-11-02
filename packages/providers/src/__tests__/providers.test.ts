import { describe, expect, it } from "vitest";
import {
  FixtureMobilityProvider,
  createFixtureRouteRequest,
  selectedRouteToTravelLeg,
  unavailableRouteToTravelLeg,
  type FixtureRouteScenario,
  type PlaceSearchRequest,
  type PlaceSummary,
  type ProviderFailureCode,
  type RetryAdvice,
} from "../index";

// Expectations are hand-written from the S3.1 contract. They do not read a
// fixture-owned expected value or infer the answer from the provider output.
const RETRIEVED_AT = "2026-09-21T12:00:00+08:00";

function provider(routeScenario: FixtureRouteScenario = "success") {
  return new FixtureMobilityProvider({ now: () => RETRIEVED_AT, routeScenario });
}

function citySearch(query: string, limit = 10): PlaceSearchRequest {
  return { query, limit, scope: { kind: "city", cityAdcode: "000000" } };
}

describe("S3.1 provider contracts", () => {
  it("keeps successful empty search distinct from failure and preserves same-name branches", async () => {
    const found = await provider().searchPlaces(citySearch("下午馆"));
    expect(found.status).toBe("ok");
    if (found.status !== "ok") return;
    expect(found.data.items).toHaveLength(2);
    expect(found.data.items.map((item) => item.name)).toEqual(["虚构下午馆", "虚构下午馆"]);
    expect(new Set(found.data.items.map((item) => `${item.ref.provider}:${item.ref.externalId}`)).size).toBe(2);
    expect(found.data.items[0].address).not.toBe(found.data.items[1].address);
    expect(found.evidence).toMatchObject({
      provider: "tripquest-fixture",
      sourceKind: "fixture",
      retrievedAt: RETRIEVED_AT,
      datasetVersion: "s3.1-v1",
    });

    const limited = await provider().searchPlaces(citySearch("下午馆", 1));
    expect(limited.status).toBe("ok");
    if (limited.status === "ok") {
      expect(limited.data).toMatchObject({ truncated: true });
      expect(limited.data.items).toHaveLength(1);
    }

    const empty = await provider().searchPlaces(citySearch("不存在"));
    expect(empty.status).toBe("ok");
    if (empty.status === "ok") expect(empty.data).toEqual({ items: [], truncated: false });

    const invalid = await provider().searchPlaces(citySearch("", 0));
    expect(invalid.status).toBe("failure");
    if (invalid.status === "failure") {
      expect(invalid.failure).toMatchObject({ code: "invalid_request", retry: "never" });
    }
  });

  it.each([
    ["empty query", citySearch("   ")],
    ["limit below range", citySearch("下午馆", 0)],
    ["limit above range", citySearch("下午馆", 26)],
    ["invalid nearby center", {
      query: "下午馆",
      limit: 2,
      scope: {
        kind: "nearby",
        cityAdcode: "000000",
        center: { longitude: 181, latitude: 30, coordinateSystem: "gcj02" },
        radiusMeters: 1_000,
      },
    }],
    ["invalid nearby radius", {
      query: "下午馆",
      limit: 2,
      scope: {
        kind: "nearby",
        cityAdcode: "000000",
        center: { longitude: 120, latitude: 30, coordinateSystem: "gcj02" },
        radiusMeters: 0,
      },
    }],
  ] as const)("returns invalid_request for %s without throwing", async (_label, request) => {
    const result = await provider().searchPlaces(request as PlaceSearchRequest);
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.failure).toMatchObject({ code: "invalid_request", retry: "never" });
    }
  });

  it("requires an explicit selected route and rounds provider seconds upward", async () => {
    const request = createFixtureRouteRequest();
    const forty = await provider("success").findRoutes(request);
    const fortyOne = await provider("rounding_boundary").findRoutes(request);
    expect(forty.status).toBe("ok");
    expect(fortyOne.status).toBe("ok");
    if (forty.status !== "ok" || fortyOne.status !== "ok") return;

    expect(forty.routes[0]).toMatchObject({ mode: "walking", durationSeconds: 2400 });
    expect(selectedRouteToTravelLeg("P-C", "P-D", forty.routes[0])).toEqual({
      fromPlaceId: "P-C",
      toPlaceId: "P-D",
      duration: { kind: "known", minutes: 40 },
    });
    expect(selectedRouteToTravelLeg("P-C", "P-D", fortyOne.routes[0]).duration).toEqual({
      kind: "known",
      minutes: 41,
    });
  });

  it("maps no_route to an explicit unknown reason rather than known zero", async () => {
    const result = await provider("no_route").findRoutes(createFixtureRouteRequest());
    expect(result.status).toBe("no_route");
    if (result.status !== "no_route") return;
    expect(result.reason).toBe("no_path");
    expect(unavailableRouteToTravelLeg("P-C", "P-D", result)).toEqual({
      fromPlaceId: "P-C",
      toPlaceId: "P-D",
      duration: { kind: "unknown", reason: "provider:no_route:no_path" },
    });
  });

  it.each([
    ["timeout", "timeout", "after_backoff", undefined],
    ["upstream_unavailable", "upstream_unavailable", "after_backoff", undefined],
    ["rate_limited", "rate_limited", "after_backoff", 30],
    ["quota_exceeded", "quota_exceeded", "after_quota_reset", undefined],
    ["authorization_failed", "authorization_failed", "after_configuration_change", undefined],
  ] as const)(
    "classifies %s and keeps the domain duration unknown",
    async (scenario, code: ProviderFailureCode, retry: RetryAdvice, retryAfterSeconds) => {
      const result = await provider(scenario).findRoutes(createFixtureRouteRequest());
      expect(result.status).toBe("failure");
      if (result.status !== "failure") return;
      expect(result.failure).toMatchObject({ code, retry });
      expect(result.failure.retryAfterSeconds).toBe(retryAfterSeconds);
      expect(result.failure.safeMessage).not.toMatch(/key|P-C|P-D|116\.|39\./i);
      expect(unavailableRouteToTravelLeg("P-C", "P-D", result).duration).toEqual({
        kind: "unknown",
        reason: `provider:failure:${code}`,
      });
    },
  );

  it("accepts RFC 3339 Z and rejects timestamps without a time-zone offset", async () => {
    const request = createFixtureRouteRequest();
    const utc = await provider().findRoutes({ ...request, departureAt: "2026-09-21T04:00:00Z" });
    expect(utc.status).toBe("ok");

    const withoutOffset = await provider().findRoutes({
      ...request,
      departureAt: "2026-09-21T12:00:00",
    });
    expect(withoutOffset.status).toBe("failure");
    if (withoutOffset.status === "failure") {
      expect(withoutOffset.failure).toMatchObject({ code: "invalid_request", retry: "never" });
    }

    const utcClock = new FixtureMobilityProvider({
      now: () => "2026-09-21T04:00:00Z",
      routeScenario: "success",
    });
    const withUtcEvidence = await utcClock.findRoutes(request);
    expect(withUtcEvidence.evidence.retrievedAt).toBe("2026-09-21T04:00:00Z");
  });

  it("returns owned place, route and evidence objects on every call", async () => {
    const service = provider();
    const first = await service.searchPlaces(citySearch("下午馆"));
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    (first.data.items as PlaceSummary[]).push(first.data.items[0]);
    (first.data.items[0] as { name: string }).name = "被调用方修改";
    (first.evidence as { attribution: string }).attribution = "被调用方修改";

    const second = await service.searchPlaces(citySearch("下午馆"));
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.data.items).toHaveLength(2);
    expect(second.data.items[0].name).toBe("虚构下午馆");
    expect(second.evidence.attribution).toBe("TripQuest 手写虚构数据");

    const firstRoute = await service.findRoutes(createFixtureRouteRequest());
    expect(firstRoute.status).toBe("ok");
    if (firstRoute.status !== "ok") return;
    (firstRoute.routes[0] as { durationSeconds: number }).durationSeconds = 0;
    (firstRoute.evidence as { attribution: string }).attribution = "被调用方修改";
    const secondRoute = await service.findRoutes(createFixtureRouteRequest());
    expect(secondRoute.status).toBe("ok");
    if (secondRoute.status === "ok") {
      expect(secondRoute.routes[0].durationSeconds).toBe(2400);
      expect(secondRoute.evidence.attribution).toBe("TripQuest 手写虚构数据");
    }
  });
});
