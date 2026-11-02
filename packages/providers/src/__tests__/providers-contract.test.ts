import { describe, expect, it } from "vitest";
import {
  FixtureMobilityProvider,
  createFixtureRouteRequest,
  selectedRouteToTravelLeg,
  unavailableRouteToTravelLeg,
  type FixtureRouteScenario,
  type MobilityProvider,
  type NoRouteReason,
  type PlaceSearchData,
  type PlaceSearchRequest,
  type PlaceSummary,
  type ProviderEvidence,
  type ProviderFailureCode,
  type ProviderResult,
  type RetryAdvice,
  type RouteOption,
  type RouteResult,
  type UnavailableRouteResult,
} from "../index";

// Expectations in this file are derived by hand from the S3.1 design contract
// (rounding, non-success routes, retry table, request validation, object
// ownership). Nothing is read back from the fixture's own output.
const CLOCK = "2026-09-21T12:00:00+08:00";

const EVIDENCE: ProviderEvidence = {
  provider: "independent-test",
  sourceKind: "live",
  retrievedAt: CLOCK,
  attribution: "独立测试构造",
};

function provider(
  routeScenario: FixtureRouteScenario = "success",
  now: () => string = () => CLOCK,
): FixtureMobilityProvider {
  return new FixtureMobilityProvider({ now, routeScenario });
}

function citySearch(query: string, limit = 10): PlaceSearchRequest {
  return { query, limit, scope: { kind: "city", cityAdcode: "000000" } };
}

function nearbySearch(overrides: {
  readonly center?: unknown;
  readonly radiusMeters?: number;
}): unknown {
  return {
    query: "下午馆",
    limit: 2,
    scope: {
      kind: "nearby",
      cityAdcode: "000000",
      center: overrides.center ?? { longitude: 116, latitude: 39.9, coordinateSystem: "gcj02" },
      radiusMeters: overrides.radiusMeters ?? 1_000,
    },
  };
}

function routeOption(durationSeconds: number): RouteOption {
  return { mode: "walking", durationSeconds, distanceMeters: 3_200 };
}

function noRouteResult(reason: NoRouteReason): UnavailableRouteResult {
  return { status: "no_route", reason, evidence: { ...EVIDENCE } };
}

function failureResult(code: ProviderFailureCode): UnavailableRouteResult {
  return {
    status: "failure",
    failure: { code, retry: "never", safeMessage: "独立测试构造" },
    evidence: { ...EVIDENCE },
  };
}

const NO_ROUTE_REASONS: readonly NoRouteReason[] = [
  "no_path",
  "origin_unmatched",
  "destination_unmatched",
  "distance_limit",
  "unsupported_mode",
];

const FAILURE_CODES: readonly ProviderFailureCode[] = [
  "invalid_request",
  "authorization_failed",
  "quota_exceeded",
  "rate_limited",
  "timeout",
  "upstream_unavailable",
  "malformed_response",
  "cancelled",
  "unknown",
];

