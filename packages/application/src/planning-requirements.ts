import type { PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import { z } from "zod";
import { chinaDate, parseOpenToday, type PlaceHours } from "./opening-hours";
import { KIND_STAYS, PLACE_KINDS } from "./place-kinds";

export const PLANNING_INTERESTS = [
  "culture",
  "nature",
  "city_walk",
  "food",
] as const;
/** 旧版固定兴趣的显示标签，同时也是稳定兴趣身份；新版自由兴趣另用 i 编号。 */
export const PLANNING_INTEREST_LABELS = {
  culture: "展馆 / 文化",
  nature: "自然",
  city_walk: "城市散步",
  food: "餐饮",
} as const;
/** 兼容旧枚举兴趣与新版 i1/i2 自由兴趣，让旧存档和新规划共享契约。 */
export const interestIdSchema = z.union([
  z.enum(PLANNING_INTERESTS),
  z.string().regex(/^i\d{1,2}$/),
]);
/**
 * 时段窗口由代码定义，模型只识别用户想要哪个时段；最终活动停留必须完整落在窗口内。
 * 缺省不限时段，不允许模型自己放宽 evening 等边界。
 */
export const INTEREST_SLOTS = {
  morning: { label: "上午", startsAt: 6 * 60, endsAt: 12 * 60 },
  noon: { label: "中午", startsAt: 11 * 60, endsAt: 14 * 60 },
  afternoon: { label: "下午", startsAt: 12 * 60, endsAt: 18 * 60 },
  dusk: { label: "傍晚", startsAt: 16 * 60 + 30, endsAt: 19 * 60 + 30 },
  evening: { label: "晚上", startsAt: 18 * 60, endsAt: 23 * 60 + 30 },
} as const;
export type InterestSlot = keyof typeof INTEREST_SLOTS;
export const interestSlotSchema = z.enum(Object.keys(INTEREST_SLOTS) as [InterestSlot, ...InterestSlot[]]);
/** 兴趣数量表示实际去几站，默认一站；“多逛几家”可为两到三站，不是多给几个候选。 */
export const interestCountSchema = z.number().int().min(1).max(3);
/** 兴趣时段与整天窗口至少重叠 30 分钟才值得开始规划；实际能否容纳停留仍由排程决定。 */
export const SLOT_MIN_OVERLAP_MINUTES = 30;

export const freeInterestSchema = z.strictObject({
  id: z.string().regex(/^i\d{1,2}$/),
  text: z.string().trim().min(1).max(40),
  when: interestSlotSchema.optional(),
  count: interestCountSchema.optional(),
});

/** 允许方式是可行性边界，prefer 是排序软偏好；旧数据没有该字段时按只步行兼容。 */
export const TRAVEL_MODES = ["walking", "transit", "taxi", "bicycling", "driving"] as const;
export const travelPreferenceSchema = z.strictObject({
  allowed: z.array(z.enum(TRAVEL_MODES)).min(1).max(5),
  prefer: z.enum(["balanced", "fast", "cheap", "less_walking"]),
});
export type TravelPreference = z.infer<typeof travelPreferenceSchema>;
/** 新对话未说交通方式时的推荐：短距离走路，长距离可公交或打车；不同于旧存档的只步行缺省。 */
export const DEFAULT_TRAVEL: TravelPreference = { allowed: ["walking", "transit", "taxi"], prefer: "balanced" };
export const WALKING_ONLY: TravelPreference = { allowed: ["walking"], prefer: "balanced" };

/** V2.10：任何城市（地级市一级的 6 位行政区编码）；之前只能是杭州 330100。 */
export const cityAdcodeSchema = z.string().regex(/^\d{6}$/, "城市编码应为 6 位数字");

/** V2.10：需求的城市；旧快照没有城市名时只可能是杭州。 */
export function requirementsCity(requirements: { cityAdcode: string; cityName?: string }): { adcode: string; name: string } {
  const fallback = requirements.cityAdcode === "330100" ? "杭州市" : requirements.cityAdcode;
  return { adcode: requirements.cityAdcode, name: requirements.cityName ?? fallback };
}

export const planningTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "请输入 HH:mm 格式的同日时间");

const text = (max: number) => z.string().trim().min(1).max(max);

const minuteOfDay = z.number().int().min(0).max(1439);
/** 当天营业窗口只参与本次请求规划，附查询日期，不进入真实地点长期保存。 */
export const placeHoursSchema = z.strictObject({
  date: z.iso.date(),
  windows: z.array(z.strictObject({ startsAt: minuteOfDay, endsAt: minuteOfDay })).min(1).max(6),
});

