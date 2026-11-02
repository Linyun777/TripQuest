import { z } from "zod";
import type { ChinaDateTime } from "@tripquest/domain";
import { PLANNING_FIXTURE_PROVIDER } from "@tripquest/providers/planning-fixture";
import type { JourneyRepository, StoredJourney } from "./contracts";
import { dayState, type DayState } from "./day-state";
import { fingerprint } from "./fingerprint";
import { toChinaDateTime } from "./runtime-values";

const reportedMinute = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+08:00$/);
export const dayProgressCommandSchema = z.strictObject({
  reportId: z.uuid(),
  basePlanVersion: z.number().int().positive(),
  baseObservationVersion: z.number().int().nonnegative(),
  completedActivityIds: z.array(z.uuid()).max(6),
  skippedActivityIds: z.array(z.uuid()).max(6),
  observedAt: reportedMinute,
  earliestResumeAt: reportedMinute,
  location: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("known"), placeId: z.uuid() }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  noCurrentActivity: z.literal(true),
});
export type DayProgressCommand = z.infer<typeof dayProgressCommandSchema>;

/** 每个观测版本保存截至该次上报的完整累计状态，便于回放与幂等核对。 */
export interface StoredDayProgress {
  readonly version: number;
  readonly basePlanVersion: number;
  readonly reportId: string;
  readonly intentFingerprint: string;
  readonly observedAt: ChinaDateTime;
  readonly earliestResumeAt: ChinaDateTime;
  readonly completedActivityIds: readonly string[];
  readonly skippedActivityIds: readonly string[];
  readonly locationPlaceId: string | null;
  readonly source: "user_reported";
  readonly recordedAt: ChinaDateTime;
}
export type NewDayProgress = Omit<StoredDayProgress, "recordedAt">;

export type DayProgressError =
  | "invalid_request"
  | "not_found"
  | "source_not_allowed"
  | "invalid_report"
  | "stale"
  | "intent_conflict"
  | "disabled"
  | "temporarily_unavailable";
export type DayProgressReply =
  | { status: "saved" | "already_saved" | "no_change"; observationVersion: number }
  | { status: DayProgressError };

export interface DayProgressRepository extends JourneyRepository {
  findDayProgressReport(
    journeyId: string,
    reportId: string,
  ): Promise<Pick<StoredDayProgress, "version" | "intentFingerprint"> | null>;
  /** 锁住行程根记录，在锁内重跑 checkDayProgress，再写入这一版完整报告。 */
  commitDayProgress(command: {
    journeyId: string;
    command: DayProgressCommand;
    intentFingerprint: string;
    recordedAt: ChinaDateTime;
  }): Promise<DayProgressReply>;
}

export function dayProgressIntentFingerprint(journeyId: string, command: DayProgressCommand): string {
  return fingerprint({
    purpose: "generated-day-progress.v1",
    journeyId,
    ...command,
    completedActivityIds: [...command.completedActivityIds].sort(),
    skippedActivityIds: [...command.skippedActivityIds].sort(),
  });
}

export function currentDayState(stored: StoredJourney): DayState {
  if (!stored.dayDetails) throw new Error("Generated day details are missing");
  return dayState(stored.dayDetails, stored.currentPlan.activities);
}

const toStored = (value: string): ChinaDateTime => `${value.slice(0, 16)}:00+08:00`;

/**
 * 针对当前计划和已有报告执行纯校验：成员、时间和累计事实都必须一致。
 * 应用层先检查一次，仓库获得行程锁后再检查，避免两个并发上报同时使用旧状态。
 */
export function checkDayProgress(
  stored: StoredJourney,
  command: DayProgressCommand,
  intentFingerprint: string,
):
  | { status: "ready"; next: NewDayProgress }
  | { status: "no_change"; observationVersion: number }
  | { status: Exclude<DayProgressError, "invalid_request" | "not_found" | "intent_conflict" | "disabled" | "temporarily_unavailable"> } {
  if (stored.creationKind !== "generated_day" || !stored.dayDetails) {
    return { status: "source_not_allowed" };
  }
  if (
    stored.currentPlan.version !== command.basePlanVersion ||
    stored.currentObservationVersion !== command.baseObservationVersion
  ) {
    return { status: "stale" };
  }
  const state = currentDayState(stored);
  if (state.places.some(({ selection }) =>
    selection.place.ref.provider !== PLANNING_FIXTURE_PROVIDER ||
    selection.evidence.sourceKind !== "fixture")) {
    return { status: "source_not_allowed" };
  }
  // 重排后已完成活动会移到归档区，累计报告的合法成员必须同时包含归档与未来活动。
  const members = new Set([
    ...state.archived.map((item) => item.record.activity.activityId),
    ...state.future.map((item) => item.record.activity.activityId),
  ]);
  // 报告是截至当前的累计集合，不是一次点击的增量；后来的报告不能撤销已确认的完成或跳过。
  // 集合排序只用于稳定比较和幂等，不改变计划内活动的先后顺序。
  const completed = [...command.completedActivityIds].sort();
  const skipped = [...command.skippedActivityIds].sort();
  const marked = [...completed, ...skipped];
  const date = state.context.date;
  const observedAt = toStored(command.observedAt);
  const earliestResumeAt = toStored(command.earliestResumeAt);
  const previous = stored.dayProgress;
  if (
    new Set(marked).size !== marked.length ||
    marked.some((id) => !members.has(id)) ||
    !command.observedAt.startsWith(`${date}T`) ||
    !command.earliestResumeAt.startsWith(`${date}T`) ||
    !validClock(command.observedAt) || !validClock(command.earliestResumeAt) ||
    earliestResumeAt < observedAt ||
    (command.location.kind === "known" &&
      !state.places.some((item) => item.placeId === (command.location as { placeId: string }).placeId)) ||
    (previous && (
      observedAt < previous.observedAt ||
      previous.completedActivityIds.some((id) => !completed.includes(id)) ||
      previous.skippedActivityIds.some((id) => !skipped.includes(id))
    ))
  ) {
    return { status: "invalid_report" };
  }
  // 相同事实无需增加观测版本；否则一次重复点击也会让正在生成的候选无谓过期。
  const locationPlaceId = command.location.kind === "known" ? command.location.placeId : null;
  if (
    previous &&
    previous.observedAt === observedAt &&
    previous.earliestResumeAt === earliestResumeAt &&
    previous.locationPlaceId === locationPlaceId &&
    previous.completedActivityIds.join() === completed.join() &&
    previous.skippedActivityIds.join() === skipped.join()
  ) {
    return { status: "no_change", observationVersion: previous.version };
  }
  return {
    status: "ready",
    next: {
      version: stored.currentObservationVersion + 1,
      basePlanVersion: stored.currentPlan.version,
      reportId: command.reportId,
      intentFingerprint,
      observedAt,
      earliestResumeAt,
      completedActivityIds: completed,
      skippedActivityIds: skipped,
      locationPlaceId,
      source: "user_reported",
    },
  };
}

