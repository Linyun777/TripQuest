import { createHash } from "node:crypto";
import { YUNLING, worldSelection } from "../v21/world";

/**
 * V2.10 各种玩法的一日规划（stages/V2.10.md §4.2），在云岭市评测世界里跑产品的一日规划器，再用独立校验
 * 判分。需求按“将来的”产品写（城市是云岭、整天型地点停留可以超过 4 小时、可以 5 点出门、可以打车），
 * 在跑的时候才交给产品校验：现在的产品会在这一步拒绝（城市只能是杭州），这就是基线。真值手写，锁定后不改。
 */
export interface PlayCase {
  readonly id: string;
  readonly note: string;
  readonly date: string;
  /** 规划需求（未校验）；跑的时候交给产品的需求 schema。 */
  readonly requirements: Readonly<Record<string, unknown>>;
  /** 每个兴趣真正能满足它的地点（评测世界编号）。 */
  readonly satisfiedBy: Readonly<Record<string, readonly string[]>>;
  readonly expect: "draft" | "no_plan";
  /** 地点的合理停留分钟数（按类型或用户说的）。 */
  readonly stays?: Readonly<Record<string, readonly [number, number]>>;
  /** 必须带户外天气提示的地点；`noAlerts` 时一个提示都不该有。 */
  readonly alerts?: readonly string[];
  readonly noAlerts?: true;
  readonly heldOut?: true;
  /** V2.11：这一站估计的停留应缩短到这个值以下，并在方案里写明原估计。 */
  readonly shortened?: { readonly id: string; readonly below: number };
  /** V2.11：放得下时不该缩短任何停留。 */
  readonly notShortened?: true;
}

const SUNNY = "2026-10-15";
const STORM = "2026-10-16";
const BY_CAR = { allowed: ["walking", "taxi", "driving"], prefer: "balanced" } as const;
const BUS_ONLY = { allowed: ["walking", "transit"], prefer: "balanced" } as const;
const at = (id: string) => worldSelection(id);
const req = (date: string, extra: Record<string, unknown>) => ({
  schemaVersion: "planning-requirements.v1",
  cityAdcode: YUNLING.adcode,
  timeZone: "Asia/Shanghai",
  travelMode: "walking",
  date,
  window: { startsAt: "09:00", endsAt: "18:00" },
  startPlace: at("Y-STATION"),
  endPlace: at("Y-STATION"),
  interests: [],
  pace: "standard",
  travel: BY_CAR,
  visits: [],
  ...extra,
});
const BIG = [180, 600] as const;
const FOOD = [30, 150] as const;

