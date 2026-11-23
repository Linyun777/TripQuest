import {
  dayMinutes,
  dayTime,
  scheduleDay,
  scheduleReplan,
  validateDayDraft,
  validateReplan,
  type DayActivity,
  type DayPlanningInput,
  type DayReplanInput,
  type DayRoute,
  type DaySchedule,
  type DaySchedulingResult,
  type DayValidation,
} from "@tripquest/domain";
import type { MapStop, PlanStop } from "../plan/view-models";

const DEMO_DATE = "2026-01-01";
const PROVIDER = "tripquest-demo";
const EVIDENCE_TIME = "2026-01-01T02:00:00.000Z";

export const BOOKING = { startsAt: dayMinutes("14:00"), endsAt: dayMinutes("15:00") };
export const DEMO_INTERESTS = {
  food: "当地小吃",
  culture: "人文体验",
  lake: "沿湖散步",
  tea: "喝茶休息",
} as const;
export type DemoInterest = keyof typeof DEMO_INTERESTS;

// A small fictional place catalog. The coordinates are only for the schematic map.
const stops = {
  market: { name: "松风市集", longitude: 2, latitude: 3, interest: "food", stayMinutes: 45 },
  "snack-lane": { name: "老巷食坊", longitude: 1, latitude: 5, interest: "food", stayMinutes: 50 },
  books: { name: "临湖书店", longitude: 4, latitude: 2, interest: "culture", stayMinutes: 65 },
  gallery: { name: "老码头展馆", longitude: 6, latitude: 1, interest: "culture", stayMinutes: 80 },
  boardwalk: { name: "芦苇栈道", longitude: 4, latitude: 6, interest: "lake", stayMinutes: 35 },
  viewpoint: { name: "西坡观景台", longitude: 0, latitude: 7, interest: "lake", stayMinutes: 40 },
  "near-tea": { name: "临湖茶馆", longitude: 3, latitude: 4, interest: "tea", stayMinutes: 25 },
  "far-tea": { name: "山坡茶馆", longitude: 2, latitude: 7, interest: "tea", stayMinutes: 25 },
} satisfies Record<string, {
  name: string;
  longitude: number;
  latitude: number;
  interest: DemoInterest;
  stayMinutes: number;
}>;
export type DemoStop = keyof typeof stops;

const points = {
  entrance: { name: "松风湖游客中心", longitude: 0, latitude: 1 },
  ...stops,
  museum: { name: "湖畔博物馆导览", longitude: 5, latitude: 5 },
  station: { name: "松风湖站", longitude: 7, latitude: 4 },
};
type PlaceId = keyof typeof points;
const stopIds = Object.keys(stops) as DemoStop[];

export const demoPlaceName = (id: DemoStop) => stops[id].name;
export const stopsForInterest = (interest: DemoInterest) => stopIds.filter((id) => stops[id].interest === interest);

// Hand-authored, bidirectional walking estimates for the fictional places.
const walkingMinutes = {
  entrance: { market: 8, "snack-lane": 17, books: 14, gallery: 22, boardwalk: 18, viewpoint: 29, "near-tea": 15, "far-tea": 27, museum: 24 },
  market: { "snack-lane": 12, books: 11, gallery: 15, boardwalk: 16, viewpoint: 21, "near-tea": 8, "far-tea": 18, museum: 20 },
  "snack-lane": { books: 21, gallery: 28, boardwalk: 18, viewpoint: 11, "near-tea": 14, "far-tea": 13, museum: 24 },
  books: { gallery: 13, boardwalk: 14, viewpoint: 29, "near-tea": 9, "far-tea": 23, museum: 12 },
  gallery: { boardwalk: 17, viewpoint: 36, "near-tea": 17, "far-tea": 29, museum: 23 },
  boardwalk: { viewpoint: 19, "near-tea": 11, "far-tea": 13, museum: 9 },
  viewpoint: { "near-tea": 21, "far-tea": 11, museum: 28 },
  "near-tea": { "far-tea": 15, museum: 10 },
  "far-tea": { museum: 24 },
  museum: { station: 16 },
} satisfies Partial<Record<PlaceId, Partial<Record<PlaceId, number>>>>;

const routes: DayRoute[] = Object.entries(walkingMinutes).flatMap(([start, links]) =>
  Object.entries(links).flatMap(([end, minutes]) => [[start, end], [end, start]].map(([fromPlaceId, toPlaceId]) => ({
    fromPlaceId,
    toPlaceId,
    status: "known" as const,
    mode: "walking" as const,
    durationSeconds: minutes * 60,
    distanceMeters: minutes * 70,
    provider: PROVIDER,
    sourceKind: "fixture" as const,
    retrievedAt: EVIDENCE_TIME,
  }))),
);

const opening = {
  status: "known",
  date: DEMO_DATE,
  windows: [{ startsAt: dayMinutes("09:00"), endsAt: dayMinutes("18:00") }],
} as const;

function visit(placeId: DemoStop, required: boolean): DayActivity {
  return {
    activityId: placeId,
    placeId,
    role: required ? "required" : "discovered",
    stayMinutes: stops[placeId].stayMinutes,
    staySource: "system_estimate",
    opening,
    tickets: "not_required",
  };
}

