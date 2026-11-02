import type {
  CandidatePlan,
  ChinaDateTime,
  JourneyState,
  PlanVersion,
  PlannedActivity,
  ReplanRequest,
  Reservation,
} from "./model";

export type ReferenceCaseId = "C1" | "C2" | "C3" | "C4" | "C5";

export type FixtureTravelDuration =
  | {
      readonly kind: "known";
      /** A non-negative integer in valid input; S2.2 will check it. */
      readonly minutes: number;
      readonly source: "hand_authored_fixture";
    }
  | { readonly kind: "unknown"; readonly reason: "not_provided" };

export interface FixtureTravelLeg {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly duration: FixtureTravelDuration;
}

export type ReferenceExpectation =
  | {
      readonly kind: "feasible";
      readonly reasoning: string;
      readonly arrivalAtNextLockedActivity: ChinaDateTime;
    }
  | {
      readonly kind: "known_violation";
      readonly reasoning: string;
      readonly arrivalAtNextLockedActivity?: ChinaDateTime;
    }
  | { readonly kind: "insufficient_information"; readonly reasoning: string };

/** The expectation is hand-written; no planner or validator produces it. */
export interface ReferenceCase {
  readonly id: ReferenceCaseId;
  readonly title: string;
  readonly provenance: "fictional_hand_authored";
  readonly input: {
    readonly plan: PlanVersion;
    readonly reservations: readonly Reservation[];
    readonly state: JourneyState;
    readonly request: ReplanRequest;
    readonly travelLegs: readonly FixtureTravelLeg[];
    readonly transferBufferMinutes: number;
  };
  readonly candidate: CandidatePlan;
  readonly expected: ReferenceExpectation;
}

// P-A through P-D, all activity times and all travel durations below are
// invented for these examples. They are not live place or route information.
const morning: PlannedActivity = {
  id: "A-MORNING",
  placeId: "P-A",
  startsAt: "2026-10-15T09:00:00+08:00",
  endsAt: "2026-10-15T10:00:00+08:00",
  priority: "normal",
  locked: false,
};

const lunch: PlannedActivity = {
  id: "A-LUNCH",
  placeId: "P-B",
  startsAt: "2026-10-15T12:00:00+08:00",
  endsAt: "2026-10-15T13:00:00+08:00",
  priority: "normal",
  locked: false,
};

const afternoon: PlannedActivity = {
  id: "A-AFTERNOON",
  placeId: "P-C",
  startsAt: "2026-10-15T15:00:00+08:00",
  endsAt: "2026-10-15T16:00:00+08:00",
  priority: "normal",
  locked: false,
};

const dinner: PlannedActivity = {
  id: "A-DINNER",
  placeId: "P-D",
  startsAt: "2026-10-15T18:00:00+08:00",
  endsAt: "2026-10-15T19:00:00+08:00",
  priority: "high",
  locked: true,
  reservationId: "R-DINNER",
};

const basePlan: PlanVersion = {
  journeyId: "J-FICTIONAL-1",
  date: "2026-10-15",
  timeZone: "Asia/Shanghai",
  version: 1,
  activities: [morning, lunch, afternoon, dinner],
};

const dinnerReservation: Reservation = {
  id: "R-DINNER",
  placeId: "P-D",
  startsAt: "2026-10-15T18:00:00+08:00",
  endsAt: "2026-10-15T19:00:00+08:00",
  confirmation: {
    status: "confirmed",
    source: { kind: "fixture", reference: "hand-authored fictional booking" },
    recordedAt: "2026-10-15T08:00:00+08:00",
  },
};

const stateAfterDelay: JourneyState = {
  journeyId: "J-FICTIONAL-1",
  version: 3,
  completedActivityIds: ["A-MORNING", "A-LUNCH"],
  skippedActivityIds: [],
  currentActivityId: null,
  observedAt: "2026-10-15T14:30:00+08:00",
  location: { kind: "known", placeId: "P-C" },
};

const delayRequest: ReplanRequest = {
  id: "REQ-DELAY-1",
  journeyId: "J-FICTIONAL-1",
  basePlanVersion: 1,
  baseStateVersion: 3,
  delay: {
    observedAt: "2026-10-15T14:30:00+08:00",
    earliestResumeAt: "2026-10-15T15:30:00+08:00",
  },
  scope: {
    kind: "selected_window",
    window: {
      startsAt: "2026-10-15T15:00:00+08:00",
      endsAt: "2026-10-15T18:00:00+08:00",
    },
  },
};

const commonTravelLegs: readonly FixtureTravelLeg[] = [
  {
    fromPlaceId: "P-A",
    toPlaceId: "P-B",
    duration: { kind: "known", minutes: 20, source: "hand_authored_fixture" },
  },
  {
    fromPlaceId: "P-B",
    toPlaceId: "P-C",
    duration: { kind: "known", minutes: 20, source: "hand_authored_fixture" },
  },
];

const afternoonAt1630: PlannedActivity = {
  ...afternoon,
  startsAt: "2026-10-15T15:30:00+08:00",
  endsAt: "2026-10-15T16:30:00+08:00",
};

