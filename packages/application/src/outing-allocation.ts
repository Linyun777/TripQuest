import { straightMeters } from "./leg-choice";
import { KIND_TYPICAL_STAYS, kindOfCategory, type PlaceKind } from "./place-kinds";
import {
  estimatedFloor,
  SLOT_MIN_OVERLAP_MINUTES,
  slotOverlapMinutes,
  type PlanningPlace,
  type TravelPreference,
} from "./planning-requirements";
import { SHORT_SEGMENT_MINUTES, splitDay, timeTransfer, timeTransfers, type DayTransfer, type TimedTransfer } from "./transfer-day";

/**
 * V2.11 出游分到各天（stages/V2.11.md §3.6）：代码算每天的可用时间和起止（住处、车站），规则分配作为
 * 基线和兜底，模型分配的结果由这里的检查把关（每个必去恰好一次、固定和指定的天不挪、每天装得下、
 * 离那天的住处或车站不太远、每天都要的兴趣每天都有、不出现空的一天）。
 */
export const MAX_ONE_WAY_MINUTES = 180;
/** 可用时间不足 2 小时的天可以空着。 */
export const EMPTY_DAY_MINUTES = 120;
/** 粗估路程：每段另加的上下车、找路时间。 */
const LEG_OVERHEAD_MINUTES = 10;
/** 每段留出的余地（分钟）。 */
const PART_SLACK_MINUTES = 15;
/** 市内和城市周边的路，道路距离约为直线的 1.3 倍。 */
const ROAD_DETOUR = 1.3;

export interface OutingVisit {
  readonly key: string;
  readonly place: PlanningPlace;
  readonly role: "optional" | "required" | "fixed";
  readonly stayMinutes: number;
  /** 估计的停留（可以缩到 floor）；kind 是估计时的地点类型。 */
  readonly floor?: number;
  readonly kind?: PlaceKind;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly day?: number;
}
export interface OutingInterest {
  readonly id: string;
  readonly text: string;
  readonly when?: "morning" | "noon" | "afternoon" | "dusk" | "evening";
  readonly city?: string;
  readonly day?: number;
  readonly perDay?: true;
}
export interface OutingPlanInput {
  readonly dates: { readonly from: string; readonly to: string };
  readonly dailyWindow: { readonly startsAt: string; readonly endsAt: string };
  readonly start: { readonly place: PlanningPlace; readonly at: string | null };
  readonly end: { readonly place: PlanningPlace; readonly at: string | null };
  /** 第 n 晚住哪（长度 = 天数 − 1）；onBoard 是在过夜交通上；null 是还没定。 */
  readonly lodging: readonly (PlanningPlace | "onBoard" | null)[];
  readonly transports: readonly (DayTransfer & { readonly day: number })[];
  readonly visits: readonly OutingVisit[];
  readonly interests: readonly OutingInterest[];
  readonly travel: TravelPreference;
  /** V3.2：这几天不自驾（车留在别的城市）。 */
  readonly noDriving?: readonly number[];
  /** V3.3：只说了区域的住宿要求（“春熙路”），暂定住处在那一带找。 */
  readonly lodgingAreas?: readonly { readonly text: string }[];
}

/** 一天的框架：起止地点、起止时刻、当天的固定交通、扣掉交通和固定事项后的可用分钟数、经过的城市。 */
export interface DayFrame {
  readonly day: number;
  readonly date: string;
  readonly start: PlanningPlace;
  readonly end: PlanningPlace;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly transfers: readonly TimedTransfer[];
  readonly available: number;
  /**
   * 按固定交通切开的几段（同第 5 步的切段）：一个地点只能用它所在城市那段的时间（高铁那天，杭州上午的
   * 时间不能拿来逛云岭）。
   */
  readonly parts: readonly {
    readonly city: string | undefined;
    readonly start: PlanningPlace;
    readonly end: PlanningPlace;
    /** 这段的起止时刻（分钟）：有时段的兴趣只放进时间对得上的段。 */
    readonly startsAt: number;
    readonly endsAt: number;
    readonly minutes: number;
  }[];
  readonly cities: readonly string[];
  /** 这一天的落脚点（起点、终点、车站）：判断地点离这天近不近。 */
  readonly anchors: readonly PlanningPlace[];
  /** V3.3：这一晚住处没定时，终点按什么估计（方案上说明）。 */
  readonly unsettled?: string;
}

