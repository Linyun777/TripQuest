import { createHash } from "node:crypto";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import type { IntakeCase, IntakeCheck } from "./intake-dataset";
import { base, tomorrow, type IntentTruth, type PlanCase } from "./plan-dataset";

/**
 * V2.3 cases: what an interest really means — when in the day, and how many stops. Written
 * by hand before any run (evaluation first, D-055). Scoring reads only these expectations,
 * never the planner's own labels, so the same cases score the code before and after.
 */

/** The slot windows from the design (3.1), minutes since midnight: the evaluation's own copy. */
export const SLOT_WINDOWS: Readonly<Record<Exclude<IntentTruth["when"], "any">, { startsAt: number; endsAt: number }>> = {
  morning: { startsAt: 6 * 60, endsAt: 12 * 60 },
  noon: { startsAt: 11 * 60, endsAt: 14 * 60 },
  afternoon: { startsAt: 12 * 60, endsAt: 18 * 60 },
  dusk: { startsAt: 16 * 60 + 30, endsAt: 19 * 60 + 30 },
  evening: { startsAt: 18 * 60, endsAt: 23 * 60 + 30 },
};

/**
 * Requirements carry when/count from step 2 on. The step 1 baseline ran with this off: the user's words only
 * (the time word stays in the text, as today's intake writes it). Step 2 turns this on.
 */
export const INTENT_FIELDS = true;

const truth = (when: IntentTruth["when"], max = 1, min = 1): IntentTruth => ({ when, min, max });
function interest(id: string, text: string, intent: IntentTruth) {
  if (!INTENT_FIELDS) return { id, text };
  return { id, text, ...(intent.when !== "any" ? { when: intent.when } : {}), count: intent.max };
}

const BARS = ["V23-BAR-A", "V23-BAR-B", "V23-BAR-C"];
const MEALS = ["V23-DINNER", "V23-HOTPOT", "V21-VEG"];

export const INTENT_PLAN_CASES: readonly PlanCase[] = [
  {
    id: "P18",
    note: "只说“晚上想去喝点酒”：一家酒馆，18 点以后",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "17:00", endsAt: "22:00" },
      pace: "relaxed",
      freeInterests: [interest("i1", "晚上喝点酒", truth("evening"))],
    }),
    satisfiedBy: { i1: BARS },
    intents: { i1: truth("evening") },
    expect: "draft",
  },
  {
    id: "P19",
    note: "白天逛湖滨，晚上找个地方喝一杯",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "22:00" },
      freeInterests: [interest("i1", "湖滨散步", truth("any")), interest("i2", "晚上喝一杯", truth("evening"))],
    }),
    satisfiedBy: { i1: ["V21-STREET", "V21-PARK"], i2: BARS },
    intents: { i1: truth("any"), i2: truth("evening") },
    expect: "draft",
  },
  {
    id: "P20",
    note: "想多逛几家书店：两到三家",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "13:00", endsAt: "18:00" },
      freeInterests: [interest("i1", "多逛几家书店", truth("any", 3, 2))],
    }),
    satisfiedBy: { i1: ["V21-BOOKS", "V21-BOOKMALL", "V23-BOOKS"] },
    intents: { i1: truth("any", 3, 2) },
    expect: "draft",
  },
  {
    id: "P21",
    note: "中午吃顿好的，下午看展：正餐在 11–14 点",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "10:00", endsAt: "17:00" },
      freeInterests: [interest("i1", "中午吃顿好的", truth("noon")), interest("i2", "看展", truth("any"))],
    }),
    satisfiedBy: { i1: MEALS, i2: ["V21-MUSEUM", "V21-OPERA-HALL", "V21-MUSEUM-WEST"] },
    intents: { i1: truth("noon"), i2: truth("any") },
    expect: "draft",
  },
  {
    id: "P22",
    note: "下午找个咖啡馆坐坐：一家，不凑别的",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "13:00", endsAt: "18:00" },
      pace: "relaxed",
      freeInterests: [interest("i1", "下午找个咖啡馆坐坐", truth("afternoon"))],
    }),
    // V2.4 added a coffee chain to the world; its branches are coffee shops too.
    satisfiedBy: { i1: ["V23-CAFE", "V21-BOOKS", "V24-LUCKIN-A", "V24-LUCKIN-B", "V24-LUCKIN-C", "V24-LUCKIN-D"] },
    intents: { i1: truth("afternoon") },
    expect: "draft",
  },
  {
    id: "P23",
    note: "早上爬山，晚上看夜景",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "07:00", endsAt: "22:00" },
      freeInterests: [interest("i1", "早上爬山", truth("morning")), interest("i2", "晚上看夜景", truth("evening"))],
    }),
    satisfiedBy: { i1: ["V21-HILL"], i2: ["V23-NIGHT"] },
    intents: { i1: truth("morning"), i2: truth("evening") },
    expect: "draft",
  },
  {
    id: "P24",
    note: "整天只有一个兴趣“想看越剧”：不为凑站数排两处越剧",
    date: tomorrow,
    forecast: "dry",
    requirements: base({ date: tomorrow, freeInterests: [interest("i1", "想看越剧", truth("any"))] }),
    satisfiedBy: { i1: ["V21-OPERA", "V21-OPERA-HALL"] },
    intents: { i1: truth("any") },
    expect: "draft",
  },
  // Held out until the end of the stage: never looked at while changing prompts or code.
  {
    id: "P25",
    note: "（留出）看展，晚饭吃火锅",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "13:00", endsAt: "21:00" },
      freeInterests: [interest("i1", "看展", truth("any")), interest("i2", "晚饭吃火锅", truth("evening"))],
    }),
    satisfiedBy: { i1: ["V21-MUSEUM", "V21-OPERA-HALL", "V21-MUSEUM-WEST"], i2: ["V23-HOTPOT"] },
    intents: { i1: truth("any"), i2: truth("evening") },
    expect: "draft",
    heldOut: true,
  },
  {
    id: "P26",
    note: "（留出）上午看个展，下午喝茶",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "17:00" },
      freeInterests: [interest("i1", "上午看个展", truth("morning")), interest("i2", "下午喝茶", truth("afternoon"))],
    }),
    satisfiedBy: { i1: ["V21-MUSEUM", "V21-OPERA-HALL", "V21-MUSEUM-WEST"], i2: ["V21-TEA"] },
    intents: { i1: truth("morning"), i2: truth("afternoon") },
    expect: "draft",
    heldOut: true,
  },
];

