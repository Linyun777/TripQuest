import type { InitialTrip } from "@tripquest/application/outing-trip";
import type { InitialRealDayDraft } from "@tripquest/application/real-day";

// Synthetic IDs and names only; no real Amap data.
export const id = (group: number, item: number) => `6000000${group}-0000-4000-8000-${String(item).padStart(12, "0")}`;
const at = "2026-10-15T09:00:00+08:00" as const;

/** 第 day 天的一段：一个地点，起终点是合成的住处。 */
export function segment(group: number, date: string): InitialRealDayDraft {
  const [journey, run, hotelId, place, activity] = [1, 2, 3, 4, 6].map((item) => id(group, item));
  return {
    journeyId: journey!,
    title: `合成出游 · 第 ${group} 天`,
    city: { adcode: "990100", name: "云岭市" },
    createdAt: at,
    updatedAt: at,
    creationRunId: run!,
    creationIntentFingerprint: "a".repeat(64),
    currentPlan: {
      journeyId: journey!,
      date,
      timeZone: "Asia/Shanghai",
      version: 1,
      changeReason: "initial_creation",
      activities: [{ id: activity!, placeId: place!, startsAt: `${date}T10:00:00+08:00`, endsAt: `${date}T11:30:00+08:00`, priority: "high", locked: false }],
    },
    activitySnapshots: [{ activityId: activity!, position: 0, placeName: "合成古镇" }],
    reservations: [],
    realDay: {
      schemaVersion: "stored-real-day.v1",
      planVersion: 1,
      context: {
        creationRunId: run!,
        requirementsFingerprint: "b".repeat(64),
        date,
        timeZone: "Asia/Shanghai",
        window: { startsAt: 540, endsAt: 1200 },
        startPlaceId: hotelId!,
        endPlaceId: hotelId!,
        bufferMinutes: 5,
        pace: "standard",
        interests: [],
      },
      places: [
        { placeId: hotelId!, provider: "amap", externalId: "SYN-HOTEL", name: "合成酒店" },
        { placeId: place!, provider: "amap", externalId: `SYN-${group}`, name: "合成古镇" },
      ],
      activities: [{
        record: {
          activity: { activityId: activity!, placeId: place!, role: "required", stayMinutes: 90, staySource: "user", opening: { status: "unknown" }, tickets: "unknown" },
        },
        startsAt: 600,
        endsAt: 690,
      }],
      acknowledgeUnknowns: true,
    },
  };
}

const hotel = { externalId: "SYN-HOTEL", name: "合成酒店" };
export const trip = (days: InitialTrip["days"]): InitialTrip => ({
  tripId: id(9, 1),
  generationId: id(9, 2),
  title: "云岭出游",
  firstDate: "2026-10-17",
  lastDate: "2026-10-18",
  createdAt: at,
  details: {
    schemaVersion: "trip.v1",
    start: { place: hotel, at: null },
    end: { place: hotel, at: null },
    lodging: [{ night: 1, place: hotel, onBoard: false }],
    transports: [],
    days: [
      { day: 1, date: "2026-10-17", parts: [{ kind: "plan", part: 0 }] },
      { day: 2, date: "2026-10-18", parts: [{ kind: "plan", part: 0 }] },
    ],
  },
  days,
});
