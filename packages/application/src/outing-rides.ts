import {
  DRAFT_LIMITS,
  outingDays,
  requirementsDraftSchema,
  type DraftPlace,
  type OutingTransport,
  type RequirementsDraft,
} from "./conversation";

/**
 * V3.6 对话记录交通（stages/V3.6.md §3.1–3.3）：对话没把车站和往返记全时由代码补，不靠提示词。先从卡片算出行程骨架
 * （从哪个城市出发、依次去哪几个城市、最后回哪），再按骨架定：哪一趟的哪一端空着、在哪个城市找车站；说了坐高铁 / 飞机
 * 却一趟没记的、往返只记了去程的，补哪几趟。这里只算，不查地图；车站由调用方按城市搜好再交给 applyRides。
 * 补上的都标“暂定”（suggested），用户改了哪部分哪部分就是用户的；用户给的车站、时间和方式一律不动。
 */

export type RideMode = "train" | "flight";

export interface RideSkeleton {
  /** 出发城市（城市编码）：起点所在的城市，没有起点时用定位得到的城市。 */
  readonly origin: string | null;
  /** 去的外地城市；ordered 为 false 时几个城市的先后定不下来。 */
  readonly stops: readonly string[];
  readonly ordered: boolean;
  /** 最后回到哪个城市：终点所在的城市，终点空着就是出发城市。 */
  readonly back: string | null;
  /** 卡片上已有交通的方式；没有时是用户原话里说的。 */
  readonly mode: RideMode | null;
  /** 用户这次对话里说了坐高铁还是飞机（原话；两种都说了为 null）。 */
  readonly said: RideMode | null;
  /** 出行方式里有自驾，或用户说了开车：不补交通。 */
  readonly driving: boolean;
  /** 依次要坐的几段（城市编码对）；骨架定不下来时为空。 */
  readonly legs: readonly (readonly [string, string])[];
}

/** 一个车站或机场：只有编号、名称和城市（D-045 / D-046）。 */
export interface RideStation {
  readonly externalId: string;
  readonly name: string;
  readonly city: string;
}

/** 要补的一端：已有交通的 id（新补的那趟是 new0、new1），在哪个城市、什么方式；preset 是卡片起终点本身就是这个城市的车站。 */
export interface StationNeed {
  readonly ride: string;
  readonly end: "from" | "to";
  readonly city: string;
  readonly mode: RideMode;
  readonly preset?: RideStation;
}

export interface RideAdd {
  readonly id: string;
  readonly day: number;
  readonly mode: RideMode;
  readonly kind: "out" | "back";
  readonly from: string;
  readonly to: string;
  /** 照另一趟的方式补的（往返只记了一趟）。 */
  readonly same?: true;
}

export interface RidePlan {
  readonly skeleton: RideSkeleton;
  readonly needs: readonly StationNeed[];
  readonly adds: readonly RideAdd[];
}

const TRAIN_WORDS = /高铁|动车|火车|城际/;
const FLIGHT_WORDS = /飞机|航班|机票|机场|飞(?=[去往到回过])|从[^，。,\s]{1,6}飞/;
const NEGATED = /(?:不|别|不想|不要|不用|不坐)(?:坐|乘|搭)?(?:高铁|动车|火车|飞机)/g;
const DRIVING_WORDS = /开车|自驾|驾车/;

const cityOf = (place: DraftPlace | null | undefined): string | null => (place?.status === "bound" ? place.city ?? null : null);
/** 这一端在哪个城市：已绑定的看它的城市，等用户选的候选都在同一个城市时也算。 */
const endCity = (place: DraftPlace | null | undefined): string | null => {
  if (place?.status === "bound") return place.city ?? null;
  if (place?.status !== "choose") return null;
  const cities = new Set(place.choices.map((choice) => choice.city));
  return cities.size === 1 ? [...cities][0] ?? null : null;
};
const isRide = (item: OutingTransport): item is OutingTransport & { mode: RideMode } => item.mode === "train" || item.mode === "flight";
const sameLeg = (left: readonly [string, string] | null, right: readonly [string, string] | undefined) =>
  !!left && !!right && left[0] === right[0] && left[1] === right[1];

/** 用户原话里说的方式；“不坐飞机”这类否定的不算，两种都说了定不下来。 */
export function saidMode(texts: readonly string[]): RideMode | null {
  const text = texts.join("\n").replace(NEGATED, "");
  const train = TRAIN_WORDS.test(text);
  const flight = FLIGHT_WORDS.test(text);
  return train === flight ? null : train ? "train" : "flight";
}