export interface Allocation {
  readonly days: readonly {
    readonly day: number;
    readonly visits: readonly string[];
    readonly interests: readonly string[];
    readonly reason?: string;
  }[];
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function outingDayCount(input: Pick<OutingPlanInput, "dates">): number {
  return Math.round((Date.parse(input.dates.to) - Date.parse(input.dates.from)) / 86_400_000) + 1;
}

/**
 * 每一天的框架（§3.6 第 1 条）。第 n 天从前一晚住处（第 1 天从出发地点）到当晚住处（最后一天到结束地点）。
 * V3.3（§3.1）：住处没定时按“人在哪”往下接——这天的终点用这天最后一趟交通的到达点（如成都东站），没有就用这天
 * 的起点；第二天从前一天的终点出发，不再退回整趟的出发地点。
 */
export function outingFrames(input: OutingPlanInput): DayFrame[] {
  const count = outingDayCount(input);
  const frames: DayFrame[] = [];
  let previousEnd = input.start.place;
  for (let day = 1; day <= count; day += 1) {
    const rides = input.transports.filter((item) => item.day === day);
    const arrived = input.transports.find((item) => item.day === day - 1 && item.arriveDay === "next");
    const before = day === 1 ? input.start.place : arrived ? arrived.to : lodgingPlace(input, day - 1) ?? previousEnd;
    const opening = arrived ? timeTransfer(arrived).arriveAt
      : day === 1 && input.start.at ? minutes(input.start.at) : minutes(input.dailyWindow.startsAt);
    // 第一天从车站坐车出发、没说几点出发：按车次估计的出发时刻开始这一天（长途最早 7 点走，不被 9 点的时间窗卡住）。
    const leaveEarly = day === 1 && !input.start.at;
    const transfers = timeTransfers(rides, before, opening, leaveEarly);
    const first = transfers[0];
    const startsAt = leaveEarly && first && first.departAt - first.bufferMinutes < opening ? first.departAt - first.bufferMinutes : opening;
    // 最后一天从结束地点坐车走（“最后从云岭南站坐高铁回杭州”）：这趟出游在上车时结束，下车后不再回结束地点。
    const leaving = day === count ? transfers.at(-1) : undefined;
    const boardsAtEnd = !!leaving && !leaving.nextDay &&
      leaving.transfer.from.place.ref.externalId === input.end.place.place.ref.externalId;
    const overnight = transfers.find((item) => item.nextDay);
    const landed = overnight ? undefined : transfers.at(-1)?.transfer.to;
    const settled = lodgingPlace(input, day);
    const after = boardsAtEnd ? leaving!.transfer.to : day === count ? input.end.place : settled ?? landed ?? before;
    const unsettled = day < count && !settled && !overnight && input.lodging[day - 1] !== "onBoard"
      ? `第 ${day} 晚住处未定，按${after.place.name}附近估计。`
      : undefined;
    previousEnd = after;
    const endsAt = overnight ? overnight.departAt - overnight.bufferMinutes
      : boardsAtEnd ? leaving!.arriveAt
        : day === count && input.end.at ? minutes(input.end.at) : minutes(input.dailyWindow.endsAt);
    const busy = transfers.filter((item) => !item.nextDay).reduce((total, item) => total + item.bufferMinutes + Math.max(0, item.arriveAt - item.departAt), 0);
    const fixed = input.visits
      .filter((visit) => visit.role === "fixed" && visit.day === day && visit.startsAt && visit.endsAt)
      .reduce((total, visit) => total + minutes(visit.endsAt!) - minutes(visit.startsAt!), 0);
    const anchors = [before, after, ...transfers.flatMap((item) => [item.transfer.from, item.transfer.to])];
    const window = { startsAt: clock(startsAt), endsAt: clock(Math.max(startsAt, endsAt)) };
    const pieces = splitDay({
      date: addDays(input.dates.from, day - 1), window, start: before, end: after,
      transfers: transfers.map((item) => item.transfer), visits: [], interests: [],
    }).segments;
    const fixedIn = (from: number, to: number) => input.visits
      .filter((visit) => visit.role === "fixed" && visit.day === day && visit.startsAt && visit.endsAt &&
        minutes(visit.startsAt) >= from && minutes(visit.endsAt) <= to)
      .reduce((total, visit) => total + minutes(visit.endsAt!) - minutes(visit.startsAt!), 0);
    frames.push({
      day,
      date: addDays(input.dates.from, day - 1),
      start: before,
      end: after,
      startsAt,
      endsAt,
      transfers,
      available: Math.max(0, endsAt - startsAt - busy - fixed),
      parts: pieces.map((piece) => ({
        city: piece.city, start: piece.start, end: piece.end, startsAt: piece.startsAt, endsAt: piece.endsAt,
        minutes: Math.max(0, piece.endsAt - piece.startsAt - fixedIn(piece.startsAt, piece.endsAt)),
      })),
      cities: [...new Set(anchors.flatMap((place) => (place.place.cityAdcode ? [place.place.cityAdcode] : [])))],
      anchors,
      ...(unsettled ? { unsettled } : {}),
    });
  }
  return frames;
}

/**
 * 卡片上的一个地点用多长停留排（验收复测第 4 条）：写了就按写的（估计的可以缩到下限）；没写的按类型给估计停留
 * （类型由模型给，或按高德分类判断），可以缩到这类的下限。以前没写的一律按 60 分钟。
 */
export function visitStay(
  visit: { readonly stayMinutes: number | null; readonly staySource?: "user" | "estimate"; readonly kind?: PlaceKind },
  categoryCode: string | undefined,
): { stayMinutes: number; floor?: number; kind?: PlaceKind } {
  if (visit.stayMinutes !== null) {
    const floor = visit.staySource === "estimate"
      ? estimatedFloor({ stayMinutes: visit.stayMinutes, staySource: "estimate", ...(visit.kind ? { kind: visit.kind } : {}) })
      : undefined;
    return { stayMinutes: visit.stayMinutes, ...(floor !== undefined ? { floor } : {}), ...(visit.kind ? { kind: visit.kind } : {}) };
  }
  const kind = visit.kind ?? kindOfCategory(categoryCode);
  const stayMinutes = KIND_TYPICAL_STAYS[kind];
  return { stayMinutes, floor: estimatedFloor({ stayMinutes, staySource: "estimate", kind })!, kind };
}

/**
 * 有时段的兴趣这天能不能排（验收复测第 2 条：“晚上吃火锅”分到了 18:00 前就要回车站的那天）：有一段（不短于
 * 1 小时）和兴趣的时段重叠够 30 分钟，同逐天生成时的切段。没有时段的哪天都行。
 */
export function interestFits(frame: DayFrame, interest: Pick<OutingInterest, "when">): boolean {
  if (!interest.when) return true;
  return frame.parts.some((part) => part.endsAt - part.startsAt >= SHORT_SEGMENT_MINUTES &&
    slotOverlapMinutes(interest.when!, { startsAt: part.startsAt, endsAt: part.endsAt }) >= SLOT_MIN_OVERLAP_MINUTES);
}

/**
 * V3.3 连住分段（§3.2）：连着的几晚、城市相同（按这天结束时所在的城市）、中间没有过夜交通，算一段。只列住处没定的
 * 晚上：同一段里用户给了其中一晚，没定的几晚跟它同一家（given，跟前面最近的那晚，前面没有就跟后面的）；整段都没定
 * 的由选住处的那一步找一家（given 为空）。
 * 这天结束时在哪个城市：用户给了住处就是住处的城市；这天坐了车就是最后一趟的到达城市；都没有时（自驾、同城）看这天
 * 分到的地点大多在哪个城市（有分配时），再没有就和前一晚同城。
 */
export interface LodgingSegment {
  readonly nights: readonly number[];
  readonly city: string | undefined;
  readonly given?: PlanningPlace;
  /**
   * 给的“住处”其实是个区域（高德分类不是住宿：街、商圈、景点、车站——对话把“住春熙路附近”记成了住处），在它附近
   * 找一家；住宅（朋友家）和查不到分类的照用户给的。
   */
  readonly area?: PlanningPlace;
}

/** 高德的住宿服务（100000）、宾馆酒店（1001xx）、旅馆招待所（1002xx）；一个地点可能有几个分类码，用“|”分开。 */
export function isLodgingCategory(code: string | undefined): boolean {
  return !!code && code.split("|").some((item) => /^10\d{4}$/.test(item.trim()));
}

/** 住处是不是其实只是个区域（见 LodgingSegment.area）：只认高德那样的 6 位分类码，不是住宿、也不是住宅。 */
function areaOnly(place: PlanningPlace): boolean {
  const codes = (place.place.categoryCode ?? "").split("|").map((item) => item.trim());
  return codes.every((item) => /^\d{6}$/.test(item)) && !codes.some((item) => /^1[02]\d{4}$/.test(item));
}

export function lodgingSegments(input: OutingPlanInput, allocation?: Allocation): LodgingSegment[] {
  let previous = input.start.place.place.cityAdcode;
  const nights = input.lodging.map((value, index) => {
    const day = index + 1;
    const rides = input.transports.filter((ride) => ride.day === day);
    const landed = rides.filter((ride) => ride.arriveDay !== "next").at(-1)?.to.place.cityAdcode;
    const city = value === "onBoard" ? undefined : value ? value.place.cityAdcode : landed ?? mainCity(input, allocation, day) ?? previous;
    // 过夜车上的那晚之后，人在这趟车的到达城市。
    previous = value === "onBoard" ? rides.find((ride) => ride.arriveDay === "next")?.to.place.cityAdcode ?? previous : city ?? previous;
    return { night: day, value, city };
  });
  const runs: (typeof nights)[] = [];
  for (const night of nights) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (night.value === "onBoard") continue;
    if (run && last && last.night === night.night - 1 && last.city === night.city) run.push(night);
    else runs.push([night]);
  }
  const segments: LodgingSegment[] = [];
  // 只是个区域的那几晚也算没定，整段在区域附近找一家。
  const isArea = (night: (typeof nights)[number]) => !!night.value && night.value !== "onBoard" && areaOnly(night.value);
  for (const run of runs) {
    const given = run.filter((night) => night.value !== null && !isArea(night));
    const open = run.filter((night) => night.value === null || isArea(night));
    if (!open.length) continue;
    if (!given.length) {
      const area = open.find(isArea)?.value as PlanningPlace | undefined;
      segments.push({ nights: open.map((night) => night.night), city: run[0]!.city, ...(area ? { area } : {}) });
      continue;
    }
    const byPlace = new Map<string, { place: PlanningPlace; nights: number[] }>();
    for (const night of open) {
      const anchor = [...given].reverse().find((item) => item.night < night.night) ?? given.find((item) => item.night > night.night)!;
      const place = anchor.value as PlanningPlace;
      const key = place.place.ref.externalId;
      byPlace.set(key, { place, nights: [...(byPlace.get(key)?.nights ?? []), night.night] });
    }
    for (const { place, nights: followed } of byPlace.values()) {
      segments.push({ nights: followed, city: place.place.cityAdcode, given: place });
    }
  }
  return segments;
}

