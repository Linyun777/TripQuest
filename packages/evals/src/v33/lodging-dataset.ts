import { createHash } from "node:crypto";
import type { Interest, Transfer, Visit } from "../v211/outing-plan-dataset";

/**
 * V3.3 住处题集 `v33-lodging.v1`（stages/V3.3.md §4.1），写在住处推荐之前，锁定后不改。每题是一张出游卡片：没定的
 * 住处写 null，兴趣按原话写（“住古镇附近”这种由产品自己识别）。分到各天用规则分配（结果稳定），再用产品的逐天
 * 生成排出来。地点用评测世界的编号（v21/world.ts，住宿在 LODGING_WORLD；岚溪故意没有住宿）。
 *
 * 判分（lodging-run.ts，评测自己算）：
 * - 每天所在城市：这天排的每一站都在 `cities` 给的城市里（没排站的天不看）；排不开（不是方案）的天另计；
 * - 每晚住处：`nights` 里写了城市的，产品定的暂定住处必须是评测世界里的住宿（分类码 10 开头）、在那个城市；同一个
 *   `segment` 的几晚是同一家；`given` 是用户给的，不能变；`same` 是跟着另一晚的（同一家）；`none` 是找不到、不能编；
 *   `onBoard` 是车上，不定住处；
 * - 候选：产品给的“换住处”建议也必须是那个城市的真实住宿；
 * - 区域：暂定住处离 `area.place` 不超过 3 公里；
 * - 车程：`estimated` 列出的交通（没填或只填一边），车程 = 两站直线距离 × 1.3 ÷ 速度 + 20 分钟（向上取到 10 分钟，
 *   至少 30 分钟；高铁 200 公里 / 时，飞机 700 公里 / 时再加 60 分钟），差 10 分钟以内算对；给了的那一边不能变；
 * - 代价：地图请求和耗时，和基线同时跑的对比在汇总里做。
 * 通过标准见 §4.2（开发中不改）。
 */
export const LODGING_DATASET_VERSION = "v33-lodging.v1";

const HZ = "330100";
const YL = "990100";
const LX = "990200";
const PUBLIC = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;

export type NightExpect =
  | { readonly city: string; readonly segment: string }
  | { readonly given: string }
  | { readonly same: number }
  | "none"
  | "onBoard";

export interface LodgingCase {
  readonly id: string;
  readonly note: string;
  readonly dates: { readonly from: string; readonly to: string };
  readonly dailyWindow?: { readonly startsAt: string; readonly endsAt: string };
  readonly start: { readonly place: string; readonly at?: string };
  readonly end: { readonly place: string; readonly at?: string };
  /** 每晚住处（天数 − 1 个）：世界编号、车上，或 null（没定）。 */
  readonly lodging: readonly (string | "onBoard" | null)[];
  readonly transfers: readonly (Transfer & { readonly day: number })[];
  readonly visits: readonly Visit[];
  /** 兴趣按原话（编号由卡片按顺序给 i1、i2…）。 */
  readonly interests: readonly Omit<Interest, "id">[];
  readonly travel: { readonly allowed: readonly string[]; readonly prefer: string };
  readonly heldOut?: true;
  readonly expect: {
    /** 每天的站应该在哪些城市（null 不看）。 */
    readonly cities: readonly (readonly string[] | null)[];
    readonly nights: readonly NightExpect[];
    readonly area?: { readonly place: string; readonly nights: readonly number[] };
    /** 要按距离估计车程的交通（第几天的第几趟，从 0 数）。 */
    readonly estimated?: readonly { readonly day: number; readonly index: number }[];
    /** 找不到住处时方案上要说明（“住处未定”）。 */
    readonly unsettledNote?: true;
  };
}

const three = { from: "2026-10-17", to: "2026-10-19" } as const;
const two = { from: "2026-10-17", to: "2026-10-18" } as const;

