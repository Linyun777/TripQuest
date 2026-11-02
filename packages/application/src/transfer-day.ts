import type { DayDraft, DayPlanningResult } from "./day-planning";
import { straightMeters } from "./leg-choice";
import {
  SLOT_MIN_OVERLAP_MINUTES,
  slotOverlapMinutes,
  type PlanningPlace,
  type PlanningRequirements,
} from "./planning-requirements";

/**
 * V2.11 一天里的固定交通（stages/V2.11.md §3.4）：用户给的高铁、航班把一天切成前后几段，每段交给现有的
 * 一日规划器，再把各段和交通拼成一天整体校验。这里只做确定的计算：交通时刻（没填时按估计）、切段、
 * 把地点和兴趣分到各段、拼接后的校验；排每一段的是 Agent 层。
 */
export const TRANSFER_BUFFER_MINUTES = { train: 30, flight: 90, other: 15 } as const;
/** 一段不足 1 小时就不排地点，只排到站。 */
export const SHORT_SEGMENT_MINUTES = 60;
/** 夜车、红眼航班早上到站：8 点前不硬塞景点，提示可以先休息或吃早饭。 */
export const EARLY_ARRIVAL_MINUTES = 8 * 60;

export interface DayTransfer {
  readonly mode: keyof typeof TRANSFER_BUFFER_MINUTES;
  readonly from: PlanningPlace;
  readonly to: PlanningPlace;
  readonly departAt: string | null;
  readonly arriveAt: string | null;
  readonly arriveDay: "same" | "next";
  /** 进站缓冲；不写按方式（高铁 30、飞机 90、其他 15 分钟）。 */
  readonly bufferMinutes?: number;
  /** 过夜交通用户在卡片上确认过（没确认不能开始规划）。 */
  readonly overnightConfirmed?: true;
}
export type DayVisit = PlanningRequirements["visits"][number];
export type DayInterest = NonNullable<PlanningRequirements["freeInterests"]>[number] & {
  /** 只在这个城市（行政区编码）找。 */
  readonly city?: string;
};

export interface TransferDayInput {
  readonly date: string;
  readonly window: { readonly startsAt: string; readonly endsAt: string };
  readonly start: PlanningPlace;
  readonly end: PlanningPlace;
  /** 当天的固定交通，按时间先后。 */
  readonly transfers: readonly DayTransfer[];
  readonly visits: readonly DayVisit[];
  readonly interests: readonly DayInterest[];
}

/** 交通实际按的时刻（分钟）；next 表示第二天到，这一天在出发站结束。 */
export interface TimedTransfer {
  readonly transfer: DayTransfer;
  readonly departAt: number;
  readonly arriveAt: number;
  readonly nextDay: boolean;
  /** 时刻里有估计的部分（用户没填车次）。 */
  readonly estimated: boolean;
  /** V3.3：估计的车程按距离算（distance），还是没法算、按 2 小时（fixed）。 */
  readonly estimate?: "distance" | "fixed";
  readonly bufferMinutes: number;
}

export interface DaySegment {
  readonly index: number;
  readonly start: PlanningPlace;
  readonly end: PlanningPlace;
  /** 这段能用的时间（分钟）：从出发（或到站）到下一段交通的进站时刻（或这一天结束）。 */
  readonly startsAt: number;
  readonly endsAt: number;
  /** 这段所在的城市（起点的城市，缺省用终点的）。 */
  readonly city: string | undefined;
  readonly visits: readonly DayVisit[];
  readonly interests: readonly DayInterest[];
}