/** 这天分到的地点大多在哪个城市（一样多时取后面的，那是这天最后去的方向）。 */
function mainCity(input: OutingPlanInput, allocation: Allocation | undefined, day: number): string | undefined {
  const keys = allocation?.days.find((entry) => entry.day === day)?.visits ?? [];
  const counts = new Map<string, number>();
  for (const key of keys) {
    const city = input.visits.find((visit) => visit.key === key)?.place.place.cityAdcode;
    if (city) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [city, count] of counts) if (!best || count >= counts.get(best)!) best = city;
  return best;
}

function lodgingPlace(input: OutingPlanInput, night: number): PlanningPlace | null {
  const value = input.lodging[night - 1];
  return value && value !== "onBoard" ? value : null;
}

/**
 * 粗估单程分钟数：按直线距离和出行方式里最快的一种的速度，另加上下车时间（§3.6 第 2 条）。两种用途估法不同：
 * - `fit`（装不装得下，缺省）：保守。100 公里以内按直线的 1.3 倍算绕行，开车的前 40 公里按市内 30 公里/时、
 *   再远的按出城的 60 公里/时；估得偏乐观时，分到一天的地点逐天生成时会差几分钟排不开；
 * - `far`（是不是太远）：乐观，直线距离、开车 35 公里/时，避免把当天能往返的郊区说成大半天在路上。
 * 100 公里以上走高速，路线接近直线，两种都按 80 公里/时。
 */
