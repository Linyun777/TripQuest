import type { PlaceSummary, RouteRequest } from "@tripquest/providers";

/**
 * V2.10：两地之间的路线请求带上各自的城市（一天可以跨出城市边界；公交按起终点各自的城市查）。
 * 主城市取起点的城市。
 */
export function routeBetween(from: PlaceSummary, to: PlaceSummary): Pick<RouteRequest, "origin" | "destination" | "cityAdcode"> {
  return {
    origin: { place: from.ref, location: from.location, cityAdcode: from.cityAdcode },
    destination: { place: to.ref, location: to.location, cityAdcode: to.cityAdcode },
    cityAdcode: from.cityAdcode,
  };
}
