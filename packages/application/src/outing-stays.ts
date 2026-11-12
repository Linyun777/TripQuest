import type { RideMode, RideStation } from "./outing-rides";
import {
  DRAFT_LIMITS,
  outingDays,
  requirementsDraftSchema,
  type DraftPlace,
  type OutingDraft,
  type OutingTransport,
  type RequirementsDraft,
} from "./conversation";

/**
 * V4.3 多城出游的“住在哪”（stages/V4.3.md §3.2–3.4）：由代码从用户原话认“去 / 在 / 到 X 住几晚”，城市由调用方用城市解析
 * 确认（查不到的那几晚空着，不编）；交通的日子和住宿对不上时，没给时刻的车挪到对的天（暂定），给了时刻的只提示。
 * 这里只算，不查地图；不改提示词。
 */

export type Stay = NonNullable<OutingDraft["stays"]>[number];
export interface StayPhrase {
  /** 原话里的地名（还没确认是不是城市）。 */
  readonly name: string;
  readonly count: number;
}

/**
 * 原话里按先后的一站：住几晚（“玩一天”“当天回”这类不住的是 0；“坐高铁去海澄玩两天”这类住几晚看不出来是 null），
 * 用户说了坐什么去（高铁 / 飞机）。back 是“再坐高铁回杭州”这类回程。
 */
export interface TripStop {
  readonly name: string;
  readonly nights: number | null;
  readonly mode?: RideMode;
}
export interface TripWords {
  readonly stops: readonly TripStop[];
  readonly back?: { readonly name: string; readonly mode: RideMode };
}

const COUNT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
/**
 * “去海澄住一晚”“第二天到松州住两天”“在海澄住两晚”“去海澄玩两天住一晚”。“住 N 天”按 N 晚算；“待两天”不认
 * （待几天说的是白天，晚数看不出来）。
 */
const PHRASE = /(?:去|在|到)([\u4e00-\u9fa5]{2,6}?)(?:玩[一二两三四五六七\d]?[天晚]?)?(?:住|待)(?:上)?([一二两三四五六七1-7])个?(晚|夜|天)/g;
/** V4.4：“第一晚住松州”——第几晚住哪，按一晚算（晚数和日期对不上时要算得出来，stages/V4.4.md §3.2）。 */
const ORDINAL = /第([一二两三四五六七1-7])(?:晚|夜)(?:先)?(?:住|待)(?:在)?([\u4e00-\u9fa5]{2,6}?)(?=[，。,；;\s的]|然后|再|$)/g;
const LODGING_NAME = /酒店|宾馆|客栈|民宿|饭店|公寓|青旅|旅馆|旅舍|山庄|度假村|山居/;
/** V4.3 验收前（用户 2026-11-04“改”）：“坐高铁去上海”“坐飞机到鹭屿”“再坐高铁回杭州”——说了方式的一段。 */
const RIDE = /(?:坐|乘|搭)(高铁|动车|火车|城际|飞机)[^，。,；;\s]{0,3}?(去|到|回)([\u4e00-\u9fa5]{2,6}?)(?=玩|住|待|看|逛|吃|再|然后|，|。|,|；|;|\s|$)/g;
/** 不住的一站：后面跟着“玩一天”“当天”“再坐……”。 */
const DAY_ONLY = /^(?:玩)?(?:一|1)天|^当天|^再(?:坐|乘|搭)/;
/** 先后看不出来的说法（“各住两晚”“住海澄还是松州”）：整句不认。 */
const UNCLEAR = /各住|或者|还是/;
const MODE = (word: string): RideMode => (word === "飞机" ? "flight" : "train");

