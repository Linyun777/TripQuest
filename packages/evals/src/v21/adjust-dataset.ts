import { createHash } from "node:crypto";
import { worldPlace } from "./world";

/**
 * V2.5 adjusting a saved trip mid-day ("博物馆逛完了，越剧不去了，换成喝咖啡"). Written by hand
 * before any run (evaluation first). Scoring reads only these expectations: the same cases score
 * today's product (re-plan the whole day from the card) and the adjustment flow.
 */

/** The saved trip every case starts from: 2026-10-16, from and back to 东门广场. */
export interface TripStop {
  /** The key the chat agent sees ("s1"). */
  readonly key: string;
  readonly placeId: string;
  readonly interest: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly fixed?: true;
  /** V2.6: outdoors (documents the case; the chat agent is not told, see V2.6 §3.5). */
  readonly outdoor?: true;
}
export const TRIP_DATE = "2026-10-16";
export const TRIP_START = "V21-SQUARE";
export const TRIP_WINDOW = { startsAt: "09:00", endsAt: "18:00" } as const;
export const TRIP_STOPS: readonly TripStop[] = [
  { key: "s1", placeId: "V21-MUSEUM", interest: "看展", startsAt: "09:30", endsAt: "11:00" },
  { key: "s2", placeId: "V21-OPERA", interest: "越剧相关", startsAt: "11:30", endsAt: "12:30" },
  { key: "s3", placeId: "V21-TEA", interest: "喝茶", startsAt: "14:00", endsAt: "15:00" },
];
/** 11:10 on the trip day; 东门广场's museum is done and the user is still there. */
export const TRIP_NOW = Date.parse("2026-10-16T03:10:00Z");
export const TRIP_NOW_CLOCK = "11:10";

// ---- What the chat agent should make of what the user says ----

/** The adjustment request the chat agent should produce (the evaluation's own description). */
export interface AdjustTruth {
  readonly completed?: readonly string[];
  readonly skipped?: readonly string[];
  readonly replace?: readonly { readonly stop: string; readonly interest: RegExp }[];
  readonly add?: readonly RegExp[];
  /** The time of day each added interest must carry (V2.3), by position. */
  readonly addWhen?: readonly string[];
  /** Earliest resume time, "HH:mm" inclusive range. */
  readonly resumeAt?: readonly [string, string];
  readonly endsAt?: string;
  /** Not about this trip: no adjustment at all. */
  readonly none?: true;
  /** V2.6: where the rest starts ("here" = where the user is now). */
  readonly from?: "here" | "start";
}

export interface AdjustIntakeCase {
  readonly id: string;
  readonly note: string;
  readonly text: string;
  readonly truth: AdjustTruth;
  /** V2.6: another trip than the default (e.g. with an outdoor stop). */
  readonly stops?: readonly TripStop[];
  readonly heldOut?: true;
}

/** Museum, an open-air market (outdoors), tea house. */
function rainyTrip(): readonly TripStop[] {
  return TRIP_STOPS.map((stop) => (stop.key === "s2"
    ? { key: "s2", placeId: "V21-CRAFT", interest: "逛文创", startsAt: stop.startsAt, endsAt: stop.endsAt, outdoor: true as const }
    : stop));
}
const INDOOR = /室内|展|馆|书|咖啡|茶|商场|电影|剧|博物|美术/;

