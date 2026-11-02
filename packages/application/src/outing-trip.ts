import { z } from "zod";
import type { ChinaDateTime } from "@tripquest/domain";
import type { JourneyCity } from "./contracts";
import type { DayDraftConfirmationSnapshot } from "./day-confirmation";
import { planningTimeSchema } from "./planning-requirements";
import { confirmRealDay, type InitialRealDayDraft, type RealDayRepository } from "./real-day";
import { toChinaDateTime } from "./runtime-values";
import type { MobilityProvider } from "@tripquest/providers";
import type { JourneyClock, JourneyIdGenerator } from "./contracts";

/**
 * V2.11 一趟出游 = 多个一日行程（stages/V2.11.md §3.8）。每天按固定交通分成几部分，每段地点是一个普通的
 * 真实一日行程（进度、导航、调整都复用）；出游本身只存日期、起终点、每晚住处、固定交通和每天的结构，
 * 地点只有编号和名称（D-046）。
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const placeRef = z.strictObject({ externalId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), name: text(80) });
const dayNumber = z.number().int().min(1).max(7);

export const TRIP_SCHEMA = "trip.v1";
export const storedTripSchema = z.strictObject({
  schemaVersion: z.literal(TRIP_SCHEMA),
  /** 最近一次确认的跨天改动（重试时按它判断已经保存过）。 */
  lastChangeId: z.uuid().optional(),
  start: z.strictObject({ place: placeRef, at: planningTimeSchema.nullable() }),
  end: z.strictObject({ place: placeRef, at: planningTimeSchema.nullable() }),
  /** V3.3：source 是 suggested 时是系统暂定的住处（用户没换过）。 */
  lodging: z.array(z.strictObject({
    night: dayNumber,
    place: placeRef.nullable(),
    onBoard: z.boolean(),
    source: z.literal("suggested").optional(),
  })).max(6),
  transports: z.array(z.strictObject({
    day: dayNumber,
    mode: z.enum(["train", "flight", "other"]),
    from: placeRef,
    to: placeRef,
    departAt: planningTimeSchema,
    arriveAt: planningTimeSchema,
    arriveDay: z.enum(["same", "next"]),
    estimated: z.boolean(),
  })).max(6),
  /** 每天的各部分按时间先后：plan 指向那一段的一日行程（同一天第几段），transfer 指向上面的第几条交通。 */
  days: z.array(z.strictObject({
    day: dayNumber,
    date: z.iso.date(),
    parts: z.array(z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("plan"), part: z.number().int().min(0).max(6) }),
      z.strictObject({ kind: z.literal("transfer"), transport: z.number().int().min(0).max(5) }),
      z.strictObject({
        kind: z.literal("connect"),
        from: text(80),
        to: text(80),
        departAt: planningTimeSchema,
        arriveAt: planningTimeSchema,
      }),
    ])).min(1).max(7),
  })).min(1).max(7),
});
export type StoredTrip = z.infer<typeof storedTripSchema>;

export interface InitialTrip {
  readonly tripId: string;
  /** 同一次生成只建一趟（重试按它幂等）。 */
  readonly generationId: string;
  readonly title: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly details: StoredTrip;
  readonly createdAt: ChinaDateTime;
  /** 各天各段的一日行程（trip_day、trip_part）。 */
  readonly days: readonly { readonly day: number; readonly part: number; readonly journey: InitialRealDayDraft }[];
}
export type TripSaveOutcome =
  | { readonly status: "saved" | "already_saved"; readonly tripId: string }
  | { readonly status: "intent_conflict" };

export interface TripRepository {
  findTripCreation(generationId: string): Promise<{ tripId: string } | null>;
  /** 出游和各天在一个事务里创建，一起成功或一起失败。 */
  createTrip(trip: InitialTrip): Promise<TripSaveOutcome>;
  /** 一趟出游的各天各段对应的一日行程。 */
  findTrip(tripId: string): Promise<{ readonly days: readonly { day: number; part: number; journeyId: string }[] } | null>;
}