/** 一句话里按先后的几站和回程；说法看不出先后时为 null。 */
export function tripWords(text: string): TripWords | null {
  const stays = [...text.matchAll(PHRASE)].flatMap((match) => {
    if (match[3] === "天" && match[0].includes("待")) return [];
    const count = COUNT[match[2]!] ?? Number(match[2]);
    return Number.isInteger(count) && count > 0 ? [{ index: match.index!, name: match[1]!, nights: count as number | null, mode: undefined as RideMode | undefined }] : [];
  });
  for (const match of text.matchAll(ORDINAL)) {
    // “第一晚住云岭山居酒店”说的是住处，不是城市（V2.11 的 O03）。
    if (stays.some((item) => item.index === match.index) || LODGING_NAME.test(match[2]!)) continue;
    stays.push({ index: match.index!, name: match[2]!, nights: 1, mode: undefined });
  }
  stays.sort((a, b) => a.index - b.index);
  if (stays.length && UNCLEAR.test(text)) return null;
  let back: TripWords["back"];
  const stops = [...stays];
  for (const match of text.matchAll(RIDE)) {
    const mode = MODE(match[1]!);
    const name = match[3]!;
    if (match[2] === "回") {
      back = { name, mode };
      continue;
    }
    // 同一站又说了住几晚（“坐高铁去海澄住两晚”）：记上方式，不另算一站。
    const same = stays.find((item) => item.name === name && item.index >= match.index! && item.index - match.index! <= 20);
    if (same) {
      same.mode = mode;
      continue;
    }
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 6);
    stops.push({ index: match.index!, name, nights: DAY_ONLY.test(after) ? 0 : null, mode });
  }
  stops.sort((a, b) => a.index - b.index);
  return { stops: stops.map(({ name, nights, mode }) => ({ name, nights, ...(mode ? { mode } : {}) })), ...(back ? { back } : {}) };
}

/**
 * 一句话里按先后认出的“住在哪”；说法看不出先后时为 null，没有这种说法时为空。住几晚看不出来的那一站之后的不算
 * （后面的从第几晚开始就不知道了）。
 */
export function stayPhrases(text: string): StayPhrase[] | null {
  const words = tripWords(text);
  if (!words) return null;
  const known = words.stops.findIndex((stop) => stop.nights === null);
  return (known < 0 ? words.stops : words.stops.slice(0, known))
    .flatMap((stop) => (stop.nights ? [{ name: stop.name, count: stop.nights }] : []));
}

/** V4.4 §3.3：这句话里一共住几晚（每站都看得出住几晚时；不住的一站算 0），看不出来或一晚都没有为 null。 */
export function tripNights(words: TripWords): number | null {
  if (!words.stops.length || words.stops.some((stop) => stop.nights === null)) return null;
  const total = words.stops.reduce((sum, stop) => sum + stop.nights!, 0);
  return total > 0 ? total : null;
}

/**
 * 认哪一句：这一轮的话里有就认这一轮；这一轮没有时，只在这一轮才有了日期（之前不知道几晚）时认用户之前最近一句有这种
 * 说法的话（第一句说了住哪、第二句才给日期）。用户在卡片上删掉“住在哪”之后，不会因为旧话又加回来。
 */
export function stayText(userTexts: readonly string[], datesJustSet: boolean): string | null {
  const latest = userTexts.at(-1);
  if (latest !== undefined && stayPhrases(latest)?.length) return latest;
  if (!datesJustSet) return null;
  return [...userTexts].reverse().find((text) => !!stayPhrases(text)?.length) ?? null;
}

/**
 * 按先后从第 1 晚往后排（§3.2）。cities 是每个地名确认后的城市（查不到为 null，那几晚空着）。晚数加起来超过这趟的晚数、
 * 没有日期（不知道几晚）、一个城市都没认出来的，返回 null（不认）。同一个城市相邻的几晚合成一行。
 */
export function buildStays(
  phrases: readonly StayPhrase[],
  cities: readonly ({ readonly adcode: string; readonly name: string } | null)[],
  nights: number,
): Stay[] | null {
  const total = phrases.reduce((sum, item) => sum + item.count, 0);
  if (!phrases.length || nights <= 0 || total > nights) return null;
  const stays: Stay[] = [];
  let night = 1;
  for (const [index, phrase] of phrases.entries()) {
    const covered = Array.from({ length: phrase.count }, (_, offset) => night + offset);
    night += phrase.count;
    const city = cities[index];
    if (!city) continue;
    const last = stays.at(-1);
    if (last && last.city.adcode === city.adcode && last.nights.at(-1) === covered[0]! - 1) {
      stays[stays.length - 1] = { ...last, nights: [...last.nights, ...covered] };
    } else {
      stays.push({ nights: covered, city: { adcode: city.adcode, name: city.name }, source: "said" });
    }
  }
  return stays.length ? stays : null;
}

