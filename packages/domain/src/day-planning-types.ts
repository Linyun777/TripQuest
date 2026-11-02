/** 单个杭州日历日内从零点起算的分钟数；跨日规划不能直接复用这个数值范围。 */
export interface DayWindow {
  readonly startsAt: number;
  readonly endsAt: number;
}

export interface DayPlace {
  readonly placeId: string;
  readonly provider: string;
  readonly externalId: string;
  /** 含坐标的规范快照；同一地点编号还不够，只有快照一致才允许采用同地零交通假设。 */
  readonly snapshot: string;
}

/** unknown 与 closed 不同；日期不匹配的营业信息也只能当未知，不能拿今日营业窗口证明未来某天可访问。 */
export type DayOpening =
  | { readonly status: "unknown" }
  | { readonly status: "closed"; readonly date: string }
  | {
      readonly status: "known";
      readonly date: string;
      readonly windows: readonly DayWindow[];
      readonly latestEntry?: number;
    };

export interface DayActivity {
  readonly activityId: string;
  readonly placeId: string;
  readonly role: "optional" | "required" | "fixed" | "discovered";
  readonly stayMinutes: number;
  readonly staySource: "user" | "system_estimate";
  readonly fixed?: DayWindow;
  /** 兴趣要求的访问时段，如晚上喝酒；整段停留都要在此窗口内。 */
  readonly within?: DayWindow;
  readonly opening: DayOpening;
  readonly tickets: "unknown" | "not_required" | "confirmed";
}

export type DayTravelMode = "walking" | "transit" | "taxi" | "bicycling" | "driving";

export type DayRoute = {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
} & (
  | {
      readonly status: "known";
      readonly durationSeconds: number;
      readonly distanceMeters: number;
      readonly provider: string;
      readonly sourceKind: "fixture" | "live";
      readonly retrievedAt: string;
      /**
       * 出行方式与费用说明用于展示和确认复查；领域排程只使用已取得的时长。
       * 缺省方式为步行以兼容旧数据，不根据字段缺省重新猜交通方式。
       */
      readonly mode?: DayTravelMode;
      readonly fareYuan?: number;
      readonly summary?: string;
      readonly walkingMeters?: number;
    }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "same_place_assumption" }
);

export interface DayPlanningInput {
  readonly date: string;
  readonly timeZone: "Asia/Shanghai";
  readonly window: DayWindow;
  readonly startPlaceId: string;
  readonly endPlaceId: string;
  readonly places: readonly DayPlace[];
  readonly activities: readonly DayActivity[];
  readonly bufferMinutes: 5 | 10;
  readonly nowMs: number;
  /** 等待改为晚些出发：保持活动开始/结束时刻，调整前一段路的出发时刻；旧数据缺省不启用。 */
  readonly leaveLate?: true;
}

export interface DayScheduledActivity extends DayWindow {
  readonly activityId: string;
  readonly placeId: string;
  readonly arrivesAt: number;
  readonly waitMinutes: number;
}

export interface DayScheduledLeg {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly departsAt: number;
  readonly arrivesAt: number;
  readonly travelMinutes: number;
  readonly bufferMinutes: number;
  readonly distanceMeters: number;
  readonly source: "route_estimate" | "same_place_assumption";
}

export interface DaySchedule {
  readonly activities: readonly DayScheduledActivity[];
  /** 路线段包含最后一站到终点，因此段数应等于活动数加一。 */
  readonly legs: readonly DayScheduledLeg[];
  readonly endArrival: number;
  readonly totalWalkingMinutes: number;
  readonly longestWalkingMinutes: number;
}

export type DayIssueCode =
  | "day_invalid_input"
  | "day_activity_count"
  | "day_unknown_activity"
  | "day_duplicate_activity"
  | "day_missing_protected"
  | "day_fixed_order"
  | "day_route_unknown"
  | "day_route_evidence"
  | "day_same_place_invalid"
  | "day_fixed_late"
  | "day_opening_conflict"
  | "day_opening_unknown"
  | "day_time_of_day"
  | "day_tickets_unknown"
  | "day_window_exceeded"
  | "day_schedule_mismatch"
  | "day_frozen_changed";

export interface DayIssue {
  readonly code: DayIssueCode;
  readonly kind: "violation" | "unknown";
  readonly activityId?: string;
  readonly fromPlaceId?: string;
  readonly toPlaceId?: string;
  readonly expected?: number;
  readonly actual?: number;
}

/** checked 表示本轮无已知问题，pending 表示仍有营业/票务未知，rejected 表示不能作为完整草稿交付。 */
export interface DayValidation {
  readonly verdict: "checked" | "pending" | "rejected";
  readonly issues: readonly DayIssue[];
}

export type DaySchedulingResult =
  | { readonly status: "scheduled"; readonly schedule: DaySchedule }
  | { readonly status: "not_scheduled"; readonly issues: readonly DayIssue[] };
