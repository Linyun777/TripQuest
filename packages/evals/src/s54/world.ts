import type { PlanningPlace } from "@tripquest/application/planning";
import type {
  MobilityProvider,
  PlaceSearchData,
  PlaceSearchRequest,
  ProviderCallOptions,
  ProviderResult,
  RouteRequest,
  RouteResult,
} from "@tripquest/providers";
import {
  PlanningFixtureProvider,
  planningFixtureEvidence,
  planningFixturePlaces,
} from "@tripquest/providers/planning-fixture";

/** Fixed evaluation clock: every run sees the same "now" and the same route evidence time. */
export const S54_NOW = Date.parse("2026-10-15T01:00:00Z");

/** The eight handwritten fixture places, by their stable external IDs. */
export type FixturePlaceId =
  | "DEMO-START" | "DEMO-MUSEUM-A" | "DEMO-MUSEUM-B" | "DEMO-PARK"
  | "DEMO-FOOD" | "DEMO-GARDEN" | "DEMO-WALK" | "DEMO-CAFE";

export function selection(externalId: FixturePlaceId): PlanningPlace {
  const place = planningFixturePlaces().find((item) => item.ref.externalId === externalId);
  if (!place) throw new Error(`Unknown fixture place ${externalId}`);
  return { place, evidence: planningFixtureEvidence(S54_NOW) };
}

/** Evaluation-only faults. Results keep the fixture evidence; only availability changes. */
export interface S54Faults {
  /** Directed walking legs that report "no_route". */
  readonly missingRoutes?: readonly (readonly [FixturePlaceId, FixturePlaceId])[];
  /** The first N place searches return a timeout failure. */
  readonly searchTimeouts?: number;
  /** Search queries that return no items. */
  readonly emptyQueries?: readonly string[];
}

/** Wraps the fixture provider; counts calls so reports can show what each policy asked for. */
export class FaultInjectingProvider implements MobilityProvider {
  private readonly fixture = new PlanningFixtureProvider(() => S54_NOW);
  searches = 0;
  routes = 0;

  constructor(private readonly faults: S54Faults = {}) {}

  async searchPlaces(
    request: PlaceSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<PlaceSearchData>> {
    this.searches += 1;
    if (this.searches <= (this.faults.searchTimeouts ?? 0)) {
      return {
        status: "failure",
        failure: { code: "timeout", retry: "after_backoff", safeMessage: "演示超时。" },
        evidence: planningFixtureEvidence(S54_NOW),
      };
    }
    if (this.faults.emptyQueries?.includes(request.query.trim())) {
      return {
        status: "ok",
        data: { items: [], truncated: false, excludedCount: 0 },
        evidence: planningFixtureEvidence(S54_NOW),
      };
    }
    return this.fixture.searchPlaces(request, options);
  }

  async findRoutes(request: RouteRequest, options?: ProviderCallOptions): Promise<RouteResult> {
    this.routes += 1;
    const missing = this.faults.missingRoutes?.some(([from, to]) =>
      request.origin.place.externalId === from && request.destination.place.externalId === to);
    if (missing) {
      return { status: "no_route", reason: "no_path", evidence: planningFixtureEvidence(S54_NOW) };
    }
    return this.fixture.findRoutes(request, options);
  }
}
