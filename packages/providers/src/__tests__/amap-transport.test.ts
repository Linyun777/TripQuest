import { describe, expect, it } from "vitest";

import type { GeoPoint, RouteOption } from "../contracts";
import { selectedRouteToTravelLeg, unavailableRouteToTravelLeg } from "../domain-mapper";
import { AmapMobilityProvider, HANGZHOU_ADCODE } from "../server/amap";

// Expectations are hand derived from the S3.5 design contract. The developer's
// amap.test.ts already covers the parsing and error-mapping tables; this file
// targets the transport-level guarantees and the seconds-to-minutes boundary,
// which had no coverage (no `Math.ceil`, no 1 MiB cap, no ceiling values).
const KEY = "synthetic-secret-canary";
const NOW = "2026-09-26T00:00:00Z";

function point(longitude = 120, latitude = 30): GeoPoint {
  return { longitude, latitude, coordinateSystem: "gcj02" };
}

function ok(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function recordingFetch(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function provider(fetchImpl: typeof globalThis.fetch, timeoutMs?: number) {
  return new AmapMobilityProvider({ key: KEY, fetch: fetchImpl, now: () => NOW, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const searchRequest = { query: "浙江省博物馆", scope: { kind: "city" as const, cityAdcode: HANGZHOU_ADCODE }, limit: 5 };

const walkingRequest = {
  origin: { place: { provider: "amap" as const, externalId: "B0FFA" }, location: point() },
  destination: { place: { provider: "amap" as const, externalId: "B0FFB" }, location: point(120.01, 30.01) },
  cityAdcode: HANGZHOU_ADCODE,
  mode: "walking" as const,
  departureAt: NOW,
};

describe("S3.5 transport guarantees", () => {
  it("sends the fixed host, no-store cache and redirect rejection", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok({ status: "1", infocode: "10000", count: "0", pois: [] }));
    await provider(fetchImpl).searchPlaces(searchRequest);

    expect(calls, "exactly one upstream request").toHaveLength(1);
    const [call] = calls;
    const url = new URL(call!.url);
    expect(url.origin, "host is fixed, never caller controlled").toBe("https://restapi.amap.com");
    expect(url.pathname).toBe("/v5/place/text");
    expect(call!.init?.cache, "no persisted fetch cache").toBe("no-store");
    expect(call!.init?.redirect, "cross-origin redirects are refused").toBe("error");
    expect(call!.init?.signal, "an abort signal is always supplied").toBeDefined();
  });

  it("aborts a hanging request and reports a timeout instead of waiting forever", async () => {
    let aborted = false;
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted by client"));
        });
      })) as unknown as typeof globalThis.fetch;

    const started = Date.now();
    const result = await provider(hanging, 50).searchPlaces(searchRequest);
    const elapsed = Date.now() - started;

    expect(result.status, "a hang becomes a timeout failure").toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("timeout");
    expect(result.failure.retry, "a timeout is retryable after backoff").toBe("after_backoff");
    expect(aborted, "the request was genuinely aborted").toBe(true);
    expect(elapsed, "it did not wait for the default timeout").toBeLessThan(2_000);
  });

  it("refuses a response body larger than the size cap", async () => {
    const huge = JSON.stringify({ status: "1", infocode: "10000", count: "0", pois: [], pad: "x".repeat(1_100_000) });
    const { fetchImpl } = recordingFetch(() => ok(huge));
    const result = await provider(fetchImpl).searchPlaces(searchRequest);

    expect(result.status, "an oversized body is not parsed as success").toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("malformed_response");
  });

  it("never leaks the key through a failure message", async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error(`request to https://restapi.amap.com/v5/place/text?key=${KEY} failed`);
    });
    const result = await provider(fetchImpl).searchPlaces(searchRequest);

    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    const serialized = JSON.stringify(result);
    expect(serialized, "no key in the failure payload").not.toContain(KEY);
    expect(serialized, "no upstream URL in the failure payload").not.toContain("restapi.amap.com");
    expect(result.failure.safeMessage, "a fixed safe message is used").not.toContain(KEY);
  });

  it("treats a multi-path answer as malformed rather than silently picking one", async () => {
    // The adapter sends alternative_route=1 yet requires at most one path. This
    // test pins the current behaviour so the live run can confirm which is right.
    const twoPaths = {
      status: "1",
      infocode: "10000",
      route: {
        paths: [
          { distance: "120", cost: { duration: "90" } },
          { distance: "140", cost: { duration: "100" } },
        ],
      },
    };
    const { fetchImpl } = recordingFetch(() => ok(twoPaths));
    const result = await provider(fetchImpl).findRoutes(walkingRequest);

    expect(result.status, "two paths are refused, not silently narrowed").toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("malformed_response");
  });

  it("accepts a genuinely zero duration without turning it into an unknown leg", async () => {
    const { fetchImpl } = recordingFetch(() => ok({ status: "1", infocode: "10000", route: { paths: [{ distance: "0", cost: { duration: "0" } }] } }));
    const result = await provider(fetchImpl).findRoutes(walkingRequest);

    expect(result.status, "zero is a valid non-negative value").toBe("ok");
    if (result.status !== "ok") return;
    expect(result.routes[0]).toMatchObject({ durationSeconds: 0, distanceMeters: 0 });
  });
});

describe("S3.5 seconds to minutes boundary", () => {
  it("rounds seconds up to whole minutes at every boundary", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [1, 1], [59, 1], [60, 1], [61, 2], [119, 2], [120, 2], [121, 3], [3599, 60], [3600, 60], [3601, 61],
    ];
    for (const [seconds, minutes] of cases) {
      const route: RouteOption = { mode: "walking", durationSeconds: seconds, distanceMeters: 100 };
      expect(selectedRouteToTravelLeg("place-a", "place-b", route).duration, `${seconds}s`).toEqual({
        kind: "known",
        minutes,
      });
    }
  });

  it("refuses a negative or unsafe duration instead of clamping it", () => {
    for (const bad of [-1, -60, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const route = { mode: "walking", durationSeconds: bad, distanceMeters: 100 } as RouteOption;
      expect(() => selectedRouteToTravelLeg("place-a", "place-b", route), `${bad}`).toThrow();
    }
  });

  it("keeps an unavailable route unknown so it can never become zero minutes", () => {
    const noRoute = unavailableRouteToTravelLeg("place-a", "place-b", { status: "no_route", reason: "no_path", evidence: { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: NOW } });
    expect(noRoute.duration).toEqual({ kind: "unknown", reason: "provider:no_route:no_path" });

    const failed = unavailableRouteToTravelLeg("place-a", "place-b", {
      status: "failure",
      failure: { code: "timeout", retry: "after_backoff", safeMessage: "高德请求超时，已终止本次请求。" },
      evidence: { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: NOW },
    });
    expect(failed.duration).toEqual({ kind: "unknown", reason: "provider:failure:timeout" });
  });
});