/**
 * 预处理实时商户详情：当天营业文本解析为带日期的 hours，其余评分、价格等在此剔除。
 * 转换发生在契约解析前，后续代码只能拿到规划真正需要的字段。
 */
function withHours(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("place" in value) || !value.place || typeof value.place !== "object") return value;
  if (!("business" in value.place)) return value;
  const { business, ...place } = value.place as Record<string, unknown>;
  const open = business && typeof business === "object" && "openToday" in business && typeof business.openToday === "string"
    ? parseOpenToday(business.openToday)
    : null;
  const evidence = "evidence" in value ? value.evidence : undefined;
  const retrievedAt = evidence && typeof evidence === "object" && "retrievedAt" in evidence ? evidence.retrievedAt : undefined;
  return {
    ...value,
    place,
    ...(open && typeof retrievedAt === "string" ? { hours: { date: chinaDate(retrievedAt), windows: open } } : {}),
  };
}

/** 这里只验证形状与字段范围；地点是否确实来自可信搜索或签名选择，仍由 Web 边界核验。 */
export const planningPlaceSchema: z.ZodType<{
  place: PlaceSummary;
  evidence: ProviderEvidence;
  hours?: PlaceHours;
}, unknown> = z.preprocess(withHours, z.strictObject({
  place: z.strictObject({
    ref: z.strictObject({ provider: text(80), externalId: text(128) }),
    name: text(200),
    location: z.strictObject({
      longitude: z.number().min(-180).max(180),
      latitude: z.number().min(-90).max(90),
      coordinateSystem: z.literal("gcj02"),
    }),
    cityAdcode: cityAdcodeSchema,
    address: text(500).optional(),
    categoryCode: text(80).optional(),
  }),
  evidence: z.strictObject({
    provider: text(80),
    sourceKind: z.enum(["fixture", "live"]),
    retrievedAt: z.iso.datetime({ offset: true }),
    attribution: text(300),
    datasetVersion: text(80).optional(),
  }),
  hours: placeHoursSchema.optional(),
}));

export const planningVisitSchema = z.discriminatedUnion("role", [
  z.strictObject({
    place: planningPlaceSchema,
    role: z.enum(["optional", "required"]),
    // V2.10：大景区、主题乐园、爬山可以占大半天（之前最多 240）。
    stayMinutes: z.number().int().min(15).max(600),
    /**
     * V2.11：停留是估计的（不是用户说的）：排不下时可以缩到这类地点的下限（stages/V2.11.md §3.2）。
     * 缺省是用户说的，旧数据也按用户说的处理。
     */
    staySource: z.literal("estimate").optional(),
    kind: z.enum(PLACE_KINDS).optional(),
  }),
  z.strictObject({
    place: planningPlaceSchema,
    role: z.literal("fixed"),
    startsAt: planningTimeSchema,
    endsAt: planningTimeSchema,
  }),
]);