export const ADJUST_INTAKE_CASES: readonly AdjustIntakeCase[] = [
  { id: "A01", note: "逛完一站", text: "博物馆逛完了", truth: { completed: ["s1"] } },
  { id: "A02", note: "不去某一站", text: "越剧那个不想去了", truth: { skipped: ["s2"] } },
  { id: "A03", note: "换成别的", text: "越剧不去了，换成喝咖啡", truth: { replace: [{ stop: "s2", interest: /咖啡/ }] } },
  { id: "A04", note: "晚到", text: "我这边还要半小时才能走", truth: { resumeAt: ["11:35", "11:50"] } },
  { id: "A05", note: "加一个", text: "下午再加个吃小吃的地方", truth: { add: [/小吃/], addWhen: ["afternoon"] } },
  { id: "A06", note: "提前结束", text: "今天想5点就结束", truth: { endsAt: "17:00" } },
  { id: "A07", note: "说的是另一天：不调整这份", text: "帮我再规划一下后天去湖滨逛逛", truth: { none: true } },
  { id: "A08", note: "一句话里两件事", text: "博物馆看完了，越剧也不去了，直接去喝茶", truth: { completed: ["s1"], skipped: ["s2"] } },
  // Found in the stage's real run (2026-10-15): the stop went into both skipped and replace.
  // Found in the stage's browser run: the user named the stop by what it was for, not its name.
  { id: "A13", note: "按兴趣说站：看展那个", text: "看展那个不去了，换成去吃小吃", truth: { replace: [{ stop: "s1", interest: /小吃/ }] } },
  // V2.6: rain on a trip with an open-air market (its name does not say it is outdoors).
  { id: "A14", note: "下雨了，户外的换成室内的", text: "下雨了，后面户外的换成室内的吧", stops: rainyTrip(), truth: { replace: [{ stop: "s2", interest: INDOOR }] } },
  { id: "A15", note: "不在上一站，从这儿重新排", text: "我现在不在上一站了，从我这儿重新排吧", truth: { from: "here" } },
  { id: "A16", note: "（留出）雨太大，户外那站不去了", text: "雨太大了，户外那站就别去了", stops: rainyTrip(), truth: { skipped: ["s2"] }, heldOut: true },
  { id: "A12", note: "关门了不去，换成别的", text: "茶馆那个关门了不去了，换成吃个甜品吧", truth: { replace: [{ stop: "s3", interest: /甜品/ }] } },
  // Held out until the end of the stage.
  { id: "A09", note: "（留出）茶馆换成书店", text: "茶馆换成书店吧", truth: { replace: [{ stop: "s3", interest: /书/ }] }, heldOut: true },
  { id: "A10", note: "（留出）不去茶馆", text: "下午的茶馆就不去了", truth: { skipped: ["s3"] }, heldOut: true },
  { id: "A11", note: "（留出）晚一小时", text: "我得晚一个小时才能继续", truth: { resumeAt: ["12:05", "12:20"] }, heldOut: true },
];

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

/** Each part of the truth as a named check over the produced request (absent = none produced). */
export function adjustChecks(truth: AdjustTruth, produced: unknown): { name: string; passed: boolean }[] {
  const request = produced && typeof produced === "object" ? produced as Record<string, unknown> : null;
  if (truth.none) return [{ name: "no_adjustment", passed: request === null }];
  if (!request) return [{ name: "adjustment_made", passed: false }];
  const checks = [{ name: "adjustment_made", passed: true }];
  checks.push({ name: "completed", passed: same(list(request.completed), truth.completed ?? []) });
  checks.push({ name: "skipped", passed: same(list(request.skipped), truth.skipped ?? []) });
  const replace = Array.isArray(request.replace) ? request.replace as { stop?: unknown; interest?: unknown }[] : [];
  checks.push({
    name: "replace",
    passed: replace.length === (truth.replace?.length ?? 0) && (truth.replace ?? []).every((want) =>
      replace.some((got) => got.stop === want.stop && typeof got.interest === "string" && want.interest.test(got.interest))),
  });
  const addedItems = Array.isArray(request.addInterests) ? request.addInterests as unknown[] : [];
  const added = addedItems.map((item) => (typeof item === "string" ? item : (item as { text?: string })?.text ?? ""));
  checks.push({ name: "add", passed: added.length === (truth.add?.length ?? 0) && (truth.add ?? []).every((want) => added.some((got) => want.test(got))) });
  if (truth.addWhen) {
    const when = addedItems.map((item) => (typeof item === "object" && item ? (item as { when?: string }).when : undefined));
    checks.push({ name: "add_when", passed: truth.addWhen.every((want, index) => when[index] === want) });
  }
  const resume = typeof request.resumeAt === "string" ? request.resumeAt : null;
  checks.push({ name: "resume", passed: truth.resumeAt ? !!resume && resume >= truth.resumeAt[0] && resume <= truth.resumeAt[1] : !resume || resume <= "11:15" });
  checks.push({ name: "ends", passed: (typeof request.endsAt === "string" ? request.endsAt : undefined) === truth.endsAt });
  // The last stop done is the default start: absent and "last_done" are the same.
  const from = request.from === "here" || request.from === "start" ? request.from : undefined;
  checks.push({ name: "from", passed: from === truth.from });
  return checks;
}

// ---- What the adjusted day should look like ----

