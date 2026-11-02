import { createHash } from "node:crypto";
import type { AllocationCase } from "../v211/outing-plan-dataset";

/**
 * V3.2 审查题集 `v32-review.v1`（stages/V3.2.md §4.1），写在审查 Agent 之前，锁定后不改。每题是一张出游卡片加一份
 * 故意不好的分到各天（不经模型分配，结果才稳定），用产品的逐天生成排出来，再看审查（OUTING_REVIEW=on）比
 * 不审查（off）好在哪。地点用评测世界的编号（见 v211/outing-plan-dataset.ts 的说明）。
 *
 * 判分（review-run.ts，评测自己算，不复用产品的找问题代码）：
 * - 空闲：一段里两站之间（扣掉路上的时间和缓冲）、一段排完到这段结束、或到站后等车，≥ 3 小时的每一段按整段时长计；
 * - 没排上：卡片上的地点和兴趣，最后哪一天都没出现；
 * - 太满：某段回到终点晚于这段结束前 30 分钟，或这段停留和路程合计超过可用时间的 90%，这天算一次；
 * - 雨天户外：有雨（雨、雪、雹、雷）那天排的户外站（世界里 indoor = false）的个数；
 * - 违例（必须为 0）：指定了天的地点不在那天、固定事项的时刻变了、车次时刻变了、用户说的停留变了、
 *   排出来的那天里少了分到它的必去；
 * - 误报：`noChange` 的题出了任何直接修改或建议；
 * - 建议命中：`suggest` 里的任一类型出现在建议里（直接改掉了同一个问题也算）。
 * 通过标准见 §4.2：空闲总时长或没排上的个数至少减少 30%、违例 0、不该改的题每题误报 ≤ 1 次（3 次里）、
 * 每趟多出的耗时中位数 ≤ 15 秒。
 */
export const REVIEW_DATASET_VERSION = "v32-review.v1";

export type ReviewProblem = "idle" | "unplaced" | "overloaded" | "wet";
export type ReviewAction = "move_visit" | "move_interest" | "swap_days_content" | "add_interest" | "set_day_travel" | "drop_visit";

export interface ReviewCase extends Omit<AllocationCase, "together" | "cityOrder" | "lightDays"> {
  /** 故意不好的分到各天：每天放哪些地点（世界编号）和兴趣（i 编号）。 */
  readonly split: readonly (readonly string[])[];
  /** 用哪份预报（云岭那份 10-16 有雷阵雨）。 */
  readonly forecast: "dry" | "yunling";
  readonly expect: {
    /** 应该变好的问题（审查后这几项里至少一项减少）。 */
    readonly improve?: readonly ReviewProblem[];
    /** 应该出现的建议类型（任一）。 */
    readonly suggest?: readonly ReviewAction[];
    /** 不该改：不出直接修改、不出建议。 */
    readonly noChange?: true;
  };
}

const YL = "990100";
const BY_CAR = { allowed: ["walking", "taxi", "driving"], prefer: "balanced" } as const;
const WALK_TAXI = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;
const two = { from: "2026-10-17", to: "2026-10-18" } as const;
const three = { from: "2026-10-17", to: "2026-10-19" } as const;
/** 云岭那份预报：10-15 晴、10-16 雷阵雨、10-17 晴。 */
const stormy = { from: "2026-10-15", to: "2026-10-17" } as const;
const station = { place: "Y-STATION", at: "09:00" } as const;
const back = { place: "Y-STATION", at: "20:00" } as const;

