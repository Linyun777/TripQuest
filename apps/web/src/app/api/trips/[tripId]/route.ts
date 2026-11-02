import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { sameOrigin } from "../../planning/request-body";
import { withUser } from "../../../auth/session";
import type { OutingTripPart } from "../../../plan/outing-progress";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** DELETE /api/trips/[id]: V2.11 deletes an outing; its days go with it (foreign key cascade). *
});
ntime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** DELETE /api/trips/[id]: V2.11 deletes an outing; its days go with it (foreign key cascade). */
export const DELETE = withUser<{ params: Promise<{ tripId: string }> }>({}, async (request, user, context): Promise<Response> => {
  const headers = { "cache-control": "no-store" };
  if (!sameOrigin(request)) return Response.json({ status: "forbidden" }, { status: 403, headers });
  const { tripId } = await context.params;
  if (!UUID.test(tripId)) return Response.json({ status: "not_found" }, { status: 404, headers });
  try {
    const result = await new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user.id).deleteTrip(tripId);
    return Response.json({ status: result }, { status: result === "deleted" ? 200 : 404, headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
});

/**
 * GET /api/trips/[id]: V2.11 an outing's structure for the progress panel: each day's parts in order
 * (a day plan by journey id, a fixed ride by our own times, a direct trip). Names and times only.
 */
export const GET = withUser<{ params: Promise<{ tripId: string }> }>({}, async (_request, user, context): Promise<Response> => {
  const headers = { "cache-control": "no-store" };
  const { tripId } = await context.params;
  if (!UUID.test(tripId)) return Response.json({ status: "not_found" }, { status: 404, headers });
  try {
    const trip = await new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user.id).findTrip(tripId);
    if (!trip) return Response.json({ status: "not_found" }, { status: 404, headers });
    const days = trip.details.days.map((day) => ({
      day: day.day,
      date: day.date,
      parts: day.parts.flatMap((part): OutingTripPart[] => {
        if (part.kind === "plan") {
          const journey = trip.days.find((item) => item.day === day.day && item.part === part.part);
          return journey ? [{ kind: "plan" as const, journeyId: journey.journeyId }] : [];
        }
        if (part.kind === "connect") return [part];
        const ride = trip.details.transports[part.transport];
        return ride ? [{
          kind: "transfer" as const, mode: ride.mode, from: ride.from.name, to: ride.to.name,
          departAt: ride.departAt, arriveAt: ride.arriveAt, nextDay: ride.arriveDay === "next", estimated: ride.estimated,
        }] : [];
      }),
    }));
    return Response.json({ status: "ok", trip: { id: trip.id, title: trip.title, days } }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
});
