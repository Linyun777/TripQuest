import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readPlanningConfig } from "../planning-config";
import { createPlanningService } from "../planning-service";

/**
 * TQ-008.1 independent test (2026-10-08). Expectations follow the S5.1 design
 * §4–5: explicit fail-closed configuration, 30-minute server-signed place
 * tokens, live-shaped results that keep provider order/truncation/evidence,
 * one request per search with no retry or fixture fallback, and replies that
 * never echo tokens, secrets or browser-claimed place data.
 * Network is a synthetic fetch double; no real Amap request is made.
 */

const secret = "independent-test-secret-0123456789abcdef";
const amapKey = "synthetic-amap-key-for-independent-test";
const t0 = Date.parse("2026-10-08T03:00:00Z");
const THIRTY_MINUTES = 30 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

function amapConfig() {
  return readPlanningConfig({
    NODE_ENV: "development",
    PLANNING_PLACE_SOURCE: "amap",
    PLANNING_PLACE_TOKEN_SECRET: secret,
    AMAP_WEB_SERVICE_KEY: amapKey,
  });
}

function fixtureConfig() {
  return readPlanningConfig({
    NODE_ENV: "production",
    PLANNING_PLACE_SOURCE: "fixture",
    PLANNING_PLACE_TOKEN_SECRET: secret,
  });
}

function poiResponse(names: readonly string[]) {
  return new Response(
    JSON.stringify({
      status: "1",
      info: "OK",
      infocode: "10000",
      count: String(names.length),
      pois: names.map((name, index) => ({
        id: `B0INDEP${index}`,
        name,
        adcode: "330106",
        location: `120.1${index},30.2${index}`,
        address: `合成测试路 ${index} 号`,
      })),
    }),
  );
}

function submission(startToken: string, visits: unknown[]) {
  return {
    schemaVersion: "planning-requirements.v1",
    cityAdcode: "330100",
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: "2026-10-08",
    window: { startsAt: "10:00", endsAt: "18:00" },
    startPlace: startToken,
    endPlace: startToken,
    interests: ["culture"],
    pace: "relaxed",
    visits,
  };
}