/** 一段要保存的地点方案：确认快照和它的指纹（来自签名凭据）。 */
export interface TripSegment {
  readonly day: number;
  readonly part: number;
  readonly snapshot: DayDraftConfirmationSnapshot;
  readonly draftFingerprint: string;
  readonly expiresAt: number;
  /** 这段所在城市（行程列表显示用）。 */
  readonly city: JourneyCity;
}

/**
 * 保存整趟：每段照一日的流程复核（路线按原方式重查、业务安排没变），全部通过后才在一个事务里写出游和各天。
 * 任何一段过期、变化或查不到路线，整趟都不保存。
 */
export async function confirmOuting(options: {
  readonly generationId: string;
  readonly title: string;
  readonly details: StoredTrip;
  readonly segments: readonly TripSegment[];
  readonly acknowledgeUnknowns: boolean;
  readonly enabled: boolean;
  readonly routes: MobilityProvider;
  readonly repository: TripRepository;
  readonly idGenerator: JourneyIdGenerator;
  readonly clock: JourneyClock;
}): Promise<
  | TripSaveOutcome
  | { status: "disabled" | "expired" | "acknowledgment_required" | "draft_changed" | "temporarily_unavailable"; day?: number }
> {
  const prior = await options.repository.findTripCreation(options.generationId);
  if (prior) return { status: "already_saved", tripId: prior.tripId };
  const collected = await collectSegments(options);
  if (!Array.isArray(collected)) return collected;
  const days = collected;
  if (!days.length) return { status: "draft_changed" };
  const dates = options.details.days.map((day) => day.date).sort();
  const createdAt = days[0]!.journey.createdAt;
  return options.repository.createTrip({
    tripId: options.idGenerator.next("journey"),
    generationId: options.generationId,
    title: options.title.trim().slice(0, 80),
    firstDate: dates[0]!,
    lastDate: dates.at(-1)!,
    details: storedTripSchema.parse(options.details),
    createdAt,
    days,
  });
}

type SegmentFailure = { status: "disabled" | "expired" | "acknowledgment_required" | "draft_changed" | "temporarily_unavailable"; day?: number };

/** 每段复用一日的确认流程（路线按原方式重查、安排没变），只是不直接写库：收集起来，最后一起写。 */
async function collectSegments(options: {
  readonly title: string;
  readonly segments: readonly TripSegment[];
  readonly acknowledgeUnknowns: boolean;
  readonly enabled: boolean;
  readonly routes: MobilityProvider;
  readonly idGenerator: JourneyIdGenerator;
  readonly clock: JourneyClock;
}): Promise<InitialTrip["days"][number][] | SegmentFailure> {
  const days: InitialTrip["days"][number][] = [];
  for (const segment of options.segments) {
    let captured: InitialRealDayDraft | null = null;
    const collector: RealDayRepository = {
      findRealDayCreation: async () => null,
      createRealDay: async (draft) => {
        captured = draft;
        return { status: "saved", journeyId: draft.journeyId, planVersion: 1 };
      },
    };
    const result = await confirmRealDay({
      snapshot: segment.snapshot,
      draftFingerprint: segment.draftFingerprint,
      title: `${options.title} · 第 ${segment.day} 天`.slice(0, 80),
      acknowledgeUnknowns: options.acknowledgeUnknowns,
      expiresAt: segment.expiresAt,
      enabled: options.enabled,
      routes: options.routes,
      repository: collector,
      idGenerator: options.idGenerator,
      clock: options.clock,
    });
    if (result.status === "saved" && captured) {
      days.push({ day: segment.day, part: segment.part, journey: { ...(captured as InitialRealDayDraft), city: segment.city } });
      continue;
    }
    // 收集器不会回放旧行程；这两种只可能来自快照本身不一致，按方案已变化处理。
    if (result.status === "saved" || result.status === "already_saved" || result.status === "intent_conflict") {
      return { status: "draft_changed", day: segment.day };
    }
    return { status: result.status, day: segment.day };
  }
  return days;
}

