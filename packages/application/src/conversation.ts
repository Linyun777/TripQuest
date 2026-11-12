import { z } from "zod";
import { suggestionFixSchema } from "./outing-review-contract";
import { PLACE_KINDS } from "./place-kinds";
import { preferenceCategorySchema, preferenceTextSchema } from "./preferences";
import {
  INTEREST_SLOTS,
  SLOT_MIN_OVERLAP_MINUTES,
  interestCountSchema,
  interestSlotSchema,
  planningTimeSchema,
  slotOverlapMinutes,
  travelPreferenceSchema,
  type InterestSlot,
} from "./planning-requirements";

/**
 * 对话持续整理的需求草稿和消息持久化契约。
 * 地点仅保留高德 ID 与名称；坐标、地址、路线和天气由展示或规划时实时查询，不在这里缓存。
 */

export const DRAFT_LIMITS = {
  visits: 8,
  protectedVisits: 6,
  fixedVisits: 2,
  interests: 5,
  /** V2.11 出游（stages/V2.11.md §3.3）：1–7 天，地点 24 个、兴趣 12 个、固定交通 6 段。 */
  outingDays: 7,
  outingVisits: 24,
  outingInterests: 12,
  transports: 6,
  interestChars: 40,
  notesChars: 200,
  mentionChars: 30,
  /** V3.3：只说了区域的住宿要求，最多几处、每处几个字。 */
  lodgingAreas: 3,
  lodgingAreaChars: 20,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const externalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const placeName = text(80);
const visitKey = z.string().regex(/^v\d{1,2}$/);
const interestId = z.string().regex(/^i\d{1,2}$/);

/** V2.10：地点所属城市（地级市一级的行政区编码，行政区信息，不是高德地点数据）。 */
const cityCode = z.string().regex(/^\d{6}$/);
export const draftChoiceSchema = z.strictObject({ externalId, name: placeName, city: cityCode.optional() });

/**
 * 地点分为已绑定、待用户选同名候选、待授权当前位置三种状态。
 * 由定位解析的 bound 只保留最近地点并标 nearby，不保存设备精确坐标，也不把未授权位置当已绑定。
 */
export const draftPlaceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("bound"), externalId, name: placeName, nearby: z.literal(true).optional(), city: cityCode.optional() }),
  z.strictObject({ status: z.literal("current") }),
  z.strictObject({
    status: z.literal("choose"),
    mention: text(DRAFT_LIMITS.mentionChars),
    choices: z.array(draftChoiceSchema).min(2).max(3),
  }),
]);
export type DraftPlace = z.infer<typeof draftPlaceSchema>;

export const draftVisitSchema = z.strictObject({
  key: visitKey,
  place: draftPlaceSchema,
  role: z.enum(["optional", "required", "fixed"]),
  stayMinutes: z.number().int().min(15).max(600).nullable(),
  /**
   * V2.11：停留是估计的（Agent 按地点类型估，卡片上显示“估计”），排不下时可以缩短；缺省是用户说的
   * （旧草稿也按用户说的）。kind 是估计时的地点类型，决定最短能缩到多少。
   */
  staySource: z.literal("estimate").optional(),
  kind: z.enum(PLACE_KINDS).optional(),
  startsAt: planningTimeSchema.nullable(),
  endsAt: planningTimeSchema.nullable(),
  /** V2.11 出游：放在第几天（不写由分配决定）；固定事项必须写。 */
  day: z.number().int().min(1).max(DRAFT_LIMITS.outingDays).optional(),
});
export type DraftVisit = z.infer<typeof draftVisitSchema>;

/**
 * V2.10：卡片的主要城市（stages/V2.10.md §3.1）。来源：located（打开页面时定位）、said（对话里明说）、
 * places（卡片上的地点大多在这个城市）。没有时就是杭州，也表示不知道用户在哪（没有授权定位）。
 */
export const draftCitySchema = z.strictObject({
  adcode: cityCode,
  name: text(40),
  source: z.enum(["located", "said", "places"]).optional(),
});
export type DraftCity = z.infer<typeof draftCitySchema>;
export const DEFAULT_CITY: DraftCity = { adcode: "330100", name: "杭州市" };

const dayNumber = z.number().int().min(1).max(DRAFT_LIMITS.outingDays);
const transportId = z.string().regex(/^t\d{1,2}$/);

/**
 * V2.11 出游的固定交通（用户给的高铁、航班等，§3.3–3.4）：起止是高德地点，时间可以先空着；
 * arriveDay 是 next 时是过夜交通，那一晚在车上，要用户在卡片上确认（overnightConfirmed）才能开始规划。
 */
export const outingTransportSchema = z.strictObject({
  id: transportId,
  day: dayNumber,
  mode: z.enum(["train", "flight", "other"]),
  from: draftPlaceSchema.nullable(),
  to: draftPlaceSchema.nullable(),
  departAt: planningTimeSchema.nullable(),
  arriveAt: planningTimeSchema.nullable(),
  arriveDay: z.enum(["same", "next"]),
  overnightConfirmed: z.literal(true).optional(),
  /**
   * V3.6：代码补的部分（卡片上写“暂定”，stages/V3.6.md §3.2–3.3）。ride 是这一趟是代码补的；from / to 是这一端的车站
   * 是按高德结果暂定的，others 是“换一个”的候选（最多 2 个）。用户改了哪部分，哪部分就是用户的，不再标。
   */
  suggested: z.strictObject({
    ride: z.literal(true).optional(),
    /** V4.3：这趟的日子是代码按“住在哪”挪的（stages/V4.3.md §3.4）。 */
    day: z.literal(true).optional(),
    from: z.strictObject({ others: z.array(draftChoiceSchema).max(2) }).optional(),
    to: z.strictObject({ others: z.array(draftChoiceSchema).max(2) }).optional(),
  }).optional(),
});
export type OutingTransport = z.infer<typeof outingTransportSchema>;

/** V2.11 出游卡片里日常没有的部分：日期范围、出发与结束时刻、每天的时间窗、每晚住处、固定交通。 */
export const outingDraftSchema = z.strictObject({
  dates: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  /** 第一天几点出发、最后一天几点前到；不写按每天的时间窗。 */
  startAt: planningTimeSchema.nullable(),
  endAt: planningTimeSchema.nullable(),
  dailyWindow: z.strictObject({ startsAt: planningTimeSchema, endsAt: planningTimeSchema }),
  /**
   * 第 night 晚住哪；place 为空是还没定；onBoard 是这一晚在过夜交通上（不能再填住处）。V3.3：source 是 suggested 时
   * 是系统按高德结果暂定的（卡片上写“暂定”，用户可以换）；不写就是用户给的。V3.6：others 是暂定时没选上的候选
   * （开始规划前把等用户选的先取第一个，其余留着“换一个”）。
   */
  lodging: z.array(z.strictObject({
    night: dayNumber,
    place: draftPlaceSchema.nullable(),
    onBoard: z.literal(true).optional(),
    source: z.literal("suggested").optional(),
    others: z.array(draftChoiceSchema).max(2).optional(),
  })).max(DRAFT_LIMITS.outingDays - 1),
  /** V3.3：只说了区域的住宿要求（“住春熙路附近”），由代码从兴趣里认出来；暂定住处在那一带找。 */
  lodgingAreas: z.array(z.strictObject({ text: text(DRAFT_LIMITS.lodgingAreaChars) })).max(DRAFT_LIMITS.lodgingAreas).optional(),
  /**
   * V4.3：哪几晚住在哪个城市（stages/V4.3.md §3.1），只存城市编码和名称。由代码从用户原话认出来（source said）；
   * 有住处的那晚以住处的城市为准。
   */
  stays: z.array(z.strictObject({
    nights: z.array(dayNumber).min(1).max(DRAFT_LIMITS.outingDays - 1),
    city: z.strictObject({ adcode: cityCode, name: text(40) }),
    source: z.literal("said").optional(),
  })).max(DRAFT_LIMITS.outingDays - 1).optional(),
  transports: z.array(outingTransportSchema).max(DRAFT_LIMITS.transports),
  /**
   * V2.11 分到各天（§3.6）：每天去哪（地点 key、兴趣 id）和一句理由；problems 是代码检查发现的问题（用户移动后
   * 可能有）。改了日期、住处、交通、地点或兴趣就作废，要重新分。只存编号和理由，不存地点数据。
   */
  allocation: z.strictObject({
    days: z.array(z.strictObject({
      day: dayNumber,
      visits: z.array(visitKey).max(DRAFT_LIMITS.outingVisits),
      interests: z.array(interestId).max(DRAFT_LIMITS.outingInterests),
      reason: text(80).optional(),
    })).max(DRAFT_LIMITS.outingDays),
    source: z.enum(["model", "rules"]),
    problems: z.array(text(200)).max(8),
    /** 模型的分配每次被检查出的问题（“#1 …”是第 1 次）：查打回是检查太严还是输出有问题，页面不显示。 */
    rejected: z.array(text(200)).max(8).optional(),
  }).optional(),
  /** V3.2：这几天不自驾（车留在别的城市；用户采纳审查建议时加上）。 */
  noDriving: z.array(dayNumber).max(DRAFT_LIMITS.outingDays).optional(),
});
export type OutingDraft = z.infer<typeof outingDraftSchema>;
export const DEFAULT_DAILY_WINDOW = { startsAt: "09:00", endsAt: "20:00" } as const;

