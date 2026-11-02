import { randomUUID } from "node:crypto";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import {
  createDayPlanningProblem,
  type DayDraft,
  type DayPlanningRunner,
  type DayProgress,
  type DayWeather,
} from "@tripquest/application/day-planning";
import { chooseLeg } from "@tripquest/application/leg-choice";
import { planningRequirementsSchema, type PlanningPlace, type TravelPreference } from "@tripquest/application/planning";
import {
  checkTransferDay,
  clock,
  idleNotes,
  splitDay,
  type DaySegment,
  type SplitDay,
  type TransferDayInput,
  type TransferDayPart,
} from "@tripquest/application/transfer-day";
import type { MobilityProvider } from "@tripquest/providers";

/**
 * V2.11 一天里的固定交通（stages/V2.11.md §3.4）：按交通切段（application/transfer-day），每段交给现有的
 * 一日规划器排；没有地点的段只核对去车站的路线。拼成一天后再整体校验。任何一段排不开，整天照实说排不开，
 * 不挪交通时间、不删必去。
 */
/** 赶早车时最早几点出门。 */
const EARLIEST_LEAVE_MINUTES = 5 * 60 + 30;

export type TransferDayResult =
  | {
      readonly status: "draft";
      readonly parts: readonly TransferDayPart[];
      readonly notes: readonly string[];
      /** 拼接后的整天校验问题（应为空）。 */
      readonly issues: readonly string[];
      readonly split: SplitDay;
    }
  | {
      readonly status: "no_plan";
      /** 哪一段排不开（-1 是整天：有放不进任何一段的必去）。 */
      readonly segment: number;
      readonly reason: "unplaced" | "requirements" | "route_unknown" | "late" | "constraints_not_met" | "no_suitable_places" | "insufficient_information";
      readonly explanation: string;
      readonly notes: readonly string[];
    }
  | { readonly status: "needs_confirmation"; readonly transfers: readonly number[] }
  | { readonly status: "failed"; readonly segment: number; readonly code: string };

