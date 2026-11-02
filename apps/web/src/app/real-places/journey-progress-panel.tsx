"use client";

import type { PlanningMapConfig } from "../journeys/map-config";
import { TripProgressPanel, useTripProgress } from "../plan/trip-progress";
import type { TripProgressView } from "../plan/trip-estimate";
import { useLiveLocation } from "../plan/use-live-location";

/** V2.5: the journey page's progress, the same panel as beside the conversation (V2.6: with live position). */
export function JourneyProgressPanel({ initial, mapConfig }: { initial: TripProgressView; mapConfig: PlanningMapConfig }) {
  const state = useTripProgress(initial.journeyId, initial);
  const live = useLiveLocation();
  return <TripProgressPanel state={state} mapConfig={mapConfig} live={live} showConversationLink />;
}