export const requirementsDraftSchema = z.strictObject({
  version: z.literal("requirements-draft.v1"),
  city: draftCitySchema.optional(),
  date: z.iso.date().nullable(),
  startsAt: planningTimeSchema.nullable(),
  endsAt: planningTimeSchema.nullable(),
  start: draftPlaceSchema.nullable(),
  end: draftPlaceSchema.nullable(),
  // 日常 8 个地点、5 个兴趣，出游 24 个、12 个；按模式的上限在 draftProblem 里查。
  visits: z.array(draftVisitSchema).max(DRAFT_LIMITS.outingVisits),
  /** when 表示访问时段，缺省不限；count 表示实际访问站数，缺省一站，不是展示多少候选。 */
  interests: z.array(z.strictObject({
    id: interestId,
    text: text(DRAFT_LIMITS.interestChars),
    when: interestSlotSchema.optional(),
    count: interestCountSchema.optional(),
    /** V2.11 出游：放在第几天、每天都要（“每天晚上喝一杯”）、只在某个城市找（“在成都吃火锅”）。 */
    day: dayNumber.optional(),
    perDay: z.literal(true).optional(),
    city: z.strictObject({ adcode: cityCode, name: text(40) }).optional(),
  })).max(DRAFT_LIMITS.outingInterests),
  pace: z.enum(["relaxed", "standard"]),
  notes: text(DRAFT_LIMITS.notesChars).nullable(),
  /** 用户允许的方式与偏好；旧草稿缺省时由对话卡片展示当前默认推荐。 */
  travel: travelPreferenceSchema.optional(),
  /**
   * short 表示今天出发、逐兴趣挑站；只有明确设置 end 才返程，缺省是一日规划模式。
   * V2.11：outing 是出游（由用户在页面上切换，模型不能改），这时 outing 字段必填，日常的 date / startsAt / endsAt 不用。
   */
  mode: z.enum(["short", "outing"]).optional(),
  outing: outingDraftSchema.optional(),
  /**
   * V4.4：用户说过的日期（stages/V4.4.md §3.1），由代码从原话认出来（日常只有 from）；只说了出发或回来那天的，另一头为空。
   * 模型在用户没说新日期的一轮里改了日期，代码打回、仍改则改回。datesGuessed：卡片上的日期是模型定的（用户没说过哪天），
   * 卡片上写“暂定”。补丁不能改这两项。
   */
  saidDates: z.strictObject({ from: z.iso.date().nullable(), to: z.iso.date().nullable() }).optional(),
  datesGuessed: z.literal(true).optional(),
});
export type RequirementsDraft = z.infer<typeof requirementsDraftSchema>;

export function emptyDraft(): RequirementsDraft {
  return {
    version: "requirements-draft.v1",
    date: null,
    startsAt: null,
    endsAt: null,
    start: null,
    end: null,
    visits: [],
    interests: [],
    pace: "standard",
    notes: null,
  };
}

/** V2.11：出游卡片的初始状态（用户在页面上选了出游）；城市是打开页面时定位得到的。 */
export function emptyOutingDraft(city?: DraftCity): RequirementsDraft {
  return {
    ...emptyDraft(),
    ...(city ? { city } : {}),
    mode: "outing",
    outing: { dates: null, startAt: null, endAt: null, dailyWindow: { ...DEFAULT_DAILY_WINDOW }, lodging: [], transports: [] },
  };
}

/** V2.11：出游一共几天（还没定日期为 0）。 */
export function outingDays(outing: OutingDraft): number {
  if (!outing.dates) return 0;
  return Math.round((Date.parse(outing.dates.to) - Date.parse(outing.dates.from)) / 86_400_000) + 1;
}

/** 服务端将设备点解析为最近高德地点后的结果，只有 ID 与名称，不回存设备点。 */
/** V2.10：定位解析的最近地点，带它所在的城市（地级市一级）。 */
export type ResolvedNearby = { externalId: string; name: string; city?: DraftCity };

/**
 * 补丁通过本轮 c 编号引用搜索结果，或把一组候选交用户选择。
 * 外部地点 ID 与名称都由服务端从候选表还原，模型不能直接提供一份伪造地点对象。
 */
const placeInputSchema = z.union([
  z.strictObject({ candidate: z.string().regex(/^c\d{1,2}$/) }),
  /** “从我这儿出发”先留下 current 状态，页面征求定位授权后再由服务端绑定最近地点。 */
  z.strictObject({ current: z.literal(true) }),
  z.strictObject({
    choose: z.strictObject({
      mention: text(DRAFT_LIMITS.mentionChars),
      candidates: z.array(z.string().regex(/^c\d{1,2}$/)).min(2).max(3),
    }),
  }),
]);

/** V2.11：停留来源；缺省是用户说的。估计时带上地点类型。 */
const staySourceInputSchema = z.enum(["user", "estimate"]);

const visitInputSchema = z.strictObject({
  place: placeInputSchema,
  role: z.enum(["optional", "required", "fixed"]),
  stayMinutes: z.number().int().min(15).max(600).optional(),
  staySource: staySourceInputSchema.optional(),
  kind: z.enum(PLACE_KINDS).optional(),
  startsAt: planningTimeSchema.optional(),
  endsAt: planningTimeSchema.optional(),
  day: dayNumber.optional(),
});

/** V2.11：等用户选的目标：起点、终点、地点，以及出游的第几晚住处（n1）和交通的起止站（t1:from）。 */
const chooseTarget = z.union([
  z.literal("start"),
  z.literal("end"),
  visitKey,
  z.string().regex(/^n[1-6]$/),
  z.string().regex(/^t\d{1,2}:(from|to)$/),
]);
const transportInputSchema = z.strictObject({
  /** 第几天；也可以直接给日期 date（代码换算成第几天，模型自己换算曾差一天）。二者给一个。 */
  day: dayNumber.optional(),
  date: z.iso.date().optional(),
  mode: z.enum(["train", "flight", "other"]),
  from: placeInputSchema.nullable().optional(),
  to: placeInputSchema.nullable().optional(),
  departAt: planningTimeSchema.nullable().optional(),
  arriveAt: planningTimeSchema.nullable().optional(),
  arriveDay: z.enum(["same", "next"]).optional(),
});

/** any 是清除时段约束的输入命令，落库时删除 when 字段，不把命令字面量存成业务时段。 */
const interestWhenInputSchema = z.union([interestSlotSchema, z.literal("any")]);

/** 聊天动作与高级卡片编辑共享同一补丁契约、同一套校验，避免两个入口产生不同的需求语义。 */
export const draftPatchSchema = z.strictObject({
  date: z.iso.date().nullable().optional(),
  startsAt: planningTimeSchema.nullable().optional(),
  endsAt: planningTimeSchema.nullable().optional(),
  start: placeInputSchema.nullable().optional(),
  end: placeInputSchema.nullable().optional(),
  pace: z.enum(["relaxed", "standard"]).optional(),
  notes: text(DRAFT_LIMITS.notesChars).nullable().optional(),
  travel: travelPreferenceSchema.optional(),
  /** 补丁可切换为短途或一日；一日是旧版缺省语义，保存时不额外写 day 字段。出游由用户在页面上选，补丁不能切。 */
  mode: z.enum(["day", "short"]).optional(),
  /** V2.11 出游卡片的字段（只在出游里用）。 */
  dates: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable().optional(),
  startAt: planningTimeSchema.nullable().optional(),
  endAt: planningTimeSchema.nullable().optional(),
  dailyWindow: z.strictObject({ startsAt: planningTimeSchema, endsAt: planningTimeSchema }).optional(),
  /** V3.3：去掉只说了区域的住宿要求（按原话）。 */
  removeLodgingAreas: z.array(text(DRAFT_LIMITS.lodgingAreaChars)).max(DRAFT_LIMITS.lodgingAreas).optional(),
  /** V4.3：去掉“住在哪”里包含这几晚的那几行（卡片上删）。 */
  removeStays: z.array(dayNumber).max(DRAFT_LIMITS.outingDays - 1).optional(),
  /** 给某几晚设住处（null 是还没定）。 */
  setLodging: z.array(z.strictObject({
    nights: z.array(dayNumber).min(1).max(DRAFT_LIMITS.outingDays - 1),
    place: placeInputSchema.nullable(),
  })).max(DRAFT_LIMITS.outingDays - 1).optional(),
  addTransports: z.array(transportInputSchema).max(DRAFT_LIMITS.transports).optional(),
  updateTransports: z.array(transportInputSchema.partial().extend({ id: transportId })).max(DRAFT_LIMITS.transports).optional(),
  removeTransports: z.array(transportId).max(DRAFT_LIMITS.transports).optional(),
  /** 用户在卡片上确认过夜交通（模型不能替用户确认）。 */
  confirmOvernight: z.array(transportId).max(DRAFT_LIMITS.transports).optional(),
  /** V3.2：这几天不自驾（审查建议采纳时由代码加，不改分配）。 */
  noDriving: z.array(dayNumber).max(DRAFT_LIMITS.outingDays).optional(),
  /** 把一个地点或兴趣放到第几天（同时固定在那天）；已有分配时跟着挪，不作废。 */
  moveToDay: z.strictObject({ target: z.union([visitKey, interestId]), day: dayNumber }).optional(),
  /** 兼容旧版纯文本兴趣；新版可同时表达时段和数量，不需要把这些信息藏进 notes。 */
  addInterests: z.array(z.union([
    text(DRAFT_LIMITS.interestChars),
    z.strictObject({
      text: text(DRAFT_LIMITS.interestChars),
      when: interestWhenInputSchema.optional(),
      count: interestCountSchema.optional(),
      day: dayNumber.optional(),
      perDay: z.literal(true).optional(),
      city: z.strictObject({ adcode: cityCode, name: text(40) }).optional(),
      /** 对话里模型只知道城市名，由服务端换成城市（city）后再写进卡片；这里不认它。 */
      cityName: text(20).optional(),
    }),
  ])).max(DRAFT_LIMITS.outingInterests).optional(),
  /** 后续对话或卡片按稳定兴趣 ID 改时段与数量，不能靠数组下标猜原兴趣。 */
  updateInterests: z.array(z.strictObject({
    id: interestId,
    when: interestWhenInputSchema.optional(),
    count: interestCountSchema.optional(),
    day: dayNumber.nullable().optional(),
    perDay: z.boolean().optional(),
  })).max(DRAFT_LIMITS.outingInterests).optional(),
  removeInterests: z.array(interestId).max(DRAFT_LIMITS.outingInterests).optional(),
  addVisits: z.array(visitInputSchema).max(DRAFT_LIMITS.outingVisits).optional(),
  updateVisits: z.array(z.strictObject({
    key: visitKey,
    /** 重新搜索后的地点替换仍走候选引用，不接受模型直接写供应商 ID。 */
    place: placeInputSchema.optional(),
    role: z.enum(["optional", "required", "fixed"]).optional(),
    stayMinutes: z.number().int().min(15).max(600).nullable().optional(),
    staySource: staySourceInputSchema.optional(),
    kind: z.enum(PLACE_KINDS).optional(),
    startsAt: planningTimeSchema.nullable().optional(),
    endsAt: planningTimeSchema.nullable().optional(),
    day: dayNumber.nullable().optional(),
  })).max(DRAFT_LIMITS.outingVisits).optional(),
  removeVisits: z.array(visitKey).max(DRAFT_LIMITS.outingVisits).optional(),
  /** 页面选择用候选中的外部 ID，模型选择用展示过的从 1 开始序号；两种输入最终绑定同一真实候选。 */
  choose: z.array(z.union([
    z.strictObject({ target: chooseTarget, externalId }),
    z.strictObject({ target: chooseTarget, option: z.number().int().min(1).max(3) }),
  ])).max(DRAFT_LIMITS.outingVisits + 2).optional(),
});
export type DraftPatch = z.infer<typeof draftPatchSchema>;