export const REVIEW_CASES: readonly ReviewCase[] = [
  {
    id: "R01", note: "半天空着：第 1 天只有博物馆，第 2 天三处，都没指定天（应挪一处到第 1 天）",
    dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [], forecast: "dry",
    visits: [
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150 },
      { place: "Y-BEACH", role: "optional", stayMinutes: 120 }, { place: "Y-TEMPLE", role: "optional", stayMinutes: 90 },
    ],
    split: [["Y-MUSEUM"], ["Y-TOWN", "Y-BEACH", "Y-TEMPLE"]],
    expect: { improve: ["idle"] },
  },
  {
    id: "R02", note: "晚上吃海鲜放在最后一天，那天 14 点就结束；前两天晚上空着（应挪兴趣）",
    dates: three, start: station, end: { place: "Y-STATION", at: "14:00" }, lodging: ["Y-HOTEL", "Y-HOTEL"], transfers: [], travel: BY_CAR,
    visits: [{ place: "Y-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150 }],
    interests: [{ id: "i1", text: "吃海鲜", when: "evening", city: YL }],
    split: [["Y-MUSEUM"], ["Y-TOWN"], ["i1"]], forecast: "dry",
    expect: { improve: ["unplaced"] },
  },
  {
    id: "R03", note: "雷阵雨那天（第 2 天）用户指定去爬山，晴天（第 1 天）指定博物馆（不能直接挪，应建议对调）",
    dates: stormy, start: station, end: back, lodging: ["Y-HOTEL", "Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120, day: 1 }, { place: "Y-GATE", role: "optional", stayMinutes: 300, day: 2 },
      { place: "Y-TOWN", role: "optional", stayMinutes: 150, day: 3 },
    ],
    split: [["Y-MUSEUM"], ["Y-GATE"], ["Y-TOWN"]], forecast: "yunling",
    expect: { suggest: ["swap_days_content", "move_visit"] },
  },
  {
    id: "R04", note: "第 1 天在杭州，第 2 天早上坐高铁去云岭；出行方式含自驾，车留在杭州（应建议云岭那两天不自驾）",
    dates: three, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: ["V21-SQUARE", "Y-HOTEL"],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "08:00", arriveAt: "10:30" }], travel: BY_CAR, interests: [],
    visits: [
      { place: "V21-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150 },
      { place: "Y-BEACH", role: "optional", stayMinutes: 120 },
    ],
    split: [["V21-MUSEUM"], ["Y-TOWN"], ["Y-BEACH"]], forecast: "dry",
    expect: { suggest: ["set_day_travel"] },
  },
  {
    id: "R05", note: "太满：第 1 天欢乐谷加古镇加博物馆，第 2 天只喝茶（应把一处挪到第 2 天）",
    dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-PARK", role: "optional", stayMinutes: 360, estimate: true }, { place: "Y-TOWN", role: "optional", stayMinutes: 150 },
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TEA", role: "optional", stayMinutes: 60 },
    ],
    split: [["Y-PARK", "Y-TOWN", "Y-MUSEUM"], ["Y-TEA"]], forecast: "dry",
    expect: { improve: ["idle", "unplaced", "overloaded"] },
  },
  {
    id: "R06", note: "两天都空半天，地点都指定了天，没有能挪的（应建议加兴趣）",
    dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [{ place: "Y-MUSEUM", role: "optional", stayMinutes: 120, day: 1 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150, day: 2 }],
    split: [["Y-MUSEUM"], ["Y-TOWN"]], forecast: "dry",
    expect: { suggest: ["add_interest"] },
  },
  {
    id: "R07", note: "不该改：住云岭站附近，两天都在市中心一带排满、不晚、不下雨",
    dates: two, dailyWindow: { startsAt: "10:00", endsAt: "18:00" }, start: { place: "Y-STATION", at: "10:00" }, end: { place: "Y-STATION", at: "18:00" },
    lodging: ["Y-STATION"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TEA", role: "optional", stayMinutes: 60 },
      { place: "Y-TEMPLE", role: "optional", stayMinutes: 120 }, { place: "Y-PARK", role: "optional", stayMinutes: 240 },
      { place: "Y-SNACK", role: "optional", stayMinutes: 60 },
    ],
    split: [["Y-MUSEUM", "Y-TEA", "Y-TEMPLE"], ["Y-PARK", "Y-SNACK"]], forecast: "dry",
    expect: { noChange: true },
  },
  {
    id: "R08", note: "第 1 天空着，第 2 天的三处都是用户指定的（不能直接挪，只能建议）",
    dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150, day: 2 },
      { place: "Y-BEACH", role: "optional", stayMinutes: 120, day: 2 }, { place: "Y-TEMPLE", role: "optional", stayMinutes: 90, day: 2 },
    ],
    split: [["Y-MUSEUM"], ["Y-TOWN", "Y-BEACH", "Y-TEMPLE"]], forecast: "dry",
    expect: { suggest: ["add_interest", "move_visit"] },
  },
  {
    id: "R09", note: "第 1 天上午固定看展（10–12 点），第 2 天下午 3 点的高铁回杭州；下午空着（固定事项和车次不能动）",
    dates: two, start: station, end: { place: "V21-HZ-EAST", at: "18:00" }, lodging: ["Y-HOTEL"],
    transfers: [{ day: 2, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST", departAt: "15:00", arriveAt: "17:30" }], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-MUSEUM", role: "fixed", startsAt: "10:00", endsAt: "12:00", day: 1 }, { place: "Y-TOWN", role: "optional", stayMinutes: 150 },
      { place: "Y-BEACH", role: "optional", stayMinutes: 120 },
    ],
    split: [["Y-MUSEUM"], ["Y-TOWN", "Y-BEACH"]], forecast: "dry",
    expect: { improve: ["idle", "unplaced"] },
  },
  {
    id: "R10", note: "兴趣放不下：第 2 天古镇、博物馆加看海和晚上吃火锅，第 1 天只喝下午茶（应挪兴趣或地点）",
    dates: two, start: station, end: back, lodging: ["Y-HOTEL"], transfers: [], travel: WALK_TAXI,
    visits: [{ place: "Y-TOWN", role: "optional", stayMinutes: 180 }, { place: "Y-MUSEUM", role: "optional", stayMinutes: 150 }],
    interests: [
      { id: "i1", text: "喝下午茶", when: "afternoon", city: YL }, { id: "i2", text: "看海", city: YL },
      { id: "i3", text: "吃火锅", when: "evening", city: YL },
    ],
    split: [["i1"], ["Y-TOWN", "Y-MUSEUM", "i2", "i3"]], forecast: "dry",
    expect: { improve: ["idle", "unplaced", "overloaded"] },
  },
  {
    id: "R11", note: "留出：三天，第 1 天只有古寺，第 3 天三处（应挪）", heldOut: true,
    dates: three, start: station, end: back, lodging: ["Y-HOTEL", "Y-INN"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-TEMPLE", role: "optional", stayMinutes: 90 }, { place: "Y-PARK", role: "optional", stayMinutes: 360, estimate: true },
      { place: "Y-TOWN", role: "optional", stayMinutes: 150 }, { place: "Y-BEACH", role: "optional", stayMinutes: 120 },
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 120 },
    ],
    split: [["Y-TEMPLE"], ["Y-PARK"], ["Y-TOWN", "Y-BEACH", "Y-MUSEUM"]], forecast: "dry",
    expect: { improve: ["idle", "unplaced", "overloaded"] },
  },
  {
    id: "R12", note: "留出：雷阵雨那天（第 2 天）指定去海边，晴天（第 3 天）指定博物馆（应建议对调）", heldOut: true,
    dates: stormy, start: station, end: back, lodging: ["Y-HOTEL", "Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-TOWN", role: "optional", stayMinutes: 150, day: 1 }, { place: "Y-BEACH", role: "optional", stayMinutes: 180, day: 2 },
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 150, day: 3 },
    ],
    split: [["Y-TOWN"], ["Y-BEACH"], ["Y-MUSEUM"]], forecast: "yunling",
    expect: { suggest: ["swap_days_content", "move_visit"] },
  },
  {
    id: "R13", note: "留出·不该改：住云岭站附近，两天排满，晚上各有安排", heldOut: true,
    dates: two, dailyWindow: { startsAt: "10:00", endsAt: "21:00" }, start: { place: "Y-STATION", at: "10:00" }, end: { place: "Y-STATION", at: "21:00" },
    lodging: ["Y-STATION"], transfers: [], travel: BY_CAR,
    visits: [
      { place: "Y-PARK", role: "optional", stayMinutes: 270 }, { place: "Y-CAFE", role: "optional", stayMinutes: 60 },
      { place: "Y-MUSEUM", role: "optional", stayMinutes: 150 }, { place: "Y-TEMPLE", role: "optional", stayMinutes: 120 },
      { place: "Y-TEA", role: "optional", stayMinutes: 60 },
    ],
    interests: [{ id: "i1", text: "喝一杯", when: "evening", city: YL }, { id: "i2", text: "吃火锅", when: "evening", city: YL }],
    split: [["Y-PARK", "Y-CAFE", "i1"], ["Y-MUSEUM", "Y-TEMPLE", "Y-TEA", "i2"]], forecast: "dry",
    expect: { noChange: true },
  },
  {
    id: "R14", note: "留出：第 1 天两处必去加一处想去，放不下；第 2 天只喝茶（必去不能被挪走或去掉，想去的可以挪）", heldOut: true,
    dates: two, dailyWindow: { startsAt: "09:00", endsAt: "18:00" }, start: station, end: { place: "Y-STATION", at: "18:00" },
    lodging: ["Y-STATION"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-PARK", role: "required", stayMinutes: 300, estimate: true }, { place: "Y-MUSEUM", role: "required", stayMinutes: 120 },
      { place: "Y-TOWN", role: "optional", stayMinutes: 150 }, { place: "Y-TEA", role: "optional", stayMinutes: 60 },
    ],
    split: [["Y-PARK", "Y-MUSEUM", "Y-TOWN"], ["Y-TEA"]], forecast: "dry",
    expect: { improve: ["idle", "unplaced", "overloaded"] },
  },
];

export function reviewDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(REVIEW_CASES)).digest("hex");
}