/** 行程骨架（§3.1）。只在出游卡片上算；userTexts 是这段对话里用户说过的话。 */
export function rideSkeleton(draft: RequirementsDraft, userTexts: readonly string[]): RideSkeleton | null {
  const outing = draft.mode === "outing" ? draft.outing : undefined;
  if (!outing) return null;
  const startUnbound = draft.start?.status !== "bound";
  const origin = cityOf(draft.start) ?? (startUnbound && draft.city?.source === "located" ? draft.city.adcode : null);
  const back = draft.end === null ? origin
    : draft.end.status === "bound" ? draft.end.city ?? null
      : draft.end.status === "current" ? origin
        : null;
  // 外地城市的线索和它出现在第几天（不知道是哪天的为 null）；出发城市和回到的城市不算。
  const clues: { city: string; key: number | null }[] = [];
  const clue = (city: string | null | undefined, key: number | null) => {
    if (city && city !== origin && city !== back) clues.push({ city, key });
  };
  for (const item of outing.transports) {
    clue(endCity(item.to), item.day);
    clue(endCity(item.from), item.day - 0.5);
  }
  for (const visit of draft.visits) clue(cityOf(visit.place), visit.day ?? null);
  for (const item of draft.interests) clue(item.city?.adcode, item.day ?? null);
  for (const night of outing.lodging) clue(cityOf(night.place), night.night);
  // V4.3：“住在哪”的城市也是去的城市，先后按住进去的那一晚（stages/V4.3.md §3.3）。
  for (const stay of outing.stays ?? []) clue(stay.city.adcode, stay.nights[0]!);
  if (draft.city && draft.city.source !== "located") clue(draft.city.adcode, null);
  const cities = [...new Set(clues.map((item) => item.city))];
  const firstDay = (city: string) => {
    const keys = clues.filter((item) => item.city === city && item.key !== null).map((item) => item.key!);
    return keys.length ? Math.min(...keys) : null;
  };
  const days = cities.map(firstDay);
  const ordered = cities.length <= 1 ||
    (days.every((day) => day !== null) && new Set(days).size === days.length);
  const stops = ordered ? [...cities].sort((a, b) => (firstDay(a) ?? 0) - (firstDay(b) ?? 0)) : cities;
  const modes = new Set(outing.transports.filter(isRide).map((item) => item.mode));
  const said = saidMode(userTexts);
  const mode = modes.size === 1 ? [...modes][0]! : modes.size ? null : said;
  const driving = !!draft.travel?.allowed.includes("driving") || DRIVING_WORDS.test(userTexts.join("\n"));
  const legs: [string, string][] = [];
  if (origin && back && ordered) {
    const path = [origin, ...stops, back].filter((city, index, all) => index === 0 || city !== all[index - 1]);
    for (let index = 1; index < path.length; index += 1) legs.push([path[index - 1]!, path[index]!]);
  }
  return { origin, stops, ordered, back, mode, said, driving, legs };
}