export type PatchError =
  | "unknown_candidate"
  | "unknown_visit"
  | "unknown_interest"
  | "unknown_choice"
  | "duplicate_place"
  | "too_many_visits"
  | "too_many_protected"
  | "too_many_fixed"
  | "too_many_interests"
  | "window_order"
  | "fixed_time"
  | "fixed_outside_window"
  | "current_only_for_ends"
  /** V2.11 出游 */
  | "outing_only"
  | "day_only"
  | "mode_is_users"
  | "dates_order"
  | "too_many_days"
  | "day_outside_dates"
  | "transport_day_missing"
  | "night_outside_dates"
  | "night_on_board"
  | "unknown_transport"
  | "too_many_transports"
  | "transport_time_order"
  | "fixed_needs_day";

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * 整份补丁先在草稿副本上完成，再复核最终状态。
 * 补丁中的先删后加或角色变化不会绕过数量、固定时段等约束，失败时原草稿不变。
 */
const cityOf = (place: { cityAdcode?: string }) => (place.cityAdcode && /^\d{6}$/.test(place.cityAdcode) ? { city: place.cityAdcode } : {});

/** V2.10：卡片的主要城市；没有就是杭州。 */
export function draftCity(draft: RequirementsDraft): DraftCity {
  return draft.city ?? DEFAULT_CITY;
}

/**
 * V2.10：卡片上已绑定的地点（起点、终点、各站）大多在哪个城市；一样多时以起点所在的城市为准。
 * 没有带城市的地点时为 null。一天可以跨出城市边界（“从云岭站去岚溪花海”主城市仍是云岭）。
 */
export function cityFromPlaces(draft: RequirementsDraft): string | null {
  const bound = [draft.start, draft.end, ...draft.visits.map((visit) => visit.place)]
    .flatMap((place) => (place?.status === "bound" && place.city ? [place.city] : []));
  if (!bound.length) return null;
  const counts = new Map<string, number>();
  for (const city of bound) counts.set(city, (counts.get(city) ?? 0) + 1);
  const most = Math.max(...counts.values());
  const leaders = [...counts].filter(([, count]) => count === most).map(([city]) => city);
  const startCity = draft.start?.status === "bound" ? draft.start.city : undefined;
  return startCity && leaders.includes(startCity) ? startCity : leaders[0];
}

export function applyDraftPatch(
  draft: RequirementsDraft,
  patch: DraftPatch,
  candidates: ReadonlyMap<string, { externalId: string; name: string; cityAdcode?: string }> = new Map(),
  /** 注入时钟供短途填充今天与“现在”；测试可固定时间，避免默认值随执行时刻漂移。 */
  options: { nowMs?: number } = {},
): { status: "ok"; draft: RequirementsDraft; changed: boolean } | { status: "invalid"; code: PatchError } {
  // 对话动作与卡片编辑共用这套补丁语义：先在副本上完成整组修改，再验证最终状态。
  // 中途失败会丢弃副本；这保证单个补丁原子应用，不会只改日期却漏掉后面的地点选择。
  const next: RequirementsDraft = structuredClone(draft);
  // V2.11：出游由用户在页面上选，补丁不能切换模式；出游和日常各用各的字段（一天的日期和时间窗 / 日期范围和每天的时间窗）。
  const outing = next.mode === "outing";
  if (outing && patch.mode !== undefined) return { status: "invalid", code: "mode_is_users" };
  if (!outing && usesOutingFields(patch)) return { status: "invalid", code: "outing_only" };
  if (outing && (patch.date !== undefined || patch.startsAt !== undefined || patch.endsAt !== undefined)) {
    return { status: "invalid", code: "day_only" };
  }
  if (patch.mode === "day") delete next.mode;
  if (patch.mode === "short") next.mode = "short";
  const resolve = (input: z.infer<typeof placeInputSchema>): DraftPlace | PatchError => {
    if ("current" in input) return { status: "current" };
    if ("candidate" in input) {
      const found = candidates.get(input.candidate);
      return found ? { status: "bound", externalId: found.externalId, name: found.name, ...cityOf(found) } : "unknown_candidate";
    }
    const choices = input.choose.candidates.map((id) => candidates.get(id));
    if (choices.some((choice) => !choice)) return "unknown_candidate";
    // 候选即使携带地址、评分等额外字段，这里也只提取 ID 与名称，限制持久化边界。
    const unique = [...new Map(choices.map((choice) => [
      choice!.externalId,
      { externalId: choice!.externalId, name: choice!.name, ...cityOf(choice!) },
    ])).values()];
    if (unique.length < 2) return { status: "bound", ...unique[0] };
    return { status: "choose", mention: input.choose.mention, choices: unique };
  };

  if (patch.date !== undefined) next.date = patch.date;
  if (patch.startsAt !== undefined) next.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) next.endsAt = patch.endsAt;
  if (patch.pace !== undefined) next.pace = patch.pace;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.travel !== undefined) next.travel = patch.travel;
  for (const field of ["start", "end"] as const) {
    const input = patch[field];
    if (input === undefined) continue;
    if (input === null) {
      next[field] = null;
      continue;
    }
    const place = resolve(input);
    if (typeof place === "string") return { status: "invalid", code: place };
    next[field] = place;
  }

  if (outing) {
    const problem = applyOutingPatch(next.outing!, patch, resolve);
    if (problem) return { status: "invalid", code: problem };
    // 分配跟着卡片：只改备注、节奏、过夜确认或移动时保留，其余改动都要重新分。
    const keeps = Object.keys(patch).every((key) => ["notes", "pace", "confirmOvernight", "moveToDay", "noDriving"].includes(key));
    if (!keeps) delete next.outing!.allocation;
    // V3.3：“人在哪”变了（日期、加删交通、交通的日期 / 起终点 / 过夜）才作废系统暂定的住处，下次规划按新的行程重新找；
    // 只改车次时间、加地点或兴趣不算。用户给的、采纳过的照留。
    if (whereabouts(next.outing!) !== whereabouts(draft.outing!)) {
      next.outing!.lodging = next.outing!.lodging.filter((item) => item.source !== "suggested");
    }
    if (patch.moveToDay) {
      const moved = moveToDay(next, patch.moveToDay.target, patch.moveToDay.day);
      if (moved) return { status: "invalid", code: moved };
    }
  }

  if (patch.removeInterests) {
    if (patch.removeInterests.some((id) => !next.interests.some((item) => item.id === id))) {
      return { status: "invalid", code: "unknown_interest" };
    }
    next.interests = next.interests.filter((item) => !patch.removeInterests!.includes(item.id));
  }
  // 缺省值用“缺字段”表示：any 清除时段、1 清除 count，保持旧草稿兼容并让语义比较稳定。
  const setIntent = (
    item: RequirementsDraft["interests"][number],
    change: { when?: InterestSlot | "any"; count?: number; day?: number | null; perDay?: boolean; city?: { adcode: string; name: string } },
  ) => {
    if (change.when === "any") delete item.when;
    else if (change.when) item.when = change.when;
    if (change.count === 1) delete item.count;
    else if (change.count) item.count = change.count;
    if (change.day === null) delete item.day;
    else if (change.day) item.day = change.day;
    if (change.perDay === false) delete item.perDay;
    else if (change.perDay) item.perDay = true;
    if (change.city) item.city = change.city;
  };
  for (const input of patch.addInterests ?? []) {
    // cityName 不写进卡片（只取 text、时段、数量、第几天、每天、城市）。
    const given = typeof input === "string" ? { text: input } : input;
    // V3.3（§3.6）：“住春熙路附近”是住宿要求，不是要去的地方：记成住处区域，不当兴趣排成一站。
    const area = outing ? lodgingAreaOf(given.text) : null;
    if (area) {
      const areas = next.outing!.lodgingAreas ?? [];
      if (!areas.some((item) => item.text === area) && areas.length < DRAFT_LIMITS.lodgingAreas) {
        next.outing!.lodgingAreas = [...areas, { text: area }];
      }
      continue;
    }
    // V2.10：一日规划里兴趣原话以时段词开头（“晚上喝一杯”）而模型没给时段时，按提示词里的对应关系补上；
    // 去掉杭州地名的例子后，模型常漏标（需求理解 I20 三次都漏）。短途是现在出发，不补。
    const said = given.when || (patch.mode ?? next.mode) === "short" ? undefined : leadingSlot(given.text);
    const added = said ? { ...given, when: said } : given;
    const existing = next.interests.find((item) => item.text === added.text);
    if (existing) {
      setIntent(existing, added);
      continue;
    }
    const item: RequirementsDraft["interests"][number] = { id: nextId("i", next.interests.map((entry) => entry.id)), text: added.text };
    setIntent(item, added);
    next.interests.push(item);
  }
  for (const change of patch.updateInterests ?? []) {
    const item = next.interests.find((entry) => entry.id === change.id);
    if (!item) return { status: "invalid", code: "unknown_interest" };
    setIntent(item, change);
  }

  if (patch.removeVisits) {
    if (patch.removeVisits.some((key) => !next.visits.some((visit) => visit.key === key))) {
      return { status: "invalid", code: "unknown_visit" };
    }
    next.visits = next.visits.filter((visit) => !patch.removeVisits!.includes(visit.key));
  }
  // 活动按 key 对齐，不按页面数组下标修改；地点变更仍必须从本轮候选池解析。
  // 角色与起止可在同一补丁里一起改，最终统一检查，允许合法的普通站 ↔ 固定事项转换。
  for (const change of patch.updateVisits ?? []) {
    const visit = next.visits.find((item) => item.key === change.key);
    if (!visit) return { status: "invalid", code: "unknown_visit" };
    if (change.place) {
      if ("current" in change.place) return { status: "invalid", code: "current_only_for_ends" };
      const place = resolve(change.place);
      if (typeof place === "string") return { status: "invalid", code: place };
      visit.place = place;
    }
    if (change.role !== undefined) visit.role = change.role;
    // V2.11：改了停留就按这次说的来源记（缺省是用户说的）；清空停留时来源一起清掉。
    if (change.stayMinutes !== undefined) {
      const kind = change.kind ?? visit.kind;
      visit.stayMinutes = change.stayMinutes;
      delete visit.staySource;
      delete visit.kind;
      Object.assign(visit, stayOrigin(change.stayMinutes, change.staySource, kind));
    }
    if (change.startsAt !== undefined) visit.startsAt = change.startsAt;
    if (change.endsAt !== undefined) visit.endsAt = change.endsAt;
    if (change.day === null) delete visit.day;
    else if (change.day !== undefined) visit.day = change.day;
  }
  for (const input of patch.addVisits ?? []) {
    if ("current" in input.place) return { status: "invalid", code: "current_only_for_ends" };
    const place = resolve(input.place);
    if (typeof place === "string") return { status: "invalid", code: place };
    next.visits.push({
      key: nextId("v", next.visits.map((visit) => visit.key)),
      place,
      role: input.role,
      stayMinutes: input.stayMinutes ?? null,
      ...stayOrigin(input.stayMinutes ?? null, input.staySource, input.kind),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      ...(input.day ? { day: input.day } : {}),
    });
  }

  // 选择只能落在当前等待中的 choices；模型的序号和页面的外部 ID 都不能越出这批候选。
  for (const pick of patch.choose ?? []) {
    const { target } = pick;
    // V3.6：暂定的车站也能换成它的候选（卡片上的“换一个”）。
    const current = chooseCurrent(next, target);
    const choices = current?.status === "choose" ? current.choices : guessedOthers(next, target);
    if (!choices.length) return { status: "invalid", code: "unknown_choice" };
    const choice = "option" in pick
      ? choices[pick.option - 1]
      : choices.find((item) => item.externalId === pick.externalId);
    if (!choice) return { status: "invalid", code: "unknown_choice" };
    const bound: DraftPlace = { status: "bound", externalId: choice.externalId, name: choice.name, ...(choice.city ? { city: choice.city } : {}) };
    setChosen(next, target, bound);
  }

  // 先应用所有明确修改，再补短途空值，最后做语义和结构复核；顺序保证默认值不会覆盖用户输入。
  if (next.mode === "short" && options.nowMs !== undefined) fillShortDefaults(next, options.nowMs);
  const problem = draftProblem(next);
  if (problem) return { status: "invalid", code: problem };
  const parsed = requirementsDraftSchema.parse(next);
  return { status: "ok", draft: parsed, changed: JSON.stringify(parsed) !== JSON.stringify(draft) };
}