export interface AdjustPlanCase {
  readonly id: string;
  readonly note: string;
  /** Overrides on the base trip for this case (e.g. an appointment). */
  readonly stops?: readonly TripStop[];
  /** V2.5: a short trip (picked step by step, ends at its last stop): its order is the user's. */
  readonly short?: true;
  readonly completed: readonly string[];
  readonly request: {
    readonly skipped?: readonly string[];
    readonly replace?: readonly { readonly stop: string; readonly interest: string }[];
    readonly addInterests?: readonly (string | { readonly text: string; readonly when?: "morning" | "noon" | "afternoon" | "dusk" | "evening" })[];
    readonly resumeAt?: string;
    readonly endsAt?: string;
  };
  readonly expect: {
    /** Stops that must still be there. */
    readonly kept: readonly string[];
    /** Stops that must be gone. */
    readonly removed: readonly string[];
    /** Places that satisfy each added or replacing interest (ground truth). */
    readonly added?: readonly (readonly string[])[];
    /** "draft": fits as asked; "suggest": does not fit, a stop should be proposed for dropping. */
    readonly outcome: "draft" | "suggest";
    /** For "suggest": the stop that should be proposed. */
    readonly suggestDrop?: string;
    /** V2.5: the stops in this order (a list = any of these places). */
    readonly order?: readonly (string | readonly string[])[];
  };
  readonly heldOut?: true;
}

const COFFEE = ["V23-CAFE", "V21-BOOKS", "V24-LUCKIN-A", "V24-LUCKIN-B", "V24-LUCKIN-C", "V24-LUCKIN-D"];
const withFixedTea: readonly TripStop[] = TRIP_STOPS.map((stop) => (stop.key === "s3" ? { ...stop, fixed: true } : stop));

export const ADJUST_PLAN_CASES: readonly AdjustPlanCase[] = [
  {
    id: "R01", note: "越剧不去了", completed: ["s1"], request: { skipped: ["s2"] },
    expect: { kept: ["V21-TEA"], removed: ["V21-OPERA"], outcome: "draft" },
  },
  {
    id: "R02", note: "越剧换成喝咖啡", completed: ["s1"], request: { replace: [{ stop: "s2", interest: "喝咖啡" }] },
    expect: { kept: ["V21-TEA"], removed: ["V21-OPERA"], added: [COFFEE], outcome: "draft" },
  },
  {
    id: "R03", note: "再加个吃小吃", completed: ["s1"], request: { addInterests: ["吃小吃"] },
    expect: { kept: ["V21-OPERA", "V21-TEA"], removed: [], added: [["V21-SNACK"]], outcome: "draft" },
  },
  {
    id: "R04", note: "13:20 才能继续、15:30 就要走，14 点的茶馆是预约：越剧放不下，应建议去掉", stops: withFixedTea,
    completed: ["s1"], request: { resumeAt: "13:20", endsAt: "15:30" },
    expect: { kept: ["V21-TEA"], removed: [], outcome: "suggest", suggestDrop: "V21-OPERA" },
  },
  {
    id: "R05", note: "13:30 就要结束：茶馆排不下，应建议去掉", completed: ["s1"], request: { endsAt: "13:30" },
    expect: { kept: ["V21-OPERA"], removed: [], outcome: "suggest", suggestDrop: "V21-TEA" },
  },
  {
    id: "R06", note: "越剧不去了，再加个看日落", completed: ["s1"], request: { skipped: ["s2"], addInterests: [{ text: "看日落", when: "dusk" }] },
    expect: { kept: ["V21-TEA"], removed: ["V21-OPERA"], added: [["V21-PARK", "V21-HILL"]], outcome: "draft" },
  },
  // V2.5: a short trip ending at its last stop. The last stop is replaced: the replacement
  // comes after the snack street, even though the tea house is on the way there.
  {
    id: "R09", note: "短途：最后一站换成喝茶，顺序不变", short: true,
    stops: [
      { key: "s1", placeId: "V23-HOTPOT", interest: "吃火锅", startsAt: "09:30", endsAt: "11:00" },
      { key: "s2", placeId: "V21-SNACK", interest: "吃小吃", startsAt: "11:20", endsAt: "12:20" },
      { key: "s3", placeId: "V23-BAR-C", interest: "找个清吧", startsAt: "12:35", endsAt: "13:35" },
    ],
    completed: ["s1"], request: { replace: [{ stop: "s3", interest: "喝茶" }] },
    expect: {
      kept: ["V21-SNACK"], removed: ["V23-BAR-C"], added: [["V21-TEA", "V21-TEAFIELD"]], outcome: "draft",
      order: ["V21-SNACK", ["V21-TEA", "V21-TEAFIELD"]],
    },
  },
  // Held out until the end of the stage.
  {
    id: "R07", note: "（留出）茶馆换成书店", completed: ["s1"], request: { replace: [{ stop: "s3", interest: "逛书店" }] },
    expect: { kept: ["V21-OPERA"], removed: ["V21-TEA"], added: [["V21-BOOKS", "V21-BOOKMALL", "V23-BOOKS"]], outcome: "draft" },
    heldOut: true,
  },
  {
    id: "R08", note: "（留出）越剧也看完了，只剩喝茶，再加吃小吃", completed: ["s1", "s2"], request: { addInterests: ["吃小吃"] },
    expect: { kept: ["V21-TEA"], removed: [], added: [["V21-SNACK"]], outcome: "draft" },
    heldOut: true,
  },
];