export function roughMinutes(from: PlanningPlace, to: PlanningPlace, travel: TravelPreference, use: "fit" | "far" = "fit"): number {
  const km = straightMeters(from.place.location, to.place.location) / 1000;
  if (km < 0.05) return 0;
  const car = travel.allowed.includes("driving") || travel.allowed.includes("taxi");
  if (car && km > 100) return Math.round((km / 80) * 60) + LEG_OVERHEAD_MINUTES;
  if (use === "far") {
    const speed = car ? 35 : travel.allowed.includes("transit") ? 20 : travel.allowed.includes("bicycling") ? 12 : 4.5;
    return Math.round((km / speed) * 60) + LEG_OVERHEAD_MINUTES;
  }
  const road = km * ROAD_DETOUR;
  if (car) return Math.round((Math.min(road, 40) / 30 + Math.max(0, road - 40) / 60) * 60) + LEG_OVERHEAD_MINUTES;
  const speed = travel.allowed.includes("transit") ? 20 : travel.allowed.includes("bicycling") ? 12 : 4.5;
  return Math.round((road / speed) * 60) + LEG_OVERHEAD_MINUTES;
}

/** 离这一天最近的落脚点的粗估单程分钟数。 */
function nearness(frame: DayFrame, place: PlanningPlace, travel: TravelPreference): number {
  return Math.min(...frame.anchors.map((anchor) => roughMinutes(anchor, place, travel, "far")));
}

