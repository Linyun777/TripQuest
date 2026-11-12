import { outingDays, requirementsDraftSchema, type RequirementsDraft } from "@tripquest/application/conversation";
import {
  applySaidLegs,
  buildStays,
  fixRideDays,
  legNeeds,
  legNote,
  saidLegs,
  stayNote,
  stayPhrases,
  staysLabel,
  stayText,
  tripNights,
  tripWords,
  type Stay,
} from "@tripquest/application/outing-stays";
import { datesByNights, nightsQuestion } from "@tripquest/application/said-dates";
import type { RideMode, RideStation } from "@tripquest/application/outing-rides";
import type { CityResolver, MobilityProvider } from "@tripquest/providers";
import { fillRides, findStations } from "./outing-rides";
import { currentRun } from "./runs";

/** 车站搜索；能确认城市时才认“住在哪”（没有城市解析就不认）。 */
type Provider = Pick<MobilityProvider, "searchPlaces"> & Partial<CityResolver>;

/** 一轮最多确认几个地名（每个一次城市解析；O04 是乌镇、苏州、上海、杭州四个）。 */
const MAX_LOOKUPS = 5;

/**
 * 出游对话每轮之后由代码补卡片（stages/V4.3.md §3.2–3.4，V3.6 §3.4）：先从用户原话认“住在哪”（城市用城市解析确认），
 * 再补用户说了方式、对话没记的那几段（V4.3 验收前加：“最后坐高铁去上海玩一天再坐高铁回杭州”），把日子和住宿对不上、
 * 没给时刻的车挪到对的天，最后照旧补车站和漏掉的往返。补了什么在回复后面加一句；模型的回复不动。
 * V4.4（stages/V4.4.md §3.2–3.3）：认住在哪之前，用户没给回来那天时结束日期按晚数算；用户给的日期和住几晚对不上时
 * 不认住在哪，返回一个问句 ask（回复里只问这一个，见 withAfterTurn）。
 * changed 是这一轮模型改了卡片；previous 是这一轮之前的卡片。
 */
export async function afterOutingTurn(
  input: RequirementsDraft,
  userTexts: readonly string[],
  provider: Provider,
  signal: AbortSignal,
  options: { readonly changed: boolean; readonly previous?: RequirementsDraft },
): Promise<{ readonly draft: RequirementsDraft; readonly note: string | null; readonly ask?: string }> {
  if (input.mode !== "outing" || !input.outing) return { draft: input, note: null };
  const datesJustSet = !!input.outing.dates && !(options.previous?.mode === "outing" && options.previous.outing?.dates);
  const text = stayText(userTexts, datesJustSet);
  const words = text ? tripWords(text) : null;
  const total = words ? tripNights(words) : null;
  const lengthened = total ? datesByNights(input, total) : null;
  const draft = lengthened?.draft ?? input;
  if (!draft.outing) return { draft: input, note: null };
  const phrases = text ? stayPhrases(text) : null;
  const ask = phrases?.length ? nightsQuestion(draft, phrases) : null;
  const said = provider.resolveCity ? await staysFromText(draft, userTexts, provider as CityResolver, signal, datesJustSet) : null;
  let next = draft;
  if (said?.stays && JSON.stringify(said.stays) !== JSON.stringify(draft.outing.stays ?? [])) {
    const changed: RequirementsDraft = structuredClone(draft);
    changed.outing!.stays = said.stays;
    // 每晚的城市变了：分到各天作废，系统暂定的住处下次按新的城市重新找（同卡片上改了“人在哪”，V3.3）。
    delete changed.outing!.allocation;
    changed.outing!.lodging = changed.outing!.lodging.filter((item) => item.source !== "suggested");
    next = requirementsDraftSchema.parse(changed);
  }
  const staysChanged = next !== draft;
  const legs = said ? await addSaidLegs(next, said, provider, signal) : null;
  if (legs) next = legs.draft;
  const first = fixRideDays(next);
  next = first.draft;
  const rides = options.changed || staysChanged || legs || first.moved.length || lengthened
    ? await fillRides(next, userTexts, provider, signal).catch(() => null)
    : null;
  if (rides) next = rides.draft;
  // 车站是刚补上的（两端原来空着、看不出是哪两个城市之间的车），补完再按住宿看一次日子。
  const second = fixRideDays(next);
  next = second.draft;
  const fixed = { moved: [...first.moved, ...second.moved] };
  currentRun()?.step("check", "outing:stays", {
    ...(said?.stays ? { stays: staysLabel(said.stays) } : {}),
    ...(said ? { lookups: said.lookups } : {}),
    ...(legs ? { legs: legs.added.map((item) => `d${item.day}:${item.mode}`) } : {}),
    moved: fixed.moved.map((item) => `${item.id}:d${item.from}->d${item.to}`),
    ...(lengthened ? { lengthened: next.outing!.dates?.to } : {}),
    ...(ask ? { asked: "nights" } : {}),
  });
  const note = [
    lengthened?.note ?? null,
    stayNote(staysChanged ? next.outing!.stays ?? null : null, []),
    legNote(legs?.added ?? []),
    stayNote(null, fixed.moved),
    rides?.note ?? null,
  ].filter(Boolean).join("");
  return { draft: next, note: note || null, ...(ask ? { ask } : {}) };
}