/** 卡片上那一行和回复里的说法：“第 1 晚海澄 · 第 2–3 晚松州”。 */
export function staysLabel(stays: readonly Stay[], separator = " · "): string {
  return stays.map((item) => `第 ${nightsText(item.nights)} 晚${short(item.city.name)}`).join(separator);
}

const short = (name: string) => name.replace(/市$/, "");
const nightsText = (nights: readonly number[]) =>
  nights.length > 1 && nights.at(-1)! - nights[0]! === nights.length - 1 ? `${nights[0]}–${nights.at(-1)}` : nights.join("、");

const cityOf = (place: DraftPlace | null | undefined): string | null => {
  if (place?.status === "bound") return place.city ?? null;
  if (place?.status !== "choose") return null;
  const cities = new Set(place.choices.map((choice) => choice.city));
  return cities.size === 1 ? [...cities][0] ?? null : null;
};

/** 每晚按“住在哪”在哪个城市（没写的为 undefined）。 */
const stayCity = (outing: OutingDraft, night: number) => outing.stays?.find((item) => item.nights.includes(night))?.city;

/**
 * 一趟车按“住在哪”应在第几天（§3.4）：离开城市 X 的车在住 X 的最后一晚的第二天（用户说了在 X 住几晚，再下一晚就不在 X，
 * 哪怕那晚住哪没写——O04 实测：五天的卡片上只写了第 2–3 晚住苏州，苏州 → 上海的车记在第 3 天）；到达城市 Y 的车在住 Y
 * 的第一晚那天。离开和到达算出来的不一样、或超出这趟的天数时为 null。
 */
function rightDay(outing: OutingDraft, ride: OutingTransport): number | null {
  const days = outingDays(outing);
  const nights = Math.max(0, days - 1);
  const runNear = (city: string) => {
    const covered = Array.from({ length: nights }, (_, index) => index + 1).filter((night) => stayCity(outing, night)?.adcode === city);
    if (!covered.length) return null;
    // 同一个城市住了几段时，取离这趟车最近的那段。
    const runs: number[][] = [];
    for (const night of covered) {
      const run = runs.at(-1);
      if (run && run.at(-1) === night - 1) run.push(night);
      else runs.push([night]);
    }
    return runs.sort((a, b) => Math.abs(a.at(-1)! - ride.day) - Math.abs(b.at(-1)! - ride.day))[0]!;
  };
  const from = cityOf(ride.from);
  const to = cityOf(ride.to);
  const leaving = from ? runNear(from) : null;
  const arriving = to ? runNear(to) : null;
  const byLeaving = leaving && leaving.at(-1)! + 1 <= days ? leaving.at(-1)! + 1 : null;
  const byArriving = arriving ? arriving[0]! : null;
  if (byLeaving && byArriving && byLeaving !== byArriving) return null;
  return byLeaving ?? byArriving;
}

/** 用户给了时刻的车不挪（§3.4），过夜车也不挪。 */
const movable = (ride: OutingTransport) => ride.departAt === null && ride.arriveAt === null && ride.arriveDay !== "next";

export interface RideDayFix {
  readonly draft: RequirementsDraft;
  /** 挪了哪几趟：编号、原来第几天、挪到第几天、“A → B”。 */
  readonly moved: readonly { readonly id: string; readonly from: number; readonly to: number; readonly label: string }[];
}

/**
 * 没给时刻的车，日子和“住在哪”对不上时挪到对的天，标“日子暂定”（suggested.day）。卡片上没有“住在哪”时原样返回。
 * 挪了就作废分到各天（同卡片改了交通）。
 */
