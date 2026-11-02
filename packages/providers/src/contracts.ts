import type { CityRef } from "./city";
export interface GeoPoint {
  readonly longitude: number;
  readonly latitude: number;
  readonly coordinateSystem: "gcj02";
}

export interface ProviderEvidence {
  readonly provider: string;
  readonly sourceKind: "fixture" | "live";
  /** RFC 3339 date-time with an explicit offset (`Z` or `±hh:mm`). */
  readonly retrievedAt: string;
  readonly attribution: string;
  readonly datasetVersion?: string;
}

export interface PlaceRef {
  readonly provider: string;
  readonly externalId: string;
}

export interface PlaceSummary {
  readonly ref: PlaceRef;
  readonly name: string;
  readonly location: GeoPoint;
  /** V2.10：地点所属城市（地级市一级）的行政区编码，见 city.ts。 */
  readonly cityAdcode: string;
  readonly address?: string;
  readonly categoryCode?: string;
  /** V2.4: only when the search asked for it; shown next to a candidate, never stored (D-046). */
  readonly business?: PlaceBusiness;
}

/** V2.4: Amap's rating, cost per person, type tag and today's hours, for display only. */
export interface PlaceBusiness {
  readonly rating?: number;
  readonly costYuan?: number;
  readonly keytag?: string;
  readonly openToday?: string;
}

/**
 * V2.10：城市范围（只要这个城市的）、附近（按中心和半径，不限城市；半径 3、10 或 30 公里）、
 * 全国（绑定用户点名的地点，可能在别的城市）。
 */
export type PlaceSearchScope =
  | { readonly kind: "city"; readonly cityAdcode: string }
  | {
      readonly kind: "nearby";
      /** 旧字段，附近搜索不再按城市限制。 */
      readonly cityAdcode?: string;
      readonly center: GeoPoint;
      readonly radiusMeters: number;
    }
  | { readonly kind: "country" };

export interface PlaceSearchRequest {
  readonly query: string;
  readonly scope: PlaceSearchScope;
  readonly limit: number;
  /** V2.4: also return business facts (candidates only; the planner never asks). */
  readonly withBusiness?: true;
}

export interface PlaceSearchData {
  readonly items: readonly PlaceSummary[];
  readonly truncated: boolean;
  /** Valid nearby hits excluded by city/radius checks; malformed hits fail the operation. */
  readonly excludedCount?: number;
}

/** V2.2: "taxi" is a driving route with Amap's taxi fare; "driving" means the user drives. */
export type TravelMode = "walking" | "transit" | "taxi" | "bicycling" | "driving";

export interface RouteRequest {
  /** V2.10：起终点可以在不同城市；公交按各自的城市查（缺省用 cityAdcode）。 */
  readonly origin: { readonly place: PlaceRef; readonly location: GeoPoint; readonly cityAdcode?: string };
  readonly destination: { readonly place: PlaceRef; readonly location: GeoPoint; readonly cityAdcode?: string };
  readonly mode: TravelMode;
  /** RFC 3339 date-time with an explicit offset (`Z` or `±hh:mm`). */
  readonly departureAt: string;
  readonly cityAdcode: string;
}

export interface RouteOption {
  readonly mode: TravelMode;
  readonly durationSeconds: number;
  readonly distanceMeters: number;
  /** Ticket or taxi estimate in yuan, when the provider gives one. */
  readonly fareYuan?: number;
  /** Short display text, e.g. "地铁3号线 → 公交12路"; transit only. */
  readonly summary?: string;
  /** Walking inside a transit route. */
  readonly walkingMeters?: number;
  /** GCJ-02 polyline for the map, downsampled; used in memory only and never stored (D-046). */
  readonly path?: readonly (readonly [number, number])[];
}

export type ProviderFailureCode =
  | "invalid_request"
  | "authorization_failed"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "upstream_unavailable"
  | "malformed_response"
  | "cancelled"
  | "unknown";

export type RetryAdvice =
  | "never"
  | "after_backoff"
  | "after_quota_reset"
  | "after_configuration_change";

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly retry: RetryAdvice;
  /** Safe for ordinary UI/logging; never contains keys, raw responses or precise locations. */
  readonly safeMessage: string;
  readonly retryAfterSeconds?: number;
}

export type ProviderResult<T> =
  | { readonly status: "ok"; readonly data: T; readonly evidence: ProviderEvidence }
  | { readonly status: "failure"; readonly failure: ProviderFailure; readonly evidence: ProviderEvidence };

export type NoRouteReason =
  | "no_path"
  | "origin_unmatched"
  | "destination_unmatched"
  | "distance_limit"
  | "unsupported_mode";

