import { createHash } from "node:crypto";
import { DEFAULT_TRAVEL, type PlanningPlace } from "@tripquest/application/planning";
import { base, tomorrow, type PlanCase } from "../v21/plan-dataset";
import { V21_TODAY, worldPlace, worldSelection } from "../v21/world";

/**
 * V4.2 规划可靠性（stages/V4.2.md §4.1）：评测世界里只走一日规划的同类题，2026-11-04 写好后锁定。
 * early：早上的固定事项来不及过去（这天要提前出门），预期排出、固定事项按时、它之前不排别的站；
 * control：固定事项离开始足够远（时间窗不该动），预期排出；
 * named：点名的“想去”地点，placed 预期排上，omitted 预期放不下、没排进去的说明里有具体原因。
 * 评测世界的营业时间只对“今天”（V21_TODAY）有效，用到营业时间的题（R06、R07）排今天，
 * 点名的地点像高德详情一样带上它在评测世界里的营业时间（opened）。
 */
export type ReliabilityExpect =
  | { readonly kind: "early"; readonly fixed: string }
  | { readonly kind: "control"; readonly fixed: string }
  | { readonly kind: "named"; readonly placed: string }
  | { readonly kind: "named"; readonly omitted: string };

export interface ReliabilityCase extends PlanCase {
  readonly reliability: ReliabilityExpect;
}

/** 卡片上点名的地点带当天营业时间（规划需求解析时按取数日期变成 hours）。 */
const opened = (id: string): PlanningPlace => {
  const selection = worldSelection(id);
  return { ...selection, place: { ...selection.place, business: { openToday: worldPlace(id).hours! } } } as PlanningPlace;
};

export const RELIABILITY_DATASET_VERSION = "v42-reliability.v1";

export const RELIABILITY_CASES: readonly ReliabilityCase[] = [
  {
    id: "R01",
    note: "早上 8:30 在博物馆有预约，时间窗也从 8:30 开始（走过去要 18 分钟）",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "08:30", endsAt: "17:00" },
      travel: DEFAULT_TRAVEL,
      freeInterests: [{ id: "i1", text: "安静的书店" }],
      visits: [{ place: worldSelection("V21-MUSEUM"), role: "fixed", startsAt: "08:30", endsAt: "10:00" }],
    }),
    satisfiedBy: { i1: ["V21-BOOKS", "V23-BOOKS", "V21-BOOKMALL"] },
    expect: "draft",
    reliability: { kind: "early", fixed: "V21-MUSEUM" },
  },
  {
    id: "R02",
    note: "9 点的固定事项在约 20 分钟车程外（茶园观景台，4 公里）",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      travel: DEFAULT_TRAVEL,
      freeInterests: [{ id: "i1", text: "湖边散步" }],
      visits: [{ place: worldSelection("V21-TEAFIELD"), role: "fixed", startsAt: "09:00", endsAt: "10:30" }],
    }),
    satisfiedBy: { i1: ["V21-PARK", "V21-STREET"] },
    expect: "draft",
    reliability: { kind: "early", fixed: "V21-TEAFIELD" },
  },
  {
    id: "R03",
    note: "对照：10:30 的固定事项，离 9 点开始够远，时间窗不动",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      window: { startsAt: "09:00", endsAt: "17:00" },
      travel: DEFAULT_TRAVEL,
      freeInterests: [{ id: "i1", text: "喝茶" }],
      visits: [{ place: worldSelection("V21-MUSEUM"), role: "fixed", startsAt: "10:30", endsAt: "12:00" }],
    }),
    satisfiedBy: { i1: ["V21-TEA"] },
    expect: "draft",
    reliability: { kind: "control", fixed: "V21-MUSEUM" },
  },
  {
    id: "R04",
    note: "像 D01：湖边散步、中午吃杭帮菜，点名要去的古寺在 13 公里外（下午有时间）",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      travel: DEFAULT_TRAVEL,
      freeInterests: [{ id: "i1", text: "湖边散步" }, { id: "i2", text: "中午吃杭帮菜", when: "noon" }],
      visits: [{ place: worldSelection("V22-TEMPLE"), role: "optional", stayMinutes: 120 }],
    }),
    satisfiedBy: { i1: ["V21-PARK", "V21-STREET"], i2: ["V23-DINNER"] },
    expect: "draft",
    reliability: { kind: "named", placed: "V22-TEMPLE" },
  },
  {
    id: "R05",
    note: "上午排满（早上喝咖啡、10:30–12:30 博物馆预约），点名的山顶观景台只能放下午",
    date: tomorrow,
    forecast: "dry",
    requirements: base({
      date: tomorrow,
      travel: DEFAULT_TRAVEL,
      freeInterests: [{ id: "i1", text: "早上喝咖啡", when: "morning" }, { id: "i2", text: "中午吃小吃", when: "noon" }],
      visits: [
        { place: worldSelection("V21-MUSEUM"), role: "fixed", startsAt: "10:30", endsAt: "12:30" },
        { place: worldSelection("V21-HILL"), role: "optional", stayMinutes: 90 },
      ],
    }),
    satisfiedBy: { i1: ["V23-CAFE", "V21-BOOKS", "V24-LUCKIN-A", "V24-LUCKIN-B"], i2: ["V21-SNACK"] },
    expect: "draft",
    reliability: { kind: "named", placed: "V21-HILL" },
  },
  {
    id: "R06",
    note: "点名的花店 16:00 关门，另外上午看展、下午喝茶、傍晚看日落",
    date: V21_TODAY,
    forecast: "dry",
    requirements: base({
      date: V21_TODAY,
      travel: DEFAULT_TRAVEL,
      freeInterests: [
        { id: "i1", text: "看展", when: "morning" },
        { id: "i2", text: "下午喝茶", when: "afternoon" },
        { id: "i3", text: "看日落", when: "dusk" },
      ],
      visits: [{ place: opened("V25-FLOWER-D"), role: "optional", stayMinutes: 30 }],
    }),
    satisfiedBy: { i1: ["V21-MUSEUM", "V21-MUSEUM-WEST", "V21-OPERA-HALL"], i2: ["V21-TEA"], i3: ["V21-PARK", "V21-HILL"] },
    expect: "draft",
    reliability: { kind: "named", placed: "V25-FLOWER-D" },
  },
  {
    id: "R07",
    note: "放不下：10:30–15:00 在 16 公里外的湿地，点名的花店 14:30 关门、要待 1 小时",
    date: V21_TODAY,
    forecast: "dry",
    requirements: base({
      date: V21_TODAY,
      travel: DEFAULT_TRAVEL,
      visits: [
        { place: worldSelection("V22-WETLAND"), role: "fixed", startsAt: "10:30", endsAt: "15:00" },
        { place: opened("V25-FLOWER-A"), role: "optional", stayMinutes: 60 },
      ],
    }),
    satisfiedBy: {},
    expect: "draft",
    reliability: { kind: "named", omitted: "V25-FLOWER-A" },
  },
];

export function reliabilityDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(RELIABILITY_CASES)).digest("hex");
}
