import { createHash } from "node:crypto";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import type { IntakeCase, IntakeCheck } from "./intake-dataset";
import { worldPlace } from "./world";

/**
 * V2.4 short trips ("现在想去吃点辣的，吃完喝瑞幸"). Written by hand before any run (evaluation
 * first, D-055/D-056). Scoring reads only these expectations and the world's grid, so the same
 * cases score the day planner before the change and the short flow after it.
 */

/** 14:45 in Hangzhou on Thursday 2026-10-15: "now" for every short case. */
export const SHORT_NOW = Date.parse("2026-10-15T06:45:00Z");
const TODAY = "2026-10-15";

export interface ShortCase {
  readonly id: string;
  readonly note: string;
  readonly start: string;
  readonly interests: readonly { readonly id: string; readonly text: string }[];
  /** Places that truly satisfy each interest (ground truth). */
  readonly satisfiedBy: Readonly<Record<string, readonly string[]>>;
  /** The user asked to come back to the start ("吃完回家"). */
  readonly back?: true;
  /** V2.5: when the trip sets off, "HH:mm" (a later start today); absent = 14:45, now. */
  readonly startsAt?: string;
  readonly heldOut?: true;
}

const SPICY = ["V24-SPICY-A", "V24-SPICY-B", "V24-SPICY-C"];
const LUCKIN = ["V24-LUCKIN-A", "V24-LUCKIN-B", "V24-LUCKIN-C", "V24-LUCKIN-D"];
const COFFEE = [...LUCKIN, "V23-CAFE", "V21-BOOKS"];
const FLOWERS = ["V25-FLOWER-A", "V25-FLOWER-B", "V25-FLOWER-C", "V25-FLOWER-D"];

export const SHORT_PLAN_CASES: readonly ShortCase[] = [
  {
    id: "S01",
    note: "现在想吃点辣的，吃完喝瑞幸：瑞幸应在饭店附近",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃点辣的" }, { id: "i2", text: "喝瑞幸" }],
    satisfiedBy: { i1: SPICY, i2: LUCKIN },
  },
  {
    id: "S02",
    note: "等会儿想喝杯咖啡：一步，多个候选",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "喝杯咖啡" }],
    satisfiedBy: { i1: COFFEE },
  },
  {
    id: "S03",
    note: "吃火锅，吃完找个酒吧：酒吧应在火锅店附近",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃火锅" }, { id: "i2", text: "找个酒吧" }],
    satisfiedBy: { i1: ["V23-HOTPOT"], i2: ["V23-BAR-A", "V23-BAR-B", "V23-BAR-C"] },
  },
  {
    id: "S04",
    note: "吃点小吃，再找个地方喝茶",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃点小吃" }, { id: "i2", text: "喝茶" }],
    satisfiedBy: { i1: ["V21-SNACK"], i2: ["V21-TEA"] },
  },
  {
    id: "S05",
    note: "吃点辣的，吃完回家：这次要回到起点",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃点辣的" }],
    satisfiedBy: { i1: SPICY },
    back: true,
  },
  // V2.5: today's hours. The nearest flower shop closed at 14:30; another closes at 16:00.
  {
    id: "S07",
    note: "现在想去买束花：最近的花店 14:30 已关门，不该给",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "买束花" }],
    satisfiedBy: { i1: FLOWERS },
  },
  {
    id: "S08",
    note: "（留出）先吃点辣的再买花：饭店旁的花店 16:00 关门，吃完已经关了",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃点辣的" }, { id: "i2", text: "买束花" }],
    satisfiedBy: { i1: SPICY, i2: FLOWERS },
    heldOut: true,
  },
  // V2.5: later today. At 19:30 the shop closing at 20:00 is no offer; the one with unknown hours is.
  {
    id: "S09",
    note: "晚上 19:30 想去买束花：20:00 关门的花店来不及，不该给",
    start: "V21-SQUARE",
    startsAt: "19:30",
    interests: [{ id: "i1", text: "买束花" }],
    satisfiedBy: { i1: FLOWERS },
  },
  {
    id: "S06",
    note: "（留出）吃点辣的，吃完随便喝杯咖啡",
    start: "V21-SQUARE",
    interests: [{ id: "i1", text: "吃点辣的" }, { id: "i2", text: "随便喝杯咖啡" }],
    satisfiedBy: { i1: SPICY, i2: COFFEE },
    heldOut: true,
  },
];

/** What a run produced, whichever flow made it. */
export interface ShortOutcome {
  readonly planned: boolean;
  /** Chosen stops in order (external IDs). */
  readonly stops: readonly string[];
  /** Whether the day ends back at the start place. */
  readonly endsAtStart: boolean;
  /** Candidates offered per step (short flow only). */
  readonly steps?: readonly { readonly interest: string; readonly offered: readonly string[] }[];
  /** V2.5: each chosen stop's planned minutes, when there is a plan. */
  readonly times?: readonly { readonly startsAt: number; readonly endsAt: number }[];
  readonly violations: readonly string[];
}

