import type {
  GeoPoint,
  MobilityProvider,
  PlaceRef,
  PlaceSearchData,
  PlaceSearchRequest,
  PlaceSummary,
  ProviderEvidence,
  ProviderFailure,
  ProviderFailureCode,
  ProviderResult,
  RetryAdvice,
  RouteRequest,
  RouteResult,
  TravelMode,
} from "./contracts";

const PROVIDER = "tripquest-fixture";
const DATASET_VERSION = "s3.1-v1";
const ATTRIBUTION = "TripQuest 手写虚构数据";

const placeTemplates: readonly PlaceSummary[] = [
  {
    ref: { provider: PROVIDER, externalId: "AFTERNOON-EAST" },
    name: "虚构下午馆",
    location: { longitude: 116.001, latitude: 39.901, coordinateSystem: "gcj02" },
    cityAdcode: "000000",
    address: "虚构市东侧测试路 1 号",
    categoryCode: "fixture:gallery",
  },
  {
    ref: { provider: PROVIDER, externalId: "AFTERNOON-WEST" },
    name: "虚构下午馆",
    location: { longitude: 115.991, latitude: 39.899, coordinateSystem: "gcj02" },
    cityAdcode: "000000",
    address: "虚构市西侧测试路 2 号",
    categoryCode: "fixture:gallery",
  },
];

export type FixtureRouteScenario =
  | "success"
  | "rounding_boundary"
  | "no_route"
  | "timeout"
  | "upstream_unavailable"
  | "rate_limited"
  | "quota_exceeded"
  | "authorization_failed";

export interface FixtureMobilityProviderOptions {
  /** An injected clock keeps fixtures deterministic and independent of local time zones. */
  readonly now: () => string;
  readonly routeScenario?: FixtureRouteScenario;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCityAdcode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGeoPoint(value: unknown): value is GeoPoint {
  if (!isRecord(value)) return false;
  const { longitude, latitude, coordinateSystem } = value;
  return typeof longitude === "number"
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180
    && typeof latitude === "number"
    && Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && coordinateSystem === "gcj02";
}

function isPlaceRef(value: unknown): value is PlaceRef {
  return isRecord(value) && isNonEmptyString(value.provider) && isNonEmptyString(value.externalId);
}

function isTravelMode(value: unknown): value is TravelMode {
  return value === "walking" || value === "driving" || value === "transit";
}

/** Strict RFC 3339 calendar shape with `Z` or a numeric offset; no host-time-zone parsing. */
function isOffsetDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validPlaceSearchRequest(value: unknown): value is PlaceSearchRequest {
  if (!isRecord(value)) return false;
  if (typeof value.query !== "string" || value.query.trim().length < 1 || value.query.trim().length > 80) {
    return false;
  }
  if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 25) {
    return false;
  }
  if (!isRecord(value.scope) || !isCityAdcode(value.scope.cityAdcode)) return false;
  if (value.scope.kind === "city") return true;
  return value.scope.kind === "nearby"
    && isGeoPoint(value.scope.center)
    && isSafeNonNegativeInteger(value.scope.radiusMeters)
    && value.scope.radiusMeters > 0;
}

function validRouteEndpoint(value: unknown): boolean {
  return isRecord(value) && isPlaceRef(value.place) && isGeoPoint(value.location);
}

function validRouteRequest(value: unknown): value is RouteRequest {
  return isRecord(value)
    && validRouteEndpoint(value.origin)
    && validRouteEndpoint(value.destination)
    && isTravelMode(value.mode)
    && isOffsetDateTime(value.departureAt)
    && isCityAdcode(value.cityAdcode);
}

function clonePoint(point: GeoPoint): GeoPoint {
  return { ...point };
}

function clonePlace(place: PlaceSummary): PlaceSummary {
  return { ...place, ref: { ...place.ref }, location: clonePoint(place.location) };
}