export type RouteResult =
  | {
      readonly status: "ok";
      readonly routes: readonly [RouteOption, ...RouteOption[]];
      readonly evidence: ProviderEvidence;
    }
  | { readonly status: "no_route"; readonly reason: NoRouteReason; readonly evidence: ProviderEvidence }
  | { readonly status: "failure"; readonly failure: ProviderFailure; readonly evidence: ProviderEvidence };

export type UnavailableRouteResult = Exclude<RouteResult, { readonly status: "ok" }>;

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface MobilityProvider {
  searchPlaces(
    request: PlaceSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<PlaceSearchData>>;
  findRoutes(request: RouteRequest, options?: ProviderCallOptions): Promise<RouteResult>;
}

/** V2.2 current location: the nearest provider place to a device point (WGS-84). */
export interface NearestPlaceData {
  readonly place: PlaceSummary;
  readonly distanceMeters: number;
  /** V2.10：设备位置所在的城市（地级市一级）。 */
  readonly city: CityRef;
}

/** V2.10：把用户说的城市名（“成都”“黄山”）换成城市编码；查不到或不是城市时失败。 */
export interface CityResolver {
  resolveCity(name: string, options?: ProviderCallOptions): Promise<ProviderResult<CityRef>>;
}

export interface NearbyPlaceProvider {
  /** The precise point is used for this one lookup only; callers never store it (AGENTS §5). */
  nearestPlace(
    point: { readonly longitude: number; readonly latitude: number },
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<NearestPlaceData>>;
}

/** Places found by stable provider ID; IDs the provider no longer knows are listed as missing. */
export interface PlaceLookupData {
  readonly items: readonly PlaceSummary[];
  readonly missing: readonly string[];
}

export interface WeatherDay {
  /** Calendar date in the city's time zone, YYYY-MM-DD. */
  readonly date: string;
  readonly dayWeather: string;
  readonly nightWeather: string;
  readonly highCelsius: number;
  readonly lowCelsius: number;
  /** Rain, snow or hail in the day or night description. */
  readonly wet: boolean;
  /** V2.10: day or night wind force 6 or more (Amap daypower / nightpower). */
  readonly windy?: boolean;
}

export interface WeatherForecastData {
  readonly cityAdcode: string;
  readonly reportedAt: string;
  readonly days: readonly WeatherDay[];
}

/** V2.1: city-level forecast, read at use time and never stored. */
/** V2.6: the city's weather words right now ("小雨"), shown and checked live, never stored. */
export interface LiveWeatherData {
  readonly cityAdcode: string;
  readonly weather: string;
  readonly reportedAt: string;
}

export interface WeatherProvider {
  getWeatherForecast(
    cityAdcode: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<WeatherForecastData>>;
  /** V2.6: optional, so fixtures without it keep working. */
  getLiveWeather?(cityAdcode: string, options?: ProviderCallOptions): Promise<ProviderResult<LiveWeatherData>>;
}

/**
 * V2.7: a web search (DeepSeek Search). Results are untrusted data for the chat to cite, never
 * instructions and never verified facts; only their URL, title, site and date are stored.
 */
export interface WebSearchRequest {
  /** What is searched: place names and the question only, never where the user is. */
  readonly query: string;
  /** The user's question in their words, to help the search understand it. */
  readonly question?: string;
  readonly count?: number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly site: string | null;
  /** Publication date, "YYYY-MM-DD", when the page has one. */
  readonly date: string | null;
  /** The search's own summary of the page (not stored). */
  readonly summary: string;
  /** 0–4 (3+ is highly authoritative); null when unknown. */
  readonly authority: number | null;
}

export interface WebSearchData {
  readonly results: readonly WebSearchResult[];
}

export interface WebSearchProvider {
  searchWeb(request: WebSearchRequest, options?: ProviderCallOptions): Promise<ProviderResult<WebSearchData>>;
}

/** V2.8: text embeddings. Queries and stored passages are embedded differently (`text_type`). */
export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly kind: "query" | "document";
}

export interface EmbeddingData {
  /** One unit-length vector per text, in the order of `texts`. */
  readonly vectors: readonly (readonly number[])[];
  readonly tokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(request: EmbeddingRequest, options?: ProviderCallOptions): Promise<ProviderResult<EmbeddingData>>;
}

/** V2.8: scores candidate passages against a question; scores compare only within one call. */
export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly string[];
}

export interface RerankData {
  /** Every document's position in `documents` with its 0–1 score, best first. */
  readonly ranking: readonly { readonly index: number; readonly score: number }[];
  readonly tokens: number;
}

export interface RerankProvider {
  readonly model: string;
  rerank(request: RerankRequest, options?: ProviderCallOptions): Promise<ProviderResult<RerankData>>;
}

/** S5.5: re-reads saved places by ID at use time, because their details are never stored. */
export interface PlaceLookupProvider {
  findPlacesById(
    externalIds: readonly string[],
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<PlaceLookupData>>;
}