/**
 * 短途只补空值：今天、接下来五分钟、四小时窗口和当前位置。
 * 用户已说出的日期、时间与起终点优先，不能用默认值覆盖明确需求。
 */
export const SHORT_TRIP_MINUTES = 4 * 60;
/**
 * 下一步粗略出发时间 = 起始时刻 + 已选各站停留 + 每站十分钟交通假设。
 * 仅用于筛掉届时已关门的候选，最终时间仍要以实际路线重新排程。
 */
export function shortStepDeparture(date: string, startsAt: string, earlierStays: readonly number[]): string {
  const start = Number(startsAt.slice(0, 2)) * 60 + Number(startsAt.slice(3, 5));
  const minutes = Math.min(23 * 60 + 59, start + earlierStays.reduce((total, stay) => total + stay + 10, 0));
  return `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`;
}

function fillShortDefaults(draft: RequirementsDraft, nowMs: number) {
  const local = new Date(nowMs + 8 * 3_600_000);
  const today = local.toISOString().slice(0, 10);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const startsAt = Math.min(Math.ceil(nowMinutes / 5) * 5, 23 * 60 + 25);
  draft.date ??= today;
  draft.startsAt ??= clock(startsAt);
  // 今天尚未到来的明确出发时刻仍保留；已过去的出发时刻才向当前时间推进。
  if (draft.date === today && minutes(draft.startsAt) < startsAt) {
    draft.startsAt = clock(startsAt);
    if (draft.endsAt && minutes(draft.endsAt) <= startsAt) draft.endsAt = null;
  }
  draft.endsAt ??= clock(Math.min(minutes(draft.startsAt) + SHORT_TRIP_MINUTES, 23 * 60 + 55));
  draft.start ??= { status: "current" };
}

/** 草稿允许暂时缺字段，不能保存自相矛盾的时间或固定事项；缺失和非法是两种不同状态。 */
function draftProblem(draft: RequirementsDraft): PatchError | null {
  const bound = draft.visits.flatMap((visit) => (visit.place.status === "bound" ? [visit.place.externalId] : []));
  if (new Set(bound).size !== bound.length) return "duplicate_place";
  if (draft.mode === "outing" && draft.outing) return outingProblem(draft, draft.outing);
  if (draft.visits.length > DRAFT_LIMITS.visits) return "too_many_visits";
  if (draft.interests.length > DRAFT_LIMITS.interests) return "too_many_interests";
  if (draft.visits.filter((visit) => visit.role !== "optional").length > DRAFT_LIMITS.protectedVisits) {
    return "too_many_protected";
  }
  const fixed = draft.visits.filter((visit) => visit.role === "fixed");
  if (fixed.length > DRAFT_LIMITS.fixedVisits) return "too_many_fixed";
  if (draft.startsAt && draft.endsAt && minutes(draft.startsAt) >= minutes(draft.endsAt)) return "window_order";
  for (const visit of fixed) {
    if (!visit.startsAt || !visit.endsAt) continue;
    if (minutes(visit.startsAt) >= minutes(visit.endsAt)) return "fixed_time";
    if (draft.startsAt && minutes(visit.startsAt) < minutes(draft.startsAt)) return "fixed_outside_window";
    if (draft.endsAt && minutes(visit.endsAt) > minutes(draft.endsAt)) return "fixed_outside_window";
  }
  return null;
}

const LEADING_SLOTS: readonly [RegExp, InterestSlot][] = [
  [/^(早上|上午|清晨)/, "morning"],
  [/^中午/, "noon"],
  [/^下午/, "afternoon"],
  [/^傍晚/, "dusk"],
  [/^(晚上|夜里)/, "evening"],
];

/** 兴趣原话开头的时段词对应的时段；“白天”不是时段，只和晚上相对。 */
function leadingSlot(text: string): InterestSlot | undefined {
  return LEADING_SLOTS.find(([pattern]) => pattern.test(text.trim()))?.[1];
}

function nextId(prefix: "i" | "v", used: readonly string[]): string {
  const highest = used.reduce((max, id) => Math.max(max, Number(id.slice(1))), 0);
  return `${prefix}${highest + 1}`;
}

/** 用卡片可读文案列出阻止开始规划的缺失需求，不能因模型说“已齐全”就跳过。 */
export function draftMissing(draft: RequirementsDraft): string[] {
  if (draft.mode === "outing" && draft.outing) return outingMissing(draft, draft.outing);
  const missing: string[] = [];
  if (!draft.date) missing.push("日期");
  if (!draft.startsAt) missing.push("出发时间");
  if (!draft.endsAt) missing.push("结束时间");
  const place = (value: DraftPlace | null, label: string) => {
    if (!value) missing.push(`${label}地点`);
    else if (value.status === "choose") missing.push(`选择${label}地点`);
    else if (value.status === "current") missing.push("允许定位（或告诉我出发地点）");
  };
  place(draft.start, "出发");
  // 短途缺终点表示在最后选中的站结束，不能因此阻止开始规划。
  if (draft.mode !== "short" || draft.end) place(draft.end, "结束");
  // 起终点都为 current 时一次定位即可同时解决，不重复要求用户授权。
  if (missing.filter((item) => item.startsWith("允许定位")).length > 1) missing.splice(missing.lastIndexOf("允许定位（或告诉我出发地点）"), 1);
  for (const visit of draft.visits) {
    if (visit.place.status === "choose") missing.push(`选择“${visit.place.mention}”`);
    if (visit.role === "fixed" && (!visit.startsAt || !visit.endsAt)) {
      missing.push(`${visit.place.status === "bound" ? visit.place.name : "固定事项"}的时间`);
    }
  }
  if (draft.visits.length === 0 && draft.interests.length === 0) missing.push("想去的地方或兴趣");
  if (draft.mode === "short" && draft.visits.length) missing.push("短途只按想做的事挑地方，具体地点请切到一日规划");
  for (const conflict of interestWindowConflicts(draft)) {
    missing.push(`时间范围要包含${conflict.label}（“${conflict.text}”）`);
  }
  return missing;
}

/**
 * 检查兴趣时段与整天窗口的重叠；冲突作为待完善需求展示，允许用户分步编辑。
 * 不把它当作补丁错误，否则用户先改兴趣再改结束时刻时会被中间状态卡住。
 */
