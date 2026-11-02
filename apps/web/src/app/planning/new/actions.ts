"use server";

import { randomUUID } from "node:crypto";
import type { ReviewReply, SearchReply } from "./contracts";
import { createS52LiveBudget, LiveBudgetError, s52LedgerPath } from "./live-budget";
import { createPlanningService } from "./planning-service";
import { readRealPlaceMode } from "../../real-places/real-mode";
import { createUserUsage } from "../../usage/usage";
import { pageUser } from "../../auth/session";

/** With S5.2 amap generation enabled, manual searches spend the same round budget. */
function liveSearchReservation(userId: string): (() => Promise<void>) | undefined {
  // S5.5 personal real mode: every Amap request counts against the daily ledger instead.
  if (readRealPlaceMode().enabled) {
    const usage = createUserUsage(userId);
    return () => usage.reserve("amap", "search", "search");
  }
  if (
    process.env.PLANNING_PLACE_SOURCE !== "amap" ||
    process.env.PLANNING_GENERATION_ENABLED !== "true" ||
    process.env.PLANNING_AMAP_GENERATION_ENABLED !== "true"
  ) {
    return undefined;
  }

  // Model availability does not remove the manual search budget obligation.
  const round = process.env.PLANNING_LIVE_ROUND;
  if (round !== "developer" && round !== "independent-test") {
    return async () => {
      throw new LiveBudgetError();
    };
  }
  const budget = createS52LiveBudget(s52LedgerPath(), round);
  return () => budget.reserveRequest(`manual-${randomUUID()}`, "search", true);
}

export async function searchPlanningPlaces(
  query: unknown,
): Promise<SearchReply> {
  const user = await pageUser("/planning/new");
  return createPlanningService({
    beforeLiveSearch: liveSearchReservation(user.id),
  }).search(query);
}

export async function reviewPlanningRequirements(
  input: unknown,
): Promise<ReviewReply> {
  await pageUser("/planning/new");
  return createPlanningService().review(input);
}
