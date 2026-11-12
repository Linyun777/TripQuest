import type {
  CommitAdjustmentResult,
  ConfirmedAdjustmentDraft,
  ConfirmationJourneyRepository,
  InitialJourneyDraft,
  JourneyListRepository,
  JourneySummary,
  StoredConfirmation,
  StoredJourney,
} from "@tripquest/application";
import type {
  ActivityPriority,
  ChinaDateTime,
  JourneyTimeZone,
  Reservation,
  ReservationConfirmationStatus,
} from "@tripquest/domain";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  assertStoredDayMatchesJourney, storedDayPlanDetailsSchema, generatedDayIntentFingerprint,
  type InitialGeneratedDayDraft, type StoredGeneratedDayCreation,
  type GeneratedDayRepository, type CommitGeneratedDayOutcome,
} from "@tripquest/application/generated-day";
import { dayDraftSemanticFingerprint } from "@tripquest/application/day-confirmation";

import {
  savedDayFingerprint,
  assertDayEditCommit,
  type DayEditRepository,
  type ConfirmedDayEdit,
  type StoredDayEditConfirmation,
} from "@tripquest/application/day-edit";
import { assertDaySnapshotIntegrity } from "@tripquest/application/day-confirmation";
import type { DayEditConfirmReply } from "@tripquest/application/saved-day";
import {
  assertDayProgressMatchesState,
  checkDayProgress,
  dayProgressIntentFingerprint,
  type DayProgressReply,
  type DayProgressRepository,
  type NewDayProgress,
  type StoredDayProgress,
} from "@tripquest/application/day-progress";
import {
  assertAdjustmentCommit,
  assertRealDayProgressMatches,
  checkRealDayProgress,
  type RealDayAdjustRepository,
} from "@tripquest/application/real-adjust";
import {
  assertDayReplanCommit,
  type ConfirmedDayReplan,
  type DayReplanRepository,
  type StoredDayReplanConfirmation,
} from "@tripquest/application/day-replan-confirm";
import { replanBaseFingerprint, type ReplanConfirmReply } from "@tripquest/application/day-replan";
import {
  assertRealDayMatchesJourney,
  storedRealDaySchema,
  type InitialRealDayDraft,
  type RealDayRepository,
  type RealDaySaveOutcome,
} from "@tripquest/application/real-day";
import {
  assertGeneratedDayMatchesJourney,
  assertGeneratedDayPreservesInitial,
  generatedDayDetailsSchema,
} from "@tripquest/application/generated-day-read";
import {
  outingBaseIsCurrent,
  storedTripSchema,
  type InitialTrip,
  type OutingChangeBase,
  type OutingChangeCommit,
  type OutingChangeOutcome,
  type OutingChangeRepository,
  type StoredTrip,
  type TripRepository,
  type TripSaveOutcome,
} from "@tripquest/application/outing-trip";
import type { JourneyDatabase } from "./connection";
import {
  trips,
  journeys,
  dayPlanDetails,
  generatedDayEditConfirmations,
  generatedDayProgress,
  generatedDayReplanConfirmations,
  journeyObservations,
  planActivities,
  planConfirmations,
  planVersions,
  reservations,
} from "./schema";

const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;
type JourneyTransaction = Parameters<Parameters<JourneyDatabase["transaction"]>[0]>[0];

export class JourneyPersistenceError extends Error {
  override readonly name = "JourneyPersistenceError";
}

/**
 * 行程聚合的事务边界：写新版本、进度和确认记录时先锁行程根，再重读当前状态并校验。
 * 应用层的复核不能代替锁内检查；并发确认只能有一个新写入，其余重放同一意图或返回过期。
 */
