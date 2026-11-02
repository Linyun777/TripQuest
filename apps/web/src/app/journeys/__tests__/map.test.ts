import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createMapStyleHandler, readPlanningMapConfig } from "../map-config";
import { groupMapNodes, type MapNode } from "../amap-loader";
import { asTestUser } from "../../../test-support/users";

const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_MAP_MODE: "amap",
  AMAP_JS_API_KEY: "fixture-js-key",
  AMAP_JS_SECURITY_CODE: "fixture-security-code",
};
afterEach(() => vi.unstubAllGlobals());

describe("S5.3.2 map display boundaries (no external requests)", () => {
  it("enables only complete explicit development config; production / test remain schematic and their proxy stays closed", async () => {
    expect(readPlanningMapConfig(environment)).toMatchObject({ mode: "amap" });
    for (const env of [
      { ...environment, NODE_ENV: "production" },
      { ...environment, NODE_ENV: "test" },
      { ...environment, PLANNING_MAP_MODE: "schematic" },
      { ...environment, AMAP_JS_SECURITY_CODE: "" },
    ] satisfies NodeJS.ProcessEnv[]) {
      expect(readPlanningMapConfig(env)).toEqual({ mode: "schematic" });
      const fetcher = vi.fn<typeof fetch>();
      expect(
        (
          await createMapStyleHandler({ environment: env, fetcher, user: asTestUser })(
            new Request("http://localhost:3354/_AMapService/v4/map/styles"),
          )
        ).status,
      ).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("accepts a normal same-origin SDK GET without Origin, fixes the upstream and overrides client credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("fixture-style", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const handler = createMapStyleHandler({ environment, fetcher, user: asTestUser });
    // Next may rewrite localhost / 127.0.0.1 in request.url. The browser's Host is authoritative.
    const response = await handler(
      new Request(
        "http://127.0.0.1:3354/_AMapService/v4/map/styles?key=client&jscode=client&style=normal",
        {
          headers: {
            host: "localhost:3354",
            referer: "http://localhost:3354/journeys/fixture",
            "sec-fetch-site": "same-origin",
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fixture-style");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const upstream = new URL(String(fetcher.mock.calls[0][0]));
    expect(upstream.origin + upstream.pathname).toBe(
      "https://webapi.amap.com/v4/map/styles",
    );
    expect(upstream.searchParams.get("key")).toBe(environment.AMAP_JS_API_KEY);
    expect(upstream.searchParams.get("jscode")).toBe(
      environment.AMAP_JS_SECURITY_CODE,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      cache: "no-store",
    });
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { referer: "invalid URL" },
    ] as Record<string, string>[]) {
      expect(
        (
          await handler(
            new Request("http://localhost:3354/_AMapService/v4/map/styles", {
              headers,
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps all independently selectable labels when start / end or activities share coordinates", () => {
    const nodes: MapNode[] = [
      { id: "start", label: "起", name: "演示起点", position: [120.1, 30.2] },
      { id: "activity:a", label: "1", name: "演示馆", position: [120.2, 30.2] },
      { id: "end", label: "终", name: "演示起点", position: [120.1, 30.2] },
    ];
    expect(
      groupMapNodes(nodes).map((group) => group.map((node) => node.id)),
    ).toEqual([["start", "end"], ["activity:a"]]);
  });
});