describe("S3.1 provider contract", () => {
  it("rounds provider seconds upward for the route the caller selected", () => {
    const table: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 1],
      [59, 1],
      [60, 1],
      [61, 2],
      [119, 2],
      [120, 2],
      [121, 3],
      [2400, 40],
      [2401, 41],
      [3600, 60],
      [86399, 1440],
    ];
    for (const [seconds, minutes] of table) {
      expect(
        selectedRouteToTravelLeg("P-C", "P-D", routeOption(seconds)).duration,
        `${seconds} seconds`,
      ).toEqual({ kind: "known", minutes });
    }

    // Two options in one result: the mapper must follow the caller's choice,
    // never silently take routes[0].
    const twoRoutes: RouteResult = {
      status: "ok",
      routes: [routeOption(2400), routeOption(2401)],
      evidence: { ...EVIDENCE },
    };
    expect(twoRoutes.status, "fixture for this case").toBe("ok");
    if (twoRoutes.status !== "ok") return;
    expect(selectedRouteToTravelLeg("P-C", "P-D", twoRoutes.routes[0]).duration, "first option").toEqual({
      kind: "known",
      minutes: 40,
    });
    expect(selectedRouteToTravelLeg("P-C", "P-D", twoRoutes.routes[1]).duration, "second option").toEqual({
      kind: "known",
      minutes: 41,
    });
  });

  it("never turns a non-success route into a known zero", () => {
    for (const reason of NO_ROUTE_REASONS) {
      const leg = unavailableRouteToTravelLeg("P-C", "P-D", noRouteResult(reason));
      expect(leg.duration, `no_route ${reason}`).toEqual({
        kind: "unknown",
        reason: `provider:no_route:${reason}`,
      });
    }
    for (const code of FAILURE_CODES) {
      const leg = unavailableRouteToTravelLeg("P-C", "P-D", failureResult(code));
      expect(leg.duration, `failure ${code}`).toEqual({
        kind: "unknown",
        reason: `provider:failure:${code}`,
      });
    }
    // The only way to a known duration is an explicitly selected successful route.
    expect(selectedRouteToTravelLeg("P-C", "P-D", routeOption(2400)).duration, "selected ok route").toEqual({
      kind: "known",
      minutes: 40,
    });
  });

  it("rejects a route option that violates the published numeric contract", () => {
    const invalid: ReadonlyArray<readonly [string, number]> = [
      ["negative", -1],
      ["fractional", 12.5],
      ["not a number", Number.NaN],
      ["infinite", Number.POSITIVE_INFINITY],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ];
    for (const [label, seconds] of invalid) {
      expect(() => selectedRouteToTravelLeg("P-C", "P-D", routeOption(seconds)), label).toThrow(RangeError);
    }

    for (const [label, placeId] of [["empty", ""], ["blank", "   "]] as const) {
      expect(() => selectedRouteToTravelLeg(placeId, "P-D", routeOption(2400)), `${label} origin`).toThrow(TypeError);
      expect(() => selectedRouteToTravelLeg("P-C", placeId, routeOption(2400)), `${label} destination`).toThrow(TypeError);
    }

    // A successful zero-second route is a legitimate known zero; the ban only
    // covers no_route and failures.
    expect(selectedRouteToTravelLeg("P-C", "P-C", routeOption(0)).duration, "explicit zero").toEqual({
      kind: "known",
      minutes: 0,
    });
  });

  it("derives the retry action from the failure code for every declared code", async () => {
    const table: ReadonlyArray<readonly [ProviderFailureCode, RetryAdvice, number | undefined]> = [
      ["invalid_request", "never", undefined],
      ["cancelled", "never", undefined],
      ["timeout", "after_backoff", undefined],
      ["upstream_unavailable", "after_backoff", undefined],
      ["rate_limited", "after_backoff", 30],
      ["malformed_response", "after_backoff", undefined],
      ["unknown", "after_backoff", undefined],
      ["quota_exceeded", "after_quota_reset", undefined],
      ["authorization_failed", "after_configuration_change", undefined],
    ];

    for (const [code, retry, retryAfterSeconds] of table) {
      // The scenario option only advertises the failure codes the lab exposes;
      // the remaining declared codes are forced in to reach the retry table.
      const result = await provider(code as unknown as FixtureRouteScenario).findRoutes(
        createFixtureRouteRequest(),
      );
      expect(result.status, `${code} status`).toBe("failure");
      if (result.status !== "failure") continue;
      expect(result.failure.code, `${code} code`).toBe(code);
      expect(result.failure.retry, `${code} retry`).toBe(retry);
      expect(result.failure.retryAfterSeconds, `${code} retryAfterSeconds`).toBe(retryAfterSeconds);
      expect(unavailableRouteToTravelLeg("P-C", "P-D", result).duration, `${code} leg`).toEqual({
        kind: "unknown",
        reason: `provider:failure:${code}`,
      });
    }
  });

  it("classifies every malformed place request as invalid_request without throwing", async () => {
    const eighty = "下".repeat(80);
    const accepted: ReadonlyArray<readonly [string, unknown]> = [
      ["one character", citySearch("下")],
      ["eighty characters", citySearch(eighty)],
      ["limit 1", citySearch("下午馆", 1)],
      ["limit 25", citySearch("下午馆", 25)],
      ["nearby radius 1", nearbySearch({ radiusMeters: 1 })],
    ];
    const rejected: ReadonlyArray<readonly [string, unknown]> = [
      ["empty query", citySearch("")],
      ["blank query", citySearch("   ")],
      ["eighty-one characters", citySearch("下".repeat(81))],
      ["limit 0", citySearch("下午馆", 0)],
      ["limit 26", citySearch("下午馆", 26)],
      ["fractional limit", citySearch("下午馆", 2.5)],
      ["short adcode", { query: "下午馆", limit: 2, scope: { kind: "city", cityAdcode: "00000" } }],
      ["long adcode", { query: "下午馆", limit: 2, scope: { kind: "city", cityAdcode: "0000000" } }],
      ["non numeric adcode", { query: "下午馆", limit: 2, scope: { kind: "city", cityAdcode: "abcdef" } }],
      ["unknown scope kind", { query: "下午馆", limit: 2, scope: { kind: "region", cityAdcode: "000000" } }],
      ["longitude 181", nearbySearch({ center: { longitude: 181, latitude: 39.9, coordinateSystem: "gcj02" } })],
      ["latitude 91", nearbySearch({ center: { longitude: 116, latitude: 91, coordinateSystem: "gcj02" } })],
      ["wrong coordinate system", nearbySearch({ center: { longitude: 116, latitude: 39.9, coordinateSystem: "wgs84" } })],
      ["zero radius", nearbySearch({ radiusMeters: 0 })],
      ["negative radius", nearbySearch({ radiusMeters: -1 })],
    ];

    for (const [label, request] of accepted) {
      const result = await provider().searchPlaces(request as PlaceSearchRequest);
      expect(result.status, `${label} accepted`).toBe("ok");
    }
    for (const [label, request] of rejected) {
      const result = await provider().searchPlaces(request as PlaceSearchRequest);
      expect(result.status, `${label} rejected`).toBe("failure");
      if (result.status !== "failure") continue;
      expect(result.failure, `${label} classification`).toMatchObject({
        code: "invalid_request",
        retry: "never",
      });
    }
  });

  it("reports truncation against the requested limit without exceeding it", async () => {
    const table: ReadonlyArray<readonly [number, number, boolean]> = [
      [1, 1, true],
      [2, 2, false],
      [25, 2, false],
    ];
    for (const [limit, count, truncated] of table) {
      const result = await provider().searchPlaces(citySearch("下午馆", limit));
      expect(result.status, `limit ${limit} status`).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.data.items.length, `limit ${limit} count`).toBe(count);
      expect(result.data.items.length <= limit, `limit ${limit} bound`).toBe(true);
      expect(result.data.truncated, `limit ${limit} truncated`).toBe(truncated);
    }
  });

  it("accepts only offset-qualified departure timestamps", async () => {
    const request = createFixtureRouteRequest();
    const accepted: readonly string[] = [
      "2026-09-21T12:00:00+08:00",
      "2026-09-21T12:00:00-08:00",
      "2026-09-21T12:00:00.500+08:00",
      "2026-09-21T12:00:00+14:00",
      "2024-02-29T12:00:00+08:00",
    ];
    const rejected: readonly string[] = [
      "2026-09-21T12:00:00",
      "2026-09-21T12:00:00+0800",
      "2026-09-21T12:00:00+14:30",
      "2026-09-21T24:00:00+08:00",
      "2026-02-29T12:00:00+08:00",
      "2026-13-01T12:00:00+08:00",
      "2026-09-21 12:00:00+08:00",
    ];

    for (const departureAt of accepted) {
      const result = await provider("success").findRoutes({ ...request, departureAt });
      expect(result.status, `accepted ${departureAt}`).toBe("ok");
    }
    for (const departureAt of rejected) {
      const result = await provider("success").findRoutes({ ...request, departureAt });
      expect(result.status, `rejected ${departureAt}`).toBe("failure");
      if (result.status !== "failure") continue;
      expect(result.failure, `classification ${departureAt}`).toMatchObject({
        code: "invalid_request",
        retry: "never",
      });
    }
  });

  it("keeps a successful empty search structurally distinct from a failure", async () => {
    const empty = await provider().searchPlaces(citySearch("不存在"));
    const broken = await provider().searchPlaces(citySearch(""));

    expect(empty.status, "empty status").toBe("ok");
    expect(broken.status, "broken status").toBe("failure");
    expect("data" in empty, "ok carries data").toBe(true);
    expect("failure" in empty, "ok carries no failure").toBe(false);
    expect("failure" in broken, "failure carries failure").toBe(true);
    expect("data" in broken, "failure carries no data").toBe(false);

    if (empty.status === "ok") {
      expect(empty.data.items, "empty ok is a real empty array").toEqual([]);
      expect(empty.data.truncated, "empty ok is not truncated").toBe(false);
    }
    if (broken.status === "failure") {
      expect(broken.failure.code, "broken code").toBe("invalid_request");
    }
    // Evidence must be present on both branches so callers can always show origin and time.
    expect(empty.evidence.retrievedAt, "ok evidence").toBe(CLOCK);
    expect(broken.evidence.retrievedAt, "failure evidence").toBe(CLOCK);
  });

  it("lets a third-party implementation drive distinct actions from the retry advice", async () => {
    const actions: Record<RetryAdvice, string> = {
      never: "stop",
      after_backoff: "retry-later",
      after_quota_reset: "wait-for-reset",
      after_configuration_change: "fix-config",
    };
    // The four advices must map to four different follow-up actions; otherwise
    // the classification would not change behaviour.
    expect(new Set(Object.values(actions)).size, "four advices, four actions").toBe(4);

    const table: ReadonlyArray<readonly [ProviderFailureCode, RetryAdvice, string]> = [
      ["timeout", "after_backoff", "retry-later"],
      ["quota_exceeded", "after_quota_reset", "wait-for-reset"],
      ["authorization_failed", "after_configuration_change", "fix-config"],
      ["invalid_request", "never", "stop"],
    ];

    for (const [code, advice, expectedAction] of table) {
      // Implemented only with the published types; the fixture is never imported.
      const service: MobilityProvider = {
        async searchPlaces(): Promise<ProviderResult<PlaceSearchData>> {
          return { status: "ok", data: { items: [], truncated: false }, evidence: { ...EVIDENCE } };
        },
        async findRoutes(): Promise<RouteResult> {
          return {
            status: "failure",
            failure: { code, retry: advice, safeMessage: "第三方实现" },
            evidence: { ...EVIDENCE },
          };
        },
      };

      const result = await service.findRoutes(createFixtureRouteRequest());
      expect(result.status, `${code} status`).toBe("failure");
      if (result.status !== "failure") continue;
      expect(actions[result.failure.retry], `${code} action`).toBe(expectedAction);
      expect(unavailableRouteToTravelLeg("P-C", "P-D", result).duration, `${code} leg`).toEqual({
        kind: "unknown",
        reason: `provider:failure:${code}`,
      });
    }
  });

  it("returns owned places, routes, evidence and failures on every call", async () => {
    const service = provider("success");

    const firstPlace = await service.searchPlaces(citySearch("下午馆"));
    expect(firstPlace.status, "first place").toBe("ok");
    if (firstPlace.status !== "ok") return;
    const item = firstPlace.data.items[0] as unknown as {
      name: string;
      ref: { externalId: string };
      location: { longitude: number };
    };
    item.name = "被调用方修改";
    item.ref.externalId = "被调用方修改";
    item.location.longitude = 0;
    (firstPlace.data.items as PlaceSummary[]).push(firstPlace.data.items[0]);
    (firstPlace.evidence as { attribution: string }).attribution = "被调用方修改";

    const secondPlace = await service.searchPlaces(citySearch("下午馆"));
    expect(secondPlace.status, "second place").toBe("ok");
    if (secondPlace.status !== "ok") return;
    expect(secondPlace.data.items.length, "place array owned").toBe(2);
    expect(secondPlace.data.items[0].name, "place name owned").toBe("虚构下午馆");
    expect(secondPlace.data.items[0].ref.externalId, "place ref owned").not.toBe("被调用方修改");
    expect(secondPlace.data.items[0].location.longitude, "place location owned").not.toBe(0);
    expect(secondPlace.evidence.attribution, "place evidence owned").toBe("TripQuest 手写虚构数据");

    const firstRoute = await service.findRoutes(createFixtureRouteRequest());
    expect(firstRoute.status, "first route").toBe("ok");
    if (firstRoute.status !== "ok") return;
    (firstRoute.routes[0] as { durationSeconds: number }).durationSeconds = 0;
    (firstRoute.evidence as { attribution: string }).attribution = "被调用方修改";
    const secondRoute = await service.findRoutes(createFixtureRouteRequest());
    expect(secondRoute.status, "second route").toBe("ok");
    if (secondRoute.status === "ok") {
      expect(secondRoute.routes[0].durationSeconds, "route owned").toBe(2400);
      expect(secondRoute.evidence.attribution, "route evidence owned").toBe("TripQuest 手写虚构数据");
    }

    // A mutated failure must not reach a different failure scenario.
    const firstFailure = await provider("timeout").findRoutes(createFixtureRouteRequest());
    expect(firstFailure.status, "first failure").toBe("failure");
    if (firstFailure.status !== "failure") return;
    (firstFailure.failure as { safeMessage: string }).safeMessage = "被调用方修改";
    (firstFailure.failure as { retry: RetryAdvice }).retry = "never";
    (firstFailure.evidence as { attribution: string }).attribution = "被调用方修改";

    const otherFailure = await provider("quota_exceeded").findRoutes(createFixtureRouteRequest());
    expect(otherFailure.status, "other failure").toBe("failure");
    if (otherFailure.status !== "failure") return;
    expect(otherFailure.failure.retry, "other retry owned").toBe("after_quota_reset");
    expect(otherFailure.failure.safeMessage, "other message owned").not.toBe("被调用方修改");
    expect(otherFailure.evidence.attribution, "other evidence owned").toBe("TripQuest 手写虚构数据");
  });

  it("keeps keys, identifiers and coordinates out of every safe message", async () => {
    const forbidden = /key|token|secret|bearer|https?:\/\/|P-C|P-D|000000|116\.|39\.9/i;

    for (const code of FAILURE_CODES) {
      const result = await provider(code as unknown as FixtureRouteScenario).findRoutes(
        createFixtureRouteRequest(),
      );
      expect(result.status, `${code} status`).toBe("failure");
      if (result.status !== "failure") continue;
      expect(result.failure.safeMessage.length, `${code} message present`).toBeGreaterThan(0);
      expect(forbidden.test(result.failure.safeMessage), `${code}: ${result.failure.safeMessage}`).toBe(false);
    }

    const placeFailure = await provider().searchPlaces(citySearch(""));
    expect(placeFailure.status, "place failure").toBe("failure");
    if (placeFailure.status === "failure") {
      expect(forbidden.test(placeFailure.failure.safeMessage), "place safeMessage").toBe(false);
    }
  });

  it("keeps the injected clock out of the data and never reports a malformed clock as success", async () => {
    const earlier = await provider("success", () => "2026-09-21T12:00:00+08:00").findRoutes(
      createFixtureRouteRequest(),
    );
    const later = await provider("success", () => "2026-09-21T13:30:00+08:00").findRoutes(
      createFixtureRouteRequest(),
    );
    expect(earlier.status, "earlier status").toBe("ok");
    expect(later.status, "later status").toBe("ok");
    if (earlier.status !== "ok" || later.status !== "ok") return;

    expect(later.routes, "clock does not change the data").toEqual(earlier.routes);
    expect(earlier.evidence.retrievedAt, "earlier stamp").toBe("2026-09-21T12:00:00+08:00");
    expect(later.evidence.retrievedAt, "later stamp").toBe("2026-09-21T13:30:00+08:00");

    // A clock without an explicit offset is a caller configuration error; whatever
    // the mechanism, it must never surface as a successful retrieval.
    let mechanism = "returned";
    let malformed: RouteResult | null = null;
    try {
      malformed = await provider("success", () => "2026-09-21T12:00:00").findRoutes(
        createFixtureRouteRequest(),
      );
    } catch {
      mechanism = "threw";
    }
    expect(
      mechanism === "threw" || malformed?.status === "failure",
      "a malformed clock is not a success",
    ).toBe(true);
  });
});