/**
 * 每轮之后补的说明加在回复后面。有问句（V4.4 §3.2）时回复里只问这一个：模型自己的问句去掉，问句放在最后。
 */
export function withAfterTurn(reply: string, filled: { readonly note: string | null; readonly ask?: string }): string {
  const kept = filled.ask
    ? reply.split(/(?<=[。！？!?\n])/).filter((sentence) => !/[？?]\s*$/.test(sentence)).join("").trim()
    : reply;
  const tail = `${filled.note ?? ""}${filled.ask ?? ""}`;
  return tail ? [kept, tail].filter(Boolean).join("\n\n") : reply;
}

interface Said {
  readonly stays: Stay[] | null;
  readonly words: NonNullable<ReturnType<typeof tripWords>>;
  readonly cities: ReadonlyMap<string, { readonly adcode: string; readonly name: string } | null>;
  readonly lookups: number;
}

/**
 * 从用户原话认出的几站（住几晚、坐什么去）、“住在哪”和用了几次城市解析；这句话里没有“住几晚”时为 null。卡片上已有的城市名
 * 对得上的不再查。
 */
async function staysFromText(
  draft: RequirementsDraft,
  userTexts: readonly string[],
  provider: CityResolver,
  signal: AbortSignal,
  datesJustSet: boolean,
): Promise<Said | null> {
  const text = stayText(userTexts, datesJustSet);
  const words = text ? tripWords(text) : null;
  const phrases = text ? stayPhrases(text) : null;
  const nights = Math.max(0, outingDays(draft.outing!) - 1);
  if (!words || !phrases?.length) return null;
  const names = [...new Set([...words.stops.map((stop) => stop.name), ...(words.back ? [words.back.name] : [])])];
  if (names.length > MAX_LOOKUPS) return null;
  const known = [...(draft.outing!.stays ?? []).map((item) => item.city), ...(draft.city ? [draft.city] : [])];
  let lookups = 0;
  const cities = new Map<string, { adcode: string; name: string } | null>();
  for (const name of names) {
    const reused = known.find((city) => city.name.replace(/市$/, "") === name.replace(/市$/, ""));
    if (reused) {
      cities.set(name, { adcode: reused.adcode, name: reused.name });
      continue;
    }
    lookups += 1;
    const reply = await provider.resolveCity(name, { signal }).catch(() => null);
    cities.set(name, reply?.status === "ok" ? reply.data : null);
  }
  const fits = phrases.reduce((sum, item) => sum + item.count, 0) <= nights;
  const stays = fits ? buildStays(phrases, phrases.map((item) => cities.get(item.name) ?? null), nights) : null;
  return { stays, words, cities, lookups };
}

/** 用户说了方式、卡片上还没有的那几段：按城市搜车站补上（暂定）；没补上为 null。 */
async function addSaidLegs(draft: RequirementsDraft, said: Said, provider: Provider, signal: AbortSignal) {
  const startCity = draft.start?.status === "bound" ? draft.start.city : undefined;
  const origin = startCity ? { adcode: startCity, name: "" } : draft.city ? { adcode: draft.city.adcode, name: draft.city.name } : null;
  // 晚数加起来超过这趟的晚数时“住在哪”不认，按它排出来的日子也不可信，不补。
  if (!said.stays) return null;
  const legs = saidLegs(said.words, said.cities, origin).filter((leg) => leg.day <= outingDays(draft.outing!));
  const needs = legNeeds(draft, legs);
  if (!needs.length) return null;
  const found = new Map<string, readonly RideStation[]>();
  for (const key of needs) {
    const [mode, city] = key.split("@") as [RideMode, string];
    found.set(key, await findStations(mode, city, provider, signal));
  }
  const applied = applySaidLegs(draft, legs, found);
  return applied.added.length ? applied : null;
}