/**
 * V2.11 跨天改动的基础版本（§3.9）：生成改动方案时的出游版本，和这趟出游每一个一日行程的计划版本、进度版本。
 * 确认时任何一个变了（别的天被调整、今天又标了完成），整个改动拒绝，请用户重新说。
 */
export interface OutingChangeBase {
  readonly tripVersion: number;
  readonly journeys: readonly { readonly journeyId: string; readonly planVersion: number; readonly observationVersion: number }[];
}

export function outingBaseIsCurrent(base: OutingChangeBase, current: OutingChangeBase): boolean {
  return base.tripVersion === current.tripVersion &&
    base.journeys.length === current.journeys.length &&
    base.journeys.every((journey) => current.journeys.some((item) =>
      item.journeyId === journey.journeyId &&
      item.planVersion === journey.planVersion &&
      item.observationVersion === journey.observationVersion));
}

export interface OutingChangeCommit {
  readonly tripId: string;
  /** 这次改动的编号（重试按它幂等）。 */
  readonly changeId: string;
  readonly base: OutingChangeBase;
  /** 整天换掉的天：新的各段一日行程。 */
  readonly replace: readonly { readonly day: number; readonly journeys: InitialTrip["days"][number][] }[];
  /** 从今天挪走的站：在今天的行程里记为跳过。 */
  readonly skip?: { readonly journeyId: string; readonly activityId: string };
  readonly details: StoredTrip;
  readonly confirmedAt: ChinaDateTime;
}
export type OutingChangeOutcome =
  | { readonly status: "saved" | "already_saved"; readonly journeys: readonly { day: number; part: number; journeyId: string }[] }
  | { readonly status: "stale" | "not_found" };

export interface OutingChangeRepository {
  /** 现在的出游版本和每一个一日行程的版本（确认前比对用）。 */
  readTripBase(tripId: string): Promise<(OutingChangeBase & { readonly details: StoredTrip }) | null>;
  /** 一个事务：比对基础版本、给今天记跳过、换掉受影响的天、出游版本加一。 */
  commitOutingChange(commit: OutingChangeCommit): Promise<OutingChangeOutcome>;
}

/**
 * 确认跨天改动：新的各段先照一日的流程复核，再一次写入。基础版本在仓储的事务里再比一次（这里先比，
 * 省掉明显过期时的路线复查）。
 */
export async function confirmOutingChange(options: {
  readonly tripId: string;
  readonly changeId: string;
  readonly title: string;
  readonly base: OutingChangeBase;
  readonly details: StoredTrip;
  readonly days: readonly number[];
  readonly segments: readonly TripSegment[];
  readonly skip?: { readonly journeyId: string; readonly activityId: string };
  readonly enabled: boolean;
  readonly routes: MobilityProvider;
  readonly repository: OutingChangeRepository;
  readonly idGenerator: JourneyIdGenerator;
  readonly clock: JourneyClock;
}): Promise<OutingChangeOutcome | SegmentFailure> {
  const current = await options.repository.readTripBase(options.tripId);
  if (!current) return { status: "not_found" };
  if (!outingBaseIsCurrent(options.base, current)) return { status: "stale" };
  const collected = await collectSegments({ ...options, acknowledgeUnknowns: true });
  if (!Array.isArray(collected)) return collected;
  const now = options.clock.now();
  return options.repository.commitOutingChange({
    tripId: options.tripId,
    changeId: options.changeId,
    base: options.base,
    replace: options.days.map((day) => ({ day, journeys: collected.filter((entry) => entry.day === day) })),
    ...(options.skip ? { skip: options.skip } : {}),
    details: storedTripSchema.parse(options.details),
    confirmedAt: toChinaDateTime(now),
  });
}
