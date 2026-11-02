import type {
  PlanVersion,
  PlannedActivity,
  Reservation,
} from "@tripquest/domain";

import type {
  CreateJourneyOutcome,
  InitialJourneyDraft,
  JourneyClock,
  JourneyIdGenerator,
  JourneyRepository,
  JourneyReservationSnapshot,
} from "./contracts";
import { createCheckedIdFactory, toChinaDateTime } from "./runtime-values";
import { validateCreateJourneyCommand } from "./validation";

export interface CreateJourneyDependencies {
  readonly repository: JourneyRepository;
  readonly idGenerator: JourneyIdGenerator;
  readonly clock: JourneyClock;
}

/**
 * 手动创建入口只依赖仓储、时钟和 ID 生成器，网页与数据库细节不进入用例。
 * 先构造完整 v1 聚合，再交仓储原子保存，避免出现只有行程、缺活动或预约的半成品。
 */
export async function createJourney(
  input: unknown,
  dependencies: CreateJourneyDependencies,
): Promise<CreateJourneyOutcome> {
  const validation = validateCreateJourneyCommand(input);
  if (!validation.success) {
    return {
      status: "invalid",
      fieldErrors: validation.fieldErrors,
      ...(validation.formError === undefined
        ? {}
        : { formError: validation.formError }),
    };
  }

  const command = validation.command;
  const nextId = createCheckedIdFactory(dependencies.idGenerator);
  const journeyId = nextId("journey");
  const now = toChinaDateTime(dependencies.clock.now());
  const reservations: JourneyReservationSnapshot[] = [];

  const activities: PlannedActivity[] = command.activities.map(
    (activityCommand) => {
      const activityId = nextId("activity");
      const placeId = nextId("place");
      const reservationId =
        activityCommand.kind === "reservation"
          ? nextId("reservation")
          : undefined;
      const startsAt = `${command.date}T${activityCommand.startsAt}:00+08:00` as const;
      const endsAt = `${command.date}T${activityCommand.endsAt}:00+08:00` as const;

      // 预约作为独立事实保存，活动仅关联它；这里的 confirmed 来自用户报告，
      // 不代表系统已经向商户核验，更不能通过移动计划来改写预约时间。
      if (reservationId !== undefined) {
        const reservation: Reservation = {
          id: reservationId,
          placeId,
          startsAt,
          endsAt,
          confirmation: {
            status: "confirmed",
            source: { kind: "user_reported" },
            recordedAt: now,
          },
        };
        reservations.push({
          placeName: activityCommand.placeName,
          reservation,
        });
      }

      return {
        id: activityId,
        placeId,
        startsAt,
        endsAt,
        priority:
          reservationId === undefined ? activityCommand.priority : "high",
        locked: reservationId !== undefined,
        ...(reservationId === undefined ? {} : { reservationId }),
      };
    },
  );

  const currentPlan: PlanVersion = {
    journeyId,
    date: command.date,
    timeZone: command.timeZone,
    version: 1,
    changeReason: "initial_creation",
    activities,
  };

  const draft: InitialJourneyDraft = {
    journeyId,
    title: command.title,
    createdAt: now,
    updatedAt: now,
    currentPlan,
    activitySnapshots: activities.map((activity, position) => ({
      activityId: activity.id,
      position,
      placeName: command.activities[position].placeName,
    })),
    reservations,
  };

  await dependencies.repository.createInitialJourney(draft);
  return { status: "created", journeyId };
}