export const LODGING_CASES: readonly LodgingCase[] = [
  {
    id: "H01", note: "用户实测的成都场景：杭州东站往返坐高铁、没填车次、没说住哪，只想吃火锅、看博物馆",
    dates: three, start: { place: "V21-HZ-EAST" }, end: { place: "V21-HZ-EAST" }, lodging: [null, null],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH" },
      { day: 3, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST" },
    ],
    visits: [], interests: [{ text: "吃火锅" }, { text: "看博物馆" }], travel: PUBLIC,
    expect: {
      cities: [[YL], [YL], [YL]],
      nights: [{ city: YL, segment: "A" }, { city: YL, segment: "A" }],
      estimated: [{ day: 1, index: 0 }, { day: 3, index: 0 }],
    },
  },
  {
    id: "H02", note: "只定了第 1 晚、第 2 晚没定，同城：第 2 晚跟第 1 晚同一家",
    dates: three, start: { place: "Y-SOUTH", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: ["Y-HOTEL-TOWN", null],
    transfers: [],
    visits: [
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
      { place: "Y-SNACK", role: "optional", stayMinutes: 60 },
    ],
    interests: [], travel: PUBLIC,
    expect: { cities: [[YL], [YL], [YL]], nights: [{ given: "Y-HOTEL-TOWN" }, { same: 1 }] },
  },
  {
    id: "H03", note: "两城出游、住处全没定：杭州一晚、云岭两晚，应两段、两家",
    dates: { from: "2026-10-15", to: "2026-10-18" }, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" },
    lodging: [null, null, null],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "V21-STREET", role: "required", stayMinutes: 60 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
    ],
    interests: [], travel: PUBLIC,
    expect: {
      cities: [[HZ], [HZ, YL], [YL], [YL]],
      nights: [{ city: HZ, segment: "A" }, { city: YL, segment: "B" }, { city: YL, segment: "B" }],
    },
  },
  {
    id: "H04", note: "只说了区域：住古镇附近（不能当成兴趣排成一站）",
    dates: two, start: { place: "Y-SOUTH", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: [null],
    transfers: [],
    visits: [{ place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 }],
    interests: [{ text: "住古镇附近" }], travel: PUBLIC,
    expect: { cities: [[YL], [YL]], nights: [{ city: YL, segment: "A" }], area: { place: "Y-TOWN", nights: [1] } },
  },
  {
    id: "H05", note: "用户给了全部住处：不能动，也不另找",
    dates: three, start: { place: "Y-SOUTH", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: ["Y-HOTEL", "Y-INN"],
    transfers: [],
    visits: [
      { place: "Y-GATE", role: "required", stayMinutes: 300, estimate: true }, { place: "Y-TOWN", role: "required", stayMinutes: 150 },
      { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
    ],
    interests: [], travel: { allowed: ["walking", "taxi", "driving"], prefer: "balanced" },
    expect: { cities: [[YL], [YL], [YL]], nights: [{ given: "Y-HOTEL" }, { given: "Y-INN" }] },
  },
  {
    id: "H06", note: "第 1 晚在过夜车上（不定住处），第 2 晚没定",
    dates: three, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: ["onBoard", null],
    transfers: [{ day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "21:00", arriveAt: "07:00", arriveDay: "next", confirmed: true }],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
    ],
    interests: [], travel: PUBLIC,
    expect: { cities: [[HZ], [YL], [YL]], nights: ["onBoard", { city: YL, segment: "A" }] },
  },
  {
    id: "H07", note: "一天的出游：没有住处，不触发",
    dates: { from: "2026-10-17", to: "2026-10-17" }, start: { place: "Y-SOUTH", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" },
    lodging: [], transfers: [],
    visits: [{ place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 }],
    interests: [], travel: PUBLIC,
    expect: { cities: [[YL]], nights: [] },
  },
  {
    id: "H08", note: "那个城市搜不到住宿（岚溪）：退回车站、说明，不编造",
    dates: two, start: { place: "V21-HZ-EAST" }, end: { place: "V21-HZ-EAST" }, lodging: [null],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "L-STATION", departAt: "07:00", arriveAt: "10:30" },
      { day: 2, mode: "train", from: "L-STATION", to: "V21-HZ-EAST", departAt: "16:00", arriveAt: "19:30" },
    ],
    visits: [{ place: "L-FLOWER", role: "required", stayMinutes: 120 }, { place: "L-TOWN", role: "required", stayMinutes: 120 }],
    interests: [], travel: PUBLIC,
    expect: { cities: [[LX], [LX]], nights: ["none"], unsettledNote: true },
  },
  {
    id: "H09", note: "长途只填了一边：去程只填出发、回程只填到达，另一边按距离估计",
    dates: two, start: { place: "V21-HZ-EAST" }, end: { place: "V21-HZ-EAST" }, lodging: ["Y-HOTEL-SOUTH"],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "07:00" },
      { day: 2, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST", arriveAt: "21:00" },
    ],
    visits: [{ place: "Y-MUSEUM", role: "required", stayMinutes: 90 }, { place: "Y-TOWN", role: "required", stayMinutes: 120 }],
    interests: [], travel: PUBLIC,
    expect: { cities: [[YL], [YL]], nights: [{ given: "Y-HOTEL-SOUTH" }], estimated: [{ day: 1, index: 0 }, { day: 2, index: 0 }] },
  },
  {
    id: "H10", note: "留出：四天往返、没填车次、只有兴趣（中心点用进城的车站）", heldOut: true,
    dates: { from: "2026-10-15", to: "2026-10-18" }, start: { place: "V21-HZ-EAST", at: "07:00" }, end: { place: "V21-HZ-EAST" },
    lodging: [null, null, null],
    transfers: [
      { day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH" },
      { day: 4, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST" },
    ],
    visits: [], interests: [{ text: "吃火锅" }, { text: "喝茶" }, { text: "喝咖啡" }], travel: PUBLIC,
    expect: {
      cities: [[YL], [YL], [YL], [YL]],
      nights: [{ city: YL, segment: "A" }, { city: YL, segment: "A" }, { city: YL, segment: "A" }],
      estimated: [{ day: 1, index: 0 }, { day: 4, index: 0 }],
    },
  },
  {
    id: "H11", note: "留出：两城，用户只给了云岭第 2 晚，第 3 晚跟它同一家，杭州那晚另找", heldOut: true,
    dates: { from: "2026-10-15", to: "2026-10-18" }, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" },
    lodging: [null, "Y-INN", null],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "V21-TEA", role: "optional", stayMinutes: 60 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-SNACK", role: "optional", stayMinutes: 60 },
    ],
    interests: [], travel: PUBLIC,
    expect: {
      cities: [[HZ], [HZ, YL], [YL], [YL]],
      nights: [{ city: HZ, segment: "A" }, { given: "Y-INN" }, { same: 2 }],
    },
  },
  {
    id: "H12", note: "留出：两城、只说了“住湖滨附近”——只管杭州那晚，云岭那晚照常找", heldOut: true,
    dates: three, start: { place: "V21-SQUARE", at: "09:00" }, end: { place: "Y-SOUTH", at: "18:00" }, lodging: [null, null],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "V21-PARK", role: "optional", stayMinutes: 60 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
    ],
    interests: [{ text: "住湖滨附近" }], travel: PUBLIC,
    expect: {
      cities: [[HZ], [HZ, YL], [YL]],
      nights: [{ city: HZ, segment: "A" }, { city: YL, segment: "B" }],
      area: { place: "V21-MALL", nights: [1] },
    },
  },
];

export function lodgingDatasetDigest(): string {
  return createHash("sha256").update(JSON.stringify(LODGING_CASES)).digest("hex");
}