export async function planTransferDay(
  input: TransferDayInput & {
    readonly travel: TravelPreference;
    readonly pace: "relaxed" | "standard";
    readonly cityAdcode: string;
    readonly notes?: string;
    readonly weather?: DayWeather;
    /** V2.11：各城市的预报：每段按它所在城市的看，户外提示按每一站的城市看。 */
    readonly weatherByCity?: Readonly<Record<string, DayWeather>>;
    /** 出游逐天生成：前几天找到的地点（高德编号），这一天不再找。 */
    readonly exclude?: readonly string[];
  },
  dependencies: { readonly runner: DayPlanningRunner; readonly provider: Pick<MobilityProvider, "findRoutes">; readonly now: () => number },
  options: {
    readonly signal: AbortSignal;
    readonly onProgress?: (segment: number, progress: DayProgress) => void;
    /** 每段排好时的确认快照（保存时用）。 */
    readonly onDraftReady?: (segment: number, snapshot: DayDraftConfirmationSnapshot) => void;
  },
): Promise<TransferDayResult> {
  // 过夜交通要用户在卡片上确认过（由代码挡，不靠模型）。
  const unconfirmed = input.transfers.flatMap((item, index) => (item.arriveDay === "next" && !item.overnightConfirmed ? [index] : []));
  if (unconfirmed.length) return { status: "needs_confirmation", transfers: unconfirmed };
  const split = splitDay(input);
  const notes = [...split.notes];
  const required = split.unplaced.visits.filter((visit) => visit.role !== "optional");
  if (required.length) {
    return {
      status: "no_plan", segment: -1, reason: "unplaced", notes,
      explanation: `${required.map((visit) => visit.place.place.name).join("、")}放不进这一天：交通前后的时间都不够。`,
    };
  }
  for (const visit of split.unplaced.visits) notes.push(`${visit.place.place.name}这天放不下，没有排。`);
  for (const interest of split.unplaced.interests) notes.push(`“${interest.text}”这天放不下，没有排。`);

  const parts: TransferDayPart[] = [];
  for (const segment of split.segments) {
    const timed = split.transfers[segment.index - 1];
    if (timed) {
      parts.push({
        kind: "transfer",
        mode: timed.transfer.mode,
        from: timed.transfer.from.place.name,
        to: timed.transfer.to.place.name,
        departAt: timed.departAt,
        arriveAt: timed.arriveAt,
        nextDay: timed.nextDay,
        estimated: timed.estimated,
        bufferMinutes: timed.bufferMinutes,
      });
    }
    // 中间不排东西的一段：起止是同一个地点（起点就是车站，或终点就是到达站）时人已经在那里；只是去赶车时
    // 出门时间跟着车走（connect 里倒推）。都不按每天的出门时间算迟到。
    const samePlace = segment.start.place.ref.externalId === segment.end.place.ref.externalId;
    const toRide = input.transfers.some((ride) => ride.from.place.ref.externalId === segment.end.place.ref.externalId);
    const nothingToPlace = !segment.visits.length && !segment.interests.length;
    if (segment.endsAt < segment.startsAt && !((samePlace || toRide) && nothingToPlace)) {
      return { status: "no_plan", segment: segment.index, reason: "late", notes, explanation: "赶不上这段交通：出发前的时间不够进站。" };
    }
    let planned = segment.visits.length || segment.interests.length
      ? await planSegment(segment, input, dependencies, options)
      : await connect(segment, input, dependencies, options.signal, notes);
    // 只有兴趣的一段排不开（兴趣是愿望，不是必去）：这段直接去下一站，照实说没排上。
    if ("status" in planned && planned.status === "no_plan" && !segment.visits.length &&
      (planned.reason === "constraints_not_met" || planned.reason === "no_suitable_places")) {
      notes.push(`${segment.interests.map((interest) => `“${interest.text}”`).join("、")}这段时间排不开，没有排。`);
      planned = await connect(segment, input, dependencies, options.signal, notes);
    }
    if ("status" in planned) return planned.status === "failed" ? planned : { ...planned, notes };
    parts.push(planned);
  }
  // 当天以过夜交通结束：最后一段之后是上车，不再排地点。
  const last = split.transfers.at(-1);
  if (last?.nextDay) {
    parts.push({
      kind: "transfer", mode: last.transfer.mode, from: last.transfer.from.place.name, to: last.transfer.to.place.name,
      departAt: last.departAt, arriveAt: last.arriveAt, nextDay: true, estimated: last.estimated, bufferMinutes: last.bufferMinutes,
    });
  }
  notes.push(...idleNotes(parts, split));
  return { status: "draft", parts, notes, issues: checkTransferDay(parts, split), split };
}

type SegmentOutcome =
  | TransferDayPart
  | Extract<TransferDayResult, { status: "no_plan" }>
  | Extract<TransferDayResult, { status: "failed" }>;

/** 有地点或兴趣的一段：用现有的一日规划器排（起点、终点、这段的时间窗、分到这段的地点和兴趣）。 */
async function planSegment(
  segment: DaySegment,
  input: Parameters<typeof planTransferDay>[0],
  dependencies: Parameters<typeof planTransferDay>[1],
  options: Parameters<typeof planTransferDay>[2],
): Promise<SegmentOutcome> {
  const parsed = planningRequirementsSchema.safeParse({
    schemaVersion: "planning-requirements.v1",
    cityAdcode: segment.city ?? input.cityAdcode,
    anyCity: true,
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: input.date,
    window: { startsAt: clock(segment.startsAt), endsAt: clock(segment.endsAt) },
    startPlace: segment.start,
    endPlace: segment.end,
    interests: [],
    // 兴趣的城市只用来分段，交给一日规划器时不带。
    ...(segment.interests.length ? {
      freeInterests: segment.interests.map((interest) => ({
        id: interest.id, text: interest.text, ...(interest.when ? { when: interest.when } : {}), ...(interest.count ? { count: interest.count } : {}),
      })),
    } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.exclude?.length ? { exclude: [...input.exclude] } : {}),
    travel: input.travel,
    pace: input.pace,
    visits: segment.visits,
  });
  if (!parsed.success) {
    return {
      status: "no_plan", segment: segment.index, reason: "requirements", notes: [],
      explanation: `${clock(segment.startsAt)}–${clock(segment.endsAt)} 这段放不下：${parsed.error.issues[0]?.message ?? "时间不够"}。`,
    };
  }
  // 这段按它所在城市的预报；户外提示按每一站的城市看。
  const weather = (segment.city ? input.weatherByCity?.[segment.city] : undefined) ?? input.weather;
  const problem = createDayPlanningProblem({
    requirements: parsed.data,
    runId: randomUUID(),
    requirementsFingerprint: fingerprintRequirements(parsed.data),
    nowMs: dependencies.now(),
    leaveLate: true,
    ...(weather ? { weather } : {}),
    ...(input.weatherByCity ? { weatherByCity: input.weatherByCity } : {}),
  });
  const result = await dependencies.runner.run(problem, {
    signal: options.signal,
    onProgress: (progress) => options.onProgress?.(segment.index, progress),
    ...(options.onDraftReady ? { onDraftReady: (snapshot: DayDraftConfirmationSnapshot) => options.onDraftReady!(segment.index, snapshot) } : {}),
  });
  if (result.status === "completed" && result.outcome === "draft") {
    return { kind: "plan", segment: segment.index, draft: result.draft as DayDraft, result };
  }
  if (result.status === "completed") {
    return { status: "no_plan", segment: segment.index, reason: result.reason, notes: [], explanation: result.explanation };
  }
  return { status: "failed", segment: segment.index, code: result.status === "failed" ? result.code : result.status };
}