const museum: DayActivity = {
  activityId: "museum",
  placeId: "museum",
  role: "fixed",
  stayMinutes: BOOKING.endsAt - BOOKING.startsAt,
  staySource: "user",
  opening,
  fixed: BOOKING,
  tickets: "confirmed",
};

const frame = {
  date: DEMO_DATE,
  timeZone: "Asia/Shanghai",
  endPlaceId: "station",
  places: Object.keys(points).map((placeId) => ({
    placeId,
    provider: PROVIDER,
    externalId: placeId,
    snapshot: placeId,
  })),
  bufferMinutes: 5,
  nowMs: Date.parse(EVIDENCE_TIME),
} as const;

function checked(result: DaySchedulingResult, validate: (schedule: DaySchedule) => DayValidation): DaySchedulingResult {
  if (result.status === "not_scheduled") return result;
  const validation = validate(result.schedule);
  return validation.verdict === "checked"
    ? result
    : { status: "not_scheduled", issues: validation.issues };
}

export type DemoRequest = {
  departure: number;
  returnBy: number;
  interests: readonly DemoInterest[];
  namedStops: readonly DemoStop[];
};

export type DemoTrial = { stops: readonly DemoStop[]; result: DaySchedulingResult };

export function coveredInterests(order: readonly DemoStop[], interests: readonly DemoInterest[]) {
  return interests.filter((interest) => order.some((id) => stops[id].interest === interest));
}

export function bestTrial(trials: readonly DemoTrial[], interests: readonly DemoInterest[]) {
  return trials.flatMap(({ stops, result }) => result.status === "scheduled" ? [{
    stops,
    schedule: result.schedule,
    coverage: coveredInterests(stops, interests).length,
  }] : []).sort((left, right) =>
    right.coverage - left.coverage || left.schedule.totalWalkingMinutes - right.schedule.totalWalkingMinutes,
  )[0];
}

export function scheduleDemo({ departure, returnBy, interests, namedStops }: DemoRequest): DemoTrial[] {
  const candidates = stopIds.filter((id) => namedStops.includes(id) || interests.includes(stops[id].interest));
  const orders = [
    [],
    ...candidates.map((id) => [id]),
    ...candidates.flatMap((first) => candidates
      .filter((second) => stops[first].interest !== stops[second].interest)
      .map((second) => [first, second])),
  ];
  return orders.filter((order) => namedStops.every((id) => order.includes(id))).map((order) => {
    const activities = [...order.map((id) => visit(id, namedStops.includes(id))), museum];
    const input: DayPlanningInput = {
      ...frame,
      window: { startsAt: departure, endsAt: returnBy },
      startPlaceId: "entrance",
      activities,
    };
    return {
      stops: order,
      result: checked(
        scheduleDay(input, activities.map(({ activityId }) => activityId), routes),
        (schedule) => validateDayDraft(input, schedule, routes),
      ),
    };
  });
}

export function tryRemainder(resumePlaceId: DemoStop, resumesAt: number, returnBy: number, stop: DemoStop | null): DemoTrial {
  const remaining = stop ? [stop] : [];
  const input: DayReplanInput = {
    ...frame,
    resumesAt,
    resumePlaceId,
    endsAt: returnBy,
    activities: [...remaining.map((id) => visit(id, false)), museum],
    frozen: [{ activityId: "museum", ...BOOKING }],
    capacity: 2,
  };
  return {
    stops: remaining,
    result: checked(
      scheduleReplan(input, remaining, routes),
      (schedule) => validateReplan(input, schedule, routes),
    ),
  };
}

export function demoTimeline(schedule: DaySchedule, namedStops: readonly DemoStop[]) {
  const first = schedule.legs[0];
  const end = schedule.legs.at(-1)!;
  return {
    departAt: dayTime(first.departsAt),
    startName: points[first.fromPlaceId as PlaceId].name,
    arriveAt: dayTime(schedule.endArrival),
    endName: points.station.name,
    travelBeforeEnd: { mode: "walking" as const, minutes: end.travelMinutes },
    live: false,
    stops: schedule.activities.map((activity, index): PlanStop => {
      const id = activity.placeId as PlaceId;
      return {
        key: activity.activityId,
        name: points[id].name,
        role: id === "museum" ? "fixed" : namedStops.includes(id as DemoStop) ? "required" : "discovered",
        startsAt: dayTime(activity.startsAt),
        endsAt: dayTime(activity.endsAt),
        travelBefore: { mode: "walking", minutes: schedule.legs[index].travelMinutes },
        waitMinutes: activity.waitMinutes,
      };
    }),
  };
}

export function demoMapStops(schedule: DaySchedule): MapStop[] {
  const first = schedule.legs[0].fromPlaceId as PlaceId;
  return [
    { ...points[first], key: "start", label: "起", kind: "start" },
    ...schedule.activities.map(({ activityId, placeId }, index): MapStop => ({
      ...points[placeId as PlaceId],
      key: activityId,
      label: String(index + 1),
      kind: "stop",
    })),
    { ...points.station, key: "end", label: "终", kind: "end" },
  ];
}