/** 一段装进这些地点要多少分钟：停留（估计的按下限）+ 从这段起点按就近顺序串起来、到这段终点的粗估路程。 */
function partLoad(part: DayFrame["parts"][number], visits: readonly OutingVisit[], travel: TravelPreference): number {
  const stays = visits.filter((visit) => visit.role !== "fixed").reduce((total, visit) => total + (visit.floor ?? visit.stayMinutes), 0);
  let at = part.start;
  let route = 0;
  const left = [...visits];
  while (left.length) {
    left.sort((a, b) => roughMinutes(at, a.place, travel) - roughMinutes(at, b.place, travel));
    const next = left.shift()!;
    route += roughMinutes(at, next.place, travel);
    at = next.place;
  }
  return stays + route + (visits.length ? roughMinutes(at, part.end, travel) : 0);
}

/** 地点放进这天的哪一段：同城的那段，没有同城的放最长的那段。 */
function partOf(frame: DayFrame, visit: OutingVisit): number {
  const same = frame.parts.findIndex((part) => !!part.city && part.city === visit.place.place.cityAdcode);
  if (same >= 0) return same;
  return frame.parts.reduce((best, part, index) => (part.minutes > frame.parts[best].minutes ? index : best), 0);
}

/** 每一段的负荷和可用分钟数（留出余地之后：粗估刚好装满的段，实际排时常差几分钟）。 */
export function dayParts(frame: DayFrame, visits: readonly OutingVisit[], travel: TravelPreference) {
  return frame.parts.map((part, index) => ({
    load: partLoad(part, visits.filter((visit) => partOf(frame, visit) === index), travel),
    minutes: Math.max(0, part.minutes - PART_SLACK_MINUTES),
  }));
}

/** 一天装进这些地点要多少分钟（各段相加，评测看“该轻的天更轻”用）。 */
export function dayLoad(frame: DayFrame, visits: readonly OutingVisit[], travel: TravelPreference): number {
  return dayParts(frame, visits, travel).reduce((total, part) => total + part.load, 0);
}

/** 分配里装不下的天（某一段的停留加粗估路程超过可用时间）。 */
export function overfullDays(input: OutingPlanInput, frames: readonly DayFrame[], allocation: Allocation): number[] {
  return frames.filter((frame) => {
    const keys = allocation.days.find((entry) => entry.day === frame.day)?.visits ?? [];
    const visits = input.visits.filter((visit) => keys.includes(visit.key));
    return !dayFits(frame, visits, input.travel);
  }).map((frame) => frame.day);
}

/** 每一段都装得下。 */
function dayFits(frame: DayFrame, visits: readonly OutingVisit[], travel: TravelPreference): boolean {
  return dayParts(frame, visits, travel).every((part) => !part.load || part.load <= part.minutes);
}