/** 没有地点的一段（太短，或什么都没分到）：只核对从这段起点到下一站（车站或终点）的路线来得及。 */
async function connect(
  segment: DaySegment,
  input: Parameters<typeof planTransferDay>[0],
  dependencies: Parameters<typeof planTransferDay>[1],
  signal: AbortSignal,
  notes: string[],
): Promise<SegmentOutcome> {
  const same = (a: PlanningPlace, b: PlanningPlace) => a.place.ref.externalId === b.place.ref.externalId;
  if (same(segment.start, segment.end)) {
    return { kind: "connect", segment: segment.index, from: segment.start.place.name, to: segment.end.place.name, departsAt: segment.startsAt, arrivesAt: segment.startsAt, mode: "same_place" };
  }
  const leg = await chooseLeg({
    from: { placeId: "from", place: segment.start.place },
    to: { placeId: "to", place: segment.end.place },
    travel: input.travel,
    provider: dependencies.provider,
    departureAt: `${input.date}T${clock(segment.startsAt)}:00+08:00`,
    call: { signal },
  });
  if (leg.route.status !== "known") {
    return { status: "no_plan", segment: segment.index, reason: "route_unknown", notes: [], explanation: `查不到从${segment.start.place.name}到${segment.end.place.name}的路线。` };
  }
  const minutes = Math.ceil(leg.route.durationSeconds / 60);
  const arrivesAt = segment.startsAt + minutes;
  // 只是去赶车的一段（中间不排东西）：按每天出门的时间赶不上时，倒推出门时间（不早于 5:30），照实写出来。
  // 车次是用户定的，出门时间跟着车走（“10 点的高铁”9 点出门来不及时，8:45 出门）。
  const rideNext = !!input.transfers.find((ride) => same(ride.from, segment.end));
  if (arrivesAt > segment.endsAt && rideNext && segment.endsAt - minutes >= EARLIEST_LEAVE_MINUTES) {
    const departsAt = segment.endsAt - minutes;
    notes.push(`要 ${clock(departsAt)} 从${segment.start.place.name}出发，才赶得上车。`);
    return {
      kind: "connect", segment: segment.index, from: segment.start.place.name, to: segment.end.place.name,
      departsAt, arrivesAt: segment.endsAt, mode: leg.route.mode ?? "walking",
    };
  }
  if (arrivesAt > segment.endsAt) {
    return { status: "no_plan", segment: segment.index, reason: "late", notes: [], explanation: `从${segment.start.place.name}到${segment.end.place.name}要到 ${clock(arrivesAt)}，赶不上。` };
  }
  return {
    kind: "connect", segment: segment.index, from: segment.start.place.name, to: segment.end.place.name,
    departsAt: segment.startsAt, arrivesAt, mode: leg.route.mode ?? "walking",
  };
}
