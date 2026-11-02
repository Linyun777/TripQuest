import type {
  ActivityPriority,
  ChinaDateTime,
  JourneyTimeZone,
  PlanVersion,
  Reservation,
} from "@tripquest/domain";
import type { DayProgressView, StoredDayProgress } from "./day-progress";
import type { StoredRealDay } from "./real-day";
import type { GeneratedDayDetails } from "./day-state";

export type JourneyActivityKind = "activity" | "reservation";

export interface CreateJourneyActivityCommand {
  readonly placeName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly priority: ActivityPriority;
  readonly kind: JourneyActivityKind;
}

export interface CreateJourneyCommand {
  readonly title: string;
  readonly date: string;
  readonly timeZone: JourneyTimeZone;
  readonly activities: readonly CreateJourneyActivityCommand[];
}

export type JourneyFieldErrors = Readonly<Record<string, readonly string[]>>;

export type CreateJourneyOutcome =
  | { readonly status: "created"; readonly journeyId: string }
  | {
      readonly status: "invalid";
      readonly fieldErrors: JourneyFieldErrors;
      readonly formError?: string;
    };

export interface JourneyActivitySnapshot {
  readonly activityId: string;
  readonly position: number;
  readonly placeName: string;
}

export interface JourneyReservationSnapshot {
  readonly placeName: string;
  readonly reservation: Reservation;
}

/** V2.10：行程的主要城市（地级市一级的行政区编码和名称）。 */
export interface JourneyCity {
  readonly adcode: string;
  readonly name: string;
}

export interface InitialJourneyDraft {
  readonly journeyId: string;
  readonly title: string;
  /** 缺省杭州（旧流程与演示行程）。 */
  readonly city?: JourneyCity;
  readonly createdAt: ChinaDateTime;
  readonly updatedAt: ChinaDateTime;
  readonly currentPlan: PlanVersion;
  readonly activitySnapshots: readonly JourneyActivitySnapshot[];
  readonly reservations: readonly JourneyReservationSnapshot[];
}

export interface StoredJourney {
  readonly currentPlanVersion?: number;
  /** "real_day": a saved day with real Amap places (S5.5); it never has `dayDetails`. */
  readonly creationKind: "manual" | "generated_day" | "real_day";
  readonly dayDetails?: GeneratedDayDetails;
  readonly realDay?: StoredRealDay;
  /** Generated days only: the report at currentObservationVersion, when it is > 0. */
  readonly dayProgress?: StoredDayProgress;
  readonly journeyId: string;
  readonly title: string;
  /** V2.10：读出时总有（旧行程回填杭州）；测试里手写的行程可以没有。 */
  readonly city?: JourneyCity;
  readonly createdAt: ChinaDateTime;
  readonly updatedAt: ChinaDateTime;
  readonly currentObservationVersion: number;
  readonly currentPlan: PlanVersion;
  readonly activitySnapshots: readonly JourneyActivitySnapshot[];
  readonly reservations: readonly JourneyReservationSnapshot[];
}

export interface StoredConfirmation {
  readonly intentFingerprint: string;
  readonly resultPlanVersion: number;
  readonly resultObservationVersion: number;
}

export interface ConfirmedAdjustmentDraft {
  readonly journeyId: string;
  readonly idempotencyKey: string;
  readonly intentFingerprint: string;
  readonly basePlanVersion: number;
  readonly baseObservationVersion: number;
  readonly expectedJourney: StoredJourney;
  readonly strategy: "shift" | "omit";
  readonly previewFingerprint: string;
  readonly command: {
    readonly observedAt: string;
    readonly earliestResumeAt: string;
    readonly completedActivityIds: readonly string[];
    readonly noCurrentActivity: true;
    readonly locationAtTarget: true;
    readonly travelMinutes: number | null;
  };
  readonly candidateActivities: PlanVersion["activities"];
  readonly confirmedAt: ChinaDateTime;
}

export type CommitAdjustmentResult =
  | { readonly status: "committed" | "already_committed"; readonly planVersion: number; readonly observationVersion: number }
  | { readonly status: "stale" | "preview_changed" | "idempotency_conflict" };

export interface JourneyRepository {
  createInitialJourney(draft: InitialJourneyDraft): Promise<void>;
  findCurrentJourney(journeyId: string): Promise<StoredJourney | null>;
  findJourneyVersion?(journeyId: string, version: number): Promise<StoredJourney | null>;
}

/** V2.1 “我的行程”: what the list shows, newest change first. */
export interface JourneySummary {
  readonly id: string;
  readonly title: string;
  readonly creationKind: "manual" | "generated_day" | "real_day";
  readonly date: string;
  readonly updatedAt: string;
  /** V2.10：行程的主要城市（出游的一天是这一段所在的城市）。 */
  readonly cityName?: string;
  /** V2.11：属于哪趟出游、第几天、当天第几段。 */
  readonly trip?: {
    readonly id: string;
    readonly title: string;
    readonly day: number;
    readonly part: number;
    /** 出游的首末日（只有交通、没有安排地点的那天没有一日行程，列表按日期补出来）。 */
    readonly firstDate: string;
    readonly lastDate: string;
  };
}

export interface JourneyListRepository {
  listJourneys(limit: number): Promise<readonly JourneySummary[]>;
}

export interface ConfirmationJourneyRepository extends JourneyRepository {
  findConfirmation(journeyId: string, idempotencyKey: string): Promise<StoredConfirmation | null>;
  commitConfirmedAdjustment(draft: ConfirmedAdjustmentDraft): Promise<CommitAdjustmentResult>;
}

export type JourneyIdKind = "journey" | "activity" | "place" | "reservation";

export interface JourneyIdGenerator {
  next(kind: JourneyIdKind): string;
}

export interface JourneyClock {
  now(): Date;
}

export interface JourneyDetailsReservation {
  readonly id: string;
  readonly confirmationStatus: Reservation["confirmation"]["status"];
  readonly sourceKind: Reservation["confirmation"]["source"]["kind"];
  readonly recordedAt: ChinaDateTime;
}

export interface JourneyDetailsActivity {
  readonly id: string;
  readonly position: number;
  readonly placeId: string;
  readonly placeName: string;
  readonly startsAt: ChinaDateTime;
  readonly endsAt: ChinaDateTime;
  readonly priority: ActivityPriority;
  readonly locked: boolean;
  readonly kind: JourneyActivityKind;
  readonly reservation?: JourneyDetailsReservation;
}

export interface JourneyDetails {
  readonly currentVersion?: number;
  readonly observationVersion?: number;
  readonly creationKind: "manual" | "generated_day" | "real_day";
  readonly dayDetails?: GeneratedDayDetails;
  /** S5.5 real day: IDs, names and the plan only; details are re-queried when shown. */
  readonly realDay?: StoredRealDay;
  /** Current version only; history never overlays the live report. */
  readonly dayProgress?: DayProgressView;
  readonly journeyId: string;
  readonly title: string;
  readonly date: string;
  readonly timeZone: JourneyTimeZone;
  readonly version: number;
  readonly createdAt: ChinaDateTime;
  readonly updatedAt: ChinaDateTime;
  readonly activities: readonly JourneyDetailsActivity[];
}

export type GetJourneyOutcome =
  | { readonly status: "found"; readonly journey: JourneyDetails }
  | { readonly status: "not_found" }
  | { readonly status: "invalid_id" };
