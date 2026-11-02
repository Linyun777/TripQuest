import type { PlaceSearchData, ProviderResult, RouteResult } from "@tripquest/providers";
export type LiveConfiguration = "ready" | "disabled" | "missing_key" | "unavailable";
export type LiveReply<T> = { status: "result"; result: T } | { status: "unavailable"; message: string };
export type SearchReply = LiveReply<ProviderResult<PlaceSearchData>>;
export type RouteReply = LiveReply<RouteResult>;