describe("S5.1 planning service · independent boundaries", () => {
  it("fails closed unless source, secret and environment are all explicit", () => {
    const cases: [string, NodeJS.ProcessEnv, boolean][] = [
      ["nothing configured", { NODE_ENV: "development" }, false],
      [
        "old lab switch plus Key, no planning source",
        {
          NODE_ENV: "development",
          AMAP_LIVE_ENABLED: "true",
          AMAP_WEB_SERVICE_KEY: amapKey,
          PLANNING_PLACE_TOKEN_SECRET: secret,
        },
        false,
      ],
      [
        "source spelled in upper case",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "AMAP",
          PLANNING_PLACE_TOKEN_SECRET: secret,
          AMAP_WEB_SERVICE_KEY: amapKey,
        },
        false,
      ],
      [
        "amap without Key",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "amap",
          PLANNING_PLACE_TOKEN_SECRET: secret,
        },
        false,
      ],
      [
        "secret reused from the model Key",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "fixture",
          PLANNING_PLACE_TOKEN_SECRET: secret,
          DEEPSEEK_API_KEY: secret,
        },
        false,
      ],
      [
        "31-byte secret",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "fixture",
          PLANNING_PLACE_TOKEN_SECRET: "s".repeat(31),
        },
        false,
      ],
      [
        "32-byte secret",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "fixture",
          PLANNING_PLACE_TOKEN_SECRET: "s".repeat(32),
        },
        true,
      ],
      [
        "fixture in a production build",
        {
          NODE_ENV: "production",
          PLANNING_PLACE_SOURCE: "fixture",
          PLANNING_PLACE_TOKEN_SECRET: secret,
        },
        true,
      ],
      [
        "amap in development",
        {
          NODE_ENV: "development",
          PLANNING_PLACE_SOURCE: "amap",
          PLANNING_PLACE_TOKEN_SECRET: secret,
          AMAP_WEB_SERVICE_KEY: amapKey,
        },
        true,
      ],
    ];
    for (const [label, environment, enabled] of cases) {
      const config = readPlanningConfig(environment);
      expect(config.enabled, label).toBe(enabled);
      expect(config.availability.enabled, label).toBe(enabled);
      const shown = JSON.stringify(config.availability);
      expect(shown, label).not.toContain(secret);
      expect(shown, label).not.toContain(amapKey);
    }
  });

  it("signs live-shaped results that verify only in amap mode, keeping provider order, truncation and evidence", async () => {
    const names = [
      "合成起点广场",
      "同名合成馆",
      "同名合成馆",
      "合成步行街",
      "合成餐厅",
      "第六个合成地点",
    ];
    const fetcher = vi.fn<typeof fetch>(async () => poiResponse(names));
    vi.stubGlobal("fetch", fetcher);
    const service = createPlanningService({
      config: amapConfig(),
      now: () => t0,
    });

    const reply = await service.search("  西湖  ");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("keywords")).toBe("西湖");
    expect(url.searchParams.get("region")).toBe("330100");
    expect(url.searchParams.get("city_limit")).toBe("true");
    if (reply.status !== "ok") throw new Error(JSON.stringify(reply));
    expect(reply.items.map((item) => item.selection.place.name)).toEqual(
      names.slice(0, 5),
    );
    expect(reply.truncated).toBe(true);
    expect(reply.evidence).toMatchObject({
      provider: "amap",
      sourceKind: "live",
      attribution: "高德地图",
      retrievedAt: new Date(t0).toISOString(),
    });

    const [start, twinA, twinB] = reply.items;
    const twinIds = [twinA, twinB].map(
      (item) => item.selection.place.ref.externalId,
    );
    expect(new Set(twinIds).size, "same name, different IDs").toBe(2);
    const input = submission(start.token, [
      { token: twinA.token, role: "optional", stayMinutes: 60 },
      { token: twinB.token, role: "required", stayMinutes: 90 },
    ]);
    for (const attempt of ["first review", "same tokens reused"]) {
      const review = service.review(input);
      if (review.status !== "ready") {
        throw new Error(`${attempt}: ${JSON.stringify(review)}`);
      }
      expect(review.requirements.startPlace, attempt).toEqual(
        start.selection,
      );
      expect(
        review.requirements.visits.map(
          (visit) => visit.place.place.ref.externalId,
        ),
        attempt,
      ).toEqual(twinIds);
    }
    expect(fetcher, "review makes no network call").toHaveBeenCalledTimes(1);

    const fixtureMode = createPlanningService({
      config: fixtureConfig(),
      now: () => t0,
    });
    expect(fixtureMode.review(input).status, "live token in fixture mode").toBe(
      "invalid",
    );
  });

  it("reports each provider failure once with its safe category text, without retry or fixture fallback", async () => {
    const failures: {
      label: string;
      respond: () => Promise<Response>;
      hint: string;
    }[] = [
      {
        label: "HTTP 429",
        respond: async () => new Response("", { status: 429 }),
        hint: "频繁",
      },
      {
        label: "network error",
        respond: async () => {
          throw new TypeError("fetch failed");
        },
        hint: "暂时不可用",
      },
      {
        label: "non-JSON body",
        respond: async () => new Response("<html></html>"),
        hint: "格式",
      },
      {
        label: "rejected Key",
        respond: async () =>
          new Response(
            JSON.stringify({
              status: "0",
              info: "INVALID_USER_KEY",
              infocode: "10001",
            }),
          ),
        hint: "权限",
      },
    ];
    for (const { label, respond, hint } of failures) {
      const fetcher = vi.fn<typeof fetch>(respond);
      vi.stubGlobal("fetch", fetcher);
      const service = createPlanningService({
        config: amapConfig(),
        now: () => t0,
      });
      const reply = await service.search("博物馆");
      if (reply.status !== "error") throw new Error(`${label}: not an error`);
      expect(reply.message, label).toContain(hint);
      expect(JSON.stringify(reply), label).not.toContain(amapKey);
      expect(fetcher, label).toHaveBeenCalledTimes(1);
    }
  });

  it("checks the 1–80 character query before any request and treats an empty result as success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => poiResponse([]));
    vi.stubGlobal("fetch", fetcher);
    const service = createPlanningService({
      config: amapConfig(),
      now: () => t0,
    });
    for (const query of ["", "   ", "测".repeat(81), 42]) {
      expect(await service.search(query), String(query)).toMatchObject({
        status: "error",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await service.search("测".repeat(80))).toMatchObject({
      status: "ok",
      items: [],
      truncated: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts only tokens plus role/time intent, flags just the stale places, and never echoes tokens or claims", async () => {
    const service = createPlanningService({
      config: fixtureConfig(),
      now: () => t0,
    });
    const reply = await service.search("演示");
    if (reply.status !== "ok") throw new Error("fixture search failed");
    const byName = (name: string) => {
      const found = reply.items.find(
        (item) => item.selection.place.name === name,
      );
      if (!found) throw new Error(`fixture has no ${name}`);
      return found;
    };
    const start = byName("演示起点");
    const museum = byName("演示博物馆");
    const visit = { token: museum.token, role: "optional", stayMinutes: 60 };
    expect(service.review(submission(start.token, [visit])).status).toBe(
      "ready",
    );

    const claims: [string, unknown[]][] = [
      ["claimed name", [{ ...visit, name: "伪造名称" }]],
      ["claimed coordinates", [{ ...visit, location: { longitude: 0 } }]],
      ["stay sent as text", [{ ...visit, stayMinutes: "60" }]],
      ["same place twice", [visit, { ...visit, role: "required" }]],
    ];
    for (const [label, visits] of claims) {
      const review = service.review(submission(start.token, visits));
      expect(review.status, label).toBe("invalid");
      const shown = JSON.stringify(review);
      for (const hidden of [start.token, museum.token, secret, "伪造名称"]) {
        expect(shown, label).not.toContain(hidden);
      }
    }

    const later = createPlanningService({
      config: fixtureConfig(),
      now: () => t0 + THIRTY_MINUTES,
    });
    const expired = later.review(submission(start.token, [visit]));
    if (expired.status !== "invalid") throw new Error("token did not expire");
    expect(Object.keys(expired.fieldErrors).sort()).toEqual([
      "endPlace",
      "startPlace",
      "visits.0.place",
    ]);
    expect(JSON.stringify(expired)).not.toContain(start.token);
  });
});