export interface IntentScore {
  /** Stops beyond an interest's maximum, summed over interests ("three bars" = 2). */
  readonly overCount: number;
  /** Stops missing below an interest's minimum ("多逛几家" with one bookstore = 1). */
  readonly underCount: number;
  /** Stops of a timed interest, and how many of them fall outside its slot. */
  readonly slotChecked: number;
  readonly slotMisses: number;
  /** Waiting before the first stop: a long one means leaving far too early. */
  readonly firstWaitMinutes: number;
}

export interface ScoredStop {
  readonly externalId: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly waitMinutes: number;
}

/** Scores chosen stops against the case's hand-written intents; the planner's labels are ignored. */
export function scoreIntent(item: PlanCase, stops: readonly ScoredStop[]): IntentScore {
  let overCount = 0;
  let underCount = 0;
  let slotChecked = 0;
  let slotMisses = 0;
  for (const [id, intent] of Object.entries(item.intents ?? {})) {
    const matching = stops.filter((stop) => item.satisfiedBy[id]?.includes(stop.externalId));
    overCount += Math.max(0, matching.length - intent.max);
    underCount += Math.max(0, intent.min - matching.length);
    if (intent.when === "any") continue;
    const slot = SLOT_WINDOWS[intent.when];
    for (const stop of matching) {
      slotChecked += 1;
      if (stop.startsAt < slot.startsAt || stop.endsAt > slot.endsAt) slotMisses += 1;
    }
  }
  return { overCount, underCount, slotChecked, slotMisses, firstWaitMinutes: stops[0]?.waitMinutes ?? 0 };
}

// ---- Intake: does the chat agent hear the slot, the number and the window? ----

type Interest = RequirementsDraft["interests"][number] & { when?: string; count?: number };
const find = (draft: RequirementsDraft, words: RegExp) =>
  draft.interests.find((item) => words.test(item.text)) as Interest | undefined;
/** Fields the product does not have yet read as "any" and 1, as old data will. */
const slotIs = (draft: RequirementsDraft, words: RegExp, when: string) => {
  const found = find(draft, words);
  return !!found && (found.when ?? "any") === when;
};
const countIs = (draft: RequirementsDraft, words: RegExp, test: (count: number) => boolean) => {
  const found = find(draft, words);
  return !!found && test(found.count ?? 1);
};
const noFailures: IntakeCheck = { name: "no_failed_turn", test: (_, turns) => turns.every((turn) => !turn.failed) };

