import type { TravelLegInput } from "@tripquest/domain";
import type { RouteOption, UnavailableRouteResult } from "./contracts";

function requirePlaceId(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty domain place id`);
  }
}

/** Converts only the route option the caller has explicitly selected. */
export function selectedRouteToTravelLeg(
  fromPlaceId: string,
  toPlaceId: string,
  selectedRoute: RouteOption,
): TravelLegInput {
  requirePlaceId(fromPlaceId, "fromPlaceId");
  requirePlaceId(toPlaceId, "toPlaceId");
  if (!Number.isSafeInteger(selectedRoute.durationSeconds) || selectedRoute.durationSeconds < 0) {
    throw new RangeError("selectedRoute.durationSeconds must be a non-negative safe integer");
  }
  return {
    fromPlaceId,
    toPlaceId,
    duration: { kind: "known", minutes: Math.ceil(selectedRoute.durationSeconds / 60) },
  };
}

/** No route and provider failures remain unknown to the S2 validator. */
export function unavailableRouteToTravelLeg(
  fromPlaceId: string,
  toPlaceId: string,
  result: UnavailableRouteResult,
): TravelLegInput {
  requirePlaceId(fromPlaceId, "fromPlaceId");
  requirePlaceId(toPlaceId, "toPlaceId");
  const reason = result.status === "no_route"
    ? `provider:no_route:${result.reason}`
    : `provider:failure:${result.failure.code}`;
  return { fromPlaceId, toPlaceId, duration: { kind: "unknown", reason } };
}
