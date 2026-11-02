import "server-only";
import type { PlaceSearchData, ProviderResult } from "@tripquest/providers";
import { PlanningFixtureProvider } from "@tripquest/providers/planning-fixture";

/** Handwritten fiction shared with generation. Never replace it with captured live responses. */
export function searchPlanningFixture(
  query: string,
  now: number,
): Promise<ProviderResult<PlaceSearchData>> {
  return new PlanningFixtureProvider(() => now).searchPlaces({
    query,
    scope: { kind: "city", cityAdcode: "330100" },
    limit: 5,
  });
}