export const INTENT_INTAKE_CASES: readonly (IntakeCase & { readonly heldOut?: true })[] = [
  {
    id: "I19",
    note: "V2.3 只说晚上喝酒：晚上、一处，时间范围就是晚上",
    turns: ["明天晚上想去喝点酒"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "evening", test: (draft) => slotIs(draft, /酒/, "evening") },
      { name: "one_place", test: (draft) => countIs(draft, /酒/, (count) => count === 1) },
      { name: "window_evening", test: (draft) => draft.startsAt! >= "16:00" && draft.endsAt! >= "21:00" },
    ],
  },
  {
    id: "I20",
    note: "V2.3 白天逛湖滨、晚上喝一杯：结束时间延到晚上",
    turns: ["明天逛逛湖滨，晚上找个地方喝一杯"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "evening_drink", test: (draft) => slotIs(draft, /酒|喝一杯|小酌/, "evening") },
      { name: "stroll_any_time", test: (draft) => slotIs(draft, /湖滨/, "any") },
      { name: "window_day_and_evening", test: (draft) => draft.startsAt! <= "10:00" && draft.endsAt! >= "21:00" },
    ],
  },
  {
    id: "I21",
    note: "V2.3 中午吃顿好的：中午、一处",
    turns: ["明天中午想吃顿好的，下午随便逛逛"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "noon_meal", test: (draft) => slotIs(draft, /吃|饭|餐/, "noon") },
      { name: "one_meal", test: (draft) => countIs(draft, /吃|饭|餐/, (count) => count === 1) },
    ],
  },
  {
    id: "I22",
    note: "V2.3 想多逛几家书店：数量 2～3",
    turns: ["明天下午想多逛几家书店"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "several", test: (draft) => countIs(draft, /书/, (count) => count >= 2 && count <= 3) },
    ],
  },
  {
    id: "I23",
    note: "V2.3 下午找个咖啡馆坐坐：下午、一处",
    turns: ["明天下午找个咖啡馆坐坐"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "afternoon", test: (draft) => slotIs(draft, /咖啡|坐/, "afternoon") },
      { name: "one_place", test: (draft) => countIs(draft, /咖啡|坐/, (count) => count === 1) },
    ],
  },
  {
    id: "I24",
    note: "V2.3 早上爬山、晚上看夜景：两个时段，时间范围从早到晚",
    turns: ["明天早上去爬山，晚上看夜景"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "morning_hike", test: (draft) => slotIs(draft, /山/, "morning") },
      { name: "evening_view", test: (draft) => slotIs(draft, /夜景/, "evening") },
      { name: "window_morning_to_night", test: (draft) => draft.startsAt! <= "09:00" && draft.endsAt! >= "21:00" },
    ],
  },
  {
    id: "I25",
    note: "V2.3 想吃点本地小吃：不限时段、一处（不乱加时段）",
    turns: ["明天想吃点本地小吃，再看看展"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "any_time", test: (draft) => slotIs(draft, /小吃/, "any") },
      { name: "one_place", test: (draft) => countIs(draft, /小吃/, (count) => count === 1) },
    ],
  },
  {
    id: "I29",
    note: "V2.3 端到端发现：“白天逛逛”不是时段，不能当成下午",
    turns: ["明天白天逛逛湖滨，晚上找个地方喝一杯"],
    forecast: "dry",
    checks: [
      noFailures,
      { name: "daytime_is_any", test: (draft) => slotIs(draft, /湖滨/, "any") },
      { name: "evening_drink", test: (draft) => slotIs(draft, /酒|喝一杯|小酌/, "evening") },
      { name: "window_day_and_evening", test: (draft) => draft.startsAt! <= "10:00" && draft.endsAt! >= "21:00" },
    ],
  },
  // Held out until the end of the stage.
  {
    id: "I26",
    note: "（留出）晚饭想吃火锅：晚上，结束时间包含晚饭",
    turns: ["明天下午看个展，晚饭想吃火锅"],
    forecast: "dry",
    heldOut: true,
    checks: [
      noFailures,
      { name: "evening_hotpot", test: (draft) => slotIs(draft, /火锅/, "evening") },
      { name: "window_has_dinner", test: (draft) => draft.endsAt! >= "20:00" },
    ],
  },
  {
    id: "I27",
    note: "（留出）上午看展、下午喝茶",
    turns: ["明天上午去看个展，下午找地方喝茶"],
    forecast: "dry",
    heldOut: true,
    checks: [
      noFailures,
      { name: "morning_show", test: (draft) => slotIs(draft, /展/, "morning") },
      { name: "afternoon_tea", test: (draft) => slotIs(draft, /茶/, "afternoon") },
    ],
  },
  {
    id: "I28",
    note: "（留出）想多看几个博物馆：数量 2～3",
    turns: ["明天想多看几个博物馆"],
    forecast: "dry",
    heldOut: true,
    checks: [
      noFailures,
      { name: "several", test: (draft) => countIs(draft, /博物馆|展/, (count) => count >= 2 && count <= 3) },
    ],
  },
];

export const INTENT_DATASET_VERSION = "v23-intent.v3";
export function intentDatasetDigest(): string {
  const shape = {
    plan: INTENT_PLAN_CASES.map((item) => ({
      ...item,
      requirements: {
        ...item.requirements,
        startPlace: item.requirements.startPlace.place.ref,
        endPlace: item.requirements.endPlace.place.ref,
      },
    })),
    intake: INTENT_INTAKE_CASES.map((item) => ({ id: item.id, turns: item.turns, checks: item.checks.map((check) => check.name) })),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