export class DrizzleJourneyRepository
  implements
    ConfirmationJourneyRepository,
    RealDayRepository,
    RealDayAdjustRepository,
    GeneratedDayRepository,
    DayEditRepository,
    DayProgressRepository,
    DayReplanRepository,
    JourneyListRepository,
    TripRepository,
    OutingChangeRepository
{
  /**
   * V2.12：仓库绑定一个用户（stages/V2.12.md §3.4），只读写这个用户的行程和出游；别人的和不存在一样。
   * 子表（版本、进度、确认、调整）按它们所属行程的用户过滤。
   */
  constructor(
    private readonly database: JourneyDatabase,
    private readonly userId: string,
  ) {}

  private journey(id: string | SQL | AnyPgColumn) {
    return and(eq(journeys.id, id), eq(journeys.userId, this.userId));
  }

  private trip(id: string | SQL | AnyPgColumn) {
    return and(eq(trips.id, id), eq(trips.userId, this.userId));
  }

  /** 子表的这一行所属的行程是这个用户的。 */
  private ownedJourney(column: AnyPgColumn): SQL {
    return sql`exists (select 1 from ${journeys} where ${journeys.id} = ${column} and ${journeys.userId} = ${this.userId})`;
  }

  /**
   * 最近更新的 limit 项：一趟出游算一项（它的各天各段全部返回），日常的一日行程各算一项。按行截取时，一趟出游
   * 排在后面的天会被截掉，列表把它们显示成“只有交通”。
   */
  async listJourneys(limit: number): Promise<readonly JourneySummary[]> {
    const item = sql`coalesce(${journeys.tripId}, ${journeys.id})`;
    const latest = this.database
      .select({ item: item.as("item") })
      .from(journeys)
      .where(eq(journeys.userId, this.userId))
      .groupBy(item)
      .orderBy(desc(sql`max(${journeys.updatedAt})`), desc(item))
      .limit(Math.min(Math.max(Math.trunc(limit), 1), 100));
    const rows = await this.database
      .select({
        id: journeys.id,
        title: journeys.title,
        creationKind: journeys.creationKind,
        date: journeys.journeyDate,
        updatedAt: journeys.updatedAt,
        cityName: journeys.cityName,
        tripId: journeys.tripId,
        tripTitle: trips.title,
        tripFirst: trips.firstDate,
        tripLast: trips.lastDate,
        tripDay: journeys.tripDay,
        tripPart: journeys.tripPart,
      })
      .from(journeys)
      .leftJoin(trips, this.trip(journeys.tripId))
      .where(and(eq(journeys.userId, this.userId), inArray(item, latest)))
      .orderBy(desc(journeys.updatedAt), desc(journeys.id));
    return rows.map(({ tripId, tripTitle, tripFirst, tripLast, tripDay, tripPart, ...row }) => ({
      ...row,
      creationKind: row.creationKind as JourneySummary["creationKind"],
      updatedAt: new Date(row.updatedAt).toISOString(),
      // V2.11：出游的各天带上出游，页面按出游分组。
      ...(tripId && tripTitle && tripFirst && tripLast && tripDay && tripPart !== null
        ? { trip: { id: tripId, title: tripTitle, day: tripDay, part: tripPart, firstDate: tripFirst, lastDate: tripLast } }
        : {}),
    }));
  }

  async findTripCreation(generationId: string): Promise<{ tripId: string } | null> {
    const [row] = await this.database.select({ tripId: trips.id }).from(trips)
      .where(and(eq(trips.generationId, generationId), eq(trips.userId, this.userId))).limit(1);
    return row ?? null;
  }

  /** 出游和各天的一日行程在一个事务里写入：任何一天写不进去，整趟都不留。 */
  async createTrip(trip: InitialTrip): Promise<TripSaveOutcome> {
    const details = storedTripSchema.parse(trip.details);
    const checked = trip.days.map((entry) => {
      const realDay = storedRealDaySchema.parse(entry.journey.realDay);
      assertRealDayMatchesJourney(realDay, entry.journey);
      return { ...entry, realDay, snapshots: assertInitialJourneyDraft(entry.journey, true) };
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => {
          const [prior] = await tx.select({ tripId: trips.id }).from(trips)
            .where(and(eq(trips.generationId, trip.generationId), eq(trips.userId, this.userId))).limit(1);
          if (prior) return { status: "already_saved", tripId: prior.tripId };
          const createdAt = parseChinaDateTime(trip.createdAt, "trip createdAt");
          await tx.insert(trips).values({
            id: trip.tripId,
            userId: this.userId,
            generationId: trip.generationId,
            title: trip.title,
            firstDate: trip.firstDate,
            lastDate: trip.lastDate,
            details,
            createdAt,
            updatedAt: createdAt,
          });
          for (const entry of checked) {
            await this.insertInitialJourney(tx, entry.journey, entry.snapshots, {
              kind: "real_day",
              runId: entry.journey.creationRunId,
              intentFingerprint: entry.journey.creationIntentFingerprint,
              details: entry.realDay,
            }, { id: trip.tripId, day: entry.day, part: entry.part });
          }
          return { status: "saved", tripId: trip.tripId };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        const code = postgresCode(error);
        if (code === "40001" || (code === "23505" && postgresConstraint(error) === "trips_generation_id_unique")) {
          const winner = await this.findTripCreation(trip.generationId);
          if (winner) return { status: "already_saved", tripId: winner.tripId };
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Trip creation retries were exhausted");
  }

  /** 一趟出游：结构和各天各段的行程编号。 */
  async findTrip(tripId: string): Promise<{
    id: string;
    title: string;
    firstDate: string;
    lastDate: string;
    details: StoredTrip;
    days: { day: number; part: number; journeyId: string }[];
  } | null> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.select().from(trips).where(this.trip(tripId)).limit(1);
      if (!row) return null;
      const parts = await tx.select({ journeyId: journeys.id, day: journeys.tripDay, part: journeys.tripPart })
        .from(journeys).where(and(eq(journeys.tripId, tripId), eq(journeys.userId, this.userId))).orderBy(asc(journeys.tripDay), asc(journeys.tripPart));
      return {
        id: row.id,
        title: row.title,
        firstDate: row.firstDate,
        lastDate: row.lastDate,
        details: storedTripSchema.parse(row.details),
        days: parts.map((part) => ({ day: part.day!, part: part.part!, journeyId: part.journeyId })),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async readTripBase(tripId: string): Promise<(OutingChangeBase & { details: StoredTrip }) | null> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.select().from(trips).where(this.trip(tripId)).limit(1);
      if (!row) return null;
      return { ...(await this.tripBase(tx, tripId, row.version)), details: storedTripSchema.parse(row.details) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /** 出游版本和它每一个一日行程的当前计划版本、进度版本。 */
  private async tripBase(tx: JourneyTransaction, tripId: string, version: number): Promise<OutingChangeBase> {
    const rows = await tx.select({
      journeyId: journeys.id,
      planVersion: planVersions.version,
      observationVersion: journeys.currentObservationVersion,
    }).from(journeys)
      .innerJoin(planVersions, and(eq(planVersions.journeyId, journeys.id), eq(planVersions.isCurrent, true)))
      .where(and(eq(journeys.tripId, tripId), eq(journeys.userId, this.userId)));
    return { tripVersion: version, journeys: rows };
  }

  /**
   * V2.11 确认跨天改动：锁住出游，比对出游和每一天的基础版本（任何一个变了整体拒绝）；给今天挪走的站记跳过；
   * 受影响的天整天换成新的一日行程（这些天还没开始，没有进度）；出游版本加一。全部在一个事务里。
   */
  async commitOutingChange(commit: OutingChangeCommit): Promise<OutingChangeOutcome> {
    const details = storedTripSchema.parse({ ...commit.details, lastChangeId: commit.changeId });
    const checked = commit.replace.flatMap((entry) => entry.journeys.map((item) => {
      const realDay = storedRealDaySchema.parse(item.journey.realDay);
      assertRealDayMatchesJourney(realDay, item.journey);
      return { ...item, realDay, snapshots: assertInitialJourneyDraft(item.journey, true) };
    }));
    const listed = async (tx: JourneyTransaction) => (await tx.select({ journeyId: journeys.id, day: journeys.tripDay, part: journeys.tripPart })
      .from(journeys).where(and(eq(journeys.tripId, commit.tripId), eq(journeys.userId, this.userId)))).map((row) => ({ journeyId: row.journeyId, day: row.day!, part: row.part! }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx): Promise<OutingChangeOutcome> => {
          const [row] = await tx.select().from(trips).where(this.trip(commit.tripId)).for("update").limit(1);
          if (!row) return { status: "not_found" };
          if (storedTripSchema.parse(row.details).lastChangeId === commit.changeId) return { status: "already_saved", journeys: await listed(tx) };
          if (!outingBaseIsCurrent(commit.base, await this.tripBase(tx, commit.tripId, row.version))) return { status: "stale" };
          const confirmedAt = parseChinaDateTime(commit.confirmedAt, "outing change confirmedAt");
          if (commit.skip) {
            const current = await this.readCurrentJourney(tx, commit.skip.journeyId);
            if (!current) return { status: "stale" };
            const at = `${commit.confirmedAt.slice(0, 16)}+08:00` as const;
            const progress = checkRealDayProgress(current, {
              reportId: commit.changeId,
              basePlanVersion: current.currentPlan.version,
              baseObservationVersion: current.currentObservationVersion,
              completedActivityIds: [...(current.dayProgress?.completedActivityIds ?? [])],
              skippedActivityIds: [...new Set([...(current.dayProgress?.skippedActivityIds ?? []), commit.skip.activityId])],
              observedAt: at,
              earliestResumeAt: at,
              location: { kind: "unknown" },
              noCurrentActivity: true,
            });
            if (progress.status === "ok") await this.insertProgress(tx, commit.skip.journeyId, progress.progress, commit.confirmedAt);
            else if (progress.status !== "no_change") return { status: "stale" };
          }
          for (const entry of commit.replace) {
            await tx.delete(journeys).where(and(eq(journeys.tripId, commit.tripId), eq(journeys.userId, this.userId), eq(journeys.tripDay, entry.day)));
          }
          for (const item of checked) {
            await this.insertInitialJourney(tx, item.journey, item.snapshots, {
              kind: "real_day",
              runId: item.journey.creationRunId,
              intentFingerprint: item.journey.creationIntentFingerprint,
              details: item.realDay,
            }, { id: commit.tripId, day: item.day, part: item.part });
          }
          await tx.update(trips).set({ details, version: row.version + 1, updatedAt: confirmedAt }).where(this.trip(commit.tripId));
          return { status: "saved", journeys: await listed(tx) };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        if (postgresCode(error) === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Outing change retries were exhausted");
  }

  /** 删除出游，各天的行程随之删除（外键级联）。 */
  async deleteTrip(tripId: string): Promise<"deleted" | "not_found"> {
    const removed = await this.database.delete(trips).where(this.trip(tripId)).returning({ id: trips.id });
    return removed.length ? "deleted" : "not_found";
  }

  async createInitialJourney(draft: InitialJourneyDraft): Promise<void> {
    const snapshots = assertInitialJourneyDraft(draft);
    await this.database.transaction(
      (tx) => this.insertInitialJourney(tx, draft, snapshots),
      { isolationLevel: "serializable", accessMode: "read write" },
    );
  }

  private async insertInitialJourney(
    transaction: JourneyTransaction,
    draft: InitialJourneyDraft,
    snapshotsByActivityId: Map<string, InitialJourneyDraft["activitySnapshots"][number]>,
    creation?: {
      kind: "generated_day" | "real_day";
      runId: string;
      intentFingerprint: string;
      details: unknown;
    },
    trip?: { id: string; day: number; part: number },
  ): Promise<void> {
    await transaction.insert(journeys).values({
      id: draft.journeyId,
      userId: this.userId,
      creationKind: creation?.kind ?? "manual",
      creationRunId: creation?.runId ?? null,
      creationIntentFingerprint: creation?.intentFingerprint ?? null,
      title: draft.title,
      ...(draft.city ? { cityAdcode: draft.city.adcode, cityName: draft.city.name } : {}),
      journeyDate: draft.currentPlan.date,
      timeZone: draft.currentPlan.timeZone,
      ...(trip ? { tripId: trip.id, tripDay: trip.day, tripPart: trip.part } : {}),
      createdAt: parseChinaDateTime(draft.createdAt, "journey createdAt"),
      updatedAt: parseChinaDateTime(draft.updatedAt, "journey updatedAt"),
    });

    await transaction.insert(planVersions).values({
      journeyId: draft.journeyId,
      version: draft.currentPlan.version,
      parentVersion: draft.currentPlan.parentVersion ?? null,
      changeReason: draft.currentPlan.changeReason ?? null,
      isCurrent: true,
      createdAt: parseChinaDateTime(draft.createdAt, "plan createdAt"),
    });

    if (draft.reservations.length > 0) {
      await transaction.insert(reservations).values(
        draft.reservations.map(({ placeName, reservation }) => ({
          id: reservation.id,
          journeyId: draft.journeyId,
          placeId: reservation.placeId,
          placeName,
          startsAt: parseChinaDateTime(
            reservation.startsAt,
            "reservation startsAt",
          ),
          endsAt: parseChinaDateTime(
            reservation.endsAt,
            "reservation endsAt",
          ),
          confirmationStatus: reservation.confirmation.status,
          sourceKind: reservation.confirmation.source.kind,
          sourceReference:
            reservation.confirmation.source.reference ?? null,
          recordedAt: parseChinaDateTime(
            reservation.confirmation.recordedAt,
            "reservation recordedAt",
          ),
        })),
      );
    }

    await transaction.insert(planActivities).values(
      draft.currentPlan.activities.map((activity) => {
        const snapshot = snapshotsByActivityId.get(activity.id);
        if (snapshot === undefined) {
          throw new JourneyPersistenceError(
            "Activity snapshot is missing during persistence",
          );
        }
        return {
          journeyId: draft.journeyId,
          planVersion: draft.currentPlan.version,
          activityId: activity.id,
          position: snapshot.position,
          placeId: activity.placeId,
          placeName: snapshot.placeName,
          startsAt: parseChinaDateTime(activity.startsAt, "activity startsAt"),
          endsAt: parseChinaDateTime(activity.endsAt, "activity endsAt"),
          priority: activity.priority,
          locked: activity.locked,
          reservationId: activity.reservationId ?? null,
        };
      }),
    );
    if (creation) {
      await transaction.insert(dayPlanDetails).values({
        journeyId: draft.journeyId, planVersion: 1, details: creation.details,
      });
    }
  }

  async findGeneratedDayCreation(runId: string): Promise<StoredGeneratedDayCreation | null> {
    const [row] = await this.database.select({
      journeyId: journeys.id, intentFingerprint: journeys.creationIntentFingerprint,
      creationKind: journeys.creationKind,
    }).from(journeys).where(and(eq(journeys.creationRunId, runId), eq(journeys.userId, this.userId))).limit(1);
    if (!row) return null;
    if (row.creationKind !== "generated_day" || !row.intentFingerprint) {
      throw new JourneyPersistenceError("Generated creation identity is invalid");
    }
    return { journeyId: row.journeyId, intentFingerprint: row.intentFingerprint };
  }

  async createGeneratedDay(draft: InitialGeneratedDayDraft): Promise<CommitGeneratedDayOutcome> {
    const details = storedDayPlanDetailsSchema.parse(draft.dayDetails);
    assertStoredDayMatchesJourney(details, draft);
    if (draft.creationRunId !== details.planning.problem.runId ||
      draft.creationIntentFingerprint !== generatedDayIntentFingerprint(
        draft.title, dayDraftSemanticFingerprint(details.planning), details.acknowledgeUnknowns,
      )) {
      throw new JourneyPersistenceError("Generated creation does not match its run");
    }
    // 仓库也验证“需求 → 草案 → 聚合记录”的绑定，不能假设所有调用方都已经走过应用层确认。
    const snapshots = assertInitialJourneyDraft(draft, true);
    const replay = (prior: StoredGeneratedDayCreation): CommitGeneratedDayOutcome =>
      prior.intentFingerprint === draft.creationIntentFingerprint
        ? { status: "already_saved", journeyId: prior.journeyId, planVersion: 1 }
        : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => {
          const [prior] = await tx.select({
            journeyId: journeys.id, intentFingerprint: journeys.creationIntentFingerprint,
          }).from(journeys).where(and(eq(journeys.creationRunId, draft.creationRunId), eq(journeys.userId, this.userId))).limit(1);
          if (prior?.intentFingerprint) return replay({
            journeyId: prior.journeyId, intentFingerprint: prior.intentFingerprint,
          });
          await this.insertInitialJourney(tx, draft, snapshots, {
            kind: "generated_day",
            runId: draft.creationRunId,
            intentFingerprint: draft.creationIntentFingerprint,
            details,
          });
          return { status: "saved", journeyId: draft.journeyId, planVersion: 1 };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        const code = postgresCode(error);
        // 序列化冲突或唯一键冲突都可能说明另一请求已先保存；事务回滚后查胜出结果。
        // 即使已到最后一次重试，也先识别成功回放，再决定是否向上抛错。
        if (
          code === "40001" ||
          (code === "23505" && postgresConstraint(error) === "journeys_creation_run_id_unique")
        ) {
          const winner = await this.findGeneratedDayCreation(draft.creationRunId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Generated creation retries were exhausted");
  }

  async findRealDayCreation(runId: string): Promise<{ journeyId: string; intentFingerprint: string } | null> {
    const [row] = await this.database.select({
      journeyId: journeys.id, intentFingerprint: journeys.creationIntentFingerprint,
      creationKind: journeys.creationKind,
    }).from(journeys).where(and(eq(journeys.creationRunId, runId), eq(journeys.userId, this.userId))).limit(1);
    if (!row) return null;
    // 同 runId 已经保存为模拟行程时，不能当作真实行程的成功回放，必须报告意图冲突。
    if (row.creationKind !== "real_day" || !row.intentFingerprint) return { journeyId: row.journeyId, intentFingerprint: "" };
    return { journeyId: row.journeyId, intentFingerprint: row.intentFingerprint };
  }

  /** 真实行程复用按 runId 幂等创建的事务边界，只保存允许长期存储的最小记录。 */
  async createRealDay(draft: InitialRealDayDraft): Promise<RealDaySaveOutcome> {
    const details = storedRealDaySchema.parse(draft.realDay);
    assertRealDayMatchesJourney(details, draft);
    if (draft.creationRunId !== details.context.creationRunId) {
      throw new JourneyPersistenceError("Real creation does not match its run");
    }
    const snapshots = assertInitialJourneyDraft(draft, true);
    const replay = (prior: { journeyId: string; intentFingerprint: string }): RealDaySaveOutcome =>
      prior.intentFingerprint === draft.creationIntentFingerprint
        ? { status: "already_saved", journeyId: prior.journeyId, planVersion: 1 }
        : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => {
          const [prior] = await tx.select({
            journeyId: journeys.id, intentFingerprint: journeys.creationIntentFingerprint,
            creationKind: journeys.creationKind,
          }).from(journeys).where(and(eq(journeys.creationRunId, draft.creationRunId), eq(journeys.userId, this.userId))).limit(1);
          if (prior) {
            return replay({
              journeyId: prior.journeyId,
              intentFingerprint: prior.creationKind === "real_day" ? prior.intentFingerprint ?? "" : "",
            });
          }
          await this.insertInitialJourney(tx, draft, snapshots, {
            kind: "real_day",
            runId: draft.creationRunId,
            intentFingerprint: draft.creationIntentFingerprint,
            details,
          });
          return { status: "saved", journeyId: draft.journeyId, planVersion: 1 };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        const code = postgresCode(error);
        if (
          code === "40001" ||
          (code === "23505" && postgresConstraint(error) === "journeys_creation_run_id_unique")
        ) {
          const winner = await this.findRealDayCreation(draft.creationRunId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Real creation retries were exhausted");
  }

  // 多表聚合必须读同一快照，否则可能把旧 current 版本与刚更新的活动、观察状态拼在一起。
  async findCurrentJourney(journeyId: string): Promise<StoredJourney | null> {
    return this.database.transaction(
      (transaction) => this.readCurrentJourney(transaction, journeyId),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  // 历史版本按指定版本读取，不能用当前指针补齐缺项，否则会把不同时间的安排混在一张页面上。
  async findJourneyVersion(
    journeyId: string,
    version: number,
  ): Promise<StoredJourney | null> {
    return this.database.transaction(
      (transaction) => this.readCurrentJourney(transaction, journeyId, version),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async findDayEditConfirmation(
    journeyId: string,
    editId: string,
  ): Promise<StoredDayEditConfirmation | null> {
    const [row] = await this.database
      .select()
      .from(generatedDayEditConfirmations)
      .where(
        and(
          eq(generatedDayEditConfirmations.journeyId, journeyId),
          eq(generatedDayEditConfirmations.editId, editId),
          this.ownedJourney(generatedDayEditConfirmations.journeyId),
        ),
      )
      .limit(1);
    return row
      ? {
          intentFingerprint: row.intentFingerprint,
          resultPlanVersion: row.resultPlanVersion,
        }
      : null;
  }

  async commitDayEdit(command: ConfirmedDayEdit): Promise<DayEditConfirmReply> {
    const { receipt, next } = command;
    const replay = (prior: StoredDayEditConfirmation): DayEditConfirmReply =>
      prior.intentFingerprint === command.intentFingerprint
        ? {
            status: "already_saved",
            journeyId: receipt.journeyId,
            planVersion: prior.resultPlanVersion,
          }
        : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(
          async (tx) => {
            const [root] = await tx
              .select()
              .from(journeys)
              .where(this.journey(receipt.journeyId))
              .for("update")
              .limit(1);
            if (!root || root.creationKind !== "generated_day")
              return { status: "stale" };
            const [prior] = await tx
              .select()
              .from(generatedDayEditConfirmations)
              .where(
                and(
                  eq(
                    generatedDayEditConfirmations.journeyId,
                    receipt.journeyId,
                  ),
                  eq(generatedDayEditConfirmations.editId, receipt.editId),
                ),
              )
              .limit(1);
            if (prior) return replay(prior);
            const current = await this.readCurrentJourney(
              tx,
              receipt.journeyId,
            );
            if (
              !current ||
              current.currentPlan.version !== receipt.basePlanVersion ||
              current.currentObservationVersion !==
                receipt.baseObservationVersion ||
              receipt.baseObservationVersion !== 0
            ) {
              return { status: "stale" };
            }
            if (savedDayFingerprint(current) !== receipt.baseFingerprint)
              return { status: "candidate_changed" };
            if (
              !next.dayDetails ||
              next.dayDetails.schemaVersion !== "stored-day-plan.v2" ||
              next.currentPlan.version !== receipt.basePlanVersion + 1 ||
              next.journeyId !== receipt.journeyId ||
              next.currentPlan.parentVersion !== receipt.basePlanVersion
            ) {
              throw new JourneyPersistenceError(
                "Edited version does not match confirmation",
              );
            }
            // 版本号相等仍不足以保存，还要核对基础语义和预览绑定，防止用同版本的另一份候选写入。
            assertDayEditCommit(current, command);
            const confirmedAt = parseChinaDateTime(
              command.confirmedAt,
              "edit confirmedAt",
            );
            const resultVersion = receipt.basePlanVersion + 1;
            // 旧版本退为历史、新版本活动、详情和幂等回执一起提交；事务失败会恢复原当前指针。
            await tx
              .update(planVersions)
              .set({ isCurrent: false })
              .where(
                and(
                  eq(planVersions.journeyId, receipt.journeyId),
                  eq(planVersions.isCurrent, true),
                ),
              );
            await tx.insert(planVersions).values({
              journeyId: receipt.journeyId,
              version: resultVersion,
              parentVersion: receipt.basePlanVersion,
              isCurrent: true,
              changeReason: "user_confirmed_day_edit",
              createdAt: confirmedAt,
            });
            await tx.insert(planActivities).values(
              next.currentPlan.activities.map((activity, position) => ({
                journeyId: receipt.journeyId,
                planVersion: resultVersion,
                activityId: activity.id,
                position,
                placeId: activity.placeId,
                placeName: next.activitySnapshots[position].placeName,
                startsAt: parseChinaDateTime(
                  activity.startsAt,
                  "edit startsAt",
                ),
                endsAt: parseChinaDateTime(activity.endsAt, "edit endsAt"),
                priority: activity.priority,
                locked: activity.locked,
                reservationId: activity.reservationId ?? null,
              })),
            );
            await tx.insert(dayPlanDetails).values({
              journeyId: receipt.journeyId,
              planVersion: resultVersion,
              details: next.dayDetails,
            });
            await tx.insert(generatedDayEditConfirmations).values({
              journeyId: receipt.journeyId,
              editId: receipt.editId,
              intentFingerprint: command.intentFingerprint,
              basePlanVersion: receipt.basePlanVersion,
              baseObservationVersion: receipt.baseObservationVersion,
              resultPlanVersion: resultVersion,
              change: receipt.change,
              candidateFingerprint: receipt.candidateFingerprint,
              confirmedAt,
            });
            await tx
              .update(journeys)
              .set({ updatedAt: confirmedAt })
              .where(this.journey(receipt.journeyId));
            return {
              status: "saved",
              journeyId: receipt.journeyId,
              planVersion: resultVersion,
            };
          },
          { isolationLevel: "serializable", accessMode: "read write" },
        );
      } catch (error) {
        const code = postgresCode(error);
        if (
          code === "40001" ||
          (code === "23505" &&
            postgresConstraint(error) ===
              "generated_day_edit_confirmations_pkey")
        ) {
          const winner = await this.findDayEditConfirmation(
            receipt.journeyId,
            receipt.editId,
          );
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError(
      "Edit serialization retries were exhausted",
    );
  }

  private async readCurrentJourney(
    transaction: JourneyTransaction,
    journeyId: string,
    version?: number,
  ): Promise<StoredJourney | null> {
    const [root] = await transaction
      .select({ journey: journeys, plan: planVersions })
      .from(journeys)
      .innerJoin(planVersions, eq(planVersions.journeyId, journeys.id))
      .where(
        and(
          this.journey(journeyId),
          version === undefined
            ? eq(planVersions.isCurrent, true)
            : eq(planVersions.version, version),
        ),
      )
      .limit(1);

    if (root === undefined) {
      const [journey] = await transaction
        .select({ creationKind: journeys.creationKind })
        .from(journeys)
        .where(this.journey(journeyId))
        .limit(1);
      if (version === undefined && ["generated_day", "real_day"].includes(journey?.creationKind ?? "")) {
        throw new JourneyPersistenceError(
          "Generated current version is missing",
        );
      }
      return null;
    }
    if (!["manual", "generated_day", "real_day"].includes(root.journey.creationKind)) {
      throw new JourneyPersistenceError("Unknown journey creation kind");
    }
    let details;
    let realDay;
    if (root.journey.creationKind === "real_day") {
      // 真实行程详情每个版本只保存最小事实；实时路线和营业信息不在数据库读取时伪装成已复查。
      const [row] = await transaction
        .select()
        .from(dayPlanDetails)
        .where(and(eq(dayPlanDetails.journeyId, journeyId), eq(dayPlanDetails.planVersion, root.plan.version)))
        .limit(1);
      if (!row) {
        throw new JourneyPersistenceError("Real day details are missing");
      }
      realDay = storedRealDaySchema.parse(row.details);
      if (realDay.planVersion !== root.plan.version) {
        throw new JourneyPersistenceError("Real day details do not match their version");
      }
      if (root.journey.creationRunId !== realDay.context.creationRunId) {
        throw new JourneyPersistenceError("Real day identity does not match its details");
      }
    } else if (root.journey.creationKind === "generated_day") {
      const [row] = await transaction
        .select()
        .from(dayPlanDetails)
        .where(
          and(
            eq(dayPlanDetails.journeyId, journeyId),
            eq(dayPlanDetails.planVersion, root.plan.version),
          ),
        )
        .limit(1);
      if (!row)
        throw new JourneyPersistenceError("Generated day details are missing");
      details = generatedDayDetailsSchema.parse(row.details);
      const [initialRow] =
        root.plan.version === 1
          ? [row]
          : await transaction
              .select()
              .from(dayPlanDetails)
              .where(
                and(
                  eq(dayPlanDetails.journeyId, journeyId),
                  eq(dayPlanDetails.planVersion, 1),
                ),
              )
              .limit(1);
      if (!initialRow)
        throw new JourneyPersistenceError(
          "Initial generated details are missing",
        );
      const initial = storedDayPlanDetailsSchema.parse(initialRow.details);
      assertDaySnapshotIntegrity(initial.planning, false);
      if (
        root.journey.creationRunId !== initial.planning.problem.runId ||
        root.journey.creationIntentFingerprint !==
          generatedDayIntentFingerprint(
            root.journey.title,
            dayDraftSemanticFingerprint(initial.planning),
            initial.acknowledgeUnknowns,
          )
      ) {
        throw new JourneyPersistenceError(
          "Generated identity does not match its initial details",
        );
      }
      assertGeneratedDayPreservesInitial(details, initial);
    } else {
      const [unexpected] = await transaction
        .select({ planVersion: dayPlanDetails.planVersion })
        .from(dayPlanDetails)
        .where(eq(dayPlanDetails.journeyId, journeyId))
        .limit(1);
      if (unexpected)
        throw new JourneyPersistenceError(
          "Manual journey contains generated details",
        );
    }

    const activityRows = await transaction
      .select()
      .from(planActivities)
      .where(
        and(
          eq(planActivities.journeyId, journeyId),
          eq(planActivities.planVersion, root.plan.version),
        ),
      )
      .orderBy(asc(planActivities.position), asc(planActivities.activityId));

    const reservationRows = await transaction
      .select()
      .from(reservations)
      .where(eq(reservations.journeyId, journeyId))
      .orderBy(asc(reservations.id));

    // 只有确认后的重排版本允许未来活动为空；初始、编辑和手工版本仍要求至少一项。
    const minimumRows = details?.schemaVersion === "stored-day-plan.v3" ? 0 : 1;
    if (activityRows.length < minimumRows || activityRows.length > 8) {
      throw new JourneyPersistenceError(
        "Current plan has an invalid number of activities",
      );
    }
    const progress =
      ["generated_day", "real_day"].includes(root.journey.creationKind) &&
      root.journey.currentObservationVersion > 0
        ? await this.readProgress(
            transaction,
            journeyId,
            root.journey.currentObservationVersion,
          )
        : undefined;

    const timeZone = toJourneyTimeZone(root.journey.timeZone);
    const currentPlan = {
      journeyId,
      date: root.journey.journeyDate,
      timeZone,
      version: root.plan.version,
      ...(root.plan.parentVersion === null
        ? {}
        : { parentVersion: root.plan.parentVersion }),
      ...(root.plan.changeReason === null
        ? {}
        : { changeReason: root.plan.changeReason }),
      activities: activityRows.map((activity) => ({
        id: activity.activityId,
        placeId: activity.placeId,
        startsAt: formatChinaDateTime(activity.startsAt),
        endsAt: formatChinaDateTime(activity.endsAt),
        priority: toActivityPriority(activity.priority),
        locked: activity.locked,
        ...(activity.reservationId === null
          ? {}
          : { reservationId: activity.reservationId }),
      })),
    } satisfies StoredJourney["currentPlan"];

    const [currentVersion] =
      version === undefined
        ? []
        : await transaction
            .select({ version: planVersions.version })
            .from(planVersions)
            .where(
              and(
                eq(planVersions.journeyId, journeyId),
                eq(planVersions.isCurrent, true),
              ),
            )
            .limit(1);
    const stored: StoredJourney = {
      ...(version === undefined
        ? {}
        : { currentPlanVersion: currentVersion?.version }),
      creationKind: root.journey.creationKind as StoredJourney["creationKind"],
      ...(details ? { dayDetails: details } : {}),
      ...(realDay ? { realDay } : {}),
      ...(progress ? { dayProgress: progress } : {}),
      journeyId,
      title: root.journey.title,
      city: { adcode: root.journey.cityAdcode, name: root.journey.cityName },
      createdAt: formatChinaDateTime(root.journey.createdAt),
      updatedAt: formatChinaDateTime(root.journey.updatedAt),
      currentObservationVersion: root.journey.currentObservationVersion,
      currentPlan,
      activitySnapshots: activityRows.map((activity) => ({
        activityId: activity.activityId,
        position: activity.position,
        placeName: activity.placeName,
      })),
      reservations: reservationRows.map((row) => ({
        placeName: row.placeName,
        reservation: {
          id: row.id,
          placeId: row.placeId,
          startsAt: formatChinaDateTime(row.startsAt),
          endsAt: formatChinaDateTime(row.endsAt),
          confirmation: {
            status: toConfirmationStatus(row.confirmationStatus),
            source: {
              kind: toSourceKind(row.sourceKind),
              ...(row.sourceReference === null
                ? {}
                : { reference: row.sourceReference }),
            },
            recordedAt: formatChinaDateTime(row.recordedAt),
          },
        },
      })),
    };

    assertStoredJourneyOrder(stored);
    if (details) assertGeneratedDayMatchesJourney(details, stored);
    if (realDay) assertRealDayMatchesJourney(realDay, stored);
    // 当前报告必须能对应当前版本的活动成员与已存地点，不能把另一版的进度直接叠上来。
    if (progress && version === undefined) {
      if (realDay) assertRealDayProgressMatches(stored);
      else assertDayProgressMatchesState(stored);
    }
    return stored;
  }

  private async readProgress(
    transaction: JourneyTransaction,
    journeyId: string,
    version: number,
  ): Promise<StoredDayProgress> {
    const [row] = await transaction
      .select()
      .from(generatedDayProgress)
      .where(
        and(
          eq(generatedDayProgress.journeyId, journeyId),
          eq(generatedDayProgress.version, version),
        ),
      )
      .limit(1);
    if (!row || row.source !== "user_reported") {
      throw new JourneyPersistenceError("Generated progress is missing");
    }
    return {
      version: row.version,
      basePlanVersion: row.basePlanVersion,
      reportId: row.reportId,
      intentFingerprint: row.intentFingerprint,
      observedAt: formatChinaDateTime(row.observedAt),
      earliestResumeAt: formatChinaDateTime(row.earliestResumeAt),
      completedActivityIds: [...row.completedActivityIds],
      skippedActivityIds: [...row.skippedActivityIds],
      locationPlaceId: row.locationPlaceId,
      source: "user_reported",
      recordedAt: formatChinaDateTime(row.recordedAt),
    };
  }

  async findDayProgressReport(
    journeyId: string,
    reportId: string,
  ): Promise<Pick<StoredDayProgress, "version" | "intentFingerprint"> | null> {
    const [row] = await this.database
      .select({
        version: generatedDayProgress.version,
        intentFingerprint: generatedDayProgress.intentFingerprint,
      })
      .from(generatedDayProgress)
      .where(
        and(
          eq(generatedDayProgress.journeyId, journeyId),
          eq(generatedDayProgress.reportId, reportId),
          this.ownedJourney(generatedDayProgress.journeyId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async commitDayProgress(
    command: Parameters<DayProgressRepository["commitDayProgress"]>[0],
  ): Promise<DayProgressReply> {
    const { journeyId, intentFingerprint } = command;
    const replay = (prior: { version: number; intentFingerprint: string }): DayProgressReply =>
      prior.intentFingerprint === intentFingerprint
        ? { status: "already_saved", observationVersion: prior.version }
        : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(
          async (tx): Promise<DayProgressReply> => {
            const [root] = await tx
              .select()
              .from(journeys)
              .where(this.journey(journeyId))
              .for("update")
              .limit(1);
            if (!root) return { status: "not_found" };
            if (root.creationKind !== "generated_day") return { status: "source_not_allowed" };
            const [prior] = await tx
              .select()
              .from(generatedDayProgress)
              .where(
                and(
                  eq(generatedDayProgress.journeyId, journeyId),
                  eq(generatedDayProgress.reportId, command.command.reportId),
                ),
              )
              .limit(1);
            if (prior) return replay(prior);
            const current = await this.readCurrentJourney(tx, journeyId);
            if (!current) return { status: "not_found" };
            // 获得根锁后，针对最新状态重跑应用层的纯校验，堵住预检查与写入间的并发窗口。
            const checked = checkDayProgress(current, command.command, intentFingerprint);
            if (checked.status !== "ready") return checked;
            const { next } = checked;
            const recordedAt = parseChinaDateTime(command.recordedAt, "progress recordedAt");
            await tx.insert(generatedDayProgress).values({
              journeyId,
              version: next.version,
              previousVersion: next.version - 1,
              basePlanVersion: next.basePlanVersion,
              reportId: next.reportId,
              intentFingerprint: next.intentFingerprint,
              observedAt: parseChinaDateTime(next.observedAt, "progress observedAt"),
              earliestResumeAt: parseChinaDateTime(next.earliestResumeAt, "progress earliestResumeAt"),
              completedActivityIds: [...next.completedActivityIds],
              skippedActivityIds: [...next.skippedActivityIds],
              locationPlaceId: next.locationPlaceId,
              source: next.source,
              recordedAt,
            });
            await tx
              .update(journeys)
              .set({ currentObservationVersion: next.version, updatedAt: recordedAt })
              .where(this.journey(journeyId));
            return { status: "saved", observationVersion: next.version };
          },
          { isolationLevel: "serializable", accessMode: "read write" },
        );
      } catch (error) {
        const code = postgresCode(error);
        if (
          code === "40001" ||
          (code === "23505" &&
            postgresConstraint(error) === "generated_day_progress_report_unique")
        ) {
          const winner = await this.findDayProgressReport(journeyId, command.command.reportId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Progress serialization retries were exhausted");
  }

  /** 真实行程的进度也在行程根锁内写入，与模拟行程共用报告表和观测版本规则。 */
  async commitRealDayProgress(input: Parameters<RealDayAdjustRepository["commitRealDayProgress"]>[0]): Promise<DayProgressReply> {
    const intentFingerprint = dayProgressIntentFingerprint(input.journeyId, input.command);
    const replay = (prior: { version: number; intentFingerprint: string }): DayProgressReply =>
      prior.intentFingerprint === intentFingerprint ? { status: "already_saved", observationVersion: prior.version } : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx): Promise<DayProgressReply> => {
          const [root] = await tx.select().from(journeys).where(this.journey(input.journeyId)).for("update").limit(1);
          if (!root) return { status: "not_found" };
          if (root.creationKind !== "real_day") return { status: "source_not_allowed" };
          const [prior] = await tx.select().from(generatedDayProgress)
            .where(and(eq(generatedDayProgress.journeyId, input.journeyId), eq(generatedDayProgress.reportId, input.command.reportId))).limit(1);
          if (prior) return replay(prior);
          const current = await this.readCurrentJourney(tx, input.journeyId);
          if (!current) return { status: "not_found" };
          const checked = checkRealDayProgress(current, input.command);
          if (checked.status === "no_change") return checked;
          if (checked.status !== "ok") return checked;
          await this.insertProgress(tx, input.journeyId, checked.progress, input.recordedAt);
          return { status: "saved", observationVersion: checked.progress.version };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        const code = postgresCode(error);
        if (code === "40001" || (code === "23505" && postgresConstraint(error) === "generated_day_progress_report_unique")) {
          const winner = await this.findDayProgressReport(input.journeyId, input.command.reportId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Progress serialization retries were exhausted");
  }

  private async insertProgress(tx: JourneyTransaction, journeyId: string, next: NewDayProgress, recordedAt: ChinaDateTime) {
    const at = parseChinaDateTime(recordedAt, "progress recordedAt");
    await tx.insert(generatedDayProgress).values({
      journeyId,
      version: next.version,
      previousVersion: next.version - 1,
      basePlanVersion: next.basePlanVersion,
      reportId: next.reportId,
      intentFingerprint: next.intentFingerprint,
      observedAt: parseChinaDateTime(next.observedAt, "progress observedAt"),
      earliestResumeAt: parseChinaDateTime(next.earliestResumeAt, "progress earliestResumeAt"),
      completedActivityIds: [...next.completedActivityIds],
      skippedActivityIds: [...next.skippedActivityIds],
      locationPlaceId: next.locationPlaceId,
      source: next.source,
      recordedAt: at,
    });
    await tx.update(journeys).set({ currentObservationVersion: next.version, updatedAt: at }).where(this.journey(journeyId));
  }

  async findRealDayAdjustment(journeyId: string, runId: string) {
    const found = await this.findDayReplanConfirmation(journeyId, runId);
    return found ? { intentFingerprint: found.intentFingerprint, planVersion: found.resultPlanVersion } : null;
  }

  /** 一次真实调整把累计报告与下一版计划一并保存，runId 保证同一次确认只产生一个结果。 */
  async commitRealDayAdjustment(input: Parameters<RealDayAdjustRepository["commitRealDayAdjustment"]>[0]): ReturnType<RealDayAdjustRepository["commitRealDayAdjustment"]> {
    const replay = (prior: StoredDayReplanConfirmation) => prior.intentFingerprint === input.intentFingerprint
      ? { status: "already_saved" as const, planVersion: prior.resultPlanVersion }
      : { status: "intent_conflict" as const };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => {
          const [root] = await tx.select().from(journeys).where(this.journey(input.journeyId)).for("update").limit(1);
          if (!root) return { status: "not_found" as const };
          if (root.creationKind !== "real_day") return { status: "stale" as const };
          const [prior] = await tx.select().from(generatedDayReplanConfirmations)
            .where(and(eq(generatedDayReplanConfirmations.journeyId, input.journeyId), eq(generatedDayReplanConfirmations.runId, input.runId))).limit(1);
          if (prior) return replay(prior);
          const current = await this.readCurrentJourney(tx, input.journeyId);
          if (!current || current.currentPlan.version !== input.basePlanVersion || current.currentObservationVersion !== input.baseObservationVersion) {
            return { status: "stale" as const };
          }
          // 调整可能只改计划、不增加新进度，此时仍要核对本次使用的累计报告。
          // 与单独“完成 / 跳过”共用同一把行程根锁；双版本复核和报告校验都在锁内进行。
          // 本事务同时保存报告、新计划和确认记录，任一步失败都回滚，旧版本保持可读。
          const checked = checkRealDayProgress(current, input.progress);
          if (checked.status !== "ok" && checked.status !== "no_change") return { status: "stale" as const };
          const progress = checked.status === "ok"
            ? { completed: checked.progress.completedActivityIds, skipped: checked.progress.skippedActivityIds }
            : { completed: current.dayProgress?.completedActivityIds ?? [], skipped: current.dayProgress?.skippedActivityIds ?? [] };
          assertAdjustmentCommit(current, input.adjusted, progress);
          assertRealDayMatchesJourney(input.adjusted.realDay, { ...input.adjusted.next, reservations: current.reservations });
          if (checked.status === "ok") await this.insertProgress(tx, input.journeyId, checked.progress, input.confirmedAt);
          const observation = checked.status === "ok" ? checked.progress.version : current.currentObservationVersion;
          if (observation < 1) return { status: "stale" as const };
          const confirmedAt = parseChinaDateTime(input.confirmedAt, "adjust confirmedAt");
          const version = input.adjusted.next.currentPlan.version;
          await tx.update(planVersions).set({ isCurrent: false })
            .where(and(eq(planVersions.journeyId, input.journeyId), eq(planVersions.isCurrent, true)));
          await tx.insert(planVersions).values({
            journeyId: input.journeyId, version, parentVersion: input.basePlanVersion, isCurrent: true,
            changeReason: "user_confirmed_replan", createdAt: confirmedAt,
          });
          await tx.insert(planActivities).values(input.adjusted.next.currentPlan.activities.map((activity, position) => ({
            journeyId: input.journeyId,
            planVersion: version,
            activityId: activity.id,
            position,
            placeId: activity.placeId,
            placeName: input.adjusted.next.activitySnapshots[position].placeName,
            startsAt: parseChinaDateTime(activity.startsAt, "adjust startsAt"),
            endsAt: parseChinaDateTime(activity.endsAt, "adjust endsAt"),
            priority: activity.priority,
            locked: activity.locked,
            reservationId: activity.reservationId ?? null,
          })));
          await tx.insert(dayPlanDetails).values({ journeyId: input.journeyId, planVersion: version, details: input.adjusted.realDay });
          await tx.insert(generatedDayReplanConfirmations).values({
            journeyId: input.journeyId, runId: input.runId, intentFingerprint: input.intentFingerprint,
            basePlanVersion: input.basePlanVersion, baseObservationVersion: observation, resultPlanVersion: version, confirmedAt,
          });
          await tx.update(journeys).set({ updatedAt: confirmedAt }).where(this.journey(input.journeyId));
          return { status: "saved" as const, planVersion: version };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        const code = postgresCode(error);
        if (code === "40001" || (code === "23505" && postgresConstraint(error) === "generated_day_replan_confirmations_pkey")) {
          const winner = await this.findDayReplanConfirmation(input.journeyId, input.runId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Adjustment serialization retries were exhausted");
  }

  async findDayReplanConfirmation(
    journeyId: string,
    runId: string,
  ): Promise<StoredDayReplanConfirmation | null> {
    const [row] = await this.database
      .select({
        intentFingerprint: generatedDayReplanConfirmations.intentFingerprint,
        resultPlanVersion: generatedDayReplanConfirmations.resultPlanVersion,
      })
      .from(generatedDayReplanConfirmations)
      .where(
        and(
          eq(generatedDayReplanConfirmations.journeyId, journeyId),
          eq(generatedDayReplanConfirmations.runId, runId),
          this.ownedJourney(generatedDayReplanConfirmations.journeyId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async commitDayReplan(command: ConfirmedDayReplan): Promise<ReplanConfirmReply> {
    const { receipt, next } = command;
    const replay = (prior: StoredDayReplanConfirmation): ReplanConfirmReply =>
      prior.intentFingerprint === command.intentFingerprint
        ? { status: "already_saved", journeyId: receipt.journeyId, planVersion: prior.resultPlanVersion }
        : { status: "intent_conflict" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(
          async (tx): Promise<ReplanConfirmReply> => {
            const [root] = await tx
              .select()
              .from(journeys)
              .where(this.journey(receipt.journeyId))
              .for("update")
              .limit(1);
            if (!root || root.creationKind !== "generated_day") return { status: "stale" };
            const [prior] = await tx
              .select()
              .from(generatedDayReplanConfirmations)
              .where(
                and(
                  eq(generatedDayReplanConfirmations.journeyId, receipt.journeyId),
                  eq(generatedDayReplanConfirmations.runId, receipt.runId),
                ),
              )
              .limit(1);
            // 锁内先识别已提交的同 runId，再比版本；第一次保存本就会推进版本，重试不能因此失效。
            if (prior) return replay(prior);
            const current = await this.readCurrentJourney(tx, receipt.journeyId);
            if (
              !current ||
              current.currentPlan.version !== receipt.basePlanVersion ||
              current.currentObservationVersion !== receipt.baseObservationVersion ||
              replanBaseFingerprint(current) !== receipt.baseFingerprint
            ) {
              return { status: "stale" };
            }
            assertDayReplanCommit(current, command);
            // 不只对照上一版，还要追到首版检查必去与固定事项，避免连续调整逐步丢失原始保护项。
            const [initialRow] = await tx
              .select()
              .from(dayPlanDetails)
              .where(
                and(
                  eq(dayPlanDetails.journeyId, receipt.journeyId),
                  eq(dayPlanDetails.planVersion, 1),
                ),
              )
              .limit(1);
            if (!initialRow) throw new JourneyPersistenceError("Initial generated details are missing");
            assertGeneratedDayPreservesInitial(
              next.dayDetails!,
              storedDayPlanDetailsSchema.parse(initialRow.details),
            );
            const confirmedAt = parseChinaDateTime(command.confirmedAt, "replan confirmedAt");
            const resultVersion = next.currentPlan.version;
            await tx
              .update(planVersions)
              .set({ isCurrent: false })
              .where(
                and(
                  eq(planVersions.journeyId, receipt.journeyId),
                  eq(planVersions.isCurrent, true),
                ),
              );
            await tx.insert(planVersions).values({
              journeyId: receipt.journeyId,
              version: resultVersion,
              parentVersion: receipt.basePlanVersion,
              isCurrent: true,
              changeReason: "user_confirmed_replan",
              createdAt: confirmedAt,
            });
            // 所有活动都已处理时，未来区允许为空；归档事实仍保存在详情，不能插入空活动占位。
            if (next.currentPlan.activities.length > 0) {
              await tx.insert(planActivities).values(
                next.currentPlan.activities.map((activity, position) => ({
                  journeyId: receipt.journeyId,
                  planVersion: resultVersion,
                  activityId: activity.id,
                  position,
                  placeId: activity.placeId,
                  placeName: next.activitySnapshots[position].placeName,
                  startsAt: parseChinaDateTime(activity.startsAt, "replan startsAt"),
                  endsAt: parseChinaDateTime(activity.endsAt, "replan endsAt"),
                  priority: activity.priority,
                  locked: activity.locked,
                  reservationId: activity.reservationId ?? null,
                })),
              );
            }
            await tx.insert(dayPlanDetails).values({
              journeyId: receipt.journeyId,
              planVersion: resultVersion,
              details: next.dayDetails,
            });
            // 回执与结果版本处于同一事务，保证查到回执就能定位那次真正保存的版本。
            await tx.insert(generatedDayReplanConfirmations).values({
              journeyId: receipt.journeyId,
              runId: receipt.runId,
              intentFingerprint: command.intentFingerprint,
              basePlanVersion: receipt.basePlanVersion,
              baseObservationVersion: receipt.baseObservationVersion,
              resultPlanVersion: resultVersion,
              confirmedAt,
            });
            await tx
              .update(journeys)
              .set({ updatedAt: confirmedAt })
              .where(this.journey(receipt.journeyId));
            return { status: "saved", journeyId: receipt.journeyId, planVersion: resultVersion };
          },
          { isolationLevel: "serializable", accessMode: "read write" },
        );
      } catch (error) {
        const code = postgresCode(error);
        if (
          code === "40001" ||
          (code === "23505" &&
            postgresConstraint(error) === "generated_day_replan_confirmations_pkey")
        ) {
          const winner = await this.findDayReplanConfirmation(receipt.journeyId, receipt.runId);
          if (winner) return replay(winner);
        }
        if (code === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Replan serialization retries were exhausted");
  }

  async findConfirmation(journeyId: string, idempotencyKey: string): Promise<StoredConfirmation | null> {
    return this.database.transaction((tx) => this.readConfirmation(tx, journeyId, idempotencyKey), { isolationLevel: "read committed", accessMode: "read only" });
  }

  private async readConfirmation(tx: JourneyTransaction, journeyId: string, idempotencyKey: string): Promise<StoredConfirmation | null> {
    const [row] = await tx.select().from(planConfirmations).where(and(
      eq(planConfirmations.journeyId, journeyId),
      eq(planConfirmations.idempotencyKey, idempotencyKey),
      this.ownedJourney(planConfirmations.journeyId),
    )).limit(1);
    return row === undefined ? null : { intentFingerprint: row.intentFingerprint, resultPlanVersion: row.resultPlanVersion, resultObservationVersion: row.resultObservationVersion };
  }

  async commitConfirmedAdjustment(draft: ConfirmedAdjustmentDraft): Promise<CommitAdjustmentResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => {
          // 先锁行程根，使同一行程的写入串行化；所有版本与意图判断都在获得锁后重做。
          const [locked] = await tx.select({ id: journeys.id, creationKind: journeys.creationKind }).from(journeys).where(this.journey(draft.journeyId)).for("update").limit(1);
          if (locked === undefined) return { status: "stale" };
          if (locked.creationKind !== "manual") return { status: "preview_changed" };
          const previous = await this.readConfirmation(tx, draft.journeyId, draft.idempotencyKey);
          if (previous !== null) return previous.intentFingerprint === draft.intentFingerprint
            ? { status: "already_committed", planVersion: previous.resultPlanVersion, observationVersion: previous.resultObservationVersion }
            : { status: "idempotency_conflict" };

          // 再锁相关事实，防止绕过根锁的并发写入改变预约或活动，导致确认依据与实际写入不一致。
          await tx.select({ id: reservations.id }).from(reservations).where(eq(reservations.journeyId, draft.journeyId)).for("share");
          await tx.select({ activityId: planActivities.activityId }).from(planActivities).where(and(eq(planActivities.journeyId, draft.journeyId), eq(planActivities.planVersion, draft.basePlanVersion))).for("share");
          await tx.select({ version: planVersions.version }).from(planVersions).where(and(eq(planVersions.journeyId, draft.journeyId), eq(planVersions.version, draft.basePlanVersion))).for("share");
          const current = await this.readCurrentJourney(tx, draft.journeyId);
          if (current === null || current.currentPlan.version !== draft.basePlanVersion || current.currentObservationVersion !== draft.baseObservationVersion) return { status: "stale" };
          if (JSON.stringify(current) !== JSON.stringify(draft.expectedJourney)) return { status: "preview_changed" };
          assertConfirmedDraft(draft, current);

          const resultPlanVersion = draft.basePlanVersion + 1;
          const resultObservationVersion = draft.baseObservationVersion + 1;
          const confirmedAt = parseChinaDateTime(draft.confirmedAt, "confirmedAt");
          const target = current.currentPlan.activities[current.currentPlan.activities.length - 2];
          if (target === undefined) throw new JourneyPersistenceError("Adjustment target is missing");
          await tx.insert(journeyObservations).values({
            journeyId: draft.journeyId,
            version: resultObservationVersion,
            observedAt: parseChinaDateTime(`${current.currentPlan.date}T${draft.command.observedAt}:00+08:00`, "observedAt"),
            completedActivityIds: [...draft.command.completedActivityIds],
            skippedActivityIds: [],
            currentActivityId: null,
            locationPlaceId: target.placeId,
            source: "user_reported",
            recordedAt: confirmedAt,
          });
          await tx.update(planVersions).set({ isCurrent: false }).where(and(eq(planVersions.journeyId, draft.journeyId), eq(planVersions.version, draft.basePlanVersion), eq(planVersions.isCurrent, true)));
          await tx.insert(planVersions).values({ journeyId: draft.journeyId, version: resultPlanVersion, parentVersion: draft.basePlanVersion, changeReason: "user_confirmed_adjustment", isCurrent: true, createdAt: confirmedAt });
          const snapshots = new Map(current.activitySnapshots.map((item) => [item.activityId, item]));
          await tx.insert(planActivities).values(draft.candidateActivities.map((activity, position) => ({
            journeyId: draft.journeyId,
            planVersion: resultPlanVersion,
            activityId: activity.id,
            position,
            placeId: activity.placeId,
            placeName: snapshots.get(activity.id)!.placeName,
            startsAt: parseChinaDateTime(activity.startsAt, "candidate startsAt"),
            endsAt: parseChinaDateTime(activity.endsAt, "candidate endsAt"),
            priority: activity.priority,
            locked: activity.locked,
            reservationId: activity.reservationId ?? null,
          })));
          await tx.insert(planConfirmations).values({
            journeyId: draft.journeyId,
            idempotencyKey: draft.idempotencyKey,
            intentFingerprint: draft.intentFingerprint,
            basePlanVersion: draft.basePlanVersion,
            baseObservationVersion: draft.baseObservationVersion,
            resultPlanVersion,
            resultObservationVersion,
            normalizedInput: draft.command,
            strategy: draft.strategy,
            previewFingerprint: draft.previewFingerprint,
            travelSource: target.placeId === current.currentPlan.activities.at(-1)?.placeId ? "same_place" : "user_estimate",
            transferBufferMinutes: 10,
            confirmedAt,
          });
          await tx.update(journeys).set({ currentObservationVersion: resultObservationVersion, updatedAt: confirmedAt }).where(this.journey(draft.journeyId));
          return { status: "committed", planVersion: resultPlanVersion, observationVersion: resultObservationVersion };
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        if (postgresCode(error) === "40001" && attempt < 2) continue;
        throw error;
      }
    }
    throw new JourneyPersistenceError("Serialization retries were exhausted");
  }
}

function postgresConstraint(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  return typeof candidate.constraint === "string"
    ? candidate.constraint
    : postgresConstraint(candidate.cause);
}

function postgresCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === "string"
    ? candidate.code
    : postgresCode(candidate.cause);
}

function assertConfirmedDraft(
  draft: ConfirmedAdjustmentDraft,
  current: StoredJourney,
): void {
  const original = current.currentPlan.activities;
  const targetPosition = original.length - 2;
  const target = original[targetPosition];
  const fixed = original[targetPosition + 1];
  if (
    !target ||
    !fixed ||
    target.locked ||
    target.reservationId !== undefined ||
    !fixed.locked ||
    fixed.reservationId === undefined ||
    !draft.command.noCurrentActivity ||
    !draft.command.locationAtTarget
  )
    throw new JourneyPersistenceError(
      "Confirmed adjustment structure is invalid",
    );
  const expectedIds =
    draft.strategy === "omit"
      ? original
          .filter((_, index) => index !== targetPosition)
          .map((item) => item.id)
      : original.map((item) => item.id);
  if (
    draft.candidateActivities.length !== expectedIds.length ||
    draft.candidateActivities.some(
      (item, index) => item.id !== expectedIds[index],
    )
  )
    throw new JourneyPersistenceError("Candidate activity order changed");
  for (const [index, candidate] of draft.candidateActivities.entries()) {
    const before = original.find((item) => item.id === candidate.id)!;
    const sameIdentity =
      candidate.placeId === before.placeId &&
      candidate.priority === before.priority &&
      candidate.locked === before.locked &&
      candidate.reservationId === before.reservationId;
    if (
      !sameIdentity ||
      (candidate.id !== target.id &&
        (candidate.startsAt !== before.startsAt ||
          candidate.endsAt !== before.endsAt))
    )
      throw new JourneyPersistenceError("Protected activity changed");
    if (
      candidate.id === target.id &&
      (draft.strategy !== "shift" ||
        candidate.startsAt === before.startsAt ||
        Date.parse(candidate.endsAt) - Date.parse(candidate.startsAt) !==
          Date.parse(before.endsAt) - Date.parse(before.startsAt))
    )
      throw new JourneyPersistenceError("Shifted activity is invalid");
    if (
      index > 0 &&
      draft.candidateActivities[index - 1]!.endsAt > candidate.startsAt
    )
      throw new JourneyPersistenceError("Candidate activities overlap");
  }
  if (
    draft.strategy === "omit" &&
    draft.candidateActivities.some((item) => item.id === target.id)
  )
    throw new JourneyPersistenceError("Omitted target remains");
}

function assertInitialJourneyDraft(
  draft: InitialJourneyDraft,
  generated = false,
): Map<string, InitialJourneyDraft["activitySnapshots"][number]> {
  if (draft.currentPlan.journeyId !== draft.journeyId) {
    throw new JourneyPersistenceError(
      "Initial plan belongs to another journey",
    );
  }
  if (
    draft.currentPlan.version !== 1 ||
    draft.currentPlan.parentVersion !== undefined ||
    draft.currentPlan.changeReason !== "initial_creation"
  ) {
    throw new JourneyPersistenceError(
      "Initial plan must be version 1 without a parent",
    );
  }
  if (
    draft.currentPlan.activities.length === 0 ||
    draft.currentPlan.activities.length > 8 ||
    draft.activitySnapshots.length !== draft.currentPlan.activities.length
  ) {
    throw new JourneyPersistenceError(
      "Initial plan and activity snapshots must contain one to eight matching items",
    );
  }

  parseChinaDateTime(draft.createdAt, "journey createdAt");
  parseChinaDateTime(draft.updatedAt, "journey updatedAt");

  const snapshotsByActivityId = new Map(
    draft.activitySnapshots.map((snapshot) => [snapshot.activityId, snapshot]),
  );
  if (snapshotsByActivityId.size !== draft.activitySnapshots.length) {
    throw new JourneyPersistenceError(
      "Activity snapshots contain duplicate IDs",
    );
  }

  const reservationsById = new Map(
    draft.reservations.map((snapshot) => [snapshot.reservation.id, snapshot]),
  );
  if (reservationsById.size !== draft.reservations.length) {
    throw new JourneyPersistenceError("Reservations contain duplicate IDs");
  }

  const linkedReservationIds = new Set<string>();
  let previousEndsAt = Number.NEGATIVE_INFINITY;

  draft.currentPlan.activities.forEach((activity, position) => {
    const snapshot = snapshotsByActivityId.get(activity.id);
    if (snapshot === undefined || snapshot.position !== position) {
      throw new JourneyPersistenceError(
        "Activity snapshots must match the current plan order",
      );
    }
    if (
      !activity.startsAt.startsWith(`${draft.currentPlan.date}T`) ||
      !activity.endsAt.startsWith(`${draft.currentPlan.date}T`)
    ) {
      throw new JourneyPersistenceError(
        "Activities must belong to the current plan date",
      );
    }

    const startsAt = parseChinaDateTime(activity.startsAt, "activity startsAt");
    const endsAt = parseChinaDateTime(activity.endsAt, "activity endsAt");
    if (startsAt.getTime() >= endsAt.getTime()) {
      throw new JourneyPersistenceError("Activity time window is invalid");
    }
    if (startsAt.getTime() < previousEndsAt) {
      throw new JourneyPersistenceError("Activities must not overlap");
    }
    previousEndsAt = endsAt.getTime();

    if (activity.reservationId === undefined) return;

    const reservationSnapshot = reservationsById.get(activity.reservationId);
    if (reservationSnapshot === undefined) {
      throw new JourneyPersistenceError("Linked reservation is missing");
    }
    const reservation = reservationSnapshot.reservation;
    if (
      reservation.confirmation.status !==
        (generated ? "unknown" : "confirmed") ||
      reservation.confirmation.source.kind !== "user_reported" ||
      !activity.locked ||
      activity.priority !== "high" ||
      activity.placeId !== reservation.placeId ||
      activity.startsAt !== reservation.startsAt ||
      activity.endsAt !== reservation.endsAt ||
      snapshot.placeName !== reservationSnapshot.placeName
    ) {
      throw new JourneyPersistenceError(
        "Initial activity does not preserve a confirmed user-reported reservation",
      );
    }
    linkedReservationIds.add(reservation.id);
  });

  if (linkedReservationIds.size !== draft.reservations.length) {
    throw new JourneyPersistenceError(
      "Every initial reservation must be linked by one activity",
    );
  }

  return snapshotsByActivityId;
}

/** 活动顺序、标签快照和预约引用共同构成聚合完整性，读取时同样需要复核。 */
function assertStoredJourneyOrder(stored: StoredJourney): void {
  let previousEndsAt = Number.NEGATIVE_INFINITY;
  stored.currentPlan.activities.forEach((activity, position) => {
    const snapshot = stored.activitySnapshots[position];
    if (
      snapshot?.position !== position ||
      snapshot.activityId !== activity.id
    ) {
      throw new JourneyPersistenceError(
        "Stored activity positions must be contiguous and ordered",
      );
    }
    const startsAt = parseChinaDateTime(activity.startsAt, "activity startsAt");
    const endsAt = parseChinaDateTime(activity.endsAt, "activity endsAt");
    if (
      startsAt.getTime() >= endsAt.getTime() ||
      startsAt.getTime() < previousEndsAt
    ) {
      throw new JourneyPersistenceError(
        "Stored activities contain an invalid or overlapping time window",
      );
    }
    previousEndsAt = endsAt.getTime();
  });
}

function parseChinaDateTime(value: ChinaDateTime, label: string): Date {
  if (!value.endsWith("+08:00")) {
    throw new JourneyPersistenceError(`${label} must use the +08:00 offset`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new JourneyPersistenceError(`${label} is invalid`);
  }
  return parsed;
}

function formatChinaDateTime(value: Date): ChinaDateTime {
  if (Number.isNaN(value.getTime())) {
    throw new JourneyPersistenceError("PostgreSQL returned an invalid timestamp");
  }
  const chinaWallClock = new Date(value.getTime() + CHINA_OFFSET_MILLISECONDS);
  return `${chinaWallClock.toISOString().slice(0, 19)}+08:00`;
}

function toJourneyTimeZone(value: string): JourneyTimeZone {
  if (value !== "Asia/Shanghai") {
    throw new JourneyPersistenceError("PostgreSQL returned an unsupported time zone");
  }
  return value;
}

function toActivityPriority(value: string): ActivityPriority {
  if (value === "high" || value === "normal" || value === "low") return value;
  throw new JourneyPersistenceError("PostgreSQL returned an invalid activity priority");
}

function toConfirmationStatus(value: string): ReservationConfirmationStatus {
  if (
    value === "confirmed" ||
    value === "pending" ||
    value === "cancelled" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new JourneyPersistenceError(
    "PostgreSQL returned an invalid reservation confirmation status",
  );
}

function toSourceKind(
  value: string,
): Reservation["confirmation"]["source"]["kind"] {
  if (
    value === "fixture" ||
    value === "user_reported" ||
    value === "provider_record"
  ) {
    return value;
  }
  throw new JourneyPersistenceError(
    "PostgreSQL returned an invalid reservation source kind",
  );
}