export interface SplitDay {
  readonly transfers: readonly TimedTransfer[];
  readonly segments: readonly DaySegment[];
  /** 放不进任何一段的地点和兴趣（必去的放不进就是排不开）。 */
  readonly unplaced: { readonly visits: readonly DayVisit[]; readonly interests: readonly DayInterest[] };
  readonly notes: readonly string[];
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

/** 没填车次时最早按几点出发（§3.7）。 */
const EARLIEST_DEPART_MINUTES = 7 * 60;
/** 估计的车程到得晚于这个时刻，提示填车次。 */
const LATE_ARRIVAL_MINUTES = 22 * 60;
const LAST_MINUTE = 23 * 60 + 59;
/** 不是从这个车站出发时，留给去车站的时间（只用来估计没填的车次）。 */
const REACH_STATION_MINUTES = 60;

/**
 * V3.3 没填车次时的车程（§3.7）：两站直线距离 × 1.3 ÷ 速度 + 20 分钟，向上取到 10 分钟，至少 30 分钟；高铁按
 * 200 公里 / 时，飞机 700 公里 / 时再加 60 分钟。其他方式和查不到坐标时没有估计（返回 null，按 2 小时）。
 */
export function estimatedRideMinutes(transfer: Pick<DayTransfer, "mode" | "from" | "to">): number | null {
  if (transfer.mode === "other") return null;
  const meters = straightMeters(transfer.from.place.location, transfer.to.place.location);
  if (!Number.isFinite(meters) || meters <= 0) return null;
  const km = (meters / 1000) * 1.3;
  const raw = transfer.mode === "flight" ? (km / 700) * 60 + 60 + 20 : (km / 200) * 60 + 20;
  return Math.max(30, Math.ceil(raw / 10) * 10);
}

/**
 * 交通实际按的时刻：用户给了就按给的；过夜交通没给按晚上 9 点出发、第二天 7 点到估计（§3.3、§3.4）。
 * V3.3：其余没给的按距离估计车程（§3.7）：只给了一头，另一头按车程推；都没给时按中午 12 点到达倒推，最早 7 点
 * 出发，也不早于 earliest（这一天开始后能赶上的时刻）。估计不了时还按 2 小时。
 */
export function timeTransfer(transfer: DayTransfer, earliest = EARLIEST_DEPART_MINUTES): TimedTransfer {
  const nextDay = transfer.arriveDay === "next";
  const given = { departAt: transfer.departAt ? minutes(transfer.departAt) : null, arriveAt: transfer.arriveAt ? minutes(transfer.arriveAt) : null };
  const ride = nextDay ? null : estimatedRideMinutes(transfer);
  const length = ride ?? 120;
  let departAt: number;
  let arriveAt: number;
  if (nextDay) {
    departAt = given.departAt ?? 21 * 60;
    arriveAt = given.arriveAt ?? 7 * 60;
  } else if (given.departAt !== null) {
    departAt = given.departAt;
    arriveAt = given.arriveAt ?? Math.min(departAt + length, LAST_MINUTE);
  } else if (given.arriveAt !== null) {
    arriveAt = given.arriveAt;
    departAt = Math.max(0, arriveAt - length);
  } else {
    departAt = Math.max(12 * 60 - length, EARLIEST_DEPART_MINUTES, earliest);
    arriveAt = Math.min(departAt + length, LAST_MINUTE);
  }
  return {
    transfer,
    departAt,
    arriveAt,
    nextDay,
    estimated: given.departAt === null || given.arriveAt === null,
    bufferMinutes: transfer.bufferMinutes ?? TRANSFER_BUFFER_MINUTES[transfer.mode],
    ...(given.departAt === null || given.arriveAt === null ? { estimate: ride === null ? "fixed" as const : "distance" as const } : {}),
  };
}

/**
 * 一天里的几趟交通按先后定时刻：没填的车次不早于这一天开始（或上一趟到站）后能赶上的时刻——从这个车站出发时
 * 只算进站缓冲，否则另加去车站的时间。outingFrames 和 splitDay 都用它，两边算出的时刻一致。
 * leaveEarly：整趟从这个车站坐车出发、用户没说几点出发——出游就从上车开始，第一趟按 §3.7 最早 7 点走，不受这一天
 * 时间窗的限制（outingFrames 再把这天的开始提前到进站时刻）。
 */
export function timeTransfers(
  transfers: readonly DayTransfer[],
  start: PlanningPlace,
  startsAt: number,
  leaveEarly = false,
): TimedTransfer[] {
  const timed: TimedTransfer[] = [];
  let place = start;
  let at = startsAt;
  for (const [index, transfer] of transfers.entries()) {
    const buffer = transfer.bufferMinutes ?? TRANSFER_BUFFER_MINUTES[transfer.mode];
    const here = place.place.ref.externalId === transfer.from.place.ref.externalId;
    const earliest = leaveEarly && here && index === 0 ? EARLIEST_DEPART_MINUTES : at + buffer + (here ? 0 : REACH_STATION_MINUTES);
    const item = timeTransfer(transfer, earliest);
    timed.push(item);
    place = transfer.to;
    at = item.arriveAt;
  }
  return timed;
}

/**
 * 按固定交通切段，再把地点和兴趣分到各段：
 * - 地点按城市，同城的几段里放离它最近的一段，一样近时放时间多的；
 * - 兴趣有城市的只放那个城市的段；有时段的只放时段对得上的段；其余放时间最多的段；
 * - 不足 1 小时的段不放；固定事项放进包含它时间的那段。
 */
export function splitDay(input: TransferDayInput): SplitDay {
  const transfers = timeTransfers(input.transfers, input.start, minutes(input.window.startsAt));
  const notes: string[] = [];
  for (const item of transfers.filter((entry) => entry.estimated)) {
    notes.push(estimateNote(item));
  }
  const bounds: { start: PlanningPlace; end: PlanningPlace; startsAt: number; endsAt: number }[] = [];
  let place = input.start;
  let at = minutes(input.window.startsAt);
  for (const item of transfers) {
    bounds.push({ start: place, end: item.transfer.from, startsAt: at, endsAt: item.departAt - item.bufferMinutes });
    if (item.nextDay) {
      place = item.transfer.to;
      at = Number.POSITIVE_INFINITY;
      break;
    }
    place = item.transfer.to;
    at = item.arriveAt;
  }
  if (Number.isFinite(at)) bounds.push({ start: place, end: input.end, startsAt: at, endsAt: minutes(input.window.endsAt) });
  // 夜车早上到站：8 点前不排地点（这段从 8 点开始找地方），提示可以先休息或吃早饭。
  const first = bounds[0];
  if (first && first.startsAt < EARLY_ARRIVAL_MINUTES && isStation(first.start)) {
    notes.push("到得早，可以先找地方休息或吃早饭。");
    first.startsAt = Math.min(EARLY_ARRIVAL_MINUTES, first.endsAt);
  }

  const usable = (index: number) => bounds[index].endsAt - bounds[index].startsAt >= SHORT_SEGMENT_MINUTES;
  const cityOf = (index: number) => bounds[index].start.place.cityAdcode ?? bounds[index].end.place.cityAdcode;
  const length = (index: number) => bounds[index].endsAt - bounds[index].startsAt;
  const indexes = bounds.map((_, index) => index).filter(usable);
  const visits = bounds.map(() => [] as DayVisit[]);
  const interests = bounds.map(() => [] as DayInterest[]);
  const unplaced = { visits: [] as DayVisit[], interests: [] as DayInterest[] };
  for (const visit of input.visits) {
    const at = visit.role === "fixed" ? { from: minutes(visit.startsAt), to: minutes(visit.endsAt) } : null;
    const fits = indexes.filter((index) => !at || (bounds[index].startsAt <= at.from && at.to <= bounds[index].endsAt));
    // 有和它同城的段（哪怕太短）就只在同城的段里放：杭州的博物馆不能放到 500 公里外云岭的那段。
    const sameCity = (index: number) => !!cityOf(index) && cityOf(index) === visit.place.place.cityAdcode;
    const pool = bounds.some((_, index) => sameCity(index)) ? fits.filter(sameCity) : fits;
    const distance = (index: number) => Math.min(
      straightMeters(bounds[index].start.place.location, visit.place.place.location),
      straightMeters(bounds[index].end.place.location, visit.place.place.location),
    );
    const best = [...pool].sort((a, b) => distance(a) - distance(b) || length(b) - length(a))[0];
    if (best === undefined) unplaced.visits.push(visit);
    else visits[best].push(visit);
  }
  for (const interest of input.interests) {
    const pool = indexes
      .filter((index) => !interest.city || cityOf(index) === interest.city)
      .filter((index) => !interest.when ||
        slotOverlapMinutes(interest.when, { startsAt: bounds[index].startsAt, endsAt: bounds[index].endsAt }) >= SLOT_MIN_OVERLAP_MINUTES);
    const best = [...pool].sort((a, b) => length(b) - length(a))[0];
    if (best === undefined) unplaced.interests.push(interest);
    else interests[best].push(interest);
  }
  return {
    transfers,
    segments: bounds.map((bound, index) => ({ index, ...bound, city: cityOf(index), visits: visits[index], interests: interests[index] })),
    unplaced,
    notes,
  };
}

/** 没填车次时方案上的说明：按什么估的、几点出发几点到；车程很长或估计不了时建议填车次。 */
function estimateNote(item: TimedTransfer): string {
  if (item.nextDay) return `未填车次，按 ${clock(item.departAt)} 出发、次日 ${clock(item.arriveAt)} 到达估计。`;
  const ride = item.arriveAt - item.departAt;
  const length = ride >= 60 ? `${Math.floor(ride / 60)} 小时${ride % 60 ? ` ${ride % 60} 分` : ""}` : `${ride} 分钟`;
  const how = item.estimate === "distance" ? `按两站距离估计车程约 ${length}` : "车程按 2 小时估计";
  const late = item.arriveAt > LATE_ARRIVAL_MINUTES ? "这段车程很长，" : "";
  return `未填车次，${how}，按 ${clock(item.departAt)} 出发、${clock(item.arriveAt)} 到达；${late}建议填上车次。`;
}

/** 车站、机场（高德分类 1501 机场相关、1502 火车站）。 */
function isStation(place: PlanningPlace): boolean {
  return /^150[12]/.test(place.place.categoryCode ?? "");
}

/** 拼成一天后的每一部分：一段规划（一日规划器排的）、一段直接去车站、一段固定交通。 */
export type TransferDayPart =
  | {
      readonly kind: "plan";
      readonly segment: number;
      readonly draft: DayDraft;
      /** 这一段的完整规划结果（签发保存凭据时要用）。 */
      readonly result?: Extract<DayPlanningResult, { status: "completed"; outcome: "draft" }>;
    }
  | {
      readonly kind: "connect";
      readonly segment: number;
      readonly from: string;
      readonly to: string;
      readonly departsAt: number;
      readonly arrivesAt: number;
      readonly mode: string;
    }
  | {
      readonly kind: "transfer";
      readonly mode: DayTransfer["mode"];
      readonly from: string;
      readonly to: string;
      readonly departAt: number;
      readonly arriveAt: number;
      readonly nextDay: boolean;
      readonly estimated: boolean;
      readonly bufferMinutes: number;
    };

/** 一段排完后空着这么久（分钟）就提示可以加地方。 */
export const IDLE_NOTE_MINUTES = 4 * 60;

/**
 * 验收复测第 4 条：一天里空着 4 小时以上时提示可以加地方或兴趣（复测里第 1 天 12:11 就回到酒店，最后一天
 * 9:32 到车站等到 17:30，修后又见到 11:45 逛完等到 18:00 吃火锅，都没有提示）。看两处：一段里两站之间
 * （扣掉路上的时间），一段排完后到这段结束（回住处、或到车站等进站）。只说空着多久，不编推荐。
 */
export function idleNotes(parts: readonly TransferDayPart[], split: SplitDay): string[] {
  const notes: string[] = [];
  const say = (from: number, to: number, where: string) => {
    if (to - from < IDLE_NOTE_MINUTES) return;
    notes.push(`${clock(from)}${where}之后到 ${clock(to)} 都空着（约 ${Math.round((to - from) / 60)} 小时），可以在对话里加个想去的地方或兴趣。`);
  };
  for (const part of parts) {
    if (part.kind === "transfer") continue;
    const segment = split.segments[part.segment];
    if (!segment) continue;
    if (part.kind === "plan") {
      const { activities, legs } = part.draft;
      for (const [index, activity] of activities.entries()) {
        const before = activities[index - 1];
        const leg = legs[index];
        const name = before && part.draft.places.find((place) => place.placeId === before.placeId)?.name.slice(0, 30);
        if (before && leg) say(before.endsAt, activity.startsAt - leg.travelMinutes - leg.bufferMinutes, ` 离开${name ?? "上一站"}，`);
      }
    }
    const from = part.kind === "plan" ? part.draft.endArrival : part.arrivesAt;
    say(from, segment.endsAt, ` 到${segment.end.place.name.slice(0, 30)}，`);
  }
  return notes;
}

/**
 * 拼好后的整天再独立校验一次：各部分时间连续不重叠；每段在下一段交通的进站时刻前到站；
 * 到站后的那段不早于到站时刻开始；固定交通的时刻和用户给的（或估计的）一致，没被挤占。
 */
export function checkTransferDay(parts: readonly TransferDayPart[], split: SplitDay): string[] {
  const issues: string[] = [];
  const window = (part: TransferDayPart) => part.kind === "plan"
    ? { from: part.draft.window.startsAt, to: part.draft.endArrival }
    : part.kind === "connect" ? { from: part.departsAt, to: part.arrivesAt }
      : { from: part.departAt, to: part.nextDay ? 24 * 60 : part.arriveAt };
  for (const [index, part] of parts.entries()) {
    if (part.kind === "plan" && part.draft.verification === "checked" && part.draft.checks.some((issue) => issue.kind === "violation")) {
      issues.push(`segment_${part.segment}_violation`);
    }
    const next = parts[index + 1];
    if (!next) continue;
    if (next.kind === "transfer") {
      // 起点就是车站（“8 点在杭州东坐 8 点的高铁”）：人已经在站里，不按进站缓冲算迟到。
      const atStation = part.kind === "connect" && part.mode === "same_place";
      if (!atStation && window(part).to > next.departAt - next.bufferMinutes) issues.push(`late_for_transfer_${index + 1}`);
    } else if (window(next).from < window(part).to) {
      issues.push(`overlap_${index + 1}`);
    }
  }
  const timed = parts.filter((part) => part.kind === "transfer");
  for (const [index, item] of split.transfers.entries()) {
    const part = timed[index];
    if (!part || part.departAt !== item.departAt || part.arriveAt !== item.arriveAt) issues.push(`transfer_${index + 1}_moved`);
  }
  return issues;
}
