import { z } from "zod";
import type { ChinaDateTime } from "@tripquest/domain";
import type {
  InitialJourneyDraft,
  JourneyIdGenerator,
  StoredJourney,
  JourneyClock,
} from "./contracts";
import {
  assertDaySnapshotIntegrity,
  dayDraftConfirmationSnapshotSchema,
  dayDraftSemanticFingerprint,
  refreshDayFixtureRoutes,
  DAY_CONFIRMATION_PROTOCOL,
  type DayDraftConfirmationSnapshot,
} from "./day-confirmation";
import { fingerprint } from "./fingerprint";
import { createCheckedIdFactory, toChinaDateTime } from "./runtime-values";

export const storedDayPlanDetailsSchema = z.strictObject({
  schemaVersion: z.literal("stored-day-plan.v1"),
  planVersion: z.literal(1),
  planning: dayDraftConfirmationSnapshotSchema,
  placeBindings: z.array(z.strictObject({
    draftPlaceId: z.string().min(1).max(100),
    placeId: z.uuid(),
  })).min(1).max(16),
  activityBindings: z.array(z.strictObject({
    draftActivityId: z.string().min(1).max(100),
    activityId: z.uuid(),
  })).min(1).max(6),
  recheckedAt: z.iso.datetime({ offset: true }),
  acknowledgeUnknowns: z.boolean(),
});
export type StoredDayPlanDetails = z.infer<typeof storedDayPlanDetailsSchema>;
export interface InitialGeneratedDayDraft extends InitialJourneyDraft {
  readonly creationRunId: string;
  readonly creationIntentFingerprint: string;
  readonly dayDetails: StoredDayPlanDetails;
}
export interface StoredGeneratedDayCreation {
  readonly journeyId: string;
  readonly intentFingerprint: string;
}
export type CommitGeneratedDayOutcome =
  | {
      readonly status: "saved" | "already_saved";
      readonly journeyId: string;
      readonly planVersion: 1;
    }
  | { readonly status: "intent_conflict" };
export interface GeneratedDayRepository {
  findGeneratedDayCreation(runId: string): Promise<StoredGeneratedDayCreation | null>;
  createGeneratedDay(draft: InitialGeneratedDayDraft): Promise<CommitGeneratedDayOutcome>;
}

export function generatedDayIntentFingerprint(
  title: string,
  draftFingerprint: string,
  acknowledgeUnknowns: boolean,
): string {
  return fingerprint({
    protocol: DAY_CONFIRMATION_PROTOCOL,
    source: "tripquest-planning-fixture",
    title: title.trim(),
    draftFingerprint,
    acknowledgeUnknowns,
  });
}

function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid stored generated day");
}
const at = (date: string, minutes: number): ChinaDateTime =>
  `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`;

/** 写入前与每次读取生成行程时都复核详细快照和聚合记录；不一致就报错，不能退回普通手工行程读取。 */
export function assertStoredDayMatchesJourney(
  details: StoredDayPlanDetails,
  stored: Pick<StoredJourney, "currentPlan" | "activitySnapshots" | "reservations">,
): void {
  assertDaySnapshotIntegrity(details.planning, false);
  const { draft } = details.planning;
  const { currentPlan } = stored;
  invariant(
    currentPlan.version === details.planVersion &&
    currentPlan.parentVersion === undefined &&
    currentPlan.date === draft.date &&
    currentPlan.timeZone === draft.timeZone &&
    currentPlan.activities.length === draft.activities.length &&
    stored.activitySnapshots.length === draft.activities.length,
  );
  invariant(details.acknowledgeUnknowns || draft.verification !== "pending");
  invariant(details.placeBindings.length === details.planning.places.length);
  invariant(details.activityBindings.length === draft.activities.length);
  const places = new Map(details.placeBindings.map((item) => [item.draftPlaceId, item.placeId]));
  const activities = new Map(details.activityBindings.map((item) => [item.draftActivityId, item.activityId]));
  invariant(places.size === details.placeBindings.length && activities.size === details.activityBindings.length);
  invariant(new Set(places.values()).size === places.size && new Set(activities.values()).size === activities.size);
  invariant(details.planning.places.every((item) => places.has(item.placeId)));
  let fixedCount = 0;
  for (const [index, activity] of draft.activities.entries()) {
    const row = currentPlan.activities[index];
    const label = stored.activitySnapshots[index];
    const name = draft.places.find((place) => place.placeId === activity.placeId)?.name;
    invariant(
      row.id === activities.get(activity.activityId) &&
      row.placeId === places.get(activity.placeId) &&
      row.startsAt === at(draft.date, activity.startsAt) &&
      row.endsAt === at(draft.date, activity.endsAt) &&
      row.locked === (activity.role === "fixed") &&
      row.priority === (activity.role === "fixed" || activity.role === "required" ? "high" : "normal") &&
      label.activityId === row.id &&
      label.position === index &&
      label.placeName === name,
    );
    if (activity.role !== "fixed") {
      invariant(row.reservationId === undefined);
      continue;
    }
    fixedCount += 1;
    const reservation = stored.reservations.find((item) => item.reservation.id === row.reservationId);
    invariant(
      reservation &&
      reservation.placeName === name &&
      reservation.reservation.placeId === row.placeId &&
      reservation.reservation.startsAt === row.startsAt &&
      reservation.reservation.endsAt === row.endsAt &&
      reservation.reservation.confirmation.status === "unknown" &&
      reservation.reservation.confirmation.source.kind === "user_reported",
    );
  }
  invariant(stored.reservations.length === fixedCount);
}