/**
 * 规则分配（§3.6 第 2 条，基线与兜底）：固定事项和指定了天的先放；其余地点大的先放，放进离它最近（差不多近时
 * 选空余多的）、装得下的那天，想去的装得下才放；兴趣放进空余最多的天（指定城市的只放有这个城市的天，
 * 每天都要的每天放）。最后补空天：先挪兴趣，再挪地点。
 */
export function allocateByRules(input: OutingPlanInput, frames: readonly DayFrame[]): Allocation {
  const placed = new Map(frames.map((frame) => [frame.day, [] as OutingVisit[]]));
  const interests = new Map(frames.map((frame) => [frame.day, [] as string[]]));
  const free = (frame: DayFrame) => frame.available - dayLoad(frame, placed.get(frame.day)!, input.travel);
  for (const visit of input.visits.filter((item) => item.day || item.role === "fixed")) {
    placed.get(visit.day ?? 1)?.push(visit);
  }
  const loose = input.visits.filter((item) => !item.day && item.role !== "fixed")
    .sort((a, b) => Number(b.role === "required") - Number(a.role === "required") || (b.floor ?? b.stayMinutes) - (a.floor ?? a.stayMinutes));
  for (const visit of loose) {
    const near = (frame: DayFrame) => nearness(frame, visit.place, input.travel);
    const best = Math.min(...frames.map(near));
    // 差不多近（相差半小时内）的几天里，选空余多的。
    const order = [...frames].sort((a, b) =>
      (near(a) - best <= 30 ? 0 : near(a)) - (near(b) - best <= 30 ? 0 : near(b)) || free(b) - free(a));
    const target = order.find((frame) => near(frame) <= MAX_ONE_WAY_MINUTES && dayFits(frame, [...placed.get(frame.day)!, visit], input.travel)) ??
      (visit.role === "required" ? order[0] : undefined);
    if (target) placed.get(target.day)!.push(visit);
  }
  for (const interest of input.interests) {
    // 有时段的只放进时间对得上的天（每天都要的也只放这些天）；哪天都对不上时照旧放，生成时照实说放不下。
    const fitting = frames.filter((frame) => interestFits(frame, interest));
    if (interest.perDay) {
      for (const frame of fitting.length ? fitting : frames) interests.get(frame.day)!.push(interest.id);
      continue;
    }
    const inCity = frames.filter((frame) => !interest.city || frame.cities.includes(interest.city));
    const pool = interest.day ? frames.filter((frame) => frame.day === interest.day)
      : [inCity.filter((frame) => fitting.includes(frame)), inCity, frames].find((list) => list.length)!;
    const target = [...pool].sort((a, b) =>
      (free(b) - interests.get(b.day)!.length * 60) - (free(a) - interests.get(a.day)!.length * 60))[0];
    interests.get(target.day)!.push(interest.id);
  }
  return fillEmptyDays(input, frames, {
    days: frames.map((frame) => ({
      day: frame.day,
      visits: placed.get(frame.day)!.map((visit) => visit.key),
      interests: interests.get(frame.day)!,
    })),
  });
}

/**
 * 补空天（可用 2 小时以上却什么都没有）：从有两项以上的天挪过来一项，先挪兴趣（时间对得上的），再挪地点
 * （没固定在那天、不太远、挪过来装得下的）。规则分配最后做一次；模型的分配也先这样补，不为空着的一天打回
 * （验收复测：模型把要赶车的最后一天留空，被打回后退回规则，规则又把晚上的火锅放到了那天）。
 */
export function fillEmptyDays(input: OutingPlanInput, frames: readonly DayFrame[], allocation: Allocation): Allocation {
  const days = allocation.days.map((entry) => ({ ...entry, visits: [...entry.visits], interests: [...entry.interests] }));
  const entryOf = (day: number) => days.find((entry) => entry.day === day);
  const visitOf = (key: string) => input.visits.find((visit) => visit.key === key);
  for (const frame of frames) {
    const empty = entryOf(frame.day);
    if (!empty || frame.available < EMPTY_DAY_MINUTES || empty.visits.length || empty.interests.length) continue;
    const donors = days.filter((entry) => entry.day !== frame.day && itemCount(input, entry) > 1)
      .sort((a, b) => itemCount(input, b) - itemCount(input, a));
    const interest = donors.flatMap((donor) => donor.interests.map((id) => ({ donor, id }))).find(({ id }) => {
      const item = input.interests.find((entry) => entry.id === id);
      return !!item && !item.perDay && !item.day && (!item.city || frame.cities.includes(item.city)) && interestFits(frame, item);
    });
    if (interest) {
      interest.donor.interests = interest.donor.interests.filter((id) => id !== interest.id);
      empty.interests.push(interest.id);
      continue;
    }
    for (const donor of donors) {
      const key = [...donor.visits].reverse().find((item) => {
        const visit = visitOf(item);
        return !!visit && !visit.day && visit.role !== "fixed" &&
          nearness(frame, visit.place, input.travel) <= MAX_ONE_WAY_MINUTES && dayFits(frame, [visit], input.travel);
      });
      if (!key) continue;
      donor.visits = donor.visits.filter((item) => item !== key);
      empty.visits.push(key);
      break;
    }
  }
  return { days };
}