/** What a run produced, whichever flow made it. */
export interface AdjustOutcome {
  readonly planned: boolean;
  /** The new day's stops, in order, with start times ("HH:mm"). */
  readonly stops: readonly { readonly placeId: string; readonly startsAt: string; readonly endsAt: string }[];
  /** A stop proposed for dropping when the request cannot fit. */
  readonly suggestDrop?: string;
  readonly violations: readonly string[];
}

export interface AdjustScore {
  /** Done stops scheduled again (they are history). */
  readonly completedAgain: number;
  /** Stops the user kept that are missing (silently dropped). */
  readonly keptMissing: number;
  /** Stops the user removed that are still there. */
  readonly removedPresent: number;
  /** Added or replacing interests with a fitting place. */
  readonly addedCovered: number;
  readonly addedWanted: number;
  /** Stops starting before the user can go on (now or the given resume time). */
  readonly beforeResume: number;
  /** An appointment whose time moved. */
  readonly fixedMoved: number;
  readonly outcomeMatched: boolean;
  /** V2.5: the stops follow the expected order (null: no order expected or no plan). */
  readonly orderKept: boolean | null;
}

export function adjustResumeAt(item: AdjustPlanCase): string {
  return item.request.resumeAt ?? TRIP_NOW_CLOCK;
}

export function scoreAdjust(item: AdjustPlanCase, outcome: AdjustOutcome): AdjustScore {
  const stops = item.stops ?? TRIP_STOPS;
  const ids = outcome.stops.map((stop) => stop.placeId);
  const done = stops.filter((stop) => item.completed.includes(stop.key)).map((stop) => stop.placeId);
  const fixed = stops.filter((stop) => stop.fixed);
  const resume = adjustResumeAt(item);
  const matched = item.expect.outcome === "draft"
    ? outcome.planned
    : outcome.suggestDrop === item.expect.suggestDrop;
  return {
    completedAgain: ids.filter((id) => done.includes(id)).length,
    keptMissing: outcome.planned ? item.expect.kept.filter((id) => !ids.includes(id)).length : 0,
    removedPresent: item.expect.removed.filter((id) => ids.includes(id)).length,
    addedCovered: (item.expect.added ?? []).filter((fits) => ids.some((id) => fits.includes(id))).length,
    addedWanted: item.expect.added?.length ?? 0,
    beforeResume: outcome.stops.filter((stop) => stop.startsAt < resume).length,
    fixedMoved: fixed.filter((stop) => {
      const found = outcome.stops.find((item2) => item2.placeId === stop.placeId);
      return found && (found.startsAt !== stop.startsAt || found.endsAt !== stop.endsAt);
    }).length,
    outcomeMatched: matched,
    orderKept: item.expect.order && outcome.planned
      ? (() => {
          const wanted = item.expect.order.map((entry) => (typeof entry === "string" ? [entry] : entry));
          const matching = ids.filter((id) => wanted.some((entry) => entry.includes(id)));
          return matching.length === wanted.length && wanted.every((entry, index) => entry.includes(matching[index]));
        })()
      : null,
  };
}

/** Names as the chat agent would see them. */
export function tripStopName(stop: TripStop): string {
  return worldPlace(stop.placeId).name;
}

export const ADJUST_DATASET_VERSION = "v26-adjust.v1";
export function adjustDatasetDigest(): string {
  const shape = {
    intake: ADJUST_INTAKE_CASES.map((item) => ({ ...item, truth: JSON.stringify(item.truth, (_, value) => (value instanceof RegExp ? value.source : value)) })),
    plan: ADJUST_PLAN_CASES,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