/** 交通按先后排（第几天、出发时刻、编号）。 */
function inOrder(transports: readonly OutingTransport[]): OutingTransport[] {
  return [...transports].sort((a, b) => a.day - b.day || (a.departAt ?? "").localeCompare(b.departAt ?? "") ||
    Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** 一趟交通在骨架里是哪一段（§3.2）：有一端知道城市就按它找；两端都空按位置（第一趟、最后一趟）。 */
function legOf(
  ride: OutingTransport,
  index: number,
  rides: readonly OutingTransport[],
  legs: RideSkeleton["legs"],
  lastDay: number,
): readonly [string, string] | null {
  const from = endCity(ride.from);
  const to = endCity(ride.to);
  // 对上的那一段还要和这趟的日子相符：第一段不在多天行程的最后一天，中间的段不在第一天，最后一段在最后一天。
  // 模型把车站记反了（第 1 天“海澄站 → 空”）时按城市会对上后面的段，补出一趟看着完整其实是错的交通，宁可照旧空着。
  const fits = (leg: readonly [string, string]) => {
    const at = legs.indexOf(leg);
    if (legs.length < 2 || lastDay <= 1) return true;
    if (at === 0) return ride.day < lastDay;
    if (at === legs.length - 1) return ride.day === lastDay;
    return ride.day > 1;
  };
  const unique = (found: readonly (readonly [string, string])[]) => (found.length === 1 && fits(found[0]!) ? found[0]! : null);
  if (from && to) return unique(legs.filter((leg) => leg[0] === from && leg[1] === to));
  if (from) return unique(legs.filter((leg) => leg[0] === from));
  if (to) return unique(legs.filter((leg) => leg[1] === to));
  if (rides.length === legs.length) return legs[index] ?? null;
  if (index === 0 && ride.day === 1) return legs[0] ?? null;
  if (index === rides.length - 1 && legs.length > 1 && lastDay > 1 && ride.day === lastDay) return legs.at(-1)!;
  return null;
}

/**
 * 不用搜的情况：卡片上别的那趟同样方式的交通在这个城市已经有站（去程到松州东站，回程就从松州东站走），或者起点、终点
 * 本身就是这个城市的车站（“从杭州东站出发”）。
 */
function presetOf(draft: RequirementsDraft, need: Omit<StationNeed, "preset">): RideStation | undefined {
  const looks = (name: string) => (need.mode === "flight" ? /机场|航站楼/.test(name) : /站$/.test(name) && !/地铁|公交|索道|轻轨|客运/.test(name));
  const rides = draft.outing!.transports.filter((item) => item.mode === need.mode).flatMap((item) => [item.from, item.to]);
  const order = need.end === "to" ? [...rides, draft.end, draft.start] : [...rides, draft.start, draft.end];
  for (const place of order) {
    if (place?.status === "bound" && place.city === need.city && looks(place.name)) {
      return { externalId: place.externalId, name: place.name, city: place.city };
    }
  }
  return undefined;
}

/**
 * 要补什么（§3.2–3.3）：已有交通空着的一端（能算出城市的）；说了坐高铁 / 飞机却一趟没记的，补去程和回程；往返只记了
 * 去程的，补回程；只记了回程的，补去程。补交通只在只去一个外地城市（或直接去终点）时做，多城中间缺的段只提示（rideHints）。自驾不补交通。
 * stationsOnly：只补车站（开始规划前那一次，§3.5；那时没有回复能说明加了交通）。
 */
export function planRides(draft: RequirementsDraft, userTexts: readonly string[], options: { readonly stationsOnly?: boolean } = {}): RidePlan | null {
  const skeleton = rideSkeleton(draft, userTexts);
  if (!skeleton || !skeleton.legs.length) return null;
  const outing = draft.outing!;
  const lastDay = outingDays(outing);
  const rides = inOrder(outing.transports).filter(isRide);
  const needs: StationNeed[] = [];
  const need = (item: Omit<StationNeed, "preset">) => {
    const preset = presetOf(draft, item);
    needs.push({ ...item, ...(preset ? { preset } : {}) });
  };
  for (const [index, ride] of rides.entries()) {
    if (ride.from && ride.to) continue;
    const leg = legOf(ride, index, rides, skeleton.legs, lastDay);
    if (!leg) continue;
    if (!ride.from) need({ ride: ride.id, end: "from", city: leg[0], mode: ride.mode });
    if (!ride.to) need({ ride: ride.id, end: "to", city: leg[1], mode: ride.mode });
  }
  const adds: RideAdd[] = [];
  const simple = skeleton.stops.length <= 1 && !skeleton.driving && !options.stationsOnly;
  const room = DRAFT_LIMITS.transports - outing.transports.length;
  const add = (item: Omit<RideAdd, "id">) => {
    if (adds.length >= room) return;
    const id = `new${adds.length}`;
    adds.push({ ...item, id });
    need({ ride: id, end: "from", city: item.from, mode: item.mode });
    need({ ride: id, end: "to", city: item.to, mode: item.mode });
  };
  const first = skeleton.legs[0]!;
  const last = skeleton.legs.at(-1)!;
  const roundTrip = skeleton.legs.length > 1;
  if (simple && !rides.length && skeleton.said) {
    add({ day: 1, mode: skeleton.said, kind: "out", from: first[0], to: first[1] });
    if (roundTrip && lastDay) add({ day: lastDay, mode: skeleton.said, kind: "back", from: last[0], to: last[1] });
  } else if (simple && roundTrip && lastDay) {
    const outbound = rides.find((ride, index) => sameLeg(legOf(ride, index, rides, skeleton.legs, lastDay), first));
    const covered = rides.some((ride, index) => ride !== outbound &&
      (sameLeg(legOf(ride, index, rides, skeleton.legs, lastDay), last) || ride.day === lastDay));
    if (outbound && !covered) add({ day: lastDay, mode: outbound.mode, kind: "back", from: last[0], to: last[1], same: true });
    // 反过来，只记了回程（O06：“第二天晚上 6 点的高铁回杭州”记上了，第一天到南京没记），补去程。
    const inbound = rides.find((ride, index) => sameLeg(legOf(ride, index, rides, skeleton.legs, lastDay), last));
    const left = rides.some((ride, index) => ride !== inbound &&
      (sameLeg(legOf(ride, index, rides, skeleton.legs, lastDay), first) || ride.day === 1));
    if (inbound && !outbound && !left) add({ day: 1, mode: inbound.mode, kind: "out", from: first[0], to: first[1], same: true });
  }
  return needs.length ? { skeleton, needs, adds } : null;
}

/** 补了什么，给回复后面那句说明和运行记录用。 */
export interface RideFill {
  readonly draft: RequirementsDraft;
  readonly stations: readonly { readonly ride: string; readonly end: "from" | "to"; readonly city: string; readonly name: string; readonly found: number }[];
  readonly added: readonly {
    readonly day: number;
    readonly mode: RideMode;
    readonly kind: "out" | "back";
    readonly from: string;
    readonly to: string;
    readonly same?: true;
  }[];
  readonly note: string | null;
}

/**
 * 按搜到的车站补卡片（§3.2–3.3）。found 按“方式@城市”给按相关度排好的车站；第一个定为这一端，再留最多 2 个可换。
 * 一个都没有的照旧空着（新补的那趟两端都要有才补）。用户的东西不动：只填空着的一端，只加没有的那趟。
 */
export function applyRides(
  draft: RequirementsDraft,
  plan: RidePlan,
  found: ReadonlyMap<string, readonly RideStation[]>,
): RideFill {
  const next: RequirementsDraft = structuredClone(draft);
  const outing = next.outing!;
  const stations: { ride: string; end: "from" | "to"; city: string; name: string; found: number }[] = [];
  const pick = (item: StationNeed) => {
    if (item.preset) return { station: item.preset, others: [] as RideStation[], found: 1 };
    const list = found.get(`${item.mode}@${item.city}`) ?? [];
    return list.length ? { station: list[0]!, others: list.slice(1, 3), found: list.length } : null;
  };
  const place = (station: RideStation): DraftPlace => ({ status: "bound", externalId: station.externalId, name: station.name, city: station.city });
  const choices = (others: readonly RideStation[]) => others.map((item) => ({ externalId: item.externalId, name: item.name, city: item.city }));
  for (const item of plan.needs.filter((entry) => !entry.ride.startsWith("new"))) {
    const ride = outing.transports.find((entry) => entry.id === item.ride);
    const picked = pick(item);
    if (!ride || ride[item.end] || !picked) continue;
    ride[item.end] = place(picked.station);
    ride.suggested = { ...ride.suggested, [item.end]: { others: choices(picked.others) } };
    stations.push({ ride: ride.id, end: item.end, city: item.city, name: picked.station.name, found: picked.found });
  }
  const added: RideFill["added"][number][] = [];
  for (const item of plan.adds) {
    const from = plan.needs.find((entry) => entry.ride === item.id && entry.end === "from");
    const to = plan.needs.find((entry) => entry.ride === item.id && entry.end === "to");
    const picked = { from: from && pick(from), to: to && pick(to) };
    if (!picked.from || !picked.to) continue;
    const id = `t${outing.transports.reduce((max, entry) => Math.max(max, Number(entry.id.slice(1))), 0) + 1}`;
    outing.transports.push({
      id,
      day: item.day,
      mode: item.mode,
      from: place(picked.from.station),
      to: place(picked.to.station),
      departAt: null,
      arriveAt: null,
      arriveDay: "same",
      suggested: { ride: true, from: { others: choices(picked.from.others) }, to: { others: choices(picked.to.others) } },
    });
    added.push({
      day: item.day,
      mode: item.mode,
      kind: item.kind,
      from: picked.from.station.name,
      to: picked.to.station.name,
      ...(item.same ? { same: true as const } : {}),
    });
  }
  outing.transports.sort((a, b) => a.day - b.day || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  if (!stations.length && !added.length) return { draft, stations, added, note: null };
  return { draft: requirementsDraftSchema.parse(next), stations, added, note: rideNote(stations, added) };
}

const WORD: Record<RideMode, string> = { train: "高铁", flight: "飞机" };

/** 回复后面由代码加的那句（§3.4）：补了哪几趟、车站按哪个估计、可以改。 */
function rideNote(stations: RideFill["stations"], added: RideFill["added"]): string {
  const parts: string[] = [];
  const out = added.find((item) => item.kind === "out");
  const back = added.find((item) => item.kind === "back");
  if (out && back) {
    parts.push(`坐${WORD[out.mode]}的去程和回程先记上了（第 ${out.day} 天 ${out.from} → ${out.to}，第 ${back.day} 天 ${back.from} → ${back.to}），车次没定，卡片上可以改。`);
  } else if (out?.same) {
    parts.push(`去程按同样的方式估计（第 ${out.day} 天 ${out.from} → ${out.to}），可改。`);
  } else if (out) {
    parts.push(`坐${WORD[out.mode]}的去程先记上了（${out.from} → ${out.to}），车次没定，卡片上可以改。`);
  } else if (back) {
    parts.push(`回程按同样的方式估计（第 ${back.day} 天 ${back.from} → ${back.to}），可改。`);
  }
  const names = [...new Set(stations.map((item) => item.name))];
  if (names.length) parts.push(`车站先按${names.join("、")}估计，卡片上可以换。`);
  return parts.join("");
}

/**
 * 多城出游中间缺的段（§3.3 最后一条）：骨架能定下先后时，相邻两个城市之间没有交通、也不自驾的，在卡片上提示“A 到 B
 * 怎么去？”，不自动补、不挡住开始规划。卡片上只有城市编码，名字用卡片上知道的城市名，不知道就用那个城市里的一个地点名。
 */
export function rideHints(draft: RequirementsDraft): string[] {
  const skeleton = rideSkeleton(draft, []);
  if (!skeleton || skeleton.stops.length < 2 || skeleton.driving || !skeleton.legs.length) return [];
  const rides = draft.outing!.transports;
  const names = new Map<string, string>();
  for (const item of draft.interests) if (item.city) names.set(item.city.adcode, item.city.name.replace(/市$/, ""));
  for (const stay of draft.outing!.stays ?? []) names.set(stay.city.adcode, stay.city.name.replace(/市$/, ""));
  if (draft.city) names.set(draft.city.adcode, draft.city.name.replace(/市$/, ""));
  const places = [draft.start, draft.end, ...draft.visits.map((visit) => visit.place), ...draft.outing!.lodging.map((night) => night.place)];
  const nameOf = (city: string) => names.get(city) ??
    places.find((place): place is Extract<DraftPlace, { status: "bound" }> => place?.status === "bound" && place.city === city)?.name;
  return skeleton.legs.flatMap(([from, to]) => {
    if (rides.some((ride) => endCity(ride.from) === from && endCity(ride.to) === to)) return [];
    const a = nameOf(from);
    const b = nameOf(to);
    return a && b ? [`${a}到${b}怎么去？`] : [];
  });
}

/**
 * V3.6 验收反馈：开始规划（分到各天、按天生成）之前，还在等用户选的车站和住处先取第一个候选作暂定（source 是
 * suggested），其余最多 2 个留着“换一个”，不挡住开始规划。用户已经选过的、本来就绑定的不动。返回改过的卡片和
 * 取了哪些（第几天哪一端、第几晚），没有要取的原样返回。
 */
export function pickPendingChoices(draft: RequirementsDraft): { readonly draft: RequirementsDraft; readonly picked: readonly string[] } {
  const outing = draft.mode === "outing" ? draft.outing : undefined;
  if (!outing) return { draft, picked: [] };
  const pending = (place: DraftPlace | null): place is Extract<DraftPlace, { status: "choose" }> => place?.status === "choose";
  if (!outing.transports.some((item) => pending(item.from) || pending(item.to)) && !outing.lodging.some((night) => pending(night.place))) {
    return { draft, picked: [] };
  }
  const next: RequirementsDraft = structuredClone(draft);
  const picked: string[] = [];
  const first = (place: Extract<DraftPlace, { status: "choose" }>): DraftPlace => {
    const [choice] = place.choices;
    return { status: "bound", externalId: choice!.externalId, name: choice!.name, ...(choice!.city ? { city: choice!.city } : {}) };
  };
  for (const ride of next.outing!.transports) {
    for (const end of ["from", "to"] as const) {
      const place = ride[end];
      if (!pending(place)) continue;
      ride[end] = first(place);
      ride.suggested = { ...ride.suggested, [end]: { others: place.choices.slice(1, 3) } };
      picked.push(`${ride.id}:${end}`);
    }
  }
  for (const night of next.outing!.lodging) {
    const place = night.place;
    if (!pending(place)) continue;
    night.place = first(place);
    night.source = "suggested";
    night.others = place.choices.slice(1, 3);
    picked.push(`n${night.night}`);
  }
  return { draft: requirementsDraftSchema.parse(next), picked };
}