/** 一天安排了几项：地点和不是每天都有的兴趣（每天都要的兴趣不让一天算“有两项、可以挪出来”）。 */
function itemCount(input: OutingPlanInput, entry: Allocation["days"][number]): number {
  return entry.visits.length + entry.interests.filter((id) => !input.interests.find((item) => item.id === id)?.perDay).length;
}

/**
 * 模型的分配先由代码整理再检查（验收复测第 3 条）：有时段的兴趣从时间对不上的天拿掉（模型常把“晚上吃火锅”
 * 放进每一天，包括 18:00 就到车站的那天），再补空天。哪天都对不上的兴趣不动，交给检查。
 */
export function settleAllocation(input: OutingPlanInput, frames: readonly DayFrame[], allocation: Allocation): Allocation {
  const fits = (day: number, id: string) => {
    const interest = input.interests.find((item) => item.id === id);
    const frame = frames.find((item) => item.day === day);
    return !interest || !frame || !frames.some((item) => interestFits(item, interest)) || interestFits(frame, interest);
  };
  const days = allocation.days.map((entry) => ({ ...entry, interests: entry.interests.filter((id) => fits(entry.day, id)) }));
  return fillEmptyDays(input, frames, { days });
}

/**
 * 检查一份分配（§3.6 第 4 条）。返回问题：给模型的是英文短句（language "en"），给卡片的是中文；空数组是通过。
 */
