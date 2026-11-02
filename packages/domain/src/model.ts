/**
 * 单日场景统一采用带 +08:00 偏移的完整日期时间。
 * 模板字面量只帮助类型检查，不能证明真实日历有效；外部输入仍由运行时解析器校验。
 */
export type ChinaDateTime = `${string}+08:00`;

/** 行程时区中的 YYYY-MM-DD 日期；字符串类型不保证日期真实存在，运行时仍须校验。 */
export type CalendarDate = string;

export type JourneyTimeZone = "Asia/Shanghai";

/** 时间区间采用左闭右开 [开始, 结束)：相邻活动可以首尾相接，不算重叠。 */
export interface TimeWindow {
  readonly startsAt: ChinaDateTime;
  readonly endsAt: ChinaDateTime;
}

export type ActivityPriority = "high" | "normal" | "low";

/** 一条计划安排，不代表已经发生；实际完成、跳过和当前位置放在独立观察状态中。 */
export interface PlannedActivity extends TimeWindow {
  readonly id: string;
  readonly placeId: string;
  readonly priority: ActivityPriority;
  readonly locked: boolean;
  /** 仅关联独立预约事实；带着预约 ID 不代表候选有权修改预约。 */
  readonly reservationId?: string;
}

/** 计划版本必须为正整数，运行时检查；调整产生新版本而不覆盖旧活动安排。 */
export interface PlanVersion {
  readonly journeyId: string;
  readonly date: CalendarDate;
  readonly timeZone: JourneyTimeZone;
  readonly version: number;
  readonly parentVersion?: number;
  readonly changeReason?: string;
  /** 数组顺序是计划语义的一部分，不能在序列化或比较时随意排序。 */
  readonly activities: readonly PlannedActivity[];
}

export type ReservationConfirmationStatus =
  | "confirmed"
  | "pending"
  | "cancelled"
  | "unknown";

export interface Reservation extends TimeWindow {
  readonly id: string;
  readonly placeId: string;
  /** 预约的来源、状态和原时段独立于计划；改计划不能把外部预约事实一起改写。 */
  readonly confirmation: {
    readonly status: ReservationConfirmationStatus;
    readonly source: {
      readonly kind: "fixture" | "user_reported" | "provider_record";
      readonly reference?: string;
    };
    readonly recordedAt: ChinaDateTime;
  };
}

export type ObservedLocation =
  | { readonly kind: "known"; readonly placeId: string }
  | { readonly kind: "unknown"; readonly reason?: string };

/** 观察状态单独版本化：用户标记完成会推进状态版本，即使计划版本尚未变化。 */
export interface JourneyState {
  readonly journeyId: string;
  readonly version: number;
  readonly completedActivityIds: readonly string[];
  readonly skippedActivityIds: readonly string[];
  /** null 明确表示没有正在进行的活动；未知何时结束的进行中活动不能直接视为已空闲。 */
  readonly currentActivityId: string | null;
  readonly observedAt: ChinaDateTime;
  readonly location: ObservedLocation;
}

export type ReplanScope =
  | { readonly kind: "selected_window"; readonly window: TimeWindow }
  | { readonly kind: "rest_of_day"; readonly from: ChinaDateTime };

/** 请求绑定用户看到的计划与状态两个基础版本；任一更新都可能使旧候选过期。 */
export interface ReplanRequest {
  readonly id: string;
  readonly journeyId: string;
  readonly basePlanVersion: number;
  readonly baseStateVersion: number;
  readonly delay: {
    readonly observedAt: ChinaDateTime;
    readonly earliestResumeAt: ChinaDateTime;
  };
  readonly scope: ReplanScope;
}

/** 等待校验的完整候选，不是已提交的新版本；完整序列便于同时检查局部修改前后的衔接。 */
export interface CandidatePlan {
  readonly id: string;
  readonly journeyId: string;
  readonly basePlanVersion: number;
  readonly baseStateVersion: number;
  readonly activities: readonly PlannedActivity[];
}
