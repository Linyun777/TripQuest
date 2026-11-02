import { createHash } from "node:crypto";

/**
 * V2.11 出游的规划层题集（stages/V2.11.md §4.4–4.7），写在实现之前，锁定后不改。输入按评测世界的地点编号写，
 * 运行器（第 5、7、8、9 步）再换成产品的规划需求；期望只写判分要看的事实，不写实现细节。
 * 现在的产品没有固定交通、分配、多天生成和跨天调整，这四组题没有可跑的基线。
 *
 * 世界：杭州（东门广场 V21-SQUARE、城东博物馆 V21-MUSEUM、湖滨步行街 V21-STREET、杭州东站 V21-HZ-EAST）、
 * 云岭（云岭南站 Y-SOUTH、云岭站 Y-STATION、云岭机场 Y-AIRPORT、云岭博物馆 Y-MUSEUM、青石古镇 Y-TOWN、
 * 云岭山 Y-GATE、云岭欢乐谷 Y-PARK、金沙湾海滩 Y-BEACH、渔港海鲜 Y-SEAFOOD、云岭山居酒店 Y-HOTEL、青石客栈 Y-INN）、
 * 岚溪（岚溪花海 L-FLOWER，离云岭约 80 公里）。杭州到云岭约 500 公里，公交不跨城。
 */
export interface Transfer {
  readonly mode: "train" | "flight" | "other";
  readonly from: string;
  readonly to: string;
  /** 不写 = 用户还没填车次。 */
  readonly departAt?: string;
  readonly arriveAt?: string;
  readonly arriveDay?: "same" | "next";
  /** 过夜交通：用户在卡片上确认过。 */
  readonly confirmed?: true;
}
export interface Visit {
  readonly place: string;
  readonly role: "optional" | "required" | "fixed";
  readonly stayMinutes?: number;
  readonly estimate?: true;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly day?: number;
}
export interface Interest {
  readonly id: string;
  readonly text: string;
  readonly when?: "morning" | "noon" | "afternoon" | "dusk" | "evening";
  /** 评测城市编码：只在这个城市找。 */
  readonly city?: string;
  readonly day?: number;
  readonly perDay?: true;
}
const BY_CAR = { allowed: ["walking", "taxi", "driving"], prefer: "balanced" } as const;
const WALK_TRANSIT = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" } as const;
const HZ = "330100";
const YL = "990100";

