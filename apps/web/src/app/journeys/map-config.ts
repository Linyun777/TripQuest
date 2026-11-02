import "server-only";
import { withUser, type UserResolver } from "../auth/session";

export type PlanningMapConfig =
  | { mode: "schematic" }
  | { mode: "amap"; key: string; serviceHost: string };

export function readPlanningMapConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PlanningMapConfig {
  if (
    environment.NODE_ENV !== "development" ||
    environment.PLANNING_MAP_MODE !== "amap" ||
    !environment.AMAP_JS_API_KEY?.trim() ||
    !environment.AMAP_JS_SECURITY_CODE?.trim()
  ) {
    return { mode: "schematic" };
  }
  return {
    mode: "amap",
    key: environment.AMAP_JS_API_KEY,
    serviceHost: "/_AMapService",
  };
}

/** Fixed map-style upstream only. No REST search, route, or arbitrary URL proxy. */
export function createMapStyleHandler(
  options: {
    environment?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    /** V2.12：测试注入当前用户；只给登录的人转发地图样式。 */
    user?: UserResolver;
  } = {},
) {
  return withUser(options, async (request): Promise<Response> => {
    const environment = options.environment ?? process.env;
    const config = readPlanningMapConfig(environment);
    if (config.mode !== "amap") return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const site = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const host = request.headers.get("host") ?? url.host;
    let foreign = site && site !== "same-origin" && site !== "none";
    try {
      foreign ||= !!origin && new URL(origin).host !== host;
      foreign ||= !!referer && new URL(referer).host !== host;
    } catch {
      foreign = true;
    }
    if (foreign) {
      return new Response(null, { status: 403 });
    }
    if (request.url.length > 8192) return new Response(null, { status: 414 });
    const upstream = new URL("https://webapi.amap.com/v4/map/styles");
    upstream.search = url.search;
    upstream.searchParams.set("key", config.key);
    upstream.searchParams.set("jscode", environment.AMAP_JS_SECURITY_CODE!);
    try {
      const response = await (options.fetcher ?? fetch)(upstream, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
      });
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type":
            response.headers.get("content-type") ?? "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  });
}
