import { createHash } from "node:crypto";
import { DEFAULT_TRAVEL, planningRequirementsSchema, type PlanningRequirements } from "@tripquest/application/planning";
import { FORECASTS, worldSelection } from "./world";

/**
 * V2.1 free-interest planning cases over the invented world. `satisfiedBy` is the ground
 * truth for coverage: which places really fit each interest (written by hand from the
 * world's tags, before any run). `expect` says whether a plan should exist at all.
 */
export interface PlanCase {
  readonly id: string;
  readonly note: string;
  readonly requirements: PlanningRequirements;
  readonly forecast: keyof typeof FORECASTS;
  readonly date: string;
  readonly satisfiedBy: Readonly<Record<string, readonly string[]>>;
  readonly expect: "draft" | "no_plan";
  /** V2.2: the far cases, each also run walking-only for the before/after comparison. */
  readonly far?: true;
  /** V2.3: what each interest really means — when, and how many stops (see intent-dataset). */
  readonly intents?: Readonly<Record<string, IntentTruth>>;
  /** V2.3: kept out of every run until the end of the stage (`--held-out`). */
  readonly heldOut?: true;
}

/** V2.3 ground truth for one interest, written by hand before any run. */
export interface IntentTruth {
  readonly when: "any" | "morning" | "noon" | "afternoon" | "dusk" | "evening";
  readonly min: number;
  readonly max: number;
}

export const base = (overrides: Partial<PlanningRequirements> & { date: string }) => planningRequirementsSchema.parse({
  schemaVersion: "planning-requirements.v1",
  cityAdcode: "330100",
  timeZone: "Asia/Shanghai",
  travelMode: "walking",
  window: { startsAt: "09:00", endsAt: "18:00" },
  startPlace: worldSelection("V21-SQUARE"),
  endPlace: worldSelection("V21-SQUARE"),
  interests: [],
  pace: "standard",
  visits: [],
  ...overrides,
});
export const tomorrow = "2026-10-16"; // rainy in the "rainy" forecast

export const PLAN_CASES: readonly PlanCase[] = [
  {
    id: "P01",
    note: "越剧 + 安静书店，下午有固定预约",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      endPlace: worldSelection("V21-MALL"),
      freeInterests: [{ id: "i1", text: "越剧相关" }, { id: "i2", text: "安静的书店" }],
      visits: [{ place: worldSelection("V21-MUSEUM"), role: "fixed", startsAt: "14:00", endsAt: "15:30" }],
    }),
    satisfiedBy: { i1: ["V21-OPERA", "V21-OPERA-HALL"], i2: ["V21-BOOKS"] },
    expect: "draft",
  },
  {
    id: "P02",
    note: "下雨天看展 + 喝茶：应选室内",
    date: tomorrow,
    forecast: "rainy",
    requirements: base({ date: tomorrow, freeInterests: [{ id: "i1", text: "看展" }, { id: "i2", text: "喝茶" }] }),
    satisfiedBy: { i1: ["V21-MUSEUM", "V21-OPERA-HALL", "V21-MUSEUM-WEST"], i2: ["V21-TEA"] },
    expect: "draft",
  },
  {
    id: "P03",
    note: "晴天傍晚看日落，晚上 7 点前到",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "13:00", endsAt: "19:00" },
      endPlace: worldSelection("V21-STREET"),
      freeInterests: [{ id: "i1", text: "看日落" }],
    }),
    satisfiedBy: { i1: ["V21-PARK", "V21-HILL"] },
    expect: "draft",
  },
  {
    id: "P04",
    note: "中午想吃素",
    date: tomorrow,
    forecast: "dry",
    requirements: base({ date: tomorrow, window: { startsAt: "10:00", endsAt: "15:00" }, freeInterests: [{ id: "i1", text: "吃素" }] }),
    satisfiedBy: { i1: ["V21-VEG"] },
    expect: "draft",
  },
  {
    id: "P05",
    note: "没有地方能满足（滑雪）、也没有指定地点：应如实给不出方案",
    date: tomorrow,
    forecast: "dry",
    requirements: base({ date: tomorrow, freeInterests: [{ id: "i1", text: "室内滑雪" }] }),
    satisfiedBy: { i1: [] },
    expect: "no_plan",
  },
  {
    id: "P06",
    note: "带孩子：科技、亲子",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      pace: "relaxed",
      freeInterests: [{ id: "i1", text: "带孩子玩科技" }],
      notes: "尽量少走路",
    }),
    satisfiedBy: { i1: ["V21-SCIENCE"] },
    expect: "draft",
  },
  {
    id: "P07",
    note: "三个兴趣、只有半天：至少照顾到一部分，不违规",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "12:30" },
      freeInterests: [{ id: "i1", text: "小吃" }, { id: "i2", text: "文创市集" }, { id: "i3", text: "看展" }],
    }),
    satisfiedBy: { i1: ["V21-SNACK"], i2: ["V21-CRAFT"], i3: ["V21-MUSEUM", "V21-OPERA-HALL", "V21-MUSEUM-WEST"] },
    expect: "draft",
  },
  {
    id: "P08",
    note: "必去戏曲小剧场 + 喝茶",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      freeInterests: [{ id: "i1", text: "喝茶" }],
      visits: [{ place: worldSelection("V21-OPERA"), role: "required", stayMinutes: 90 }],
    }),
    satisfiedBy: { i1: ["V21-TEA"] },
    expect: "draft",
  },
  {
    id: "P09",
    note: "下雨天也想在户外散步：仍可安排，但应在理由里提到天气",
    date: tomorrow,
    forecast: "rainy",
    requirements: base({ date: tomorrow, window: { startsAt: "10:00", endsAt: "16:00" }, freeInterests: [{ id: "i1", text: "公园散步" }, { id: "i2", text: "书店" }] }),
    satisfiedBy: { i1: ["V21-PARK", "V21-STREET"], i2: ["V21-BOOKS", "V21-BOOKMALL"] },
    expect: "draft",
  },
  {
    id: "P10",
    note: "时间很紧：固定预约占满大半天，只能放下一个兴趣或不放",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "13:00" },
      freeInterests: [{ id: "i1", text: "看日落" }],
      visits: [{ place: worldSelection("V21-OPERA-HALL"), role: "fixed", startsAt: "09:30", endsAt: "12:00" }],
    }),
    satisfiedBy: { i1: ["V21-PARK", "V21-HILL"] },
    expect: "draft",
  },
];