export function interestWindowConflicts(draft: RequirementsDraft): {
  id: string;
  text: string;
  when: InterestSlot;
  label: string;
  /** 能让该兴趣具备最小可排空间的时间窗修改建议，不等于已经得到可行行程。 */
  needs: { startsAt?: string; endsAt?: string };
}[] {
  if (!draft.startsAt || !draft.endsAt) return [];
  const window = { startsAt: minutes(draft.startsAt), endsAt: minutes(draft.endsAt) };
  return draft.interests.flatMap((item) => {
    if (!item.when || slotOverlapMinutes(item.when, window) >= SLOT_MIN_OVERLAP_MINUTES) return [];
    const slot = INTEREST_SLOTS[item.when];
    const needs = slot.startsAt >= window.endsAt - SLOT_MIN_OVERLAP_MINUTES
      ? { endsAt: clock(Math.min(slot.startsAt + 4 * 60, slot.endsAt)) }
      : { startsAt: clock(Math.max(slot.endsAt - 3 * 60, slot.startsAt)) };
    return [{ id: item.id, text: item.text, when: item.when, label: slot.label, needs }];
  });
}

const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

// 下面是持久化消息：按 kind 区分正文契约，历史快照与当前可编辑草稿分别维护。

export const progressStepSchema = z.strictObject({ key: text(40), text: text(120) });

const travelModeSchema = z.enum(["walking", "transit", "taxi", "bicycling", "driving"]);

export const planStopSummarySchema = z.strictObject({
  externalId,
  name: placeName,
  startsAt: planningTimeSchema,
  endsAt: planningTimeSchema,
  role: z.enum(["optional", "required", "fixed", "discovered"]),
  reason: text(80).optional(),
  /** 保存的是本计划采用的入站方式，不保存路线查询的交通分钟或费用；活动起止仍是自有计划内容。 */
  arrivalMode: travelModeSchema.optional(),
});

