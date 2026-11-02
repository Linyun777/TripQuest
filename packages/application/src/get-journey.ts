import type {
  GetJourneyOutcome,
  JourneyDetailsActivity,
  JourneyRepository,
  StoredJourney,
} from "./contracts";
import { isJourneyId } from "./runtime-values";
import { toDayProgressView } from "./day-progress";
import { assertGeneratedDayMatchesJourney, generatedDayDetailsSchema } from "./generated-day-read";
import { assertRealDayMatchesJourney, storedRealDaySchema } from "./real-day";

export class JourneyReadModelError extends Error {
  override readonly name = "JourneyReadModelError";
}

export async function getJourney(
  journeyId: unknown,
  repository: JourneyRepository,
  version?: number,
): Promise<GetJourneyOutcome> {
  if (!isJourneyId(journeyId)) return { status: "invalid_id" };

  const stored = version === undefined
    ? await repository.findCurrentJourney(journeyId)
    : await repository.findJourneyVersion?.(journeyId, version) ?? null;
  if (stored === null) return { status: "not_found" };
  if (stored.journeyId !== journeyId) {
    throw new JourneyReadModelError("Repository returned another journey");
  }

  return {
    status: "found",
    journey: mapJourneyDetails(stored),
  };
}

function mapJourneyDetails(stored: StoredJourney) {
  if (stored.creationKind === "generated_day") {
    if (!stored.dayDetails) throw new JourneyReadModelError("Generated day details are missing");
    assertGeneratedDayMatchesJourney(generatedDayDetailsSchema.parse(stored.dayDetails), stored);
    if ((stored.currentObservationVersion > 0) !== (stored.dayProgress !== undefined)) {
      throw new JourneyReadModelError("Generated progress does not match its version");
    }
  } else if (stored.creationKind === "real_day") {
    if (!stored.realDay || stored.dayDetails) {
      throw new JourneyReadModelError("Real day details are invalid");
    }
    // V2.5: real days record progress too, kept by the same observation versions.
    if ((stored.currentObservationVersion > 0) !== (stored.dayProgress !== undefined)) {
      throw new JourneyReadModelError("Real day progress does not match its version");
    }
    assertRealDayMatchesJourney(storedRealDaySchema.parse(stored.realDay), stored);
  } else if (stored.creationKind !== "manual" || stored.dayDetails !== undefined) {
    throw new JourneyReadModelError("Invalid journey creation kind");
  }
  if (stored.journeyId !== stored.currentPlan.journeyId) {
    throw new JourneyReadModelError("Current plan belongs to another journey");
  }

  const snapshotsByActivityId = new Map(
    stored.activitySnapshots.map((snapshot) => [snapshot.activityId, snapshot]),
  );
  if (snapshotsByActivityId.size !== stored.activitySnapshots.length) {
    throw new JourneyReadModelError("Duplicate activity snapshot");
  }
  if (stored.activitySnapshots.length !== stored.currentPlan.activities.length) {
    throw new JourneyReadModelError("Activity snapshot count does not match current plan");
  }

  const reservationsById = new Map(
    stored.reservations.map((snapshot) => [snapshot.reservation.id, snapshot]),
  );
  if (reservationsById.size !== stored.reservations.length) {
    throw new JourneyReadModelError("Duplicate reservation snapshot");
  }

  const activities: JourneyDetailsActivity[] = stored.currentPlan.activities.map(
    (activity, position) => {
      const snapshot = snapshotsByActivityId.get(activity.id);
      if (snapshot === undefined || snapshot.position !== position) {
        throw new JourneyReadModelError("Activity position does not match current plan order");
      }

      if (activity.reservationId === undefined) {
        return {
          ...activity,
          position,
          placeName: snapshot.placeName,
          kind: "activity",
        };
      }

      const reservationSnapshot = reservationsById.get(activity.reservationId);
      if (reservationSnapshot === undefined) {
        throw new JourneyReadModelError("Linked reservation is missing");
      }
      const reservation = reservationSnapshot.reservation;
      if (
        reservation.placeId !== activity.placeId ||
        reservation.startsAt !== activity.startsAt ||
        reservation.endsAt !== activity.endsAt ||
        !activity.locked ||
        activity.priority !== "high"
      ) {
        throw new JourneyReadModelError(
          "Linked activity does not preserve its fixed reservation",
        );
      }
      return {
        ...activity,
        position,
        placeName: snapshot.placeName,
        kind: "reservation",
        reservation: {
          id: reservation.id,
          confirmationStatus: reservation.confirmation.status,
          sourceKind: reservation.confirmation.source.kind,
          recordedAt: reservation.confirmation.recordedAt,
        },
      };
    },
  );

  return {
    creationKind: stored.creationKind,
    ...(stored.creationKind === "generated_day" ? {
      observationVersion: stored.currentObservationVersion,
      currentVersion: stored.currentPlanVersion ?? stored.currentPlan.version,
      // A history version shows its own frozen basis, never the live report.
      ...((stored.currentPlanVersion ?? stored.currentPlan.version) === stored.currentPlan.version
        ? { dayProgress: toDayProgressView(stored.dayProgress) }
        : {}),
    } : {}),
    ...(stored.dayDetails ? { dayDetails: stored.dayDetails } : {}),
    ...(stored.realDay ? { realDay: stored.realDay } : {}),
    journeyId: stored.journeyId,
    title: stored.title,
    date: stored.currentPlan.date,
    timeZone: stored.currentPlan.timeZone,
    version: stored.currentPlan.version,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    activities,
  };
}