export const planningRequirementsSchema = z
  .strictObject({
    schemaVersion: z.literal("planning-requirements.v1"),
    cityAdcode: cityAdcodeSchema,
    /** V2.10：城市名（“成都市”），保存行程时写进行程；旧快照没有，按杭州。 */
    cityName: z.string().trim().min(1).max(40).optional(),
    /** V2.11 出游：不限城市（按兴趣找地点时不去掉邻市的结果）；日常没有这一项，只在所在城市。 */
    anyCity: z.literal(true).optional(),
    /** V2.11 出游逐天生成：前几天按兴趣找到的地点（高德编号），这一天不再找（跨天不重复）。 */
    exclude: z.array(z.string().min(1).max(128)).max(60).optional(),
    timeZone: z.literal("Asia/Shanghai"),
    travelMode: z.literal("walking"),
    date: z.iso
      .date({ error: "请输入真实的 YYYY-MM-DD 日历日期" })
      .refine((date) => !date.startsWith("0000"), "年份必须大于 0"),
    window: z.strictObject({
      startsAt: planningTimeSchema,
      endsAt: planningTimeSchema,
    }),
    startPlace: planningPlaceSchema,
    endPlace: planningPlaceSchema,
    interests: z.array(z.enum(PLANNING_INTERESTS)).max(4),
    /** 来自对话的用户原话兴趣；保留兴趣 ID，供候选搜索、数量与时段约束追踪。 */
    freeInterests: z.array(freeInterestSchema).max(5).optional(),
    /** “别太累”等愿望仅作模型软目标；不能绕过必去、固定时段或路线硬校验。 */
    notes: text(400).optional(),
    /** 旧版未保存交通偏好时按只步行读取；新建对话的默认推荐由上层显式传入。 */
    travel: travelPreferenceSchema.optional(),
    pace: z.enum(["relaxed", "standard"]),
    visits: z.array(planningVisitSchema).max(8, "最多添加 8 个活动地点"),
  })
  // Zod 字段校验之后补跨字段约束：同日时间顺序、唯一兴趣/方式、固定事项与整天窗口的一致性。
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const start = minutes(value.window.startsAt);
    const end = minutes(value.window.endsAt);
    if (start >= end)
      issue(["window", "endsAt"], "结束必须晚于出发，且不能跨午夜");
    if (new Set(value.interests).size !== value.interests.length) {
      issue(["interests"], "兴趣不能重复");
    }
    if (value.travel && new Set(value.travel.allowed).size !== value.travel.allowed.length) {
      issue(["travel", "allowed"], "出行方式不能重复");
    }
    if (value.freeInterests && new Set(value.freeInterests.map((item) => item.id)).size !== value.freeInterests.length) {
      issue(["freeInterests"], "兴趣编号不能重复");
    }
    if (value.visits.length === 0 && value.interests.length === 0 && !value.freeInterests?.length) {
      issue(["interests"], "没有活动地点时，请至少选择一项兴趣");
    }
    // 兴趣时段先检查与整天窗口是否有最小重叠；具体站的路线和停留留给领域层验证。
    const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    if (/^\d{2}:\d{2}$/.test(value.window.startsAt) && /^\d{2}:\d{2}$/.test(value.window.endsAt)) {
      const window = { startsAt: toMinutes(value.window.startsAt), endsAt: toMinutes(value.window.endsAt) };
      value.freeInterests?.forEach((item, index) => {
        if (item.when && slotOverlapMinutes(item.when, window) < SLOT_MIN_OVERLAP_MINUTES) {
          issue(["freeInterests", index, "when"], `“${item.text}”在${INTEREST_SLOTS[item.when].label}，不在这一天的时间范围内`);
        }
      });
    }

    const seen = new Set<string>();
    const fixed: { index: number; start: number; end: number }[] = [];
    let requiredCount = 0;
    let requiredMinutes = 0;
    for (const [index, visit] of value.visits.entries()) {
      const key = planningPlaceKey(visit.place);
      if (seen.has(key))
        issue(["visits", index, "place"], "该地点已在活动列表中，请编辑原项");
      seen.add(key);
      if (visit.role !== "optional") requiredCount += 1;
      if (visit.role !== "fixed") {
        // V2.11：估计的停留排不下时可以缩短，这里按能缩到的下限算。
        if (visit.role === "required") requiredMinutes += estimatedFloor(visit) ?? visit.stayMinutes;
        continue;
      }
      const from = minutes(visit.startsAt);
      const to = minutes(visit.endsAt);
      if (from >= to)
        issue(["visits", index, "endsAt"], "固定事项结束必须晚于开始");
      if (from < start || to > end) {
        issue(
          ["visits", index, "startsAt"],
          `固定事项 ${visit.startsAt}–${visit.endsAt} 须在出行时段内`,
        );
      }
      requiredMinutes += Math.max(0, to - from);
      fixed.push({ index, start: from, end: to });
    }
    if (fixed.length > 2) issue(["visits"], "固定事项最多 2 个");
    if (requiredCount > 6) issue(["visits"], "必去与固定事项合计最多 6 个");
    fixed.sort((a, b) => a.start - b.start);
    for (let index = 1; index < fixed.length; index += 1) {
      if (fixed[index].start < fixed[index - 1].end) {
        const visit = value.visits[fixed[index].index];
        issue(
          ["visits", fixed[index].index, "startsAt"],
          `固定事项 ${visit.role === "fixed" ? `${visit.startsAt}–${visit.endsAt}` : ""} 与另一固定事项重叠`,
        );
      }
    }
    if (end > start && requiredMinutes > end - start) {
      issue(["visits"], "必去预计停留与固定事项占用时间已超过出行窗口");
    }
  });

export type PlanningPlace = z.infer<typeof planningPlaceSchema>;
export type PlanningRequirements = z.infer<typeof planningRequirementsSchema>;
export type PlanningInterest = (typeof PLANNING_INTERESTS)[number];
export type PlanningInterestId = z.infer<typeof interestIdSchema>;
export type PlanningInterestSpec = {
  readonly id: PlanningInterestId;
  readonly text: string;
  readonly when?: InterestSlot;
  readonly count?: number;
};

/** 兴趣对应的整段访问窗口，开始和结束均须落在其中；不限时段则不生成 within。 */
export function interestWithin(spec: PlanningInterestSpec | undefined): { startsAt: number; endsAt: number } | undefined {
  if (!spec?.when) return undefined;
  const slot = INTEREST_SLOTS[spec.when];
  return { startsAt: slot.startsAt, endsAt: slot.endsAt };
}