export function fixRideDays(draft: RequirementsDraft): RideDayFix {
  const outing = draft.mode === "outing" ? draft.outing : undefined;
  if (!outing?.stays?.length) return { draft, moved: [] };
  const next: RequirementsDraft = structuredClone(draft);
  const moved: { id: string; from: number; to: number; label: string }[] = [];
  for (const ride of next.outing!.transports) {
    if (!movable(ride)) continue;
    const day = rightDay(next.outing!, ride);
    if (!day || day === ride.day) continue;
    moved.push({ id: ride.id, from: ride.day, to: day, label: rideLabel(ride) });
    ride.day = day;
    ride.suggested = { ...ride.suggested, day: true };
  }
  if (!moved.length) return { draft, moved };
  next.outing!.transports.sort((a, b) => a.day - b.day || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  delete next.outing!.allocation;
  return { draft: requirementsDraftSchema.parse(next), moved };
}

const rideLabel = (ride: OutingTransport) => {
  const name = (place: DraftPlace | null) => (place?.status === "bound" ? place.name : "车站待定");
  return `${name(ride.from)} → ${name(ride.to)}`;
};

/** 给了时刻的车和“住在哪”对不上（§3.4）：卡片上提示一行，不挪。 */
export function stayHints(draft: RequirementsDraft): string[] {
  const outing = draft.mode === "outing" ? draft.outing : undefined;
  if (!outing?.stays?.length) return [];
  return outing.transports.flatMap((ride) => {
    if (movable(ride) || ride.arriveDay === "next") return [];
    const day = rightDay(outing, ride);
    if (!day || day === ride.day) return [];
    const from = cityOf(ride.from);
    const night = from && stayCity(outing, ride.day)?.adcode === from ? ride.day : day - 1;
    const city = stayCity(outing, night);
    return city ? [`第 ${ride.day} 天的车和第 ${night} 晚住${short(city.name)}对不上`] : [];
  });
}

/** 回复后面由代码加的那句（§3.2、§3.4）。 */
export function stayNote(stays: readonly Stay[] | null, moved: RideDayFix["moved"]): string | null {
  const parts: string[] = [];
  if (stays?.length) parts.push(`住宿按${staysLabel(stays, "、")}记在卡片上，可改。`);
  for (const item of moved) parts.push(`${item.label}按住宿放到第 ${item.to} 天，可改。`);
  return parts.length ? parts.join("") : null;
}

type City = { readonly adcode: string; readonly name: string };

/** 用户说了坐什么去的一段（V4.3 验收前加）：第几天、方式、从哪个城市到哪个城市（城市编码和名称）。 */
export interface SaidLeg {
  readonly day: number;
  readonly mode: RideMode;
  readonly from: City;
  readonly to: City;
}

/**
 * 多城出游（说了在某处住几晚、又不止一站）里，用户说了方式的几段：进第 i 站在“前面几站住的晚数之和 + 1”那天，回程在
 * “全部晚数 + 1”那天。前一站或这一站的城市没确认、住几晚看不出来的那一站之后，都不算。第一站从 origin 出发。
 */
export function saidLegs(words: TripWords, cities: ReadonlyMap<string, City | null>, origin: City | null): SaidLeg[] {
  const stops = words.stops;
  if (stops.length < 2 || !stops.some((stop) => stop.nights)) return [];
  const legs: SaidLeg[] = [];
  let previous = origin;
  let day = 1;
  for (const stop of stops) {
    const city = cities.get(stop.name) ?? null;
    if (stop.mode && previous && city && previous.adcode !== city.adcode) legs.push({ day, mode: stop.mode, from: previous, to: city });
    if (stop.nights === null) return legs;
    day += stop.nights;
    previous = city;
  }
  const home = words.back ? cities.get(words.back.name) ?? null : null;
  if (words.back && previous && home && previous.adcode !== home.adcode) legs.push({ day, mode: words.back.mode, from: previous, to: home });
  return legs;
}

/** 这一段卡片上已经有了没有：两端城市都对得上的车（哪天都算，日子另由 fixRideDays 管）。 */
const covers = (ride: OutingTransport, leg: SaidLeg) => cityOf(ride.from) === leg.from.adcode && cityOf(ride.to) === leg.to.adcode;
/** 能补成这一段的车：同一天、同方式，一端对得上，另一端空着或是代码暂定的别的城市的站。 */
const fillable = (ride: OutingTransport, leg: SaidLeg) => {
  if (ride.day !== leg.day || ride.mode !== leg.mode || ride.departAt || ride.arriveAt) return null;
  const open = (end: "from" | "to") => !ride[end] || (!!ride.suggested?.[end] && cityOf(ride[end]) !== leg[end].adcode);
  if (cityOf(ride.to) === leg.to.adcode && open("from")) return "from" as const;
  if (cityOf(ride.from) === leg.from.adcode && open("to")) return "to" as const;
  return null;
};

/** 每一段要不要补：已有就不补；能补成它的车补那一端；都没有就加一趟。要搜车站的城市在 needs 里（“方式@城市”）。 */
export function legNeeds(draft: RequirementsDraft, legs: readonly SaidLeg[]): string[] {
  const rides = draft.mode === "outing" ? draft.outing?.transports ?? [] : [];
  return [...new Set(legs.flatMap((leg) => {
    if (rides.some((ride) => covers(ride, leg))) return [];
    const ride = rides.find((item) => fillable(item, leg));
    const end = ride ? fillable(ride, leg) : null;
    return end ? [`${leg.mode}@${leg[end].adcode}`] : [`${leg.mode}@${leg.from.adcode}`, `${leg.mode}@${leg.to.adcode}`];
  }))];
}

/**
 * 按搜到的车站补卡片：能补成这一段的车补那一端（标暂定），没有就加一趟（两端都搜到才加，标代码补的）。用户给的车站和
 * 时刻不动。added 给回复后面那句用。
 */
export function applySaidLegs(
  draft: RequirementsDraft,
  legs: readonly SaidLeg[],
  found: ReadonlyMap<string, readonly RideStation[]>,
): { readonly draft: RequirementsDraft; readonly added: readonly { readonly day: number; readonly mode: RideMode; readonly from: string; readonly to: string }[] } {
  if (draft.mode !== "outing" || !draft.outing || !legs.length) return { draft, added: [] };
  const next: RequirementsDraft = structuredClone(draft);
  const outing = next.outing!;
  const added: { day: number; mode: RideMode; from: string; to: string }[] = [];
  const station = (mode: RideMode, city: string) => found.get(`${mode}@${city}`) ?? [];
  const place = (item: RideStation): DraftPlace => ({ status: "bound", externalId: item.externalId, name: item.name, city: item.city });
  const others = (list: readonly RideStation[]) => list.slice(1, 3).map((item) => ({ externalId: item.externalId, name: item.name, city: item.city }));
  for (const leg of legs) {
    if (outing.transports.some((ride) => covers(ride, leg))) continue;
    const ride = outing.transports.find((item) => fillable(item, leg));
    const end = ride ? fillable(ride, leg) : null;
    if (ride && end) {
      const list = station(leg.mode, leg[end].adcode);
      if (!list.length) continue;
      ride[end] = place(list[0]!);
      ride.suggested = { ...ride.suggested, [end]: { others: others(list) } };
      added.push({ day: ride.day, mode: leg.mode, from: ride.from?.status === "bound" ? ride.from.name : "", to: ride.to?.status === "bound" ? ride.to.name : "" });
      continue;
    }
    const from = station(leg.mode, leg.from.adcode);
    const to = station(leg.mode, leg.to.adcode);
    if (!from.length || !to.length || outing.transports.length >= DRAFT_LIMITS.transports) continue;
    outing.transports.push({
      id: `t${outing.transports.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0) + 1}`,
      day: leg.day,
      mode: leg.mode,
      from: place(from[0]!),
      to: place(to[0]!),
      departAt: null,
      arriveAt: null,
      arriveDay: "same",
      suggested: { ride: true, from: { others: others(from) }, to: { others: others(to) } },
    });
    added.push({ day: leg.day, mode: leg.mode, from: from[0]!.name, to: to[0]!.name });
  }
  if (!added.length) return { draft, added };
  outing.transports.sort((a, b) => a.day - b.day || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  delete outing.allocation;
  return { draft: requirementsDraftSchema.parse(next), added };
}

/** 回复后面那句：“坐高铁的第 4 天 苏州站 → 上海站先记上了，车次没定，可改。” */
export function legNote(added: readonly { readonly day: number; readonly mode: RideMode; readonly from: string; readonly to: string }[]): string | null {
  if (!added.length) return null;
  const word = (mode: RideMode) => (mode === "flight" ? "飞机" : "高铁");
  return `${added.map((item) => `坐${word(item.mode)}的第 ${item.day} 天 ${item.from} → ${item.to}`).join("、")}先记上了，车次没定，可改。`;
}