export interface ShortScore {
  /** Interests with a chosen stop that truly satisfies them. */
  readonly covered: number;
  readonly interests: number;
  /** Meters the next stop lies beyond the nearest fit to the previous stop, summed over links. */
  readonly chainExcessMeters: number | null;
  /** Ends at the start although the user did not ask to come back (or not, when they did). */
  readonly wrongEnd: boolean;
  /**
   * Short flow: steps whose candidates all fit, none repeated, and at least min(3, fits within
   * search reach of that step's anchor): one hotpot nearby means one is the right offer.
   */
  readonly goodSteps: number | null;
  /** V2.5: planned stops the world says are closed at their planned time. */
  readonly closedStops: number;
  /** V2.5: candidates offered that were closed (or closing within 45 minutes) when that step set off. */
  readonly closedOffers: number;
}

/** World hours ("09:00-14:30 17:00-21:00", overnight allowed); null when unknown. */
function worldOpen(id: string, startsAt: number, endsAt: number): boolean | null {
  const hours = worldPlace(id).hours;
  if (!hours) return null;
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return hours.split(" ").some((range) => {
    const [open, close] = range.split("-").map(minutes);
    const end = close <= open ? 24 * 60 : close;
    return startsAt >= open && endsAt <= end;
  });
}
const SHORT_START_MINUTE = 14 * 60 + 45;
let caseStart = SHORT_START_MINUTE;
/** When a step set off: the trip's start, then the planned end of the stop before it. */
const setsOff = (outcome: ShortOutcome, step: number) =>
  step === 0 ? caseStart : outcome.times?.[step - 1]?.endsAt ?? caseStart;

const meters = (a: string, b: string) => {
  const [p, q] = [worldPlace(a), worldPlace(b)];
  return Math.round(Math.hypot(p.x - q.x, p.y - q.y) * 100);
};

export function scoreShort(item: ShortCase, outcome: ShortOutcome): ShortScore {
  caseStart = item.startsAt ? Number(item.startsAt.slice(0, 2)) * 60 + Number(item.startsAt.slice(3, 5)) : SHORT_START_MINUTE;
  const chosen = item.interests.map((interest) => outcome.stops.find((id) => item.satisfiedBy[interest.id].includes(id)));
  let excess: number | null = null;
  for (let index = 1; index < item.interests.length; index += 1) {
    const [before, after] = [chosen[index - 1], chosen[index]];
    if (!before || !after) continue;
    const nearest = Math.min(...item.satisfiedBy[item.interests[index].id].map((id) => meters(before, id)));
    excess = (excess ?? 0) + meters(before, after) - nearest;
  }
  return {
    covered: chosen.filter(Boolean).length,
    interests: item.interests.length,
    chainExcessMeters: excess,
    wrongEnd: outcome.planned && outcome.endsAtStart !== !!item.back,
    closedStops: (outcome.times ?? []).filter((time, index) => worldOpen(outcome.stops[index], time.startsAt, time.endsAt) === false).length,
    closedOffers: (outcome.steps ?? []).flatMap((step, index) => step.offered
      .filter((id) => worldOpen(id, setsOff(outcome, index), setsOff(outcome, index) + 45) === false)).length,
    goodSteps: outcome.steps
      ? outcome.steps.filter((step, index) => {
        const fits = item.satisfiedBy[step.interest] ?? [];
        const anchor = index === 0 ? item.start : outcome.stops[index - 1];
        // A shop closed, or closing within 45 minutes, when the step sets off is no fit (V2.5, as the product).
        const open = fits.filter((id) => worldOpen(id, setsOff(outcome, index), setsOff(outcome, index) + 45) !== false);
        const reachableOpen = anchor ? open.filter((id) => meters(anchor, id) <= 3000).length : open.length;
        return step.offered.length >= Math.min(3, reachableOpen) && step.offered.length <= 5 &&
          new Set(step.offered).size === step.offered.length && step.offered.every((id) => open.includes(id));
      }).length
      : null,
  };
}

// ---- Intake: does the chat agent hear "now, no need to come back"? ----

type Draft = RequirementsDraft & { mode?: string };
const mode = (draft: RequirementsDraft) => (draft as Draft).mode ?? "day";
const noFailures: IntakeCheck = { name: "no_failed_turn", test: (_, turns) => turns.every((turn) => !turn.failed) };
const current = (value: RequirementsDraft["start"]) => value?.status === "current";
const interest = (draft: RequirementsDraft, words: RegExp) => draft.interests.some((item) => words.test(item.text));
const startsNow = (draft: RequirementsDraft) =>
  draft.date === TODAY && !!draft.startsAt && draft.startsAt >= "14:45" && draft.startsAt <= "15:00";