export async function confirmGeneratedDay(options: {
  snapshot: DayDraftConfirmationSnapshot;
  draftFingerprint: string;
  title: string;
  acknowledgeUnknowns: boolean;
  expiresAt: number;
  enabled: boolean;
  repository: GeneratedDayRepository;
  idGenerator: JourneyIdGenerator;
  clock: JourneyClock;
}): Promise<CommitGeneratedDayOutcome | { status: "disabled" | "expired" | "acknowledgment_required" | "draft_changed" }> {
  const { snapshot, repository } = options;
  assertDaySnapshotIntegrity(snapshot, false);
  invariant(dayDraftSemanticFingerprint(snapshot) === options.draftFingerprint);
  const title = options.title.trim();
  invariant(title.length >= 1 && title.length <= 80);
  const intentFingerprint = generatedDayIntentFingerprint(
    title,
    options.draftFingerprint,
    options.acknowledgeUnknowns,
  );
  // 用生成 runId 找成功回执，再比确认意图；浏览器重试不会创建第二份行程，同 runId 也不能改标题后冒充重试。
  const prior = await repository.findGeneratedDayCreation(snapshot.problem.runId);
  if (prior !== null) {
    return prior.intentFingerprint === intentFingerprint
      ? { status: "already_saved", journeyId: prior.journeyId, planVersion: 1 }
      : { status: "intent_conflict" };
  }
  if (!options.enabled) return { status: "disabled" };
  const now = options.clock.now();
  if (now.getTime() >= options.expiresAt) return { status: "expired" };
  if (snapshot.draft.verification === "pending" && !options.acknowledgeUnknowns) {
    return { status: "acknowledgment_required" };
  }
  // 首次保存才检查目录是否仍有效并刷新路线；已成功的旧回执不受后来目录升级影响。
  let refreshed;
  try {
    assertDaySnapshotIntegrity(snapshot);
    refreshed = await refreshDayFixtureRoutes(snapshot, now.getTime());
    if (dayDraftSemanticFingerprint(snapshot, refreshed) !== options.draftFingerprint) {
      return { status: "draft_changed" };
    }
  } catch {
    return { status: "draft_changed" };
  }
  // 复查通过才把草案的局部 ID 映射到正式 UUID。映射随详情保存，读取时据此核对每条活动。
  const nextId = createCheckedIdFactory(options.idGenerator);
  const journeyId = nextId("journey");
  const confirmedAt = toChinaDateTime(now);
  const places = new Map(snapshot.places.map((item) => [item.placeId, nextId("place")]));
  const activityBindings = snapshot.draft.activities.map((item) => ({
    draftActivityId: item.activityId,
    activityId: nextId("activity"),
  }));
  const reservations: InitialJourneyDraft["reservations"][number][] = [];
  const activities = snapshot.draft.activities.map((item, index) => {
    const placeId = places.get(item.placeId)!;
    const startsAt = at(snapshot.draft.date, item.startsAt);
    const endsAt = at(snapshot.draft.date, item.endsAt);
    const reservationId = item.role === "fixed" ? nextId("reservation") : undefined;
    // 固定时段只说明用户要求保留，不能据此宣称预约已被外部平台确认。
    if (reservationId) {
      reservations.push({
        placeName: snapshot.draft.places.find((place) => place.placeId === item.placeId)!.name,
        reservation: {
          id: reservationId,
          placeId,
          startsAt,
          endsAt,
          confirmation: {
            status: "unknown",
            source: { kind: "user_reported" },
            recordedAt: confirmedAt,
          },
        },
      });
    }
    return {
      id: activityBindings[index].activityId,
      placeId,
      startsAt,
      endsAt,
      priority: item.role === "fixed" || item.role === "required" ? "high" as const : "normal" as const,
      locked: item.role === "fixed",
      ...(reservationId ? { reservationId } : {}),
    };
  });
  const dayDetails = storedDayPlanDetailsSchema.parse({
    schemaVersion: "stored-day-plan.v1",
    planVersion: 1,
    planning: { ...snapshot, draft: refreshed },
    placeBindings: [...places].map(([draftPlaceId, placeId]) => ({ draftPlaceId, placeId })),
    activityBindings,
    recheckedAt: now.toISOString(),
    acknowledgeUnknowns: options.acknowledgeUnknowns,
  });
  // 原路线时间戳继续随原语义快照保存，复查时间另记；刷新证据不应改变用户确认的业务安排。
  const draft: InitialGeneratedDayDraft = {
    journeyId,
    title,
    createdAt: confirmedAt,
    updatedAt: confirmedAt,
    creationRunId: snapshot.problem.runId,
    creationIntentFingerprint: intentFingerprint,
    currentPlan: {
      journeyId,
      date: snapshot.draft.date,
      timeZone: snapshot.draft.timeZone,
      version: 1,
      changeReason: "initial_creation",
      activities,
    },
    activitySnapshots: activities.map((item, position) => ({
      activityId: item.id,
      position,
      placeName: snapshot.draft.places.find((place) => place.placeId === snapshot.draft.activities[position].placeId)!.name,
    })),
    reservations,
    dayDetails,
  };
  assertStoredDayMatchesJourney(dayDetails, draft);
  return repository.createGeneratedDay(draft);
}
