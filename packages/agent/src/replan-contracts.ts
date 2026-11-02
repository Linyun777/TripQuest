import { z } from "zod";
import { REPLAN_LIMITS } from "@tripquest/application/day-replan";
import type { ReplanCounts, ReplanGoal, ReplanScope } from "@tripquest/application/day-state";
import type { DayIssue } from "@tripquest/domain";
import type { MobilityProvider } from "@tripquest/providers";
import type { RunThread } from "./day-contracts";
import type { ModelReply } from "./contracts";

const localId = z.string().regex(/^[pa]\d{1,2}$/);
// 模型只列可调整部分的顺序，冻结尾部由代码接回；允许空序列表示只保留冻结部分或直接去终点。
export const replanActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("search_places"),
    interest: z.enum(["culture", "nature", "city_walk", "food"]),
    anchorPlaceId: localId,
  }),
  z.strictObject({
    action: z.literal("try_replan"),
    orderedActivityIds: z.array(localId).max(6),
  }),
  z.strictObject({
    action: z.literal("finish"),
    attemptId: z.string().regex(/^(baseline|attempt-[1-3])$/),
  }),
  z.strictObject({
    action: z.literal("stop"),
    reason: z.enum(["constraints_not_met", "insufficient_information"]),
  }),
]);
export type ReplanAction = z.infer<typeof replanActionSchema>;

export type ReplanLimits = { readonly [K in keyof typeof REPLAN_LIMITS]: number };

/** 重规划模型的最小视图：可调整范围、软目标、冻结边界和工具观察；不给写库权限或外部地点原始数据。 */
export interface ReplanDecisionContext {
  readonly protocolVersion: "day-replanning.v1";
  readonly scope: ReplanScope;
  readonly goal: ReplanGoal;
  readonly date: string;
  readonly bufferMinutes: number;
  readonly interests: readonly string[];
  readonly resume: { readonly placeId: string; readonly at: number };
  readonly end: { readonly placeId: string; readonly by: number };
  readonly anchor: null | { readonly activityId: string; readonly startsAt: number };
  readonly maxFutureActivities: number;
  readonly archivedCount: number;
  readonly places: readonly { readonly placeId: string; readonly name: string }[];
  readonly activities: readonly {
    readonly activityId: string;
    readonly placeId: string;
    readonly role: "optional" | "required" | "fixed" | "discovered";
    readonly stayMinutes: number;
    readonly fixed?: { readonly startsAt: number; readonly endsAt: number };
    readonly interest?: string;
    readonly adjustable: boolean;
  }[];
  readonly currentOrder: readonly string[];
  readonly frozenOrder: readonly string[];
  readonly searchAnchors: readonly string[];
  readonly searches: readonly ReplanSearchObservation[];
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly order: readonly string[];
    readonly status: "success" | "not_scheduled";
    readonly issues: readonly DayIssue[];
    readonly endArrival?: number;
    readonly walkingMinutes?: number;
    readonly waitingMinutes?: number;
  }[];
  readonly routes: readonly {
    readonly fromPlaceId: string;
    readonly toPlaceId: string;
    readonly status: "known" | "unknown" | "same_place_assumption";
    readonly travelMinutes?: number;
  }[];
  readonly feedback: null | { readonly code: string };
  readonly remaining: Omit<ReplanCounts, "baseline">;
}
export interface ReplanSearchObservation {
  readonly interest: Extract<ReplanAction, { action: "search_places" }>["interest"];
  readonly anchorPlaceId: string;
  readonly activityIds: readonly string[];
  readonly failureCode?: string;
}
export interface ReplanDecisionModel {
  readonly mode: "scripted" | "live";
  readonly provider: string;
  readonly model: string;
  decide(context: ReplanDecisionContext, options: { signal: AbortSignal }): Promise<ModelReply>;
}
export interface ReplanRunnerDependencies {
  readonly provider: MobilityProvider;
  readonly model: ReplanDecisionModel;
  readonly now?: () => number;
  readonly limits?: Partial<ReplanLimits>;
  /** 持久任务复用同一图线程，恢复已落盘的计数、事实和节点进度。 */
  readonly thread?: RunThread;
}
