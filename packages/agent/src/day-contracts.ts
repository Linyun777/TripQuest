import { z } from "zod";
import {
  PLACE_KINDS,
  type DayActivityRecord,
  type DayCounts,
  type DayFailure,
  type DayPlanningProblem,
  type DayProgress,
} from "@tripquest/application/day-planning";
import type { DayIssue, DaySchedule, DayTravelMode, DayValidation } from "@tripquest/domain";
import type { TravelPreference } from "@tripquest/application/planning";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { MobilityProvider } from "@tripquest/providers";
import type { ModelReply } from "./contracts";

const localId = z.string().regex(/^[pa]\d{1,2}$/);
// 严格对象拒绝额外字段，模型不能夹带到达时间、坐标或保存命令；业务可执行性仍由 guard 检查。
export const dayActionSchema = z.discriminatedUnion("action", [
  // 兼容旧版固定兴趣与新版自由兴趣；新版由模型把用户兴趣转换为搜索词和停留估计。
  z.strictObject({
    action: z.literal("search_places"),
    interest: z.enum(["culture", "nature", "city_walk", "food"]).optional(),
    interestId: z.union([z.enum(["culture", "nature", "city_walk", "food"]), z.string().regex(/^i\d{1,2}$/)]).optional(),
    query: z.string().trim().min(2).max(20).optional(),
    // V2.10：停留最多 600 分钟；kind 是这类地点的大致类型，服务端按它把停留夹到合理范围、判断户外。
    stayMinutes: z.number().int().min(30).max(600).optional(),
    kind: z.enum(PLACE_KINDS).optional(),
    // 搜索中心二选一：已登记地点，或先按名称解析用户说过的区域；两者不能同时提交。
    anchorPlaceId: localId.optional(),
    area: z.string().trim().min(2).max(12).optional(),
  }),
  z.strictObject({ action: z.literal("try_itinerary"), orderedActivityIds: z.array(localId).min(1).max(6) }),
  z.strictObject({
    action: z.literal("finish"),
    attemptId: z.string().regex(/^attempt-[1-3]$/),
    /** 理由按活动 ID 关联，只保留实际采用的新发现站；文案可裁短或丢弃，不能因此丢失已验证方案。 */
    reasons: z.record(localId, z.string().trim().min(1).max(300)).optional(),
  }),
  z.strictObject({ action: z.literal("stop"), reason: z.enum([
    "no_suitable_places", "constraints_not_met", "insufficient_information",
  ]) }),
]);
export type DayAction = z.infer<typeof dayActionSchema>;
export const DAY_LIMITS = {
  // 路线额度与组合次数独立；一段路比较多种方式时，每次实际请求都扣路线预算。
  searches: 4, tries: 3, routes: 48, model: 10, semanticRepairs: 2,
  runMs: 120_000, modelMs: 15_000, providerMs: 5_000, contextBytes: 24 * 1024, recursion: 64,
} as const;
export type DayLimits = { readonly [K in keyof typeof DAY_LIMITS]: number };

/** 试算同时绑定 runId 与需求指纹，防止 finish 拿另一轮或另一份需求的成功编号冒充当前结果。 */
export interface DayAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly requirementsFingerprint: string;
  readonly order: readonly string[];
  readonly issues: readonly DayIssue[];
  readonly schedule?: DaySchedule;
  readonly validation?: DayValidation;
  /** V2.11：这次排得开靠缩短了卡片上估计的停留（活动 → 分钟）。 */
  readonly stays?: Readonly<Record<string, number>>;
}
export interface DaySearchObservation {
  readonly interest: string;
  readonly query: string;
  /** 实际解析成功的搜索中心；区域查不到时缺省，不能凭区域名称构造坐标。 */
  readonly anchorPlaceId?: string;
  readonly area?: string;
  readonly activityIds: readonly string[];
  readonly excludedCount: number;
  readonly failureCode?: string;
  /** V2.10：附近太少时扩大后的搜索半径（米）；没扩大时缺省（3 公里）。 */
  readonly radiusMeters?: number;
  /** V3.4：同一个搜索又来一次时改在这一天的城市里按相关度搜（附近的结果不合适）；只在这种时候出现。 */
  readonly cityWide?: string;
}
export interface DayDecisionContext {
  readonly protocolVersion: "day-planning.v1";
  readonly requirements: {
    readonly date: string;
    readonly window: { readonly startsAt: number; readonly endsAt: number };
    readonly startPlaceId: string;
    readonly endPlaceId: string;
    /** when 表示兴趣时段，count 表示要实际去几站，缺省一站；都由用户需求推导。 */
    readonly interests: readonly { readonly id: string; readonly text: string; readonly when?: string; readonly count?: number }[];
    readonly pace: "relaxed" | "standard";
    readonly bufferMinutes: number;
    readonly notes?: string;
    readonly weather?: DayPlanningProblem["weather"];
    /** 用户允许的出行方式与软偏好；每段具体方式由确定性选路策略决定。 */
    readonly travel: TravelPreference;
  };
  readonly places: readonly { readonly placeId: string; readonly name: string }[];
  readonly activities: readonly DayActivityRecord[];
  readonly searches: readonly DaySearchObservation[];
  readonly triedOrders: readonly (readonly string[])[];
  readonly latestAttempt: null | {
    readonly attemptId: string;
    readonly order: readonly string[];
    readonly status: "success" | "not_scheduled";
    readonly issues: readonly DayIssue[];
    readonly endArrival?: number;
    /**
     * 固定预约将迟到时，代码给出“把一个普通站移到预约后”的候选顺序。
     * 模型可选择试算，但建议本身没有可行性承诺。
     */
    readonly suggestedOrder?: readonly string[];
  };
  readonly routes: readonly {
    readonly fromPlaceId: string;
    readonly toPlaceId: string;
    readonly status: "known" | "unknown" | "same_place_assumption";
    readonly travelMinutes?: number;
    /** 缺省为步行，兼容旧快照；不能把缺省理解为出行方式未知。 */
    readonly mode?: DayTravelMode;
  }[];
  readonly feedback: null | { readonly code: string };
  readonly remaining: DayCounts;
}
export interface DayPlanningDecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  getRequestCount?(): number;
  decide(context: DayDecisionContext, options: { signal: AbortSignal }): Promise<ModelReply>;
}
export interface DayRunnerDependencies {
  readonly provider: MobilityProvider;
  readonly model: DayPlanningDecisionModel;
  readonly now?: () => number;
  readonly limits?: Partial<DayLimits>;
  readonly beforeProvider?: (kind: "search" | "route") => Promise<void>;
  /** 持久任务把任务 ID 作为图线程 ID；已有检查点时从最后落盘节点续接。 */
  readonly thread?: RunThread;
}
export interface RunThread {
  readonly checkpointer: BaseCheckpointSaver;
  readonly threadId: string;
}
export class DayRunError extends Error {
  constructor(readonly code: DayFailure) {
    super(code);
  }
}
export interface DayToolOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DayProgress) => void;
  readonly counts: DayCounts;
  readonly onRoutePath?: (fromPlaceId: string, toPlaceId: string, path: readonly (readonly [number, number])[]) => void;
}
