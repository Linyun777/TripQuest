import type { GeoPoint, MobilityProvider, PlaceLookupData, PlaceBusiness, PlaceLookupProvider, PlaceSearchRequest, PlaceSearchData, PlaceSummary, ProviderCallOptions, ProviderEvidence, ProviderFailure, ProviderFailureCode, ProviderResult, RouteOption, RouteRequest, RouteResult, WeatherDay, WeatherForecastData, WeatherProvider, NearbyPlaceProvider, NearestPlaceData, LiveWeatherData } from "../contracts";
import { straightLineMeters } from "../geo-distance";
import { cityAdcodeOf, isAdcode, isMunicipality, type CityRef } from "../city";
import type { CityResolver } from "../contracts";

/** 旧名字：缺省城市（没有定位、也没说城市时）。V2.10 起不再限制只能是杭州。 */
export const HANGZHOU_ADCODE = "330100";
/** V2.10：附近搜索允许的半径（3 公里起，郊区和山区逐级扩大到 10、30 公里）。 */
const NEARBY_RADII = new Set([3000, 10_000, 30_000]);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 500): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const integer = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) return;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
};
export function isAmapPoint(v: unknown): v is GeoPoint {
  return record(v) && v.coordinateSystem === "gcj02"
    && typeof v.longitude === "number" && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180
    && typeof v.latitude === "number" && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90;
}
export function isAmapEndpoint(v: unknown): v is RouteRequest["origin"] {
  return record(v) && record(v.place) && v.place.provider === "amap" && id(v.place.externalId) && isAmapPoint(v.location);
}
function point(v: unknown): GeoPoint | undefined {
  if (typeof v !== "string" || !/^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(v)) return;
  const [longitude, latitude] = v.split(",").map(Number);
  const p = { longitude, latitude, coordinateSystem: "gcj02" as const };
  return isAmapPoint(p) ? p : undefined;
}
/** V2.10：任何城市的地点都接受；地点的城市按区县编码换算到地级市一级（city.ts）。 */
function place(v: unknown): PlaceSummary | undefined {
  if (!record(v) || !id(v.id) || !text(v.name) || !isAdcode(v.adcode)) return;
  if (v.pcode !== undefined && (!isAdcode(v.pcode) || v.pcode.slice(0, 2) !== v.adcode.slice(0, 2))) return;
  if ([v.citycode, v.cityname].some((value) => value !== undefined && !text(value) && !(Array.isArray(value) && !value.length))) return;
  const location = point(v.location);
  if (!location) return;
  return { ref: { provider: "amap", externalId: v.id }, name: v.name.trim(), location, cityAdcode: cityAdcodeOf(v.adcode),
    ...(text(v.address) ? { address: v.address } : {}), ...(text(v.typecode, 100) ? { categoryCode: v.typecode } : {}) };
}
/** 只提取页面需要的有限业务字段，异常值直接省略；电话号码不保留。 */
function business(v: unknown): PlaceBusiness | undefined {
  if (!record(v)) return;
  const number = (value: unknown, max: number) =>
    typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= max ? Number(value) : undefined;
  const facts: PlaceBusiness = {
    ...(number(v.rating, 5) !== undefined ? { rating: number(v.rating, 5)! } : {}),
    ...(number(v.cost, 10_000) !== undefined ? { costYuan: number(v.cost, 10_000)! } : {}),
    ...(text(v.keytag, 20) ? { keytag: v.keytag.trim() } : {}),
    ...(typeof v.opentime_today === "string" && /^[\d:\- ]{5,40}$/.test(v.opentime_today) ? { openToday: v.opentime_today.trim() } : {}),
  };
  return Object.keys(facts).length ? facts : undefined;
}
const messages: Record<ProviderFailureCode, string> = {
  invalid_request: "仅支持中国大陆的城市、地点和有效的查询参数。", authorization_failed: "高德配置或服务权限不可用。",
  quota_exceeded: "高德调用配额不可用，请停止查询并核对控制台。", rate_limited: "请求过于频繁，请稍后手动重试。",
  timeout: "高德请求超时，已终止本次请求。", upstream_unavailable: "高德服务或网络暂时不可用。",
  malformed_response: "高德返回的数据缺失或格式不符合约定。", cancelled: "请求已取消。", unknown: "高德返回了未识别的错误。",
};
function failure(code: ProviderFailureCode, retryAfterSeconds?: number): ProviderFailure {
  const retry = code === "invalid_request" || code === "cancelled" ? "never" : code === "authorization_failed" ? "after_configuration_change" : code === "quota_exceeded" ? "after_quota_reset" : "after_backoff";
  return { code, retry, safeMessage: messages[code], ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}
const businessCodes: Record<string, ProviderFailureCode> = {
  "10001": "authorization_failed", "10002": "authorization_failed", "10003": "quota_exceeded", "10004": "rate_limited",
  "10005": "authorization_failed", "10006": "authorization_failed", "10007": "authorization_failed", "10008": "authorization_failed", "10009": "authorization_failed",
  "10010": "authorization_failed", "10011": "authorization_failed", "10012": "authorization_failed", "10013": "authorization_failed",
  "10014": "rate_limited", "10015": "rate_limited", "10016": "upstream_unavailable", "10017": "upstream_unavailable", "10019": "rate_limited", "10020": "rate_limited",
  "10021": "rate_limited", "10026": "authorization_failed", "10029": "rate_limited", "10041": "authorization_failed", "10044": "quota_exceeded", "10045": "quota_exceeded", "20000": "invalid_request", "20001": "invalid_request", "20002": "invalid_request", "20003": "unknown", "20011": "authorization_failed", "20012": "invalid_request", "20800": "invalid_request", "20801": "unknown", "20802": "unknown", "20803": "invalid_request", "40000": "quota_exceeded", "40002": "authorization_failed", "40003": "quota_exceeded",
};
class RequestFailure extends Error { constructor(readonly detail: ProviderFailure) { super(detail.code); } }
function fail(code: ProviderFailureCode): never { throw new RequestFailure(failure(code)); }

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("aborted"));
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
export interface AmapProviderOptions {
  readonly key: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  readonly timeoutMs?: number;
  /** 两步操作之间留出间隔，避免个人 Key 因短时突发请求被限流。 */
  readonly stepGapMs?: number;
}
/** 仅服务端调用，每个操作发一次请求，不自动重试，也不保留 POI 或原始响应。 */
export class AmapMobilityProvider implements MobilityProvider, PlaceLookupProvider, WeatherProvider, NearbyPlaceProvider, CityResolver {
  readonly #options: AmapProviderOptions;
  /** 城市编码 → 高德城市代码（公交 city1/city2 只认它，如杭州 0571）。行政区信息，不是地点数据。 */
  readonly #cityCodes = new Map<string, string>();
  constructor(options: AmapProviderOptions) {
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000)) throw new TypeError("Invalid provider timeout");
    this.#options = options;
  }
  #evidence(): ProviderEvidence {
    const retrievedAt = this.#options.now();
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(retrievedAt) || !Number.isFinite(Date.parse(retrievedAt))) throw new TypeError("Invalid provider clock");
    return { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt };
  }
  // 统一传输边界同时处理 HTTP 与高德业务状态；HTTP 200 也可能表示配额或权限失败。
  // 只向上暴露规范化失败码，原始 URL 含 Key，响应与网络错误都不能直接进入日志或界面。
  async #request(
    path:
      | "/v5/place/text"
      | "/v5/place/around"
      | "/v5/place/detail"
      | "/v5/direction/walking"
      | "/v5/direction/transit/integrated"
      | "/v5/direction/driving"
      | "/v5/direction/bicycling"
      | "/v3/assistant/coordinate/convert"
      | "/v3/geocode/regeo"
      | "/v3/config/district"
      | "/v3/weather/weatherInfo",
    params: Record<string, string>,
    options?: ProviderCallOptions,
  ): Promise<Record<string, unknown>> {
    if (options?.signal?.aborted) fail("cancelled");
    if (!this.#options.key.trim()) fail("authorization_failed");
    const url = new URL(path, "https://restapi.amap.com");
    url.search = new URLSearchParams({ ...params, key: this.#options.key, output: "json" }).toString();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 5000);
    try {
      const response = await abortable(
        this.#options.fetch(url, { signal: controller.signal, redirect: "error", cache: "no-store" }),
        controller.signal,
      );
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream_unavailable" : response.status === 401 || response.status === 403 ? "authorization_failed" : "unknown";
        const seconds = integer(response.headers.get("retry-after"));
        throw new RequestFailure(failure(code, seconds !== undefined && seconds <= 3600 ? seconds : undefined));
      }
      const reader = response.body?.getReader();
      if (!reader) fail("malformed_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await abortable(reader.read(), controller.signal);
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) { controller.abort(); await reader.cancel(); fail("malformed_response"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("malformed_response"); }
      if (!record(body) || !["0", "1"].includes(String(body.status)) || typeof body.status !== "string" || typeof body.infocode !== "string") fail("malformed_response");
      if (body.status !== "1") {
        const detail = failure(businessCodes[body.infocode] ?? "unknown");
        // 付费余额耗尽与每日配额不足不同，等待跨日重置不能解决余额问题。
        throw new RequestFailure(body.infocode === "40000" || body.infocode === "40003" ? { ...detail, retry: "after_configuration_change" } : detail);
      }
      if (body.infocode !== "10000") fail("malformed_response");
      return body;
    } catch (error) {
      if (error instanceof RequestFailure) throw error;
      // 不向上透传原始异常、堆栈、响应或 URL；请求 URL 含 Key，只返回受控错误代码。
      return fail(options?.signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "upstream_unavailable");
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", cancel);
    }
  }
  async searchPlaces(request: PlaceSearchRequest, options?: ProviderCallOptions): Promise<ProviderResult<PlaceSearchData>> {
    try {
      if (!record(request) || typeof request.query !== "string" || request.query.trim().length < 1 || request.query.trim().length > 80 ||
        !record(request.scope) || !["city", "nearby", "country"].includes(request.scope.kind) ||
        !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10) fail("invalid_request");
      const scope = request.scope;
      const city = scope.kind === "city" ? scope.cityAdcode : undefined;
      if (scope.kind === "city" && !isAdcode(city)) fail("invalid_request");
      const nearby = scope.kind === "nearby" ? scope : undefined;
      if (nearby && (!isAmapPoint(nearby.center) || !NEARBY_RADII.has(nearby.radiusMeters) || request.limit > 5)) fail("invalid_request");
      const pageSize = nearby ? request.limit : request.limit + 1;
      // 城市范围：只召回这个城市的（city_limit）；附近：按中心和半径，不限城市；全国：不带 region。
      const body = await this.#request(nearby ? "/v5/place/around" : "/v5/place/text", {
        keywords: request.query.trim(),
        ...(city ? { region: city, city_limit: "true" } : {}),
        page_num: "1", page_size: String(pageSize),
        ...(request.withBusiness ? { show_fields: "business" } : {}),
        ...(nearby ? {
          location: `${nearby.center.longitude.toFixed(6)},${nearby.center.latitude.toFixed(6)}`,
          radius: String(nearby.radiusMeters),
        } : {}),
      }, options);
      if (!Array.isArray(body.pois) || integer(body.count) !== body.pois.length || body.pois.length > pageSize) fail("malformed_response");
      const items: PlaceSummary[] = [];
      const seen = new Set<string>();
      let excludedCount = 0;
      for (const raw of body.pois) {
        const parsed = place(raw);
        if (!parsed) fail("malformed_response");
        if ((nearby && straightLineMeters(nearby.center, parsed.location) > nearby.radiusMeters) ||
          (city && parsed.cityAdcode !== cityAdcodeOf(city))) {
          excludedCount += 1;
          continue;
        }
        const facts = request.withBusiness && record(raw) ? business(raw.business) : undefined;
        if (!seen.has(parsed.ref.externalId)) { seen.add(parsed.ref.externalId); items.push(facts ? { ...parsed, business: facts } : parsed); }
      }
      return {
        status: "ok",
        data: {
          items: items.slice(0, request.limit),
          truncated: nearby ? body.pois.length === pageSize : items.length > request.limit,
          ...(nearby || excludedCount ? { excludedCount } : {}),
        },
        evidence: this.#evidence(),
      };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }
  /** 按 ID 查询每批最多 10 个；高德会静默省略未知 ID，因此适配层显式返回缺失列表。 */
  async findPlacesById(
    externalIds: readonly string[],
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<PlaceLookupData>> {
    try {
      if (
        !Array.isArray(externalIds) || externalIds.length < 1 || externalIds.length > 10 ||
        !externalIds.every(id) || new Set(externalIds).size !== externalIds.length
      ) {
        fail("invalid_request");
      }
      // 当天营业时间随同一次查点返回，用于显示与排程，不进入长期存储。
      const body = await this.#request("/v5/place/detail", { id: externalIds.join("|"), show_fields: "business" }, options);
      if (!Array.isArray(body.pois) || integer(body.count) !== body.pois.length || body.pois.length > externalIds.length) {
        fail("malformed_response");
      }
      const items: PlaceSummary[] = [];
      for (const raw of body.pois) {
        const parsed = place(raw);
        if (!parsed || !externalIds.includes(parsed.ref.externalId)) fail("malformed_response");
        const facts = record(raw) ? business(raw.business) : undefined;
        if (!items.some((item) => item.ref.externalId === parsed.ref.externalId)) items.push(facts ? { ...parsed, business: facts } : parsed);
      }
      const found = new Set(items.map((item) => item.ref.externalId));
      return {
        status: "ok",
        data: { items, missing: externalIds.filter((externalId) => !found.has(externalId)) },
        evidence: this.#evidence(),
      };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }
  /** 城市级今天及后三天天气预报；响应结构已用真实返回核对（2026-10-13）。 */
  async getWeatherForecast(
    cityAdcode: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<WeatherForecastData>> {
    try {
      if (!isAdcode(cityAdcode)) fail("invalid_request");
      const body = await this.#request(
        "/v3/weather/weatherInfo",
        { city: cityAdcode, extensions: "all" },
        options,
      );
      const forecast = Array.isArray(body.forecasts) && body.forecasts.length === 1 ? body.forecasts[0] : null;
      if (!record(forecast) || forecast.adcode !== cityAdcode || !Array.isArray(forecast.casts)) {
        fail("malformed_response");
      }
      const reportedAt = typeof forecast.reporttime === "string" ? forecast.reporttime : "";
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(reportedAt) || forecast.casts.length > 7) {
        fail("malformed_response");
      }
      const days = forecast.casts.map((cast) => weatherDay(cast));
      if (days.some((day) => day === null)) fail("malformed_response");
      return {
        status: "ok",
        data: {
          cityAdcode,
          reportedAt: `${reportedAt.replace(" ", "T")}+08:00`,
          days: days as WeatherDay[],
        },
        evidence: this.#evidence(),
      };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }
  /** 城市实时天气只提取天气描述与报告时间，接口使用 extensions=base。 */
  async getLiveWeather(cityAdcode: string, options?: ProviderCallOptions): Promise<ProviderResult<LiveWeatherData>> {
    try {
      if (!isAdcode(cityAdcode)) fail("invalid_request");
      const body = await this.#request("/v3/weather/weatherInfo", { city: cityAdcode, extensions: "base" }, options);
      const live = Array.isArray(body.lives) && body.lives.length === 1 ? body.lives[0] : null;
      if (!record(live) || live.adcode !== cityAdcode || typeof live.weather !== "string" || !/^[\u4e00-\u9fa5/]{1,12}$/.test(live.weather)) {
        fail("malformed_response");
      }
      const reportedAt = typeof live.reporttime === "string" ? live.reporttime : "";
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(reportedAt)) fail("malformed_response");
      return {
        status: "ok",
        data: { cityAdcode, weather: live.weather, reportedAt: `${reportedAt.replace(" ", "T")}+08:00` },
        evidence: this.#evidence(),
      };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }
  /**
   * 统一步行、公交地铁、打车、骑行与自驾结果，全部属于估算。
   * 打车使用驾车时长加高德费用字段，不能冒充已叫车后的实际时长或车费。
   */
  async findRoutes(request: RouteRequest, options?: ProviderCallOptions): Promise<RouteResult> {
    try {
      if (options?.signal?.aborted) fail("cancelled");
      const modes = ["walking", "transit", "taxi", "bicycling", "driving"];
      if (
        !record(request) || !isAdcode(request.cityAdcode) ||
        [request.origin, request.destination].some((end) => record(end) && end.cityAdcode !== undefined && !isAdcode(end.cityAdcode)) ||
        !isAmapEndpoint(request.origin) || !isAmapEndpoint(request.destination) ||
        !modes.includes(request.mode) || typeof request.departureAt !== "string" ||
        !Number.isFinite(Date.parse(request.departureAt)) || !/(Z|[+-]\d{2}:\d{2})$/.test(request.departureAt)
      ) {
        fail("invalid_request");
      }
      const coordinate = (p: GeoPoint) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`;
      const ends = { origin: coordinate(request.origin.location), destination: coordinate(request.destination.location) };
      const option = request.mode === "transit"
        ? await this.#transit({
          ...ends,
          city1: await this.#cityCode(request.origin.cityAdcode ?? request.cityAdcode, options),
          city2: await this.#cityCode(request.destination.cityAdcode ?? request.cityAdcode, options),
        }, options)
        : request.mode === "taxi" || request.mode === "driving"
          ? await this.#driving(ends, request.mode, options)
          : await this.#simple(request.mode, {
              ...ends,
              ...(request.mode === "walking"
                ? { origin_id: request.origin.place.externalId, destination_id: request.destination.place.externalId }
                : {}),
            }, options);
      if (!option) return { status: "no_route", reason: "no_path", evidence: this.#evidence() };
      return { status: "ok", routes: [option], evidence: this.#evidence() };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }

  async #simple(
    mode: "walking" | "bicycling",
    params: Record<string, string>,
    options?: ProviderCallOptions,
  ): Promise<RouteOption | null> {
    const body = await this.#request(
      mode === "walking" ? "/v5/direction/walking" : "/v5/direction/bicycling",
      { ...params, show_fields: "cost,polyline", ...(mode === "walking" ? { alternative_route: "1" } : {}) },
      options,
    );
    // 此分支只接受唯一候选路径；多条路径无法在未定义选择规则时静默替用户选择。
    if (!record(body.route) || !Array.isArray(body.route.paths) || body.route.paths.length > 1) fail("malformed_response");
    if (body.route.paths.length === 0) return null;
    const path = body.route.paths[0];
    if (!record(path)) fail("malformed_response");
    // 步行时长在 cost 下，骑行在路径本身，需分别读取，不能直接套同一响应结构。
    const durationSeconds = integer(mode === "walking" ? (record(path.cost) ? path.cost.duration : undefined) : path.duration);
    const distanceMeters = integer(path.distance);
    if (durationSeconds === undefined || distanceMeters === undefined) fail("malformed_response");
    return { mode, durationSeconds, distanceMeters, path: stepsPath(path.steps) };
  }

  async #driving(ends: Record<string, string>, mode: "taxi" | "driving", options?: ProviderCallOptions): Promise<RouteOption | null> {
    const body = await this.#request("/v5/direction/driving", { ...ends, show_fields: "cost,polyline" }, options);
    if (!record(body.route) || !Array.isArray(body.route.paths)) fail("malformed_response");
    if (body.route.paths.length === 0) return null;
    const path = body.route.paths[0];
    if (!record(path) || !record(path.cost)) fail("malformed_response");
    const durationSeconds = integer(path.cost.duration);
    const distanceMeters = integer(path.distance);
    if (durationSeconds === undefined || distanceMeters === undefined) fail("malformed_response");
    const taxiFare = yuan(body.route.taxi_cost);
    return {
      mode,
      durationSeconds,
      distanceMeters,
      ...(mode === "taxi" && taxiFare !== undefined ? { fareYuan: taxiFare } : {}),
      path: stepsPath(path.steps),
    };
  }

  async #transit(ends: Record<string, string>, options?: ProviderCallOptions): Promise<RouteOption | null> {
    const body = await this.#request(
      "/v5/direction/transit/integrated",
      { ...ends, show_fields: "cost,polyline" },
      options,
    );
    if (!record(body.route) || !Array.isArray(body.route.transits)) fail("malformed_response");
    // 公交方案按高德推荐顺序取首个真正使用线路的方案，避免把纯步行结果误称为公交。
    const transit = body.route.transits.find((item) =>
      record(item) && Array.isArray(item.segments) && item.segments.some((segment) => record(segment) && record(segment.bus)));
    if (!transit) return null;
    if (!record(transit.cost) || !Array.isArray(transit.segments)) fail("malformed_response");
    const durationSeconds = integer(transit.cost.duration);
    const distanceMeters = integer(transit.distance);
    if (durationSeconds === undefined || distanceMeters === undefined) fail("malformed_response");
    const lines: string[] = [];
    const path: [number, number][] = [];
    for (const segment of transit.segments) {
      if (!record(segment)) continue;
      if (record(segment.walking)) path.push(...stepsPath(segment.walking.steps));
      const line = record(segment.bus) && Array.isArray(segment.bus.buslines) ? segment.bus.buslines[0] : undefined;
      if (record(line)) {
        if (text(line.name, 80)) lines.push(line.name.replace(/\(.*\)$/, "").trim());
        path.push(...polylinePoints(record(line.polyline) ? line.polyline.polyline : line.polyline));
      }
    }
    const fare = yuan(transit.cost.transit_fee);
    const walkingMeters = integer(transit.walking_distance);
    return {
      mode: "transit",
      durationSeconds,
      distanceMeters,
      ...(fare !== undefined ? { fareYuan: fare } : {}),
      ...(lines.length ? { summary: lines.join(" → ").slice(0, 80) } : {}),
      ...(walkingMeters !== undefined ? { walkingMeters } : {}),
      path: downsample(path),
    };
  }

  /**
   * V2.10：用户说的城市名换成城市编码（行政区查询）。只接受地级市、直辖市和省直辖县级市；
   * 区县、乡镇、景点名都不算城市（“乌镇”“西湖区”交给地点搜索）。
   */
  async resolveCity(name: string, options?: ProviderCallOptions): Promise<ProviderResult<CityRef>> {
    try {
      if (!text(name, 20)) fail("invalid_request");
      const found = await this.#district(name.trim(), options);
      const level = found?.level;
      const isCity = found && (level === "city" || (level === "province" && isMunicipality(found.adcode)) ||
        (level === "district" && found.adcode.slice(2, 4) === "90"));
      if (!found || !isCity) fail("invalid_request");
      if (text(found.citycode, 10)) this.#cityCodes.set(cityAdcodeOf(found.adcode), found.citycode);
      return { status: "ok", data: { adcode: cityAdcodeOf(found.adcode), name: found.name }, evidence: this.#evidence() };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }

  /** 行政区查询的第一条结果（不要下级、不要边界）。 */
  async #district(keywords: string, options?: ProviderCallOptions) {
    const body = await this.#request("/v3/config/district", { keywords, subdistrict: "0", extensions: "base" }, options);
    if (!Array.isArray(body.districts)) fail("malformed_response");
    const first: unknown = body.districts[0];
    if (first === undefined) return null;
    if (!record(first) || !isAdcode(first.adcode) || !text(first.name, 40) || typeof first.level !== "string") fail("malformed_response");
    return { adcode: first.adcode, name: first.name.trim(), level: first.level, citycode: first.citycode };
  }

  /** 公交的 city1/city2：城市编码换成高德城市代码，每个城市只查一次。 */
  async #cityCode(cityAdcode: string, options?: ProviderCallOptions): Promise<string> {
    const city = cityAdcodeOf(cityAdcode);
    const cached = this.#cityCodes.get(city);
    if (cached) return cached;
    const found = await this.#district(city, options);
    if (!found || !text(found.citycode, 10)) fail("malformed_response");
    this.#cityCodes.set(city, found.citycode);
    return found.citycode;
  }

  /** 原始设备坐标先转高德坐标，再解析成带 ID 的最近地点；只返回地点，不回显精确设备点。 */
  async nearestPlace(
    devicePoint: { readonly longitude: number; readonly latitude: number },
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<NearestPlaceData>> {
    try {
      const valid = (value: number, limit: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
      if (!record(devicePoint) || !valid(devicePoint.longitude, 180) || !valid(devicePoint.latitude, 90)) fail("invalid_request");
      const converted = await this.#request("/v3/assistant/coordinate/convert", {
        locations: `${devicePoint.longitude.toFixed(6)},${devicePoint.latitude.toFixed(6)}`,
        coordsys: "gps",
      }, options);
      const location = point(converted.locations);
      if (!location) fail("malformed_response");
      if (this.#options.stepGapMs) await new Promise((resolve) => setTimeout(resolve, this.#options.stepGapMs));
      const body = await this.#request("/v3/geocode/regeo", {
        location: `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`,
        extensions: "all",
        radius: "500",
      }, options);
      const regeo = record(body.regeocode) ? body.regeocode : null;
      const area = regeo && record(regeo.addressComponent) ? regeo.addressComponent : null;
      if (!regeo || !area || !Array.isArray(regeo.pois)) fail("malformed_response");
      // V2.10：任何城市都解析；同时带回所在城市（直辖市、省直辖县级市的 city 字段为空，用省名或区县名）。
      if (!isAdcode(area.adcode)) fail("invalid_request");
      const cityName = text(area.city, 40) ? area.city : isMunicipality(area.adcode) ? area.province : area.district;
      if (!text(cityName, 40)) fail("malformed_response");
      const city: CityRef = { adcode: cityAdcodeOf(area.adcode), name: cityName.trim() };
      // 优先用所在或紧邻的园区、校园、商场、公园来表达当前位置。
      // 这类地点有正式 ID，可作为后续排程的起点。
      const enclosing = (Array.isArray(regeo.aois) ? regeo.aois : [])
        .map((raw) => ({ raw, distance: record(raw) ? Number(raw.distance) : NaN }))
        .filter((item) => Number.isFinite(item.distance) && item.distance <= AOI_RADIUS_METERS)
        .sort((a, b) => a.distance - b.distance)
        .map((item) => ({ place: place({ ...(item.raw as Record<string, unknown>), adcode: area.adcode }), distance: item.distance }))
        .find((item) => item.place);
      if (enclosing?.place) {
        return { status: "ok", data: { place: enclosing.place, distanceMeters: Math.round(enclosing.distance), city }, evidence: this.#evidence() };
      }
      // 没有合适区域时再选附近 POI；银行、诊所和办公点辨识度低，
      // 允许优先选稍远但更好认的地点。
      const weighted = (raw: unknown, distance: number) =>
        distance + (record(raw) && typeof raw.type === "string" && POOR_LANDMARK.test(raw.type) ? POOR_LANDMARK_PENALTY_METERS : 0);
      const nearest = regeo.pois
        .map((raw) => ({ raw, distance: record(raw) ? Number(raw.distance) : NaN }))
        .filter((item) => Number.isFinite(item.distance))
        .sort((a, b) => weighted(a.raw, a.distance) - weighted(b.raw, b.distance))
        .map((item) => ({ place: place({ ...(item.raw as Record<string, unknown>), adcode: area.adcode }), distance: item.distance }))
        .find((item) => item.place);
      if (!nearest?.place) return { status: "failure", failure: failure("malformed_response"), evidence: this.#evidence() };
      return {
        status: "ok",
        data: { place: nearest.place, distanceMeters: Math.round(nearest.distance), city },
        evidence: this.#evidence(),
      };
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      return { status: "failure", failure: error.detail, evidence: this.#evidence() };
    }
  }
}

/** 这些顶级类别不适合用作“我在这里附近”的地点名，优先考虑更容易辨认的公共地点。 */
const POOR_LANDMARK = /^(医疗保健服务|政府机构及社会团体|金融保险服务|生活服务|公司企业)/;
const POOR_LANDMARK_PENALTY_METERS = 200;
const AOI_RADIUS_METERS = 150;

const weatherText = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 20 ? value.trim() : null;
const celsius = (value: unknown): number | null => {
  const number = typeof value === "string" && /^-?\d{1,2}(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number > -60 && number < 60 ? number : null;
};

function weatherDay(raw: unknown): WeatherDay | null {
  if (!record(raw) || typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  const dayWeather = weatherText(raw.dayweather);
  const nightWeather = weatherText(raw.nightweather);
  const high = celsius(raw.daytemp_float ?? raw.daytemp);
  const low = celsius(raw.nighttemp_float ?? raw.nighttemp);
  if (!dayWeather || !nightWeather || high === null || low === null) return null;
  return {
    date: raw.date,
    dayWeather,
    nightWeather,
    highCelsius: high,
    lowCelsius: low,
    wet: /雨|雪|雹/.test(dayWeather + nightWeather),
    ...(windForce(raw.daypower) >= 6 || windForce(raw.nightpower) >= 6 ? { windy: true } : {}),
  };
}

/** V2.10：高德风力是“≤3”“4”“5-6”这类写法，取其中最大的级数；读不出来按 0。 */
function windForce(value: unknown): number {
  if (typeof value !== "string") return 0;
  return Math.max(0, ...(value.match(/\d{1,2}/g) ?? []).map(Number));
}

/** 高德费用可能是小数字符串，转换为元后再校验，缺失不等于免费。 */
function yuan(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,4}(\.\d{1,2})?$/.test(value)) return;
  return Number(value);
}

/** 将分号分隔的经纬度串解析为点，跳过非法坐标对。 */
function polylinePoints(value: unknown): [number, number][] {
  if (typeof value !== "string") return [];
  return value.split(";").flatMap((pair) => {
    const [longitude, latitude] = pair.split(",").map(Number);
    return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
      ? [[longitude, latitude] as [number, number]]
      : [];
  });
}

/** 步行和驾车的 steps 直接带 polyline，公交步行段则嵌在对象中，分别提取后统一处理。 */
function stepsPath(steps: unknown): [number, number][] {
  if (!Array.isArray(steps)) return [];
  return downsample(steps.flatMap((step) =>
    record(step) ? polylinePoints(record(step.polyline) ? step.polyline.polyline : step.polyline) : []));
}

/** 最多保留 200 个点以控制地图负担，始终保留两端，避免抽稀后路线接不上标记。 */
function downsample(points: readonly [number, number][], limit = 200): [number, number][] {
  if (points.length <= limit) return [...points];
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * step)]);
}