export const PLAY_CASES: readonly PlayCase[] = [
  {
    id: "G01", note: "爬云岭山一整天：用户说待 6 小时（超过以前 4 小时的上限）", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "06:00", endsAt: "19:00" }, visits: [{ place: at("Y-GATE"), role: "required", stayMinutes: 360 }] }),
    satisfiedBy: {}, expect: "draft", stays: { "Y-GATE": [360, 360] }, noAlerts: true,
  },
  {
    id: "G02", note: "爬山 + 中午吃农家菜：山门附近 3 公里内没有饭店，要扩大范围", date: SUNNY,
    requirements: req(SUNNY, {
      window: { startsAt: "07:00", endsAt: "18:00" },
      visits: [{ place: at("Y-GATE"), role: "required", stayMinutes: 240 }],
      freeInterests: [{ id: "i1", text: "吃农家菜", when: "noon" }],
    }),
    satisfiedBy: { i1: ["Y-FARM"] }, expect: "draft", stays: { "Y-FARM": FOOD },
  },
  {
    id: "G03", note: "看日出：4 点半从山门出发，5 点半到山顶（固定）", date: SUNNY,
    requirements: req(SUNNY, {
      window: { startsAt: "04:30", endsAt: "12:00" },
      startPlace: at("Y-GATE"),
      endPlace: at("Y-GATE"),
      visits: [{ place: at("Y-PEAK"), role: "fixed", startsAt: "05:30", endsAt: "06:30" }],
    }),
    satisfiedBy: {}, expect: "draft",
  },
  {
    id: "G04", note: "主题乐园玩一整天：停留按大景区估计", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "08:30", endsAt: "21:00" }, freeInterests: [{ id: "i1", text: "去欢乐谷玩" }] }),
    satisfiedBy: { i1: ["Y-PARK"] }, expect: "draft", stays: { "Y-PARK": [240, 600] }, noAlerts: true,
  },
  {
    id: "G05", note: "古镇 + 晚上吃小吃", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "10:00", endsAt: "21:00" }, freeInterests: [{ id: "i1", text: "逛古镇" }, { id: "i2", text: "吃小吃", when: "evening" }] }),
    satisfiedBy: { i1: ["Y-TOWN"], i2: ["Y-SNACK"] }, expect: "draft", stays: { "Y-TOWN": [90, 360] },
  },
  {
    id: "G06", note: "晴天海边 + 海鲜：没有天气提示", date: SUNNY,
    requirements: req(SUNNY, { freeInterests: [{ id: "i1", text: "去海边走走" }, { id: "i2", text: "吃海鲜" }] }),
    satisfiedBy: { i1: ["Y-BEACH"], i2: ["Y-SEAFOOD"] }, expect: "draft", noAlerts: true,
  },
  {
    id: "G07", note: "雷阵雨天的海边：照排、提示，不删站", date: STORM,
    requirements: req(STORM, { freeInterests: [{ id: "i1", text: "去海边走走" }, { id: "i2", text: "吃海鲜" }] }),
    satisfiedBy: { i1: ["Y-BEACH"], i2: ["Y-SEAFOOD"] }, expect: "draft", alerts: ["Y-BEACH"],
  },
  {
    id: "G08", note: "雷阵雨天爬山（必去）：保留并提示", date: STORM,
    requirements: req(STORM, { window: { startsAt: "07:00", endsAt: "18:00" }, visits: [{ place: at("Y-GATE"), role: "required", stayMinutes: 300 }] }),
    satisfiedBy: {}, expect: "draft", alerts: ["Y-GATE"],
  },
  {
    id: "G09", note: "跨出城市边界：从云岭站去邻市的花海", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "07:00", endsAt: "20:00" }, visits: [{ place: at("L-FLOWER"), role: "required", stayMinutes: 180 }] }),
    satisfiedBy: {}, expect: "draft",
  },
  {
    id: "G10", note: "只坐公交：山门没有公交，也走不过去，如实说排不开", date: SUNNY,
    requirements: req(SUNNY, { travel: BUS_ONLY, visits: [{ place: at("Y-GATE"), role: "required", stayMinutes: 240 }] }),
    satisfiedBy: {}, expect: "no_plan",
  },
  {
    id: "G11", note: "晚上逛吃到很晚：火锅再喝一杯，23:30 前结束", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "18:00", endsAt: "23:30" }, freeInterests: [{ id: "i1", text: "吃火锅", when: "evening" }, { id: "i2", text: "喝一杯", when: "evening" }] }),
    satisfiedBy: { i1: ["Y-HOTPOT"], i2: ["Y-BAR"] }, expect: "draft",
  },
  {
    id: "G12", note: "城区一日：博物馆、茶馆、小吃（与杭州同类题对照）", date: SUNNY,
    requirements: req(SUNNY, { freeInterests: [{ id: "i1", text: "看展" }, { id: "i2", text: "喝茶" }, { id: "i3", text: "吃小吃" }] }),
    satisfiedBy: { i1: ["Y-MUSEUM"], i2: ["Y-TEA"], i3: ["Y-SNACK"] }, expect: "draft",
  },
  {
    id: "G13", note: "留出：晴天欢乐谷，晚上小吃街", date: SUNNY,
    requirements: req(SUNNY, { window: { startsAt: "09:00", endsAt: "22:00" }, freeInterests: [{ id: "i1", text: "玩主题乐园" }, { id: "i2", text: "吃小吃", when: "evening" }] }),
    satisfiedBy: { i1: ["Y-PARK"], i2: ["Y-SNACK"] }, expect: "draft", stays: { "Y-PARK": BIG }, heldOut: true,
  },
  {
    id: "G14", note: "留出：雷阵雨天逛古镇（户外），提示", date: STORM,
    requirements: req(STORM, { freeInterests: [{ id: "i1", text: "逛古镇" }] }),
    satisfiedBy: { i1: ["Y-TOWN"] }, expect: "draft", alerts: ["Y-TOWN"], heldOut: true,
  },
  {
    id: "G15", note: "留出：去邻市花海，晚上回云岭吃火锅", date: SUNNY,
    requirements: req(SUNNY, {
      window: { startsAt: "08:00", endsAt: "21:00" },
      visits: [{ place: at("L-FLOWER"), role: "required", stayMinutes: 150 }],
      freeInterests: [{ id: "i1", text: "吃火锅", when: "evening" }],
    }),
    satisfiedBy: { i1: ["Y-HOTPOT"] }, expect: "draft", heldOut: true,
  },
];

export const PLAY_DATASET_VERSION = "v210-play.v1";
export function playDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(PLAY_CASES)).digest("hex");
}