function retryFor(code: ProviderFailureCode): RetryAdvice {
  switch (code) {
    case "invalid_request":
    case "cancelled":
      return "never";
    case "authorization_failed":
      return "after_configuration_change";
    case "quota_exceeded":
      return "after_quota_reset";
    case "rate_limited":
    case "timeout":
    case "upstream_unavailable":
    case "malformed_response":
    case "unknown":
      return "after_backoff";
  }
}

const safeMessages: Record<ProviderFailureCode, string> = {
  invalid_request: "请求参数无效。",
  authorization_failed: "路线服务配置未通过校验。",
  quota_exceeded: "路线服务配额暂不可用。",
  rate_limited: "路线服务请求过于频繁，请稍后重试。",
  timeout: "路线服务响应超时，请稍后重试。",
  upstream_unavailable: "路线服务暂时不可用，请稍后重试。",
  malformed_response: "路线服务返回了无法识别的数据。",
  cancelled: "路线查询已取消。",
  unknown: "路线服务出现未分类错误。",
};

function failureFor(code: ProviderFailureCode): ProviderFailure {
  return {
    code,
    retry: retryFor(code),
    safeMessage: safeMessages[code],
    ...(code === "rate_limited" ? { retryAfterSeconds: 30 } : {}),
  };
}

export function createFixtureRouteRequest(): RouteRequest {
  return {
    origin: {
      place: { provider: PROVIDER, externalId: "P-C" },
      location: { longitude: 116, latitude: 39.9, coordinateSystem: "gcj02" },
    },
    destination: {
      place: { provider: PROVIDER, externalId: "P-D" },
      location: { longitude: 116.01, latitude: 39.91, coordinateSystem: "gcj02" },
    },
    mode: "walking",
    departureAt: "2026-10-15T16:30:00+08:00",
    cityAdcode: "000000",
  };
}

export class FixtureMobilityProvider implements MobilityProvider {
  readonly #now: () => string;
  readonly #routeScenario: FixtureRouteScenario;

  constructor(options: FixtureMobilityProviderOptions) {
    this.#now = options.now;
    this.#routeScenario = options.routeScenario ?? "success";
  }

  #evidence(): ProviderEvidence {
    const retrievedAt = this.#now();
    if (!isOffsetDateTime(retrievedAt)) {
      throw new TypeError("FixtureMobilityProvider clock must return RFC 3339 with `Z` or an explicit numeric offset");
    }
    return {
      provider: PROVIDER,
      sourceKind: "fixture",
      retrievedAt,
      attribution: ATTRIBUTION,
      datasetVersion: DATASET_VERSION,
    };
  }

  async searchPlaces(request: PlaceSearchRequest): Promise<ProviderResult<PlaceSearchData>> {
    const evidence = this.#evidence();
    if (!validPlaceSearchRequest(request)) {
      return { status: "failure", failure: failureFor("invalid_request"), evidence };
    }
    const query = request.query.trim();
    const matches = query === "下午馆" ? placeTemplates : [];
    const items = matches.slice(0, request.limit).map(clonePlace);
    return { status: "ok", data: { items, truncated: matches.length > request.limit }, evidence };
  }

  async findRoutes(request: RouteRequest): Promise<RouteResult> {
    const evidence = this.#evidence();
    if (!validRouteRequest(request)) {
      return { status: "failure", failure: failureFor("invalid_request"), evidence };
    }
    if (this.#routeScenario === "no_route") {
      return { status: "no_route", reason: "no_path", evidence };
    }
    if (this.#routeScenario === "success" || this.#routeScenario === "rounding_boundary") {
      return {
        status: "ok",
        routes: [{
          mode: request.mode,
          durationSeconds: this.#routeScenario === "success" ? 2_400 : 2_401,
          distanceMeters: 3_200,
        }],
        evidence,
      };
    }
    return { status: "failure", failure: failureFor(this.#routeScenario), evidence };
  }
}
