import "server-only";
import { withUser, type WithUser } from "../../auth/session";
import { z } from "zod";
import { readBody, sameOrigin } from "../planning/request-body";
import { createTripProgressService, type TripProgressOptions } from "../../plan/trip-progress-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const markSchema = z.strictObject({
  action: z.enum(["complete", "skip"]),
  activityId: z.uuid(),
  reportId: z.uuid(),
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().nonnegative(),
});
const STATUS: Record<string, number> = {
  saved: 201, already_saved: 200, no_change: 200, not_found: 404, not_today: 409, stale: 409,
  invalid_report: 422, intent_conflict: 409, source_not_allowed: 403,
};

/**
 * V2.5 /api/journeys/[id]/trip-progress: GET the progress panel of a real day (map points
 * looked up live, not stored); POST "完成" / "跳过" on one stop.
 */
export function createTripProgressHandlers(options: WithUser<TripProgressOptions> = {}) {
  const service = (userId: string) => createTripProgressService({ ...options, userId });
  return {
    GET: withUser<{ params: Promise<{ journeyId: string }> }>(options, async (_request, user, context) => {
      const { journeyId } = await context.params;
      if (!UUID.test(journeyId)) return json({ status: "not_found" }, 404);
      try {
        const view = await service(user.id).load(journeyId);
        return view ? json({ status: "ok", view }) : json({ status: "not_found" }, 404);
      } catch {
        return json({ status: "unavailable" }, 503);
      }
    }),
    POST: withUser<{ params: Promise<{ journeyId: string }> }>(options, async (request, user, context) => {
      const { journeyId } = await context.params;
      if (!UUID.test(journeyId)) return json({ status: "not_found" }, 404);
      if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
      const body = await readBody(request);
      if (body === "too_large" || body === "invalid") return json({ status: "invalid_request" }, 400);
      let input;
      try {
        input = markSchema.parse(JSON.parse(body));
      } catch {
        return json({ status: "invalid_request" }, 400);
      }
      try {
        const result = await service(user.id).mark(journeyId, input);
        return json(result, STATUS[result.status] ?? 500);
      } catch {
        return json({ status: "unavailable" }, 503);
      }
    }),
  };
}