/** 网页出处只保留 URL、标题、站点和日期，不复制摘要或正文到聊天记录。 */
const webSourceSchema = z.strictObject({
  // 旧消息没有 kind 时按网页引用解析，兼容历史数据而不额外迁移。
  kind: z.literal("web").default("web"),
  url: z.string().max(2048).regex(/^https?:\/\//).refine((value) => URL.canParse(value)),
  title: text(200),
  site: text(60).nullable(),
  date: z.iso.date().nullable(),
});

/** 知识引用保存文档与段落 ID，正文在打开出处时读取，消息本身不复制资料库内容。 */
const knowledgeSourceSchema = z.strictObject({
  kind: z.literal("kb"),
  documentId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  chunkId: z.string().regex(/^[a-z0-9-]{1,80}:\d{1,4}$/),
  title: text(80),
  headingPath: text(200),
});

export const messageSourceSchema = z.union([knowledgeSourceSchema, webSourceSchema]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

const planCardBodySchema = z.strictObject({
  runId: z.uuid(),
  title: text(80),
  date: z.iso.date(),
  departAt: planningTimeSchema,
  arriveAt: planningTimeSchema,
  start: draftChoiceSchema,
  end: draftChoiceSchema,
  stops: z.array(planStopSummarySchema).max(8),
  endArrivalMode: travelModeSchema.optional(),
  notes: z.array(text(120)).max(8),
  journeyId: z.uuid().nullable(),
});

/**
 * V2.11 出游的一天（§3.7）：一天按固定交通分成几部分，每段地点是一份普通的一日方案（同 plan_card），
 * 交通和直接前往只存名称和我们的时刻。同一次生成的各天共用 generationId；整趟保存后写 tripId。
 */
const outingDayBodySchema = z.strictObject({
  generationId: z.uuid(),
  day: z.number().int().min(1).max(DRAFT_LIMITS.outingDays),
  date: z.iso.date(),
  title: text(80),
  status: z.enum(["draft", "no_plan", "failed"]),
  parts: z.array(z.discriminatedUnion("kind", [
    /** segment 是当天第几段（按固定交通切开），保存后对应 journeys.trip_part。 */
    z.strictObject({ kind: z.literal("plan"), segment: z.number().int().min(0).max(6), plan: planCardBodySchema }),
    z.strictObject({
      kind: z.literal("transfer"),
      mode: z.enum(["train", "flight", "other"]),
      from: placeName,
      to: placeName,
      departAt: planningTimeSchema,
      arriveAt: planningTimeSchema,
      nextDay: z.boolean(),
      estimated: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("connect"),
      from: placeName,
      to: placeName,
      departAt: planningTimeSchema,
      arriveAt: planningTimeSchema,
      mode: travelModeSchema.optional(),
    }),
  ])).max(7),
  notes: z.array(text(120)).max(8),
  explanation: text(300).optional(),
  tripId: z.uuid().nullable(),
  /** 这一天来自哪次确认过的跨天改动（outing_change 的 changeId）。 */
  fromChange: z.uuid().optional(),
});

/**
 * V2.11 已保存出游的跨天改动（§3.9）：改动前后各天去哪、确认时比对的基础版本、改动后的卡片和新的各天。
 * 确认成功后新的各天另存为 outing_day（带 fromChange），这张卡片本身不改。
 */
const outingChangeBodySchema = z.strictObject({
  changeId: z.uuid(),
  tripId: z.uuid(),
  note: text(80),
  base: z.strictObject({
    tripVersion: z.number().int().min(1),
    journeys: z.array(z.strictObject({
      journeyId: z.uuid(),
      planVersion: z.number().int().min(1),
      observationVersion: z.number().int().min(0),
    })).max(49),
  }),
  skip: z.strictObject({ journeyId: z.uuid(), activityId: z.uuid() }).optional(),
  before: z.array(z.strictObject({ day: z.number().int().min(1).max(7), stops: z.array(placeName).max(16) })).max(7),
  days: z.array(outingDayBodySchema).min(1).max(7),
  draft: requirementsDraftSchema,
});

/** 每种消息单独限制可存字段，排除供应商坐标、地址、路线数值和天气值，不能把响应对象整份落库。 */
export const messageBodySchemas = {
  text: z.strictObject({
    text: text(1000),
    asking: z.boolean().optional(),
    sources: z.array(messageSourceSchema).max(5).optional(),
    /** V2.9：建议里推荐的地点，只存地点编号和名称（D-046），详情显示时再查。 */
    places: z.array(z.strictObject({ externalId, name: placeName, city: cityCode.optional() })).max(5).optional(),
    /** V3.5：用户消息的客户端编号（页面生成）；同一个编号再发，回已经存的那一轮，不再跑一遍。 */
    clientId: z.uuid().optional(),
  }),
  requirements_card: z.strictObject({ draft: requirementsDraftSchema }),
  planning_progress: z.strictObject({
    steps: z.array(progressStepSchema).max(30),
    outcome: z.enum(["draft", "no_plan", "failed", "cancelled"]),
  }),
  plan_card: planCardBodySchema,
  outing_day: outingDayBodySchema,
  outing_change: outingChangeBodySchema,
  /** V3.2：审查给用户的建议（每条一个“采纳”“忽略”）。 */
  outing_review: z.strictObject({
    generationId: z.uuid(),
    suggestions: z.array(z.strictObject({
      fix: suggestionFixSchema,
      text: text(80),
      status: z.enum(["pending", "adopted", "dismissed"]),
      /** V4.0：这条建议试排的结果（“已试排：……”，审查-修复 Agent 给的才有）。 */
      tried: text(120).optional(),
    })).max(12),
    /** V4.7：“这趟符合你的要求吗”：一句总评和逐条清单（只有说明，不带用户原话、分数；没有判断结果时没有这一项）。 */
    assessment: z.strictObject({
      summary: text(200),
      items: z.array(z.strictObject({ text: text(80), status: z.enum(["met", "partly", "unmet", "unknown"]), note: z.string().max(120) })).max(20),
      issues: z.array(z.strictObject({ day: z.number().int().min(1).max(7), severity: z.enum(["minor", "major"]), note: z.string().max(120) })).max(8),
    }).optional(),
  }),
  notice: z.strictObject({
    text: text(300),
    tone: z.enum(["info", "warning"]),
    /**
     * V2.11（D-072）：日常里遇到的外地地点或城市，页面显示“切到出游”。只存编号、名称和所在城市；
     * 切到出游时带过去。
     */
    outing: z.strictObject({
      places: z.array(z.strictObject({
        externalId: externalId.optional(),
        name: placeName,
        city: cityCode,
        cityName: text(40),
      })).min(1).max(6),
    }).optional(),
  }),
  /** V2.9：对话提议记住一条长期偏好；用户点“记住”才写入偏好表（AGENTS §4）。 */
  preference_proposal: z.strictObject({
    text: preferenceTextSchema,
    category: preferenceCategorySchema,
    status: z.enum(["pending", "saved", "dismissed"]),
    preferenceId: z.uuid().optional(),
  }),
  /**
   * 短途每一步的已展示候选，仅存编号、名称、理由与预计停留。
   * 距离、路线、评分和价格仅在本次页面响应展示，anchor 为空表示最初出发点。
   */
  choices: z.strictObject({
    /** 一次短途所有选择步骤共享 tripId；重新开始规划使用新身份，旧批次不能再继续作答。 */
    tripId: z.uuid(),
    step: z.number().int().min(1).max(DRAFT_LIMITS.interests),
    interestId,
    anchor: draftChoiceSchema.nullable(),
    round: z.number().int().min(1).max(3),
    options: z.array(z.strictObject({
      externalId,
      name: placeName,
      reason: text(80),
      stayMinutes: z.number().int().min(15).max(180),
    })).min(1).max(5),
    chosen: externalId.nullable(),
  }),
  /** 调整卡片保存旧剩余部分与新候选的差异摘要，只有用户确认成功后才写 savedVersion。 */
  adjust_card: z.strictObject({
    runId: z.uuid(),
    journeyId: z.uuid(),
    basePlanVersion: z.number().int().positive(),
    note: text(60),
    items: z.array(z.strictObject({
      kind: z.enum(["done", "kept", "moved", "added", "removed"]),
      name: placeName,
      before: z.strictObject({ startsAt: planningTimeSchema, endsAt: planningTimeSchema }).optional(),
      after: z.strictObject({ startsAt: planningTimeSchema, endsAt: planningTimeSchema }).optional(),
      arrivalMode: travelModeSchema.optional(),
    })).min(1).max(16),
    /** 候选要求少去这一站；确认该卡片也表示用户明确接受删站，不能静默执行。 */
    suggestDrop: placeName.nullable(),
    arriveAt: planningTimeSchema,
    endName: placeName,
    savedVersion: z.number().int().positive().nullable(),
  }),
} as const;

export type MessageKind = keyof typeof messageBodySchemas;
export type StoredMessage = {
  [K in MessageKind]: {
    readonly id: string;
    readonly seq: number;
    readonly role: "user" | "assistant";
    readonly kind: K;
    readonly body: z.infer<(typeof messageBodySchemas)[K]>;
    readonly createdAt: string;
  };
}[MessageKind];
export type NewMessage = {
  [K in MessageKind]: { readonly role: "user" | "assistant"; readonly kind: K; readonly body: z.infer<(typeof messageBodySchemas)[K]> };
}[MessageKind];

/**
 * 落库的 JSON 也要重新按消息种类解析；TypeScript 联合类型无法保证历史行或数据库内容合法。
 * 展示层只接收通过对应 schema 的消息，避免把不兼容数据直接断言成可信状态。
 */
export function parseStoredMessage(row: {
  id: string;
  seq: number;
  role: string;
  kind: string;
  body: unknown;
  createdAt: string;
}): StoredMessage {
  if (row.role !== "user" && row.role !== "assistant") throw new Error("Invalid message role");
  if (!Object.hasOwn(messageBodySchemas, row.kind)) throw new Error("Invalid message kind");
  const kind = row.kind as MessageKind;
  const body = messageBodySchemas[kind].parse(row.body);
  return { id: row.id, seq: row.seq, role: row.role, kind, body, createdAt: row.createdAt } as StoredMessage;
}

export interface StoredConversation {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "planned" | "archived";
  readonly journeyId: string | null;
  readonly draft: RequirementsDraft;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** V2.9：最近消息窗口之外的旧对话的滚动摘要，摘要到第 throughSeq 条消息为止。 */
  readonly summary?: ConversationSummary;
}

export const conversationSummarySchema = z.strictObject({
  text: z.string().trim().min(1).max(300),
  throughSeq: z.number().int().positive(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export type AppendOutcome = { status: "appended"; messageCount: number } | { status: "conflict" } | { status: "not_found" };
export type DraftUpdateOutcome = { status: "updated" } | { status: "conflict" } | { status: "not_found" };

export interface ConversationRepository {
  createConversation(input: { id: string; title: string; now: Date }): Promise<StoredConversation>;
  /** V3.5：这个用户的哪段对话里有这个客户端编号的用户消息（第一条消息重发时找到已建的对话）。 */
  findConversationIdByClientId?(clientId: string): Promise<string | null>;
  findConversation(id: string): Promise<{ conversation: StoredConversation; messages: StoredMessage[] } | null>;
  /**
   * 在 expectedCount 仍匹配时原子追加整轮消息，同时更新草稿、标题与计数。
   * 两个标签页并发发送不能交错写入；过时上下文生成的回复返回 conflict。
   */
  appendTurn(input: {
    conversationId: string;
    expectedCount: number;
    messages: readonly NewMessage[];
    draft?: RequirementsDraft;
    title?: string;
    journeyId?: string;
    now: Date;
    newId: () => string;
  }): Promise<AppendOutcome>;
  /** V2.11：整趟出游保存后，把这次生成的各天消息关联到出游和各段行程。 */
  markOutingSaved(input: {
    conversationId: string;
    generationId: string;
    tripId: string;
    journeys: readonly { day: number; part: number; journeyId: string }[];
    now: Date;
  }): Promise<{ status: "updated" | "not_found" }>;
  /** 正式行程已保存后，把 plan_card 与该行程关联；这一步不创建新的正式计划。 */
  markPlanSaved(input: { conversationId: string; runId: string; journeyId: string; now: Date }): Promise<{ status: "updated" | "not_found" }>;
  /** 已确认的调整卡片补上实际产生的版本号；聊天摘要与正式行程写入分开处理。 */
  markAdjustSaved(input: { conversationId: string; runId: string; planVersion: number; now: Date }): Promise<{ status: "updated" | "not_found" }>;
  /** 候选消息上的选择只写一次，另一个标签页再选会冲突；允许变更的消息字段有明确范围。 */
  chooseOption(input: { conversationId: string; messageId: string; externalId: string; now: Date }): Promise<{ status: "updated" | "not_found" | "conflict" }>;
  /** V3.2：审查建议的“采纳”“忽略”只记一次（另一个标签页再点是冲突）。 */
  decideSuggestion(input: {
    conversationId: string;
    messageId: string;
    index: number;
    status: "adopted" | "dismissed";
    now: Date;
  }): Promise<{ status: "updated" | "not_found" | "conflict" }>;
  /** V2.9：追加一轮的决策记录（只追加；同一轮重复写入时忽略）。 */
  recordTrace(input: { conversationId: string; seq: number; record: unknown; now: Date }): Promise<void>;
  /** V2.9：一个对话的全部决策记录，按轮次排列（`pnpm trace` 与调试用）。 */
  listTraces(conversationId: string): Promise<{ seq: number; record: unknown; createdAt: string }[]>;
  /** V2.9：更新滚动摘要；只会往后推进（throughSeq 不小于已有的），原消息不动。 */
  updateSummary(input: { conversationId: string; summary: ConversationSummary }): Promise<{ status: "updated" | "stale" | "not_found" }>;
  /** 卡片编辑以页面所见草稿指纹作乐观锁，不能用旧卡片覆盖对话刚产生的新草稿。 */
  updateDraft(input: {
    conversationId: string;
    expectedFingerprint: string;
    draft: RequirementsDraft;
    now: Date;
  }): Promise<DraftUpdateOutcome>;
}

/** 同一次定位把所有待定 current 起终点绑定到最近地点，保留 nearby 标记，精确点不进入草稿。 */
export function applyCurrentLocation(draft: RequirementsDraft, nearby: ResolvedNearby): RequirementsDraft {
  const bound: DraftPlace = {
    status: "bound",
    externalId: nearby.externalId,
    name: nearby.name,
    nearby: true,
    ...(nearby.city ? { city: nearby.city.adcode } : {}),
  };
  return requirementsDraftSchema.parse({
    ...draft,
    // V2.10：卡片还没有城市（没授权过定位）时，定位得到的就是所在城市；用户说过的城市不覆盖。
    ...(nearby.city && !draft.city ? { city: { adcode: nearby.city.adcode, name: nearby.city.name, source: "located" } } : {}),
    start: draft.start?.status === "current" ? bound : draft.start,
    end: draft.end?.status === "current" ? bound : draft.end,
  });
}

/** V2.11：只有估计的停留记来源和类型；用户说的、没给停留的都不记（缺省就是用户说的）。 */
function stayOrigin(
  stayMinutes: number | null,
  source: "user" | "estimate" | undefined,
  kind: DraftVisit["kind"],
): Pick<DraftVisit, "staySource" | "kind"> {
  if (stayMinutes === null || source !== "estimate") return {};
  return { staySource: "estimate", ...(kind ? { kind } : {}) };
}

type PlaceInput = z.infer<typeof placeInputSchema>;

/** V2.11：补丁里有没有出游才有的字段（日常卡片不接受）。 */
function usesOutingFields(patch: DraftPatch): boolean {
  const own = [
    "dates", "startAt", "endAt", "dailyWindow", "setLodging", "removeLodgingAreas", "removeStays", "addTransports", "updateTransports",
    "removeTransports", "confirmOvernight", "moveToDay", "noDriving",
  ] as const;
  return own.some((field) => patch[field] !== undefined) ||
    (patch.addVisits ?? []).some((visit) => visit.day !== undefined) ||
    (patch.updateVisits ?? []).some((visit) => visit.day !== undefined) ||
    (patch.addInterests ?? []).some((item) => typeof item !== "string" &&
      (item.day !== undefined || item.perDay !== undefined || item.city !== undefined || item.cityName !== undefined)) ||
    (patch.updateInterests ?? []).some((item) => item.day !== undefined || item.perDay !== undefined);
}

/**
 * V2.11：出游卡片的日期、住处和固定交通。过夜交通（arriveDay next，或到达早于出发）那一晚自动是“车上”，
 * 不能再填住处；改了这段交通的时间或日期要重新确认（§3.4）。
 */
function applyOutingPatch(
  outing: OutingDraft,
  patch: DraftPatch,
  resolve: (input: PlaceInput) => DraftPlace | PatchError,
): PatchError | null {
  if (patch.dates !== undefined) {
    outing.dates = patch.dates;
    // 日期改短了，超出的那几晚住处、“住在哪”一起去掉。
    const days = outingDays(outing);
    if (days) outing.lodging = outing.lodging.filter((item) => item.night < days);
    if (days && outing.stays) {
      const stays = outing.stays.map((item) => ({ ...item, nights: item.nights.filter((night) => night < days) })).filter((item) => item.nights.length);
      if (stays.length) outing.stays = stays;
      else delete outing.stays;
    }
  }
  if (patch.startAt !== undefined) outing.startAt = patch.startAt;
  if (patch.endAt !== undefined) outing.endAt = patch.endAt;
  if (patch.dailyWindow) outing.dailyWindow = patch.dailyWindow;
  const station = (input: PlaceInput | null | undefined): DraftPlace | null | PatchError => {
    if (input === undefined || input === null) return null;
    if ("current" in input) return "current_only_for_ends";
    return resolve(input);
  };
  for (const id of patch.removeTransports ?? []) {
    if (!outing.transports.some((item) => item.id === id)) return "unknown_transport";
    outing.transports = outing.transports.filter((item) => item.id !== id);
  }
  // 交通的日期换成第几天（第 1 天是 dates.from）。
  const dayOf = (input: { day?: number; date?: string }): number | PatchError => {
    if (input.date === undefined) return input.day ?? "transport_day_missing";
    if (!outing.dates) return "day_outside_dates";
    const day = Math.round((Date.parse(input.date) - Date.parse(outing.dates.from)) / 86_400_000) + 1;
    return day >= 1 && day <= outingDays(outing) ? day : "day_outside_dates";
  };
  for (const change of patch.updateTransports ?? []) {
    const item = outing.transports.find((entry) => entry.id === change.id);
    if (!item) return "unknown_transport";
    if (change.date !== undefined) {
      const day = dayOf(change);
      if (typeof day === "string") return day;
      change.day = day;
    }
    for (const field of ["from", "to"] as const) {
      if (change[field] === undefined) continue;
      const place = station(change[field]);
      if (typeof place === "string") return place;
      item[field] = place;
    }
    if (change.day !== undefined) item.day = change.day;
    if (change.mode !== undefined) item.mode = change.mode;
    if (change.departAt !== undefined) item.departAt = change.departAt;
    if (change.arriveAt !== undefined) item.arriveAt = change.arriveAt;
    item.arriveDay = change.arriveDay ?? arrivalDay(item.departAt, item.arriveAt, item.arriveDay);
    ownRide(item, (["from", "to"] as const).filter((field) => change[field] !== undefined));
    // 时间、日期或到达哪天改了，过夜要重新确认。
    if (change.day !== undefined || change.departAt !== undefined || change.arriveAt !== undefined || change.arriveDay !== undefined) {
      delete item.overnightConfirmed;
    }
  }
  for (const given of patch.addTransports ?? []) {
    const day = dayOf(given);
    if (typeof day === "string") return day;
    const input = { ...given, day };
    const from = station(input.from);
    const to = station(input.to);
    if (typeof from === "string") return from;
    if (typeof to === "string") return to;
    const departAt = input.departAt ?? null;
    const arriveAt = input.arriveAt ?? null;
    // 同一天同一种方式、起止站不冲突（原来空着或相同）的，是在补全原来那段，不另加一段（O06：先加了两段空的，
    // 查到车站后又加了两段）。同一天往返两段高铁起止站不同，照样是两段。V3.6：代码暂定的车站也算空着，用户说的车站换掉它。
    const same = (left: DraftPlace | null, right: DraftPlace | null, guessed: boolean) =>
      guessed || !left || !right || (left.status === "bound" && right.status === "bound" && left.externalId === right.externalId);
    const earlier = outing.transports.find((item) => item.day === input.day && item.mode === input.mode &&
      same(item.from, from, !!item.suggested?.from) && same(item.to, to, !!item.suggested?.to));
    if (earlier) {
      earlier.from = from ?? earlier.from;
      earlier.to = to ?? earlier.to;
      ownRide(earlier, [...(from ? ["from" as const] : []), ...(to ? ["to" as const] : [])]);
      earlier.departAt = departAt ?? earlier.departAt;
      earlier.arriveAt = arriveAt ?? earlier.arriveAt;
      earlier.arriveDay = input.arriveDay ?? arrivalDay(earlier.departAt, earlier.arriveAt, earlier.arriveDay);
      delete earlier.overnightConfirmed;
      continue;
    }
    outing.transports.push({
      id: nextTransportId(outing.transports.map((item) => item.id)),
      day: input.day,
      mode: input.mode,
      from,
      to,
      departAt,
      arriveAt,
      arriveDay: input.arriveDay ?? arrivalDay(departAt, arriveAt, "same"),
    });
  }
  if (outing.transports.length > DRAFT_LIMITS.transports) return "too_many_transports";
  for (const id of patch.confirmOvernight ?? []) {
    const item = outing.transports.find((entry) => entry.id === id);
    if (!item || item.arriveDay !== "next") return "unknown_transport";
    item.overnightConfirmed = true;
  }
  if (patch.removeLodgingAreas?.length) {
    const areas = (outing.lodgingAreas ?? []).filter((item) => !patch.removeLodgingAreas!.includes(item.text));
    if (areas.length) outing.lodgingAreas = areas;
    else delete outing.lodgingAreas;
  }
  if (patch.removeStays?.length) {
    const stays = (outing.stays ?? []).filter((item) => !item.nights.some((night) => patch.removeStays!.includes(night)));
    if (stays.length) outing.stays = stays;
    else delete outing.stays;
  }
  if (patch.noDriving?.length) outing.noDriving = [...new Set([...(outing.noDriving ?? []), ...patch.noDriving])].sort((a, b) => a - b);
  // 最后一天的过夜交通（夜车回家）不占行程里的哪一晚。
  const days = outingDays(outing);
  const onBoard = new Set(outing.transports
    .filter((item) => item.arriveDay === "next" && (!days || item.day < days))
    .map((item) => item.day));
  for (const set of patch.setLodging ?? []) {
    // “都住 X”时跳过在车上的那一晚；要设的几晚全在车上才算填错。
    const nights = set.nights.filter((night) => !onBoard.has(night));
    if (!nights.length && set.place !== null) return "night_on_board";
    const place = set.place === null ? null : resolve(set.place);
    if (typeof place === "string") return place;
    if (place?.status === "current") return "current_only_for_ends";
    for (const night of nights) {
      outing.lodging = [...outing.lodging.filter((item) => item.night !== night), { night, place }];
    }
  }
  // 过夜交通那一晚在车上；交通删了或不再过夜，这一晚恢复成未定。
  outing.lodging = outing.lodging.filter((item) => !item.onBoard || onBoard.has(item.night));
  for (const night of onBoard) {
    outing.lodging = [...outing.lodging.filter((item) => item.night !== night), { night, place: null, onBoard: true }];
  }
  outing.lodging.sort((a, b) => a.night - b.night);
  return null;
}

/**
 * V3.3（§3.6）：兴趣的原话是“住 / 住在 + 地名 + （附近 / 一带 / 周边）”时，返回地名（“住春熙路附近”→“春熙路”）；
 * 说的是住得怎样或住哪类（“住得舒服点”“住民宿”）不算。
 */
export function lodgingAreaOf(text: string): string | null {
  const said = /^(?:住在|住宿在|住到|住)(.+?)(?:附近|一带|周边|旁边|边上|那边|边)?$/.exec(text.trim());
  const area = said?.[1]?.trim();
  if (!area || area.length < 2 || area.length > DRAFT_LIMITS.lodgingAreaChars) return null;
  if (/^宿|[得好点贵晚]|舒服|便宜|安静|干净|方便|酒店|宾馆|民宿|客栈|青旅|旅舍|旅馆/.test(area)) return null;
  return area;
}

/** V3.3：决定每天人在哪的部分（日期、每段交通的日期、起终点、过夜），用来判断暂定的住处还作不作数。 */
function whereabouts(outing: OutingDraft): string {
  const id = (place: DraftPlace | null) => (place?.status === "bound" ? place.externalId : place?.status ?? "");
  return JSON.stringify([
    outing.dates,
    outing.transports.map((item) => [item.day, id(item.from), id(item.to), item.arriveDay]).sort(),
    // V4.3：“住在哪”变了，每晚的城市跟着变。
    (outing.stays ?? []).map((item) => [item.nights, item.city.adcode]),
  ]);
}

/** V3.6：用户改了这趟交通：改了的那一端不再是暂定的，这一趟也不再算代码补的。 */
function ownRide(item: OutingTransport, ends: readonly ("from" | "to")[]) {
  if (!item.suggested) return;
  const rest = { ...item.suggested };
  delete rest.ride;
  delete rest.day;
  for (const end of ends) delete rest[end];
  if (Object.keys(rest).length) item.suggested = rest;
  else delete item.suggested;
}

/** 没说到达哪天时：到达时刻早于出发时刻就是第二天到（夜车、红眼航班）。 */
function arrivalDay(departAt: string | null, arriveAt: string | null, fallback: "same" | "next"): "same" | "next" {
  if (departAt && arriveAt) return minutes(arriveAt) < minutes(departAt) ? "next" : "same";
  return fallback;
}

function nextTransportId(used: readonly string[]): string {
  return `t${used.reduce((max, id) => Math.max(max, Number(id.slice(1))), 0) + 1}`;
}

/** 等用户选的位置：起点、终点、地点，出游的第几晚住处（n2）和交通的起止站（t1:from）。 */
function chooseCurrent(draft: RequirementsDraft, target: string): DraftPlace | null | undefined {
  if (target === "start" || target === "end") return draft[target];
  if (/^n\d$/.test(target)) return draft.outing?.lodging.find((item) => item.night === Number(target.slice(1)))?.place;
  const leg = /^(t\d{1,2}):(from|to)$/.exec(target);
  if (leg) return draft.outing?.transports.find((item) => item.id === leg[1])?.[leg[2] as "from" | "to"];
  return draft.visits.find((visit) => visit.key === target)?.place;
}

/** V3.6：暂定车站、暂定住处的候选（目标是 t1:to、n1 这类，这一处是代码暂定的）。 */
function guessedOthers(draft: RequirementsDraft, target: string): readonly z.infer<typeof draftChoiceSchema>[] {
  if (/^n\d$/.test(target)) {
    const night = draft.outing?.lodging.find((item) => item.night === Number(target.slice(1)));
    return night?.source === "suggested" ? night.others ?? [] : [];
  }
  const leg = /^(t\d{1,2}):(from|to)$/.exec(target);
  const item = leg ? draft.outing?.transports.find((entry) => entry.id === leg[1]) : undefined;
  return item?.suggested?.[leg![2] as "from" | "to"]?.others ?? [];
}

function setChosen(draft: RequirementsDraft, target: string, place: DraftPlace) {
  if (target === "start" || target === "end") {
    draft[target] = place;
    return;
  }
  if (/^n\d$/.test(target)) {
    // 用户选的就是用户的：不再标暂定，候选也不留。
    const night = draft.outing!.lodging.find((item) => item.night === Number(target.slice(1)))!;
    night.place = place;
    delete night.source;
    delete night.others;
    return;
  }
  const leg = /^(t\d{1,2}):(from|to)$/.exec(target);
  if (leg) {
    const item = draft.outing!.transports.find((entry) => entry.id === leg[1])!;
    item[leg[2] as "from" | "to"] = place;
    ownRide(item, [leg[2] as "from" | "to"]);
    return;
  }
  draft.visits.find((visit) => visit.key === target)!.place = place;
}

/** V2.11：出游卡片不能自相矛盾：日期顺序、最多 7 天、各项的第几天在日期范围内、交通时间、固定事项有日子。 */
function outingProblem(draft: RequirementsDraft, outing: OutingDraft): PatchError | null {
  if (draft.visits.length > DRAFT_LIMITS.outingVisits) return "too_many_visits";
  if (draft.interests.length > DRAFT_LIMITS.outingInterests) return "too_many_interests";
  if (outing.dates && outing.dates.from > outing.dates.to) return "dates_order";
  const days = outingDays(outing);
  if (days > DRAFT_LIMITS.outingDays) return "too_many_days";
  if (minutes(outing.dailyWindow.startsAt) >= minutes(outing.dailyWindow.endsAt)) return "window_order";
  if (days) {
    if ([...draft.visits, ...draft.interests, ...outing.transports].some((item) => (item.day ?? 0) > days)) return "day_outside_dates";
    if (outing.lodging.some((item) => item.night >= days)) return "night_outside_dates";
  }
  for (const item of outing.transports) {
    if (item.arriveDay === "same" && item.departAt && item.arriveAt && minutes(item.arriveAt) <= minutes(item.departAt)) {
      return "transport_time_order";
    }
  }
  for (const visit of draft.visits.filter((item) => item.role === "fixed")) {
    if (!visit.day) return "fixed_needs_day";
    if (visit.startsAt && visit.endsAt && minutes(visit.startsAt) >= minutes(visit.endsAt)) return "fixed_time";
  }
  const fixedPerDay = new Map<number, number>();
  for (const visit of draft.visits.filter((item) => item.role === "fixed")) fixedPerDay.set(visit.day!, (fixedPerDay.get(visit.day!) ?? 0) + 1);
  if ([...fixedPerDay.values()].some((count) => count > DRAFT_LIMITS.fixedVisits)) return "too_many_fixed";
  return null;
}

const TRANSPORT_WORDS = { train: "高铁", flight: "航班", other: "交通" } as const;

/**
 * V2.11 出游卡片还缺什么（§3.3）：日期、出发地点、要选的地点、交通的车站、过夜交通的确认（由代码挡住开始规划，
 * 不靠模型）；地点跨了城市却没有交通方式（没登记高铁航班，出行方式里也没有自驾或打车）时要问。
 */
function outingMissing(draft: RequirementsDraft, outing: OutingDraft): string[] {
  const missing: string[] = [];
  if (!outing.dates) missing.push("日期");
  const place = (value: DraftPlace | null, label: string) => {
    if (value?.status === "choose") missing.push(`选择${label}`);
    else if (value?.status === "current") missing.push("允许定位（或告诉我出发地点）");
  };
  if (!draft.start) missing.push("出发地点");
  place(draft.start, "出发地点");
  place(draft.end, "结束地点");
  for (const night of outing.lodging) place(night.place, `第 ${night.night} 晚的住处`);
  for (const item of outing.transports) {
    const word = TRANSPORT_WORDS[item.mode];
    if (!item.from) missing.push(`第 ${item.day} 天${word}的出发站`);
    if (!item.to) missing.push(`第 ${item.day} 天${word}的到达站`);
    place(item.from, `第 ${item.day} 天${word}的出发站`);
    place(item.to, `第 ${item.day} 天${word}的到达站`);
    if (item.arriveDay === "next" && !item.overnightConfirmed) missing.push(`确认第 ${item.day} 晚在${item.mode === "flight" ? "飞机" : "车"}上过夜`);
  }
  for (const visit of draft.visits) {
    if (visit.place.status === "choose") missing.push(`选择“${visit.place.mention}”`);
    if (visit.role === "fixed" && (!visit.startsAt || !visit.endsAt)) {
      missing.push(`${visit.place.status === "bound" ? visit.place.name : "固定事项"}的时间`);
    }
  }
  if (draft.visits.length === 0 && draft.interests.length === 0) missing.push("想去的地方或兴趣");
  const cities = new Set([
    draft.start, draft.end, ...outing.lodging.map((item) => item.place), ...draft.visits.map((visit) => visit.place),
    ...outing.transports.flatMap((item) => [item.from, item.to]),
  ].flatMap((value) => (value?.status === "bound" && value.city ? [value.city] : [])));
  const ways = draft.travel?.allowed ?? [];
  if (cities.size > 1 && !outing.transports.length && !ways.includes("driving") && !ways.includes("taxi")) {
    missing.push("城市之间怎么去（高铁、飞机或开车）");
  }
  // 起点和终点都等定位时只说一次。
  return [...new Set(missing)];
}

/** V2.11：把地点或兴趣放到第几天并固定在那天；已有分配时在分配里跟着挪（检查由服务端重做）。 */
function moveToDay(draft: RequirementsDraft, target: string, day: number): PatchError | null {
  const visit = draft.visits.find((item) => item.key === target);
  const interest = draft.interests.find((item) => item.id === target);
  if (!visit && !interest) return target.startsWith("v") ? "unknown_visit" : "unknown_interest";
  if (visit) visit.day = day;
  if (interest) {
    interest.day = day;
    delete interest.perDay;
  }
  const allocation = draft.outing?.allocation;
  if (allocation) {
    const field = visit ? "visits" : "interests";
    for (const entry of allocation.days) entry[field] = entry[field].filter((id) => id !== target);
    const entry = allocation.days.find((item) => item.day === day);
    if (entry) entry[field].push(target);
    else allocation.days.push({ day, visits: visit ? [target] : [], interests: interest ? [target] : [] });
    allocation.days.sort((a, b) => a.day - b.day);
  }
  return null;
}

/**
 * V2.11 对话中切换日常 / 出游（§3.10）：新建一张另一种模式的卡片，把已经说的地点、兴趣、日期带过去。
 * 出游 → 日常只带卡片主要城市的地点和兴趣（日常只做所在城市，D-072）；日常 → 出游时，日常里遇到的外地地点
 * （elsewhere，只有编号、名称和城市）一起带上。返回带过去和留下的名称，页面照实说明。
 */
export function switchDraftMode(
  draft: RequirementsDraft,
  to: "daily" | "outing",
  elsewhere: readonly { readonly externalId: string; readonly name: string; readonly city: string }[] = [],
): { draft: RequirementsDraft; carried: string[]; left: string[] } {
  const city = draftCity(draft);
  const named = (place: DraftPlace | null) => (place?.status === "bound" ? place.name : null);
  const carried: string[] = [];
  const left: string[] = [];
  if (to === "outing") {
    if (draft.mode === "outing") return { draft, carried, left };
    const visits = draft.visits.map((visit) => ({ ...visit }));
    for (const place of elsewhere) {
      if (visits.length >= DRAFT_LIMITS.outingVisits) break;
      if (visits.some((visit) => visit.place.status === "bound" && visit.place.externalId === place.externalId)) continue;
      visits.push({
        key: `v${Math.max(0, ...visits.map((visit) => Number(visit.key.slice(1)))) + 1}`,
        place: { status: "bound", externalId: place.externalId, name: place.name, city: place.city },
        role: "required",
        stayMinutes: null,
        startsAt: null,
        endsAt: null,
      });
    }
    carried.push(...visits.flatMap((visit) => named(visit.place) ?? []), ...draft.interests.map((item) => item.text));
    const outing = emptyOutingDraft(draft.city).outing!;
    return {
      draft: requirementsDraftSchema.parse({
        ...emptyOutingDraft(draft.city),
        start: draft.start,
        end: draft.end,
        visits,
        interests: draft.interests,
        ...(draft.travel ? { travel: draft.travel } : {}),
        pace: draft.pace,
        notes: draft.notes,
        outing: {
          ...outing,
          ...(draft.date ? { dates: { from: draft.date, to: draft.date } } : {}),
          startAt: draft.startsAt,
          endAt: draft.endsAt,
        },
      }),
      carried,
      left,
    };
  }
  if (draft.mode !== "outing") return { draft, carried, left };
  const here = (place: DraftPlace | null) => !place || place.status !== "bound" || !place.city || place.city === city.adcode;
  const visits = draft.visits.filter((visit) => {
    // 固定事项只有在第一天（日常卡片的那一天）的才带。
    const keep = here(visit.place) && (visit.role !== "fixed" || !visit.day || visit.day === 1) && carried.length < DRAFT_LIMITS.visits;
    (keep ? carried : left).push(named(visit.place) ?? visit.key);
    return keep;
  }).map((visit) => {
    const next = { ...visit };
    delete next.day;
    return next;
  });
  const interests = draft.interests.filter((item) => {
    const keep = (!item.city || item.city.adcode === city.adcode) && interestsKept(carried, draft) < DRAFT_LIMITS.interests;
    (keep ? carried : left).push(item.text);
    return keep;
  }).map((item) => {
    const next = { ...item };
    delete next.day;
    delete next.perDay;
    delete next.city;
    return next;
  });
  return {
    draft: requirementsDraftSchema.parse({
      ...emptyDraft(),
      ...(draft.city ? { city: draft.city } : {}),
      date: draft.outing?.dates?.from ?? null,
      startsAt: draft.outing?.startAt ?? null,
      endsAt: draft.outing?.endAt ?? null,
      start: here(draft.start) ? draft.start : null,
      end: here(draft.end) ? draft.end : null,
      visits,
      interests,
      ...(draft.travel ? { travel: draft.travel } : {}),
      pace: draft.pace,
      notes: draft.notes,
    }),
    carried,
    left,
  };
}

/** 已经带上的兴趣数（carried 前面是地点）。 */
function interestsKept(carried: readonly string[], draft: RequirementsDraft): number {
  return carried.filter((name) => draft.interests.some((item) => item.text === name)).length;
}