export function checkAllocation(
  input: OutingPlanInput,
  frames: readonly DayFrame[],
  allocation: Allocation,
  language: "en" | "zh" = "en",
): string[] {
  const problems: string[] = [];
  const say = (en: string, zh: string) => problems.push(language === "en" ? en : zh);
  const name = (key: string) => input.visits.find((visit) => visit.key === key)?.place.place.name ?? key;
  const label = (id: string) => input.interests.find((item) => item.id === id)?.text ?? id;
  const days = new Map(allocation.days.map((entry) => [entry.day, entry]));
  if (allocation.days.some((entry) => !frames.some((frame) => frame.day === entry.day)) || new Set(allocation.days.map((entry) => entry.day)).size !== allocation.days.length) {
    say("days: each day of the trip once, numbered from 1", "天数对不上");
  }
  const visitKeys = new Set(input.visits.map((visit) => visit.key));
  const interestIds = new Set(input.interests.map((item) => item.id));
  const where = new Map<string, number[]>();
  for (const entry of allocation.days) {
    for (const key of entry.visits) {
      if (!visitKeys.has(key)) say(`unknown_visit ${key}`, "有不在卡片上的地点");
      where.set(key, [...(where.get(key) ?? []), entry.day]);
    }
    for (const id of entry.interests) if (!interestIds.has(id)) say(`unknown_interest ${id}`, "有不在卡片上的兴趣");
  }
  for (const visit of input.visits) {
    const at = where.get(visit.key) ?? [];
    if (at.length > 1) say(`${visit.key} is on days ${at.join(",")}: put it on one day`, `${name(visit.key)}出现在了好几天`);
    if (visit.role !== "optional" && !at.length) {
      say(`${visit.key} (${visit.place.place.name}) is missing: every required place goes on one day`, `${name(visit.key)}没有分到哪一天`);
    }
    if (visit.day && at.length && at[0] !== visit.day) say(`${visit.key} must stay on day ${visit.day}`, `${name(visit.key)}要在第 ${visit.day} 天`);
  }
  for (const frame of frames) {
    const entry = days.get(frame.day);
    const visits = (entry?.visits ?? []).flatMap((key) => input.visits.filter((visit) => visit.key === key));
    for (const [index, part] of dayParts(frame, visits, input.travel).entries()) {
      if (!part.load || part.load <= part.minutes) continue;
      const where = frame.parts.length > 1 ? ` (${index === 0 ? "before" : "after"} its ride)` : "";
      say(
        `day ${frame.day}${where} is too full: about ${part.load} of ${part.minutes} minutes`,
        `第 ${frame.day} 天${frame.parts.length > 1 ? (index === 0 ? "坐车前" : "到站后") : ""}排得太满（约需 ${part.load} 分钟，只有 ${part.minutes} 分钟）`,
      );
    }
    for (const visit of visits) {
      const far = nearness(frame, visit.place, input.travel);
      if (far > MAX_ONE_WAY_MINUTES) {
        say(
          `${visit.key} is about ${far} minutes from where day ${frame.day} starts or ends: most of the day on the road`,
          `${name(visit.key)}离第 ${frame.day} 天的住处或车站单程约 ${far} 分钟，大半天在路上`,
        );
      }
    }
    // 空着的一天：可用 2 小时以上、而别的天有两项以上、其中有能挪过来的（没固定在那天、挪过来装得下）时才算。
    const movable = (other: Allocation["days"][number]) =>
      other.interests.some((id) => {
        const interest = input.interests.find((item) => item.id === id);
        return !!interest && !interest.perDay && !interest.day && (!interest.city || frame.cities.includes(interest.city));
      }) ||
      other.visits.some((key) => {
        const visit = input.visits.find((item) => item.key === key);
        return !!visit && !visit.day && visit.role !== "fixed" &&
          nearness(frame, visit.place, input.travel) <= MAX_ONE_WAY_MINUTES && dayFits(frame, [visit], input.travel);
      });
    const crowded = allocation.days.find((other) => other.day !== frame.day && itemCount(input, other) > 1 && movable(other));
    if (!visits.length && !(entry?.interests.length) && frame.available >= EMPTY_DAY_MINUTES && crowded) {
      say(
        `day ${frame.day} is empty while day ${crowded.day} has ${itemCount(input, crowded)}: move one of them to day ${frame.day}`,
        `第 ${frame.day} 天空着，第 ${crowded.day} 天有 ${itemCount(input, crowded)} 项`,
      );
    }
  }
  for (const interest of input.interests) {
    const on = allocation.days.filter((entry) => entry.interests.includes(interest.id)).map((entry) => entry.day);
    // 有时段的兴趣只看时间对得上的天（都对不上时不管时段）。
    const fitting = frames.filter((frame) => interestFits(frame, interest)).map((frame) => frame.day);
    const days = fitting.length ? fitting : frames.map((frame) => frame.day);
    const slot = interest.when ? ` (${interest.when})` : "";
    if (interest.perDay && days.some((day) => !on.includes(day))) {
      say(`${interest.id}${slot} is for every day its time fits: days ${days.join(",")}`, `“${label(interest.id)}”是每天都要的`);
    }
    if (!interest.perDay && on.length !== 1) {
      say(
        `${interest.id}${slot} goes on exactly one day${on.length ? ` (now on days ${on.join(",")})` : ""}; its time fits days ${days.join(",")}`,
        `“${label(interest.id)}”要放在某一天`,
      );
    }
    const misfit = on.filter((day) => !days.includes(day));
    if (misfit.length) {
      const frame = frames.find((item) => item.day === misfit[0])!;
      say(
        `${interest.id}${slot} does not fit day ${misfit[0]} (${clock(frame.startsAt)}–${clock(frame.endsAt)}); its time fits days ${days.join(",")}`,
        `“${label(interest.id)}”的时间第 ${misfit[0]} 天排不上（${clock(frame.startsAt)}–${clock(frame.endsAt)}）`,
      );
    }
    if (interest.day && !on.includes(interest.day)) say(`${interest.id} must stay on day ${interest.day}`, `“${label(interest.id)}”要在第 ${interest.day} 天`);
    if (interest.city && on.some((day) => !frames.find((frame) => frame.day === day)?.cities.includes(interest.city!))) {
      say(`${interest.id} is only for its city: put it on a day in that city`, `“${label(interest.id)}”只在它的城市找，那天不在那个城市`);
    }
  }
  return problems;
}