/** 4.4 一天里的固定交通：整天独立校验、交通时间不被挤占、两段的地点在各自的城市。 */
export interface TransferDayCase {
  readonly id: string;
  readonly note: string;
  readonly date: string;
  readonly window: { readonly startsAt: string; readonly endsAt: string };
  readonly start: string;
  readonly end: string;
  readonly transfers: readonly Transfer[];
  readonly visits: readonly Visit[];
  readonly interests: readonly Interest[];
  readonly travel: { readonly allowed: readonly string[]; readonly prefer: string };
  readonly expect: "draft" | "no_plan" | "needs_confirmation";
  /** 必须排在第一段交通之前 / 最后一段交通之后的地点。 */
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  /** 两段交通之间（到达城市里）的地点。 */
  readonly middle?: readonly string[];
  /** 交通前这段太短：一个地点都不排，只排到站。 */
  readonly nothingBefore?: true;
  /** 方案里要写明车次时间是估计的。 */
  readonly estimatedNoted?: true;
  /** 到得早（08:00 前）时要有提示，不在 08:00 前硬塞地点。 */
  readonly earlyNoted?: true;
  readonly heldOut?: true;
}
const day = "2026-10-17";
export const TRANSFER_DAY_CASES: readonly TransferDayCase[] = [
  {
    id: "F01", note: "上午杭州看展，12 点高铁，下午云岭逛古镇", date: day, window: { startsAt: "09:00", endsAt: "19:00" },
    start: "V21-SQUARE", end: "Y-INN", travel: BY_CAR,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "Y-TOWN", role: "required", stayMinutes: 120 }],
    interests: [], expect: "draft", before: ["V21-MUSEUM"], after: ["Y-TOWN"],
  },
  {
    id: "F02", note: "早班飞机：前段太短，只排到机场", date: day, window: { startsAt: "06:00", endsAt: "20:00" },
    start: "Y-HOTEL", end: "V21-SQUARE", travel: BY_CAR,
    transfers: [{ mode: "flight", from: "Y-AIRPORT", to: "V21-HZ-EAST", departAt: "08:00", arriveAt: "09:40" }],
    visits: [{ place: "Y-TOWN", role: "optional", stayMinutes: 60 }], interests: [{ id: "i1", text: "逛逛湖滨", city: HZ }],
    expect: "draft", nothingBefore: true,
  },
  {
    id: "F03", note: "一天两段固定交通：杭州 → 云岭 → 杭州", date: day, window: { startsAt: "07:00", endsAt: "22:00" },
    start: "V21-SQUARE", end: "V21-SQUARE", travel: BY_CAR,
    transfers: [
      { mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "08:00", arriveAt: "10:30" },
      { mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST", departAt: "17:00", arriveAt: "19:30" },
    ],
    visits: [{ place: "Y-MUSEUM", role: "required", stayMinutes: 120 }], interests: [{ id: "i1", text: "吃海鲜", when: "noon", city: YL }],
    expect: "draft", middle: ["Y-MUSEUM"],
  },
  {
    id: "F04", note: "车次时间空着：按中午到达估计并写明", date: day, window: { startsAt: "09:00", endsAt: "20:00" },
    start: "V21-SQUARE", end: "Y-INN", travel: BY_CAR,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH" }],
    visits: [{ place: "Y-TOWN", role: "required", stayMinutes: 120 }], interests: [],
    expect: "draft", after: ["Y-TOWN"], estimatedNoted: true,
  },
  {
    id: "F05", note: "赶不上车：前段排不开，照实说", date: day, window: { startsAt: "09:00", endsAt: "20:00" },
    start: "V21-SQUARE", end: "Y-INN", travel: BY_CAR,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "10:00", arriveAt: "12:30" }],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 120 }], interests: [], expect: "no_plan",
  },
  {
    id: "F06", note: "自驾跨城市：不切段，路程照常实查", date: day, window: { startsAt: "08:00", endsAt: "20:00" },
    start: "Y-STATION", end: "Y-STATION", travel: BY_CAR, transfers: [],
    visits: [{ place: "L-FLOWER", role: "required", stayMinutes: 150 }, { place: "Y-SEAFOOD", role: "optional", stayMinutes: 60 }],
    interests: [], expect: "draft",
  },
  {
    id: "F07", note: "过夜交通没确认：不能开始规划", date: day, window: { startsAt: "09:00", endsAt: "23:00" },
    start: "V21-SQUARE", end: "V21-HZ-EAST", travel: WALK_TRANSIT,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "21:30", arriveAt: "06:10", arriveDay: "next" }],
    visits: [], interests: [{ id: "i1", text: "逛湖滨" }], expect: "needs_confirmation",
  },
  {
    id: "F08", note: "过夜交通确认后：出发那天在车站结束", date: day, window: { startsAt: "09:00", endsAt: "23:00" },
    start: "V21-SQUARE", end: "V21-HZ-EAST", travel: WALK_TRANSIT,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "21:30", arriveAt: "06:10", arriveDay: "next", confirmed: true }],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 90 }], interests: [{ id: "i1", text: "逛湖滨", when: "afternoon" }],
    expect: "draft", before: ["V21-MUSEUM"],
  },
  {
    id: "F09", note: "留出：夜车第二天 06:10 到：提示到得早，不在 8 点前硬塞景点", date: "2026-10-18", window: { startsAt: "06:10", endsAt: "20:00" },
    start: "Y-SOUTH", end: "Y-HOTEL", travel: BY_CAR, transfers: [],
    visits: [{ place: "Y-TOWN", role: "required", stayMinutes: 120 }], interests: [{ id: "i1", text: "吃早饭", when: "morning" }],
    expect: "draft", earlyNoted: true, heldOut: true,
  },
  {
    id: "F10", note: "留出：下午到站，在到达城市的车站附近找吃的", date: day, window: { startsAt: "09:00", endsAt: "20:00" },
    start: "V21-SQUARE", end: "Y-HOTEL", travel: BY_CAR,
    transfers: [{ mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "10:00", arriveAt: "12:30" }],
    visits: [], interests: [{ id: "i1", text: "吃海鲜", when: "afternoon", city: YL }], expect: "draft", after: ["Y-SEAFOOD"], heldOut: true,
  },
];