const afternoonAt1750: PlannedActivity = {
  ...afternoon,
  startsAt: "2026-10-15T16:50:00+08:00",
  endsAt: "2026-10-15T17:50:00+08:00",
};

const candidateBase = {
  journeyId: "J-FICTIONAL-1",
  basePlanVersion: 1,
  baseStateVersion: 3,
} as const;

const commonInput = {
  plan: basePlan,
  reservations: [dinnerReservation],
  state: stateAfterDelay,
  request: delayRequest,
  transferBufferMinutes: 10,
} as const;

/** Static, JSON-serializable inputs and independent human expectations. */
export const referenceCases: readonly ReferenceCase[] = [
  {
    id: "C1",
    title: "Afternoon activity still reaches the fixed dinner",
    provenance: "fictional_hand_authored",
    input: {
      ...commonInput,
      travelLegs: [
        ...commonTravelLegs,
        {
          fromPlaceId: "P-C",
          toPlaceId: "P-D",
          duration: { kind: "known", minutes: 40, source: "hand_authored_fixture" },
        },
      ],
    },
    candidate: {
      id: "CAND-C1",
      ...candidateBase,
      activities: [morning, lunch, afternoonAt1630, dinner],
    },
    expected: {
      kind: "feasible",
      arrivalAtNextLockedActivity: "2026-10-15T17:20:00+08:00",
      reasoning: "16:30 + 40 minutes travel + 10 minutes buffer = 17:20, before 18:00. Morning, lunch, and locked dinner stay unchanged.",
    },
  },
  {
    id: "C2",
    title: "Afternoon activity ends too late for dinner",
    provenance: "fictional_hand_authored",
    input: {
      ...commonInput,
      travelLegs: [
        ...commonTravelLegs,
        {
          fromPlaceId: "P-C",
          toPlaceId: "P-D",
          duration: { kind: "known", minutes: 30, source: "hand_authored_fixture" },
        },
      ],
    },
    candidate: {
      id: "CAND-C2",
      ...candidateBase,
      activities: [morning, lunch, afternoonAt1750, dinner],
    },
    expected: {
      kind: "known_violation",
      arrivalAtNextLockedActivity: "2026-10-15T18:30:00+08:00",
      reasoning: "17:50 + 30 minutes travel + 10 minutes buffer = 18:30, thirty minutes after the unchanged 18:00 dinner starts.",
    },
  },
  {
    id: "C3",
    title: "Candidate moves the fixed dinner without changing the booking",
    provenance: "fictional_hand_authored",
    input: {
      ...commonInput,
      travelLegs: [
        ...commonTravelLegs,
        {
          fromPlaceId: "P-C",
          toPlaceId: "P-D",
          duration: { kind: "known", minutes: 40, source: "hand_authored_fixture" },
        },
      ],
    },
    candidate: {
      id: "CAND-C3",
      ...candidateBase,
      activities: [
        morning,
        lunch,
        afternoonAt1630,
        {
          ...dinner,
          startsAt: "2026-10-15T18:30:00+08:00",
          endsAt: "2026-10-15T19:30:00+08:00",
        },
      ],
    },
    expected: {
      kind: "known_violation",
      reasoning: "The candidate moves locked A-DINNER from 18:00–19:00 to 18:30–19:30, outside the selected [15:00, 18:00) window. Confirmed R-DINNER remains 18:00–19:00.",
    },
  },
  {
    id: "C4",
    title: "Candidate rewrites a completed morning activity",
    provenance: "fictional_hand_authored",
    input: {
      ...commonInput,
      travelLegs: [
        ...commonTravelLegs,
        {
          fromPlaceId: "P-C",
          toPlaceId: "P-D",
          duration: { kind: "known", minutes: 40, source: "hand_authored_fixture" },
        },
      ],
    },
    candidate: {
      id: "CAND-C4",
      ...candidateBase,
      activities: [
        {
          ...morning,
          startsAt: "2026-10-15T09:30:00+08:00",
          endsAt: "2026-10-15T10:30:00+08:00",
        },
        lunch,
        afternoonAt1630,
        dinner,
      ],
    },
    expected: {
      kind: "known_violation",
      reasoning: "A-MORNING changes from 09:00–10:00 to 09:30–10:30 even though it is completed in state version 3 and outside [15:00, 18:00).",
    },
  },
  {
    id: "C5",
    title: "Travel time from afternoon place to dinner is missing",
    provenance: "fictional_hand_authored",
    input: {
      ...commonInput,
      travelLegs: [
        ...commonTravelLegs,
        {
          fromPlaceId: "P-C",
          toPlaceId: "P-D",
          duration: { kind: "unknown", reason: "not_provided" },
        },
      ],
    },
    candidate: {
      id: "CAND-C5",
      ...candidateBase,
      activities: [morning, lunch, afternoonAt1630, dinner],
    },
    expected: {
      kind: "insufficient_information",
      reasoning: "The P-C to P-D travel time is explicitly unknown. A 16:30 end and 10-minute buffer cannot establish an arrival time before 18:00.",
    },
  },
];