/** 读取时也验证报告仍引用当前行程的活动与地点，防止错误数据进入页面和下一次重排。 */
export function assertDayProgressMatchesState(stored: StoredJourney): void {
  const progress = stored.dayProgress;
  if (!progress) return;
  const state = currentDayState(stored);
  const members = new Set([
    ...state.archived.map((item) => item.record.activity.activityId),
    ...state.future.map((item) => item.record.activity.activityId),
  ]);
  const marked = [...progress.completedActivityIds, ...progress.skippedActivityIds];
  if (
    progress.version !== stored.currentObservationVersion ||
    progress.basePlanVersion > stored.currentPlan.version ||
    new Set(marked).size !== marked.length ||
    marked.some((id) => !members.has(id)) ||
    !progress.observedAt.startsWith(`${state.context.date}T`) ||
    !progress.earliestResumeAt.startsWith(`${state.context.date}T`) ||
    (progress.locationPlaceId !== null &&
      !state.places.some((item) => item.placeId === progress.locationPlaceId)) ||
    // 已被重排归档的完成或跳过标记属于历史事实，之后的上报不能改变。
    state.archived.some((item) =>
      !(item.status === "completed" ? progress.completedActivityIds : progress.skippedActivityIds)
        .includes(item.record.activity.activityId))
  ) {
    throw new Error("Generated progress does not match the current version");
  }
}

function validClock(value: string): boolean {
  const hours = Number(value.slice(11, 13));
  const minutes = Number(value.slice(14, 16));
  return hours < 24 && minutes < 60;
}

export async function reportDayProgress(options: {
  journeyId: string;
  command: DayProgressCommand;
  enabled: boolean;
  now: number;
  repository: DayProgressRepository;
}): Promise<DayProgressReply> {
  const { journeyId, command, repository } = options;
  const intentFingerprint = dayProgressIntentFingerprint(journeyId, command);
  // 先回放同一次上报的成功结果，再考虑开关和后续版本；同 ID 不同意图则拒绝。
  const prior = await repository.findDayProgressReport(journeyId, command.reportId);
  if (prior) {
    return prior.intentFingerprint === intentFingerprint
      ? { status: "already_saved", observationVersion: prior.version }
      : { status: "intent_conflict" };
  }
  if (!options.enabled) return { status: "disabled" };
  const stored = await repository.findCurrentJourney(journeyId);
  if (!stored) return { status: "not_found" };
  const checked = checkDayProgress(stored, command, intentFingerprint);
  if (checked.status !== "ready") return checked;
  return repository.commitDayProgress({
    journeyId,
    command,
    intentFingerprint,
    recordedAt: toChinaDateTime(new Date(options.now)),
  });
}

/** 页面只叠加当前报告；查看历史计划时不能套用后来上报的进度。 */
export type DayProgressView =
  | { status: "unreported" }
  | {
      status: "reported";
      version: number;
      basePlanVersion: number;
      observedAt: ChinaDateTime;
      earliestResumeAt: ChinaDateTime;
      completedActivityIds: readonly string[];
      skippedActivityIds: readonly string[];
      locationPlaceId: string | null;
      recordedAt: ChinaDateTime;
    };

export function toDayProgressView(progress: StoredDayProgress | undefined): DayProgressView {
  if (!progress) return { status: "unreported" };
  return {
    status: "reported",
    version: progress.version,
    basePlanVersion: progress.basePlanVersion,
    observedAt: progress.observedAt,
    earliestResumeAt: progress.earliestResumeAt,
    completedActivityIds: progress.completedActivityIds,
    skippedActivityIds: progress.skippedActivityIds,
    locationPlaceId: progress.locationPlaceId,
    recordedAt: progress.recordedAt,
  };
}