/** 4.5 分到各天：卡片 → 每天去哪（模型分配 + 代码检查 + 规则兜底，与规则分配对照）。 */
export interface AllocationCase {
  readonly id: string;
  readonly note: string;
  readonly dates: { readonly from: string; readonly to: string };
  readonly dailyWindow?: { readonly startsAt: string; readonly endsAt: string };
  readonly start: { readonly place: string; readonly at?: string };
  readonly end: { readonly place: string; readonly at?: string };
  /** 每晚住处（天数 − 1 个）。 */
  readonly lodging: readonly (string | "onBoard")[];
  readonly transfers: readonly (Transfer & { readonly day: number })[];
  readonly visits: readonly Visit[];
  readonly interests: readonly Interest[];
  readonly notes?: string;
  readonly travel: { readonly allowed: readonly string[]; readonly prefer: string };
  /** 要放在一起的地点；先后（城市编码按天的顺序）。 */
  readonly together?: readonly (readonly [string, string])[];
  readonly cityOrder?: readonly string[];
  /** 应该更轻的天（交通、出发、结束当天，或用户说的）。 */
  readonly lightDays?: readonly number[];
  readonly heldOut?: true;
}
const three = { from: "2026-10-17", to: "2026-10-19" } as const;
const two = { from: "2026-10-17", to: "2026-10-18" } as const;
const ylStart = { place: "Y-SOUTH", at: "09:00" } as const;
export const ALLOCATION_CASES: readonly AllocationCase[] = [
  {
    id: "L01", note: "三天云岭：山、古镇、海边、欢乐谷，按住处远近分", dates: three, start: ylStart, end: { place: "Y-SOUTH", at: "18:00" },
    lodging: ["Y-HOTEL", "Y-INN"], transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-GATE", role: "required", stayMinutes: 300, estimate: true }, { place: "Y-TOWN", role: "required", stayMinutes: 150 },
      { place: "Y-BEACH", role: "required", stayMinutes: 120 }, { place: "Y-PARK", role: "required", stayMinutes: 360, estimate: true },
    ],
  },
  {
    id: "L02", note: "固定事项和指定的天不能挪", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-HOTEL"],
    transfers: [], travel: BY_CAR, interests: [],
    visits: [
      { place: "Y-MUSEUM", role: "fixed", day: 2, startsAt: "14:00", endsAt: "16:00" }, { place: "Y-GATE", role: "required", stayMinutes: 300, day: 3 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-BEACH", role: "optional", stayMinutes: 90 },
    ],
  },
  {
    id: "L03", note: "装不下：欢乐谷 6 小时和山 5 小时不能放同一天", dates: two, start: ylStart, end: { place: "Y-SOUTH", at: "19:00" },
    lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [],
    visits: [{ place: "Y-PARK", role: "required", stayMinutes: 360 }, { place: "Y-GATE", role: "required", stayMinutes: 300 }],
  },
  {
    id: "L04", note: "跨城市：杭州两天、云岭一天，中间坐高铁；杭州的放杭州的天", dates: three, start: { place: "V21-SQUARE", at: "09:00" },
    // v2：第二晚原来住山居酒店：14:30 到站后去古镇再回酒店实测要到 20:07，第 3 天又放不下两处，题目本身排不开；改住古镇边的客栈。
    end: { place: "Y-SOUTH", at: "18:00" }, lodging: ["V21-SQUARE", "Y-INN"],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    travel: BY_CAR, interests: [], cityOrder: [HZ, HZ, YL],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "V21-STREET", role: "required", stayMinutes: 60 },
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-GATE", role: "required", stayMinutes: 300 },
    ],
    lightDays: [2],
  },
  {
    id: "L05", note: "每天晚上喝一杯：每天都有", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-INN"],
    transfers: [], travel: BY_CAR, visits: [{ place: "Y-TOWN", role: "required", stayMinutes: 150 }],
    interests: [{ id: "i1", text: "喝一杯", when: "evening", perDay: true }],
  },
  {
    id: "L06", note: "指定城市的兴趣只放进有这个城市的天", dates: three, start: { place: "V21-SQUARE" }, end: { place: "Y-SOUTH" },
    lodging: ["Y-HOTEL", "Y-HOTEL"], travel: BY_CAR, transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "09:00", arriveAt: "11:30" }],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 90 }], interests: [{ id: "i1", text: "吃海鲜", city: YL }], cityOrder: [HZ, YL, YL],
  },
  {
    id: "L07", note: "第一天轻松点", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-HOTEL"],
    transfers: [], travel: BY_CAR, interests: [], notes: "第一天轻松点", lightDays: [1],
    visits: [
      { place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-PARK", role: "required", stayMinutes: 300 },
      { place: "Y-MUSEUM", role: "required", stayMinutes: 90 },
    ],
  },
  {
    id: "L08", note: "X 和 Y 一起：古镇和海鲜同一天", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-INN"],
    transfers: [], travel: BY_CAR, interests: [], notes: "青石古镇和渔港海鲜放一天", together: [["Y-TOWN", "Y-SEAFOOD"]],
    visits: [
      { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-SEAFOOD", role: "required", stayMinutes: 60 },
      { place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-BEACH", role: "required", stayMinutes: 120 },
    ],
  },
  {
    id: "L09", note: "先杭州后云岭（自驾）", dates: three, start: { place: "V21-SQUARE" }, end: { place: "Y-SOUTH" }, lodging: ["V21-SQUARE", "Y-HOTEL"],
    transfers: [], travel: BY_CAR, interests: [], notes: "先杭州后云岭", cityOrder: [HZ, YL, YL],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "Y-TOWN", role: "required", stayMinutes: 150 }, { place: "Y-BEACH", role: "required", stayMinutes: 120 }],
  },
  {
    id: "L10", note: "到达那天只有半天：少放", dates: two, start: { place: "Y-SOUTH", at: "14:00" }, end: { place: "Y-SOUTH", at: "18:00" },
    lodging: ["Y-HOTEL"], transfers: [], travel: BY_CAR, interests: [], lightDays: [1],
    visits: [{ place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 }],
  },
  {
    id: "L11", note: "要赶车那天少放：最后一天 13 点的高铁", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-HOTEL"],
    transfers: [{ day: 3, mode: "train", from: "Y-SOUTH", to: "V21-HZ-EAST", departAt: "13:00", arriveAt: "15:30" }],
    travel: BY_CAR, interests: [], lightDays: [3],
    visits: [{ place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-PARK", role: "required", stayMinutes: 300 }, { place: "Y-MUSEUM", role: "required", stayMinutes: 90 }],
  },
  {
    id: "L12", note: "离住处单程超过 3 小时的不放那天：岚溪花海放住在云岭的天也要能当天往返", dates: two, start: ylStart, end: { place: "Y-SOUTH" },
    lodging: ["Y-INN"], transfers: [], travel: BY_CAR, interests: [],
    visits: [{ place: "L-FLOWER", role: "required", stayMinutes: 150 }, { place: "Y-TOWN", role: "required", stayMinutes: 150 }],
  },
  {
    id: "L13", note: "留出：五天三城（杭州、云岭、岚溪），高铁加自驾", dates: { from: "2026-10-17", to: "2026-10-21" }, start: { place: "V21-SQUARE" },
    end: { place: "Y-SOUTH", at: "17:00" }, lodging: ["V21-SQUARE", "Y-HOTEL", "Y-INN", "Y-INN"], travel: BY_CAR, interests: [],
    transfers: [{ day: 2, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "12:00", arriveAt: "14:30" }],
    visits: [
      { place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "V21-STREET", role: "optional", stayMinutes: 60 },
      { place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-TOWN", role: "required", stayMinutes: 150 },
      { place: "L-FLOWER", role: "required", stayMinutes: 150 }, { place: "Y-BEACH", role: "optional", stayMinutes: 120 },
    ],
    cityOrder: [HZ, HZ, YL, YL, YL], lightDays: [2], heldOut: true,
  },
  {
    id: "L14", note: "留出：只有兴趣没有地点，空余多的天多放", dates: two, start: ylStart, end: { place: "Y-SOUTH", at: "15:00" }, lodging: ["Y-HOTEL"],
    transfers: [], travel: BY_CAR, visits: [],
    interests: [{ id: "i1", text: "看海" }, { id: "i2", text: "逛古镇" }, { id: "i3", text: "吃海鲜" }], lightDays: [2], heldOut: true,
  },
  {
    id: "L15", note: "留出：不出现空的一天", dates: three, start: ylStart, end: { place: "Y-SOUTH" }, lodging: ["Y-HOTEL", "Y-HOTEL"],
    transfers: [], travel: BY_CAR, interests: [],
    visits: [{ place: "Y-MUSEUM", role: "required", stayMinutes: 90 }, { place: "Y-TOWN", role: "required", stayMinutes: 120 }, { place: "Y-BEACH", role: "required", stayMinutes: 90 }],
    heldOut: true,
  },
  {
    id: "L16", note: "留出：夜车那晚不住，第二天从到站开始", dates: three, start: { place: "V21-SQUARE" }, end: { place: "Y-SOUTH" },
    lodging: ["onBoard", "Y-HOTEL"], travel: BY_CAR, interests: [],
    transfers: [{ day: 1, mode: "train", from: "V21-HZ-EAST", to: "Y-SOUTH", departAt: "21:30", arriveAt: "06:10", arriveDay: "next", confirmed: true }],
    visits: [{ place: "V21-MUSEUM", role: "required", stayMinutes: 90 }, { place: "Y-GATE", role: "required", stayMinutes: 300 }, { place: "Y-TOWN", role: "required", stayMinutes: 150 }],
    cityOrder: [HZ, YL, YL], heldOut: true,
  },
];

/** 4.6 出游端到端：卡片 → 分配 → 逐天方案（一天的和多天的）。 */
export interface OutingE2eCase extends AllocationCase {
  /** 期望整趟都排得开。 */
  readonly expect: "all_days" | "some_day_fails";
}
export const OUTING_E2E_CASES: readonly OutingE2eCase[] = [
  { ...ALLOCATION_CASES[0], id: "X01", note: "三天云岭（L01 的卡片）", expect: "all_days" },
  { ...ALLOCATION_CASES[3], id: "X02", note: "杭州两天、高铁去云岭（L04）", expect: "all_days" },
  { ...ALLOCATION_CASES[4], id: "X03", note: "每晚喝一杯（L05）：每天都排上，跨天不重复", expect: "all_days" },
  { ...ALLOCATION_CASES[8], id: "X04", note: "先杭州后云岭自驾（L09）", expect: "all_days" },
  {
    id: "X05", note: "一天的出游：云岭开车去岚溪", dates: { from: "2026-10-17", to: "2026-10-17" }, start: { place: "Y-STATION", at: "08:00" },
    end: { place: "Y-STATION", at: "20:00" }, lodging: [], transfers: [], travel: BY_CAR, interests: [{ id: "i1", text: "吃海鲜", when: "evening", city: YL }],
    visits: [{ place: "L-FLOWER", role: "required", stayMinutes: 150 }], expect: "all_days",
  },
  { ...ALLOCATION_CASES[10], id: "X06", note: "最后一天赶 13 点的高铁（L11）", expect: "all_days" },
  { ...ALLOCATION_CASES[12], id: "X07", note: "留出：五天三城（L13）", expect: "all_days", heldOut: true },
  { ...ALLOCATION_CASES[15], id: "X08", note: "留出：夜车（L16）", expect: "all_days", heldOut: true },
];

/** 4.7 跨天调整与改车次：已保存的出游（按 4.6 的 X01、X02 生成）+ 用户一句话。 */
export interface CrossDayCase {
  readonly id: string;
  readonly note: string;
  /** 用哪一趟出游（4.6 的题号；L02 是带固定事项的那张卡片）。 */
  readonly trip: "X01" | "X02" | "L02";
  /** 现在是第几天、几点。 */
  readonly today: number;
  readonly now: string;
  /** 今天已经完成的站。 */
  readonly done?: readonly string[];
  readonly text: string;
  readonly expect:
    | { readonly move: string; readonly toDay: number }
    | { readonly refused: "fixed" | "done" | "no_room" }
    | { readonly askOnly: true }
    | { readonly transferAt: string; readonly day: number }
    | { readonly lodging: string; readonly days: readonly number[] }
    | { readonly stale: true };
  readonly heldOut?: true;
}
export const CROSS_DAY_CASES: readonly CrossDayCase[] = [
  { id: "M01", note: "没去成的挪到明天", trip: "X01", today: 1, now: "17:30", text: "今天没去成青石古镇，挪到明天吧", expect: { move: "Y-TOWN", toDay: 2 } },
  { id: "M02", note: "固定事项不能挪", trip: "L02", today: 1, now: "10:00", text: "把云岭博物馆的讲座挪到今天", expect: { refused: "fixed" } },
  { id: "M03", note: "只是问问：先说明，不生成", trip: "X01", today: 1, now: "10:00", text: "海滩能不能挪到后天去？", expect: { askOnly: true } },
  { id: "M04", note: "目标日装不下：照实说", trip: "X01", today: 1, now: "10:00", text: "把欢乐谷也放到明天", expect: { refused: "no_room" } },
  { id: "M05", note: "改高铁时间：那天重新切段", trip: "X02", today: 1, now: "20:00", text: "明天去云岭的高铁改成下午3点", expect: { transferAt: "15:00", day: 2 } },
  { id: "M06", note: "改住处：影响前后两天", trip: "X01", today: 1, now: "20:00", text: "明晚改住青石客栈", expect: { lodging: "Y-INN", days: [2, 3] } },
  { id: "M07", note: "留出：已完成的站不能挪", trip: "X01", today: 1, now: "15:00", done: ["Y-GATE"], text: "把云岭山挪到明天", expect: { refused: "done" }, heldOut: true },
  { id: "M08", note: "留出：确认时另一天已经变了：整体拒绝", trip: "X01", today: 1, now: "10:00", text: "今天没去成青石古镇，挪到明天吧", expect: { stale: true }, heldOut: true },
];

export const OUTING_PLAN_VERSION = "v211-outing-plan.v2";
export function outingPlanDigest(): string {
  return createHash("sha256").update(JSON.stringify([TRANSFER_DAY_CASES, ALLOCATION_CASES, OUTING_E2E_CASES, CROSS_DAY_CASES])).digest("hex");
}
