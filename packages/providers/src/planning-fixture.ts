import type {
  MobilityProvider,
  PlaceSearchData,
  PlaceSearchRequest,
  PlaceSummary,
  ProviderCallOptions,
  ProviderEvidence,
  ProviderResult,
  RouteRequest,
  RouteResult,
} from "./contracts";
import { straightLineMeters } from "./geo-distance";

export const PLANNING_FIXTURE_PROVIDER = "tripquest-planning-fixture";
export const PLANNING_FIXTURE_VERSION = "planning-fixture.v2";
/** Handwritten fiction, never captured API responses or real venue facts. */
const entries = [
  ["DEMO-START", "演示起点", "虚构东街 1 号", 120, 30, "fixture:start"],
  ["DEMO-MUSEUM-A", "演示博物馆", "虚构文化街 2 号", 120.003, 30.002, "140100"],
  ["DEMO-MUSEUM-B", "演示博物馆", "虚构文化街 8 号", 120.008, 30.004, "140100"],
  ["DEMO-PARK", "演示公园步行街", "虚构绿地街 3 号", 120.01, 30.007, "110100"],
  ["DEMO-FOOD", "演示餐饮终点", "虚构食街 4 号", 120.012, 30.003, "050000"],
  ["DEMO-GARDEN", "演示公园花园", "虚构花园街 5 号", 120.006, 30.008, "110100"],
  ["DEMO-WALK", "演示步行街", "虚构街巷 6 号", 120.004, 30.005, "060000"],
  ["DEMO-CAFE", "演示餐饮小馆", "虚构茶街 7 号", 120.009, 30.006, "050000"],
] as const;

export function planningFixturePlaces(): PlaceSummary[] {
  return entries.map(([externalId, name, address, longitude, latitude, categoryCode]) => ({
    ref: { provider: PLANNING_FIXTURE_PROVIDER, externalId },
    name,
    address,
    cityAdcode: "330100",
    categoryCode,
    location: { longitude, latitude, coordinateSystem: "gcj02" },
  }));
}

export function planningFixtureEvidence(now: number): ProviderEvidence {
  return {
    provider: PLANNING_FIXTURE_PROVIDER,
    sourceKind: "fixture",
    retrievedAt: new Date(now).toISOString(),
    attribution: "TripQuest 手写演示地点与有向路线，全部虚构",
    datasetVersion: PLANNING_FIXTURE_VERSION,
  };
}

export class PlanningFixtureProvider implements MobilityProvider {
  constructor(private readonly now: () => number) {}

  private failed(code: "cancelled" | "invalid_request") {
    return {
      status: "failure" as const,
      failure: {
        code,
        retry: "never" as const,
        safeMessage: code === "cancelled" ? "请求已取消。" : "演示请求无效。",
      },
      evidence: planningFixtureEvidence(this.now()),
    };
  }

  async searchPlaces(
    request: PlaceSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<PlaceSearchData>> {
    if (options?.signal?.aborted) return this.failed("cancelled");
    if (!request.query.trim() || request.query.length > 80 || (request.scope.kind === "city" && request.scope.cityAdcode !== "330100") ||
      !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 5) {
      return this.failed("invalid_request");
    }
    const matches = planningFixturePlaces().filter((p) => p.name.includes(request.query.trim()));
    const scope = request.scope;
    const items = scope.kind === "nearby"
      ? matches.filter((p) => straightLineMeters(scope.center, p.location) <= scope.radiusMeters)
      : matches;
    return {
      status: "ok",
      data: { items: items.slice(0, request.limit), truncated: items.length > request.limit, excludedCount: matches.length - items.length },
      evidence: planningFixtureEvidence(this.now()),
    };
  }

  async findRoutes(request: RouteRequest, options?: ProviderCallOptions): Promise<RouteResult> {
    if (options?.signal?.aborted) return this.failed("cancelled");
    const places = planningFixturePlaces();
    const find = (endpoint: RouteRequest["origin"]) => places.findIndex((p) =>
      p.ref.provider === endpoint.place.provider && p.ref.externalId === endpoint.place.externalId &&
      JSON.stringify(p.location) === JSON.stringify(endpoint.location));
    const from = find(request.origin);
    const to = find(request.destination);
    if (from < 0 || to < 0 || request.mode !== "walking" || request.cityAdcode !== "330100") {
      return this.failed("invalid_request");
    }
    // The two directions deliberately differ. Even identical coordinates cannot invent a zero leg.
    const durationSeconds = 240 + Math.abs(to - from) * 120 + (from > to ? 61 : 1);
    return {
      status: "ok",
      routes: [{ mode: "walking", durationSeconds, distanceMeters: 250 + Math.abs(to - from) * 140 }],
      evidence: planningFixtureEvidence(this.now()),
    };
  }
}