const required = (id: string, stayMinutes: number) => ({ place: worldSelection(id), role: "required" as const, stayMinutes });

/**
 * V2.2 far cases: the western district and the canal town are 10–16 km out. Each window was
 * sized by hand so that walking alone cannot fit the must-go places, and other modes can.
 */
export const FAR_CASES: readonly PlanCase[] = [
  {
    id: "P11",
    note: "古寺 + 湿地，都在西郊，从东门广场出发再回来",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({ date: tomorrow, travel: DEFAULT_TRAVEL, visits: [required("V22-TEMPLE", 120), required("V22-WETLAND", 120)] }),
    satisfiedBy: {},
    expect: "draft",
  },
  {
    id: "P12",
    note: "半天去古寺，附近吃碗面，想快一点",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "15:00" },
      travel: { ...DEFAULT_TRAVEL, prefer: "fast" },
      freeInterests: [{ id: "i1", text: "吃面" }],
      visits: [required("V22-TEMPLE", 120)],
    }),
    satisfiedBy: { i1: ["V22-NOODLE"] },
    expect: "draft",
  },
  {
    id: "P13",
    note: "不打车、省钱：上午去湿地，下午 2 点回城看戏（固定预约）",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      travel: { allowed: ["walking", "transit"], prefer: "cheap" },
      visits: [
        required("V22-WETLAND", 120),
        { place: worldSelection("V21-OPERA"), role: "fixed", startsAt: "14:00", endsAt: "15:30" },
      ],
    }),
    satisfiedBy: {},
    expect: "draft",
  },
  {
    id: "P14",
    note: "腿脚不便少走路：运河古镇 + 喝茶",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "17:00" },
      travel: { ...DEFAULT_TRAVEL, prefer: "less_walking" },
      freeInterests: [{ id: "i1", text: "喝茶" }],
      visits: [required("V22-TOWN", 120)],
    }),
    satisfiedBy: { i1: ["V21-TEA"] },
    expect: "draft",
  },
  {
    id: "P15",
    note: "骑车去湿地，下午 3 点前回来",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "15:00" },
      travel: { allowed: ["walking", "bicycling"], prefer: "balanced" },
      visits: [required("V22-WETLAND", 90)],
    }),
    satisfiedBy: {},
    expect: "draft",
  },
  {
    id: "P16",
    note: "自驾：运河古镇 + 古寺（两地相距 25 公里）",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "17:00" },
      travel: { allowed: ["walking", "driving"], prefer: "fast" },
      visits: [required("V22-TOWN", 90), required("V22-TEMPLE", 90)],
    }),
    satisfiedBy: {},
    expect: "draft",
  },
  {
    id: "P17",
    note: "从东郊大学城（当前位置）出发，去湖滨一带慢慢逛，看越剧，别太累",
    date: tomorrow,
    forecast: "dry",
    far: true,
    requirements: base({
      date: tomorrow,
      startPlace: worldSelection("V22-CAMPUS"),
      endPlace: worldSelection("V22-CAMPUS"),
      travel: { ...DEFAULT_TRAVEL, prefer: "less_walking" },
      pace: "relaxed",
      notes: "在湖滨一带慢慢逛，别太累",
      freeInterests: [{ id: "i1", text: "越剧相关" }, { id: "i2", text: "湖滨散步" }],
    }),
    satisfiedBy: { i1: ["V21-OPERA", "V21-OPERA-HALL"], i2: ["V21-STREET", "V21-PARK"] },
    expect: "draft",
  },
];

/** The same far case with travel left out: V2.1 read it as walking only, so no plan fits. */
export function walkingOnly(item: PlanCase): PlanCase {
  const requirements = { ...item.requirements };
  delete requirements.travel;
  return { ...item, id: `${item.id}-walk`, requirements, expect: "no_plan" };
}

export const ALL_PLAN_CASES: readonly PlanCase[] = [...PLAN_CASES, ...FAR_CASES];

export const PLAN_DATASET_VERSION = "v22-plan.v2";
export function planDatasetDigest(): string {
  const shape = ALL_PLAN_CASES.map((item) => ({ ...item, requirements: { ...item.requirements, startPlace: item.requirements.startPlace.place.ref, endPlace: item.requirements.endPlace.place.ref } }));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