/** V2.5: later today, in the evening: picked step by step, from here, no way back asked. */
const evening = (): IntakeCheck[] => [
  { name: "short_mode", test: (draft) => mode(draft) === "short" },
  { name: "today", test: (draft) => draft.date === TODAY },
  { name: "starts_evening", test: (draft) => !!draft.startsAt && draft.startsAt >= "17:00" && draft.startsAt <= "19:30" },
  { name: "from_here", test: (draft) => current(draft.start) },
  { name: "no_return", test: (draft) => draft.end === null },
];
const short = (extra: IntakeCheck[] = []): IntakeCheck[] => [
  noFailures,
  { name: "short_mode", test: (draft) => mode(draft) === "short" },
  { name: "starts_now", test: startsNow },
  { name: "from_here", test: (draft) => current(draft.start) },
  ...extra,
];

export const SHORT_INTAKE_CASES: readonly (IntakeCase & { readonly heldOut?: true })[] = [
  {
    id: "I30",
    note: "V2.4 现在想吃点偏辣的：短途、从这里出发、不用回来",
    turns: ["我现在想去吃点饭，最好偏辣的"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: short([
      { name: "no_return", test: (draft) => draft.end === null },
      { name: "spicy_kept", test: (draft) => interest(draft, /辣/) },
    ]),
  },
  {
    id: "I31",
    note: "V2.4 吃完喝瑞幸：瑞幸是兴趣，不是待选的固定地点",
    turns: ["现在想吃点辣的，吃完去喝瑞幸"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: short([
      { name: "luckin_interest", test: (draft) => interest(draft, /瑞幸/) },
      { name: "no_fixed_visit", test: (draft) => draft.visits.length === 0 },
      { name: "no_return", test: (draft) => draft.end === null },
    ]),
  },
  {
    id: "I32",
    note: "V2.4 等会儿喝杯咖啡：短途",
    turns: ["等会儿想去喝杯咖啡"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: short([{ name: "coffee_kept", test: (draft) => interest(draft, /咖啡/) }]),
  },
  {
    id: "I33",
    note: "V2.4 吃完回家：短途，但要回到这里",
    turns: ["现在去吃火锅，吃完回家"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: short([{ name: "back_home", test: (draft) => current(draft.end) }]),
  },
  {
    id: "I34",
    note: "V2.4 明天中午吃火锅：一日规划，不是短途",
    turns: ["明天中午想吃火锅"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: [
      noFailures,
      { name: "day_mode", test: (draft) => mode(draft) === "day" },
      { name: "tomorrow", test: (draft) => draft.date === "2026-10-16" },
    ],
  },
  {
    id: "I35",
    note: "V2.4 周六逛一天：一日规划",
    turns: ["这周六想在湖滨逛一天"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: [noFailures, { name: "day_mode", test: (draft) => mode(draft) === "day" }],
  },
  // V2.5 (user, 2026-10-17): a few things in a row later today pick from options too.
  {
    id: "I38",
    note: "V2.5 我晚上想吃铁板烧然后去喝点酒：短途（逐站挑），晚上出发，不用回来",
    turns: ["我晚上想吃铁板烧然后去喝点酒"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: [noFailures, ...evening()],
  },
  {
    id: "I39",
    note: "V2.5 接着说“给我多点选择”：是更多候选，不是每样去三家",
    turns: ["我晚上想吃铁板烧然后去喝点酒", "给我多点选择"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: [noFailures, ...evening(), { name: "one_each", test: (draft) => draft.interests.every((item) => (item.count ?? 1) === 1) }],
  },
  {
    id: "I40",
    note: "V2.5 明天晚上吃火锅再喝一杯：说的是明天，仍是一日规划",
    turns: ["明天晚上想吃火锅再去喝一杯"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    checks: [
      noFailures,
      { name: "day_mode", test: (draft) => mode(draft) === "day" },
      { name: "tomorrow", test: (draft) => draft.date === "2026-10-16" },
    ],
  },
  // Held out until the end of the stage.
  {
    id: "I41",
    note: "（留出）今晚想去看个电影，然后吃点夜宵",
    turns: ["今晚想去看个电影，然后吃点夜宵"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    heldOut: true,
    checks: [noFailures, ...evening()],
  },
  {
    id: "I36",
    note: "（留出）马上想找个地方喝奶茶",
    turns: ["马上想找个地方喝奶茶"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    heldOut: true,
    checks: short([{ name: "no_return", test: (draft) => draft.end === null }]),
  },
  {
    id: "I37",
    note: "（留出）一会儿去吃个面，然后逛逛书店",
    turns: ["一会儿去吃个面，然后逛逛书店"],
    forecast: "dry",
    nowMs: SHORT_NOW,
    heldOut: true,
    checks: short([{ name: "two_interests", test: (draft) => interest(draft, /面/) && interest(draft, /书/) }]),
  },
];

export const SHORT_DATASET_VERSION = "v24-short.v3";
export function shortDatasetDigest(): string {
  const shape = {
    plan: SHORT_PLAN_CASES,
    intake: SHORT_INTAKE_CASES.map((item) => ({ id: item.id, turns: item.turns, checks: item.checks.map((check) => check.name) })),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