/** 计算半开时间窗的交集分钟数，作为需求预检，不把“有重叠”直接当成行程能排下。 */
export function slotOverlapMinutes(when: InterestSlot, window: { startsAt: number; endsAt: number }): number {
  const slot = INTEREST_SLOTS[when];
  return Math.max(0, Math.min(slot.endsAt, window.endsAt) - Math.max(slot.startsAt, window.startsAt));
}

export function planningTravel(requirements: PlanningRequirements): TravelPreference {
  return requirements.travel ?? WALKING_ONLY;
}

/** 把旧固定标签与新自由文本统一成规划器可搜索的兴趣列表；调用方不必复制兼容逻辑。 */
export function planningInterestSpecs(requirements: PlanningRequirements): PlanningInterestSpec[] {
  return [
    ...requirements.interests.map((id) => ({ id, text: PLANNING_INTEREST_LABELS[id] })),
    ...(requirements.freeInterests ?? []),
  ];
}
export type PlanningFieldErrors = Record<string, string[]>;

export function planningPlaceKey(selection: PlanningPlace): string {
  return JSON.stringify([
    selection.place.ref.provider,
    selection.place.ref.externalId,
  ]);
}

export function validatePlanningRequirements(
  input: unknown,
):
  | { success: true; requirements: PlanningRequirements }
  | { success: false; fieldErrors: PlanningFieldErrors } {
  const parsed = planningRequirementsSchema.safeParse(input);
  if (parsed.success) return { success: true, requirements: parsed.data };
  const fieldErrors: PlanningFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join(".") || "form";
    const message =
      issue.code === "unrecognized_keys"
        ? "输入包含不支持的字段"
        : issue.message;
    (fieldErrors[path] ??= []).push(message);
  }
  return { success: false, fieldErrors };
}

function minutes(value: string): number {
  const [hours, minute] = value.split(":").map(Number);
  return hours * 60 + minute;
}

/** V4.2（stages/V4.2.md §3.1）：固定事项离这一天的开始不到这么多分钟时，这天提前出门。 */
export const EARLY_FIXED_LEAD_MINUTES = 90;
/** 提前出门最早到 06:00。 */
export const EARLIEST_DAY_START = 6 * 60;

/**
 * V4.2：早上的固定事项（“9 点在博物馆有预约”）离这一天的开始不到 90 分钟时，这天改成从“固定事项开始前 90 分钟”
 * 开始（最早 06:00），留出从住处 / 起点过去的路程；不早于原来的开始就不改。出游（outingFrames）和日常
 * （withEarlyStart）共用这一条规则。
 */
export function earlyStart<T extends { readonly startsAt: number }>(
  startsAt: number,
  fixed: readonly T[],
): { readonly startsAt: number; readonly fixed: T } | null {
  const first = [...fixed].sort((a, b) => a.startsAt - b.startsAt)[0];
  if (!first || first.startsAt - startsAt >= EARLY_FIXED_LEAD_MINUTES) return null;
  const moved = Math.max(EARLIEST_DAY_START, first.startsAt - EARLY_FIXED_LEAD_MINUTES);
  return moved < startsAt ? { startsAt: moved, fixed: first } : null;
}

/** V4.2：日常一日规划的时间窗按 earlyStart 提前（卡片不变；保存时从这份需求重建，前后一致）。 */
export function withEarlyStart(requirements: PlanningRequirements): PlanningRequirements {
  const fixed = requirements.visits.flatMap((visit) => (visit.role === "fixed" ? [{ startsAt: minutes(visit.startsAt) }] : []));
  const early = earlyStart(minutes(requirements.window.startsAt), fixed);
  if (!early) return requirements;
  const startsAt = `${String(Math.floor(early.startsAt / 60)).padStart(2, "0")}:${String(early.startsAt % 60).padStart(2, "0")}`;
  return { ...requirements, window: { ...requirements.window, startsAt } };
}

/** V2.11：估计的停留最短能缩到多少（这类地点的下限，不高于原估计）；用户说的返回 undefined。 */
export function estimatedFloor(visit: { readonly stayMinutes: number; readonly staySource?: "estimate"; readonly kind?: keyof typeof KIND_STAYS }): number | undefined {
  if (visit.staySource !== "estimate") return undefined;
  // 没给类型时，估计 4 小时以上的按大景区算（下限 3 小时），免得把主题乐园缩到半小时。
  const kind = visit.kind ?? (visit.stayMinutes >= 240 ? "big_scenic" : "other");
  return Math.min(visit.stayMinutes, KIND_STAYS[kind][0]);
}
