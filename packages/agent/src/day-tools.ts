import {
  DAY_INTEREST_QUERIES,
  DAY_STAY_MINUTES,
  buildDayDraft,
  withStays,
  freezeDayProblem,
  stayForKind,
  type PlaceKind,
  type DayActivityRecord,
  type DayPlaceRecord,
  type DayPlanningProblem,
} from "@tripquest/application/day-planning";
import { openingFor } from "@tripquest/application/opening-hours";
import {
  interestWithin,
  planningInterestSpecs,
  planningPlaceSchema,
  planningTravel,
  type PlanningPlace,
} from "@tripquest/application/planning";
import { chooseLeg, straightMeters } from "@tripquest/application/leg-choice";
import {
  inspectDayOrder,
  sameDayPlace,
  scheduleDay,
  validateDayDraft,
  type DayPlanningInput,
  type DayRoute,
  type DaySchedule,
} from "@tripquest/domain";
import { PLANNING_FIXTURE_VERSION } from "@tripquest/providers/planning-fixture";
import type { MobilityProvider, PlaceSearchRequest, ProviderEvidence } from "@tripquest/providers";
import { z } from "zod";
import {
  DayRunError,
  type DayAction,
  type DayAttempt,
  type DayDecisionContext,
  type DayLimits,
  type DayRunnerDependencies,
  type DaySearchObservation,
  type DayToolOptions,
} from "./day-contracts";
import { dayOperation } from "./day-runtime";
import { partOf } from "./place-names";

const evidenceSchema = z.strictObject({
  provider: z.string().min(1).max(80), sourceKind: z.enum(["fixture", "live"]),
  retrievedAt: z.iso.datetime({ offset: true }), attribution: z.string().min(1).max(300),
  datasetVersion: z.string().max(80).optional(),
});
const failureSchema = z.strictObject({
  code: z.enum(["invalid_request", "authorization_failed", "quota_exceeded", "rate_limited", "timeout",
    "upstream_unavailable", "malformed_response", "cancelled", "unknown"]),
  retry: z.enum(["never", "after_backoff", "after_quota_reset", "after_configuration_change"]),
  safeMessage: z.string().max(600), retryAfterSeconds: z.number().int().nonnegative().optional(),
});
const searchSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), evidence: evidenceSchema, data: z.strictObject({
    items: z.array(z.unknown()).max(5), truncated: z.boolean(), excludedCount: z.number().int().nonnegative().optional(),
  }) }),
  z.strictObject({ status: z.literal("failure"), evidence: evidenceSchema, failure: failureSchema }),
]);
const routeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), evidence: evidenceSchema, routes: z.array(z.strictObject({
    mode: z.enum(["walking", "transit", "taxi", "bicycling", "driving"]),
    durationSeconds: z.number().int().nonnegative().safe(),
    distanceMeters: z.number().int().nonnegative().safe(),
    fareYuan: z.number().nonnegative().max(10_000).optional(),
    summary: z.string().min(1).max(80).optional(),
    walkingMeters: z.number().int().nonnegative().safe().optional(),
    path: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).max(200).optional(),
  })).min(1).max(20) }),
  z.strictObject({ status: z.literal("no_route"), evidence: evidenceSchema, reason: z.enum([
    "no_path", "origin_unmatched", "destination_unmatched", "distance_limit", "unsupported_mode",
  ]) }),
  z.strictObject({ status: z.literal("failure"), evidence: evidenceSchema, failure: failureSchema }),
]);

/**
 * V3.5：景点类的地点类型；明显不是景点的高德分类：餐饮 05、购物 06（0610 是景区里的商业街，不算）、生活服务 07（游客
 * 接待中心、邮局）、公司企业 17（旅行社：成都东站旁搜“熊猫”的第一个结果是 170200）。
 */
const SIGHT_KINDS = new Set(["city_spot", "big_scenic", "hike", "water"]);
function plainlyNotSight(code: string | undefined): boolean {
  const first = (code ?? "").split("|")[0] ?? "";
  return /^(05|07|17)/.test(first) || (first.startsWith("06") && !first.startsWith("0610"));
}

/** V3.4：全城搜过的记在去重记录里的写法（和普通搜索的键放在一起，检查点不用改）。 */
const cityWideKey = (key: string) => `${key}#city`;
const CITY_WIDE_NOTE = "nothing suitable nearby, so these are results from the whole city; check the route in a try";

/** 执行器已取得的事实与去重记录；Map/Set 展开为数组，才能作为 JSON 写入检查点。 */
export interface DayToolSnapshot {
  readonly places: DayPlaceRecord[];
  readonly activities: DayActivityRecord[];
  readonly searches: DaySearchObservation[];
  readonly attempts: DayAttempt[];
  readonly routes: [string, DayRoute][];
  readonly evidence: [string, ProviderEvidence][];
  readonly searchKeys: string[];
  readonly orderKeys: string[];
  /** V4.2：已经因为点名的地点没试过打回过一次（只打回一次）。旧检查点没有这一项。 */
  readonly namedNudged?: boolean;
}

/** V4.2：点名的地点要放进空档，除了停留再留这么多分钟走过去、走回来。 */
const NAMED_TRAVEL_MARGIN = 30;
const clockOf = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

/**
 * 一次运行共享一份地点池、活动池、路线事实和去重记录。
 * 图每步从快照重建实例，恢复后仍知道哪些词查过、哪些顺序试过，成功与失败观察都保留。
 */
export class DayToolExecutor {
  readonly places: DayPlaceRecord[];
  readonly activities: DayActivityRecord[];
  readonly searches: DaySearchObservation[];
  readonly attempts: DayAttempt[];
  readonly routeEvidence: Map<string, ProviderEvidence>;
  private readonly routeCache: Map<string, DayRoute>;
  private readonly searchKeys: Set<string>;
  private readonly orderKeys: Set<string>;
  private namedNudged: boolean;

  constructor(
    readonly problem: DayPlanningProblem,
    private readonly dependencies: DayRunnerDependencies,
    private readonly limits: DayLimits,
    private readonly options: DayToolOptions,
    snapshot?: DayToolSnapshot,
  ) {
    // 深拷贝快照和初始问题，执行期间增添候选或试算不会修改上游冻结输入，也不共享恢复前实例的引用。
    const saved = snapshot ? structuredClone(snapshot) : undefined;
    this.places = saved?.places ?? structuredClone(problem.places) as DayPlaceRecord[];
    this.activities = saved?.activities ?? structuredClone(problem.activities) as DayActivityRecord[];
    this.searches = saved?.searches ?? [];
    this.attempts = saved?.attempts ?? [];
    this.routeCache = new Map(saved?.routes ?? []);
    this.routeEvidence = new Map(saved?.evidence ?? []);
    this.searchKeys = new Set(saved?.searchKeys ?? []);
    this.orderKeys = new Set(saved?.orderKeys ?? []);
    this.namedNudged = saved?.namedNudged ?? false;
  }

  snapshot(): DayToolSnapshot {
    return structuredClone({
      places: this.places,
      activities: this.activities,
      searches: this.searches,
      attempts: this.attempts,
      routes: [...this.routeCache.entries()],
      evidence: [...this.routeEvidence.entries()],
      searchKeys: [...this.searchKeys],
      orderKeys: [...this.orderKeys],
      ...(this.namedNudged ? { namedNudged: true } : {}),
    });
  }

  /** 每次试算用当前活动池重新构造领域输入，并刷新 nowMs；证据是否已过期按此刻判断。 */
  /** V2.11：stays 是这次试排缩短了的估计停留。 */
  input(stays: ReadonlyMap<string, number> = new Map()): DayPlanningInput {
    return {
      ...this.problem.input,
      places: this.places.map(({ placeId, selection }) => ({
        placeId, ...selection.place.ref, snapshot: JSON.stringify(selection.place),
      })),
      activities: withStays(this.activities, stays).map((r) => r.activity),
      nowMs: this.now(),
    };
  }

  private now() { return (this.dependencies.now ?? Date.now)(); }
  private active() {
    if (this.options.signal.aborted) throw new DayRunError("timeout");
  }
  private progress(phase: "searching" | "routing" | "checking", detail?: string) {
    this.active();
    this.options.onProgress({ phase, counts: { ...this.options.counts }, ...(detail ? { detail: detail.slice(0, 120) } : {}) });
  }

  private placeName(placeId: string, length = 30): string {
    return this.places.find((p) => p.placeId === placeId)?.selection.place.name.slice(0, length) ?? "某地";
  }
  // 同一轮只接受与初始地点同来源的证据；未来时间戳、超过五分钟的结果或错误 fixture 版本都拒绝。
  // 这能检查来源一致性和新鲜度，不能替代供应商对地点真实性的保证。
  private validEvidence(evidence: ProviderEvidence) {
    const expected = this.problem.places[0].selection.evidence;
    const time = Date.parse(evidence.retrievedAt);
    if (evidence.provider !== expected.provider || evidence.sourceKind !== expected.sourceKind ||
      !Number.isFinite(time) || time > this.now() || this.now() - time > 300_000 ||
      (expected.sourceKind === "fixture" && evidence.datasetVersion !== PLANNING_FIXTURE_VERSION)) {
      throw new DayRunError("provider_error");
    }
  }
  // 权限、配额、限流及协议错误应停止本次调查；普通临时查询失败则留作失败观察，让模型决定换方向。
  private checkFailure(code: string) {
    if (["authorization_failed", "quota_exceeded", "rate_limited", "malformed_response", "invalid_request"].includes(code)) {
      throw new DayRunError("provider_error");
    }
    if (code === "cancelled") throw new DayRunError("timeout");
  }

  /**
   * V2.3：检查自由兴趣是否排了超过用户要求的站数，例如“喝点酒”默认只是一家。
   * 一次指出全部超量兴趣，并建议保留各兴趣前几站的顺序；逐个报错曾让模型来回修复。
   * 这项预检不发路线请求；旧版枚举兴趣保持原有语义。
   */
  private overCount(order: readonly string[]): string | null {
    const allowed = new Map(planningInterestSpecs(this.problem.requirements)
      .filter((spec) => /^i\d/.test(spec.id))
      .map((spec) => [spec.id, spec.count ?? 1]));
    const kept = new Map<string, number>();
    const over = new Map<string, string[]>();
    const trimmed = order.filter((id) => {
      const record = this.activities.find((item) => item.activity.activityId === id);
      const interest = record?.activity.role === "discovered" ? record.interest : undefined;
      if (!interest || !allowed.has(interest)) return true;
      const used = (kept.get(interest) ?? 0) + 1;
      kept.set(interest, used);
      return used <= allowed.get(interest)!;
    });
    for (const id of order) {
      const record = this.activities.find((item) => item.activity.activityId === id);
      const interest = record?.activity.role === "discovered" ? record.interest : undefined;
      if (interest && (kept.get(interest) ?? 0) > allowed.get(interest)!) over.set(interest, [...(over.get(interest) ?? []), id]);
    }
    if (!over.size) return null;
    const parts = [...over].map(([interest, ids]) => `${interest} wants ${allowed.get(interest)}, order has ${ids.join(",")}`);
    // 裁剪后的顺序若也失败过，就继续给更小组合或停止建议，不能让模型再试同一个失败方案。
    const next = this.orderKeys.has(JSON.stringify(trimmed)) ? this.duplicateHint(trimmed) : `try ${JSON.stringify(trimmed)}`;
    return `interest_over_count: ${parts.join("; ")}; ${next}`;
  }

  /**
   * 解析一次搜索对应的兴趣、关键词和停留估计：旧版枚举映射固定词，新版自由兴趣由模型给词。
   * 模型只能调查用户已选的兴趣；搜索词变化不能变相增加新的业务目标。
   */
  private resolveSearch(action: Extract<DayAction, { action: "search_places" }>):
    | { interest: string; query: string; stayMinutes: number; kind?: PlaceKind; key: string }
    | string {
    const interest = action.interestId ?? action.interest;
    if (!interest || (action.interest && action.interestId)) return "invalid_search";
    if (!planningInterestSpecs(this.problem.requirements).some((spec) => spec.id === interest)) {
      return "interest_not_selected";
    }
    const fixed = interest in DAY_INTEREST_QUERIES ? interest as keyof typeof DAY_INTEREST_QUERIES : null;
    const query = action.query ?? (fixed ? DAY_INTEREST_QUERIES[fixed] : null);
    if (!query) return "query_required";
    // V2.10：模型给了大致类型时，停留夹到这类地点的合理范围（爬山、主题乐园可以占大半天）。
    const stayMinutes = stayForKind(action.kind, action.stayMinutes ?? (fixed ? DAY_STAY_MINUTES[fixed] : 60));
    // 旧动作保留旧去重键，兼容已有检查点；新版把兴趣、关键词和搜索中心一起作为身份。
    const anchor = action.anchorPlaceId ?? `area:${action.area}`;
    const key = action.query
      ? JSON.stringify([interest, query, anchor])
      : JSON.stringify([interest, anchor]);
    return { interest, query, stayMinutes, ...(action.kind ? { kind: action.kind } : {}), key };
  }

  /**
   * 执行前的语义门：搜索中心必须存在，试算不能删受保护站，finish 只能引用本轮同需求的成功试算。
   * stop 也要有依据，不能让模型用“没有合适地点”掩盖从未搜索、或用“排不开”掩盖从未尝试。
   */
  guard(action: DayAction): string | null {
    switch (action.action) {
      case "search_places": {
        const search = this.resolveSearch(action);
        if (typeof search === "string") return search;
        // 搜索耗尽后告知仍合法的下一步；有活动可试排，池为空才只能说明没有找到地点。
        if (this.options.counts.searches >= this.limits.searches) {
          return this.activities.length
            ? "no_searches_left: try_itinerary with the activities found, or stop"
            : "no_searches_left: stop no_suitable_places";
        }
        if (!action.anchorPlaceId === !action.area) return "anchor_required: give anchorPlaceId or area, not both";
        if (action.anchorPlaceId && !this.places.some((p) => p.placeId === action.anchorPlaceId)) return "unknown_place";
        // V3.4（stages/V3.4.md §3.7）：同一个搜索第二次不拒绝，改为全城搜一次（search 里）；再重复才拒绝。
        if (this.searchKeys.has(cityWideKey(search.key))) return "duplicate_search";
        return null;
      }
      case "try_itinerary": {
        const issues = inspectDayOrder(this.input(), action.orderedActivityIds);
        if (issues.length) return issues[0].code;
        const over = this.overCount(action.orderedActivityIds);
        if (over) return over;
        if (this.orderKeys.has(JSON.stringify(action.orderedActivityIds))) {
          // 重复已成功顺序通常表示模型想结束，反馈明确给出可引用的 attemptId。
          const done = this.attempts.find((attempt) =>
            attempt.schedule && JSON.stringify(attempt.order) === JSON.stringify(action.orderedActivityIds));
          if (done) return `duplicate_order: ${done.attemptId} already succeeded, finish it`;
          // 重复失败组合时提供未试过的更小顺序或停止条件，不只返回一个裸错误码。
          return this.duplicateHint(action.orderedActivityIds);
        }
        return null;
      }
      case "finish": {
        const attempt = this.attempts.find((a) => a.attemptId === action.attemptId);
        if (!(attempt?.schedule && attempt.validation?.verdict !== "rejected" &&
          attempt.runId === this.problem.runId && attempt.requirementsFingerprint === this.problem.requirementsFingerprint)) {
          return "unverified_attempt";
        }
        return this.untriedNamed(attempt);
      }
      case "stop": {
        const latest = this.attempts.at(-1);
        const unknown = latest?.issues.some((i) => i.kind === "unknown") || this.searches.some((s) => s.failureCode);
        // 还没试算就说排不开没有证据；若有受保护站，先要求只试固定与必去组成的最小顺序。
        const untried = this.firstOrder();
        const unsupported = !this.attempts.length && untried.length
          ? `unsupported_stop: nothing tried yet; try ${JSON.stringify(untried)}`
          : "unsupported_stop";
        if (action.reason === "insufficient_information") return unknown ? null : unsupported;
        if (action.reason === "constraints_not_met") {
          if (!(latest && !latest.schedule && latest.issues.length)) return unsupported;
          // 宣告约束不满足前，必须试过只有固定与必去的组合，不能因可选站过多就直接放弃。
          const protectedOrder = this.protectedOrder();
          const tried = this.attempts.some((attempt) => JSON.stringify(attempt.order) === JSON.stringify(protectedOrder));
          return protectedOrder.length && !tried ? `protected_only_untried: try ${JSON.stringify(protectedOrder)}` : null;
        }
        return this.searches.length > 0 && this.activities.length === 0 ? null : unsupported;
      }
    }
  }

  async search(action: Extract<DayAction, { action: "search_places" }>): Promise<void> {
    this.active();
    if (this.options.counts.searches >= this.limits.searches) throw new DayRunError("budget_exhausted");
    const search = this.resolveSearch(action);
    if (typeof search === "string") throw new DayRunError("internal_error");
    // V3.4：同一个兴趣、同一个词、同一个中心又搜一次，说明附近的结果模型不要（成都东站旁搜“熊猫”全是带熊猫的店）。
    // 这一次改在这一天的城市里按相关度搜；路线来不来得及照旧由试算判断。
    let cityWide = this.searchKeys.has(search.key);
    this.searchKeys.add(cityWide ? cityWideKey(search.key) : search.key);
    this.options.counts.searches += 1;
    const observed = (fields: Partial<DaySearchObservation>): DaySearchObservation => ({
      interest: search.interest, query: search.query,
      ...(action.area ? { area: action.area } : {}),
      activityIds: [], excludedCount: 0, ...fields,
    });
    // V2.2：用户说“西湖边”等区域时，先查区域地点，再围绕它做周边搜索。
    // 区域地点登记进本轮地点池，后续可以引用同一搜索中心，减少重复的城市搜索。
    let anchorPlaceId = action.anchorPlaceId;
    if (!anchorPlaceId) {
      const area = await this.findArea(action.area!);
      if (typeof area === "string") {
        this.searches.push(observed({ failureCode: area }));
        return;
      }
      anchorPlaceId = area.placeId;
    }
    const interestText = planningInterestSpecs(this.problem.requirements).find((spec) => spec.id === search.interest)?.text;
    this.progress(
      "searching",
      `在“${this.placeName(anchorPlaceId)}”附近搜索“${search.query}”${interestText && interestText !== search.query ? `（${interestText}）` : ""}`,
    );
    const anchor = this.places.find((p) => p.placeId === anchorPlaceId)!;
    const near = async (radiusMeters: number) => {
      const found = await this.lookup({
        query: search.query,
        scope: cityWide
          ? { kind: "city", cityAdcode: this.problem.requirements.cityAdcode }
          : { kind: "nearby", center: anchor.selection.place.location, radiusMeters },
        limit: 5,
        // V2.5：同次搜索读取当天营业信息，只转换为规划时段；其余商户详情不进入需求持久化。
        withBusiness: true,
      });
      if ("failureCode" in found) return found;
      // V2.11：日常只在所在城市（D-072）：扩大半径后搜到的邻市地点不用；出游不限城市。
      // 出游逐天生成：前几天找到的地点这一天不再用（跨天不重复）。
      const { cityAdcode: city, anyCity, exclude = [] } = this.problem.requirements;
      const kept = found.selections.filter((selection) =>
        (anyCity || !selection.place.cityAdcode || selection.place.cityAdcode === city) && !exclude.includes(selection.place.ref.externalId));
      return { selections: kept, excludedCount: found.excludedCount + found.selections.length - kept.length };
    };
    // V2.10：郊区、山区附近的地点少：3 公里内不到 3 个就扩到 10 公里，再不到就扩到 30 公里；
    // 扩大后的半径写进观察，模型说理由时知道“离山门约 8 公里”。仍算一次地点调查。
    let radiusMeters = 3000;
    let found = await near(radiusMeters);
    while (!cityWide && !("failureCode" in found) && found.selections.length < 3 && radiusMeters < 30_000) {
      radiusMeters = radiusMeters === 3000 ? 10_000 : 30_000;
      const wider = await near(radiusMeters);
      if ("failureCode" in wider) break;
      found = wider;
    }
    // V3.5（stages/V3.5.md §3.6）：模型说要找景点类（kind）时，去掉明显不是景点的结果（餐饮、购物、生活服务：成都东站旁
    // 搜“熊猫”的旅行社、快闪店）；去掉后一个不剩，不等模型重复，直接在全城按相关度搜一次（同 V3.4 的那一步）。
    let dropped = 0;
    const sights = (result: typeof found) => {
      if ("failureCode" in result || !search.kind || !SIGHT_KINDS.has(search.kind)) return result;
      const kept = result.selections.filter((selection) => !plainlyNotSight(selection.place.categoryCode));
      dropped += result.selections.length - kept.length;
      return { selections: kept, excludedCount: result.excludedCount };
    };
    const before = found;
    found = sights(found);
    if (!cityWide && !("failureCode" in before) && before.selections.length && !("failureCode" in found) && !found.selections.length) {
      cityWide = true;
      this.searchKeys.add(cityWideKey(search.key));
      found = sights(await near(0));
    }
    if (!("failureCode" in found) && dropped) found = { ...found, excludedCount: found.excludedCount + dropped };
    const wide = cityWide ? { cityWide: CITY_WIDE_NOTE } : radiusMeters > 3000 ? { radiusMeters } : {};
    if ("failureCode" in found) {
      this.searches.push(observed({ anchorPlaceId, failureCode: found.failureCode, ...wide }));
      return;
    }
    // 地点是供应商身份，活动是一次停留；同一地点若已登记，不再凭另一个搜索词复制一份活动。
    const activityIds: string[] = [];
    for (const selection of found.selections) {
      // 景点子节点不重复作为新一站，例如“中山公园-西湖天下景”与“中山公园”；复用已有活动身份。
      const whole = this.activities.find((a) =>
        partOf(selection.place.name, this.placeName(a.activity.placeId, 80)) ||
        partOf(this.placeName(a.activity.placeId, 80), selection.place.name));
      if (whole) {
        activityIds.push(whole.activity.activityId);
        continue;
      }
      const record = this.register(selection);
      let activity = this.activities.find((a) => a.activity.placeId === record.placeId);
      if (!activity) {
        // V2.3：把兴趣时段绑定到新活动，由排程器保证整段停留落在时段内，不能只在推荐理由里提“晚上”。
        const within = interestWithin(planningInterestSpecs(this.problem.requirements).find((spec) => spec.id === search.interest));
        activity = freezeDayProblem({
          activity: {
            activityId: `a${this.activities.length + 1}`, placeId: record.placeId,
            role: "discovered" as const, stayMinutes: search.stayMinutes,
            staySource: "system_estimate" as const, ...(within ? { within } : {}),
            opening: openingFor(record.selection.hours, this.problem.requirements.date), tickets: "unknown" as const,
          },
          interest: search.interest,
          ...(search.kind ? { kind: search.kind } : {}),
        });
        this.activities.push(activity);
      }
      activityIds.push(activity.activity.activityId);
    }
    this.searches.push(observed({ anchorPlaceId, activityIds: [...new Set(activityIds)], excludedCount: found.excludedCount, ...wide }));
  }

  /** 同一区域优先复用先前搜索已解析的中心；首次才做一次城市搜索，找不到时返回明确失败原因。 */
  private async findArea(area: string): Promise<DayPlaceRecord | string> {
    const earlier = this.searches.find((s) => s.area === area && s.anchorPlaceId);
    if (earlier) return this.places.find((p) => p.placeId === earlier.anchorPlaceId)!;
    this.progress("searching", `查找“${area}”在哪里`);
    const found = await this.lookup({ query: area, scope: { kind: "city", cityAdcode: this.problem.requirements.cityAdcode }, limit: 1 });
    if ("failureCode" in found) return found.failureCode;
    return found.selections.length ? this.register(found.selections[0]) : "area_not_found";
  }

  /** 把一次供应商响应作为整批校验：格式、证据、每个地点都合格后才返回候选，避免部分坏数据混进活动池。 */
  private async lookup(request: PlaceSearchRequest):
    Promise<{ selections: PlanningPlace[]; excludedCount: number } | { failureCode: string }> {
    let raw: unknown;
    try {
      await this.dependencies.beforeProvider?.("search");
      this.active();
      raw = await dayOperation({
        signal: this.options.signal,
        timeoutMs: this.limits.providerMs,
        operation: (signal) => this.dependencies.provider.searchPlaces(request, { signal }),
      });
    } catch (error) {
      this.active();
      if (error instanceof DayRunError && error.code !== "timeout") throw error;
      return { failureCode: "unavailable" };
    }
    this.active();
    const parsed = searchSchema.safeParse(raw);
    if (!parsed.success) throw new DayRunError("provider_error");
    const reply = parsed.data;
    this.validEvidence(reply.evidence);
    if (reply.status === "failure") {
      this.checkFailure(reply.failure.code);
      return { failureCode: reply.failure.code };
    }
    const selections = reply.data.items.map((place) => {
      const selection = planningPlaceSchema.safeParse({ place, evidence: reply.evidence });
      if (!selection.success || selection.data.place.ref.provider !== reply.evidence.provider) {
        throw new DayRunError("provider_error");
      }
      return selection.data;
    });
    return { selections, excludedCount: reply.data.excludedCount ?? 0 };
  }

  /** 按供应商与外部地点 ID 复用本轮身份；同一地点的快照出现矛盾时拒绝，不能静默覆盖已用于试算的事实。 */
  private register(selection: PlanningPlace): DayPlaceRecord {
    const record = this.places.find((p) =>
      p.selection.place.ref.provider === selection.place.ref.provider &&
      p.selection.place.ref.externalId === selection.place.ref.externalId);
    if (record && JSON.stringify(record.selection.place) !== JSON.stringify(selection.place)) {
      throw new DayRunError("provider_error");
    }
    if (record) return record;
    if (this.places.length >= 30) throw new DayRunError("budget_exhausted");
    const added = freezeDayProblem({ placeId: `p${this.places.length + 1}`, selection });
    this.places.push(added);
    return added;
  }

  // 路线是有方向的事实；同名地点、坐标变化、出行偏好或日期变化都不能命中旧结果。
  // 缓存只服务本次运行及其检查点，不能据此承诺下次打开页面时路线仍有效。
  private cacheKey(from: DayPlaceRecord, to: DayPlaceRecord): string {
    return JSON.stringify([
      from.selection.evidence.provider, from.selection.evidence.sourceKind,
      from.placeId, from.selection.place.location, to.placeId, to.selection.place.location,
      planningTravel(this.problem.requirements), this.problem.input.date,
    ]);
  }
  routeFacts(): DayRoute[] { return [...this.routeCache.values()]; }

  /**
   * server 表示代码兜底的额外试算，独立编号为 attempt-server，不占模型的组合次数。
   * 它仍受同一份路线额度、超时、排程和独立校验约束，不能借兜底绕过业务边界。
   */
  async tryItinerary(action: Extract<DayAction, { action: "try_itinerary" }>, server = false): Promise<void> {
    this.active();
    if (!server && this.options.counts.tries >= this.limits.tries) throw new DayRunError("budget_exhausted");
    this.orderKeys.add(JSON.stringify(action.orderedActivityIds));
    if (!server) this.options.counts.tries += 1;
    // 把活动序列展开为起点 → 各站 → 终点的有向边；返程也算在路线额度与整天时间窗里。
    const placeIds = [this.problem.input.startPlaceId,
      ...action.orderedActivityIds.map((id) => this.activities.find((a) => a.activity.activityId === id)!.activity.placeId),
      this.problem.input.endPlaceId];
    const input = this.input();
    const edges = placeIds.slice(1).map((id, i) => {
      const from = this.places.find((p) => p.placeId === placeIds[i])!;
      const to = this.places.find((p) => p.placeId === id)!;
      return { from, to, key: this.cacheKey(from, to) };
    });
    // 先按缓存键去重待查询边。同地衔接单独标记假设，不发 API，也不把同名但快照不同的地点当成同地。
    const needed = new Map(edges.filter(({ from, to, key }) =>
      !this.routeCache.has(key) && !sameDayPlace(
        input.places.find((p) => p.placeId === from.placeId)!,
        input.places.find((p) => p.placeId === to.placeId)!,
      )).map((edge) => [edge.key, edge]));
    if (this.options.counts.routes + needed.size > this.limits.routes) throw new DayRunError("budget_exhausted");
    // 这里先估算至少需要查的边；一段可能比较多种方式，实际每次请求仍在 beforeRequest 中再扣额度。
    for (const { from, to, key } of edges) {
      this.active();
      if (this.routeCache.has(key)) continue;
      const edge = { fromPlaceId: from.placeId, toPlaceId: to.placeId };
      if (sameDayPlace(input.places.find((p) => p.placeId === from.placeId)!, input.places.find((p) => p.placeId === to.placeId)!)) {
        this.routeCache.set(key, { ...edge, status: "same_place_assumption" });
        continue;
      }
      this.progress("routing", `核对路线：${this.placeName(from.placeId)} → ${this.placeName(to.placeId)}`);
      // 出行方式交共享选路策略决定；本适配层为每次实际请求保留预算、超时、结构与证据检查。
      // 各方式的证据分开保存，最终只把选中方式的来源挂到这条有向边上。
      const evidenceByMode = new Map<string, ProviderEvidence>();
      const chosen = await chooseLeg({
        from: { placeId: from.placeId, place: from.selection.place },
        to: { placeId: to.placeId, place: to.selection.place },
        travel: planningTravel(this.problem.requirements),
        departureAt: `${this.problem.input.date}T${this.problem.requirements.window.startsAt}:00+08:00`,
        beforeRequest: async () => {
          if (this.options.counts.routes >= this.limits.routes) throw new DayRunError("budget_exhausted");
          this.options.counts.routes += 1;
          await this.dependencies.beforeProvider?.("route");
          this.active();
        },
        provider: {
          findRoutes: async (request) => {
            let raw: unknown;
            try {
              raw = await dayOperation({
                signal: this.options.signal,
                timeoutMs: this.limits.providerMs,
                operation: (signal) => this.dependencies.provider.findRoutes(request, { signal }),
              });
            } catch (error) {
              this.active();
              if (error instanceof DayRunError && error.code !== "timeout") throw error;
              // 单次方式超时不直接编造时长；让选路器继续尝试其余允许方式，全部失败则保留 unknown。
              return {
                status: "failure",
                failure: { code: "timeout", retry: "after_backoff", safeMessage: "路线查询超时。" },
                evidence: { provider: "unavailable", sourceKind: "live", attribution: "-", retrievedAt: new Date(this.now()).toISOString() },
              };
            }
            this.active();
            const parsed = routeSchema.safeParse(raw);
            if (!parsed.success) throw new DayRunError("provider_error");
            const reply = parsed.data;
            this.validEvidence(reply.evidence);
            if (reply.status === "failure") this.checkFailure(reply.failure.code);
            if (reply.status === "ok") evidenceByMode.set(request.mode, reply.evidence);
            return reply as Awaited<ReturnType<MobilityProvider["findRoutes"]>>;
          },
        },
      });
      // 成功和失败都缓存到本轮，换组合时复用已知结果；失败绝不转成零分钟或常识估时。
      this.routeCache.set(key, chosen.route);
      if (chosen.route.status === "known") {
        const evidence = evidenceByMode.get(chosen.route.mode ?? "walking");
        if (evidence) this.routeEvidence.set(JSON.stringify([from.placeId, to.placeId]), evidence);
        if (chosen.path) this.options.onRoutePath?.(from.placeId, to.placeId, chosen.path);
      }
    }
    const tryNumber = server ? this.options.counts.tries + 1 : this.options.counts.tries;
    this.progress("checking", `试排第 ${tryNumber} 种组合：${action.orderedActivityIds.map((id) => this.placeName(
      this.activities.find((r) => r.activity.activityId === id)!.activity.placeId)).join(" → ")}`);
    const facts = this.routeFacts();
    // 模型只提供活动顺序，不能填写到达或停留时刻。排程后再走独立校验器，
    // 避免排程器自身的错误被它自己的成功状态掩盖；未知项与明确违反分别保留。
    const stays = new Map<string, number>();
    const schedule = () => {
      const input = this.input(stays);
      const scheduled = scheduleDay(input, action.orderedActivityIds, facts);
      const validation = scheduled.status === "scheduled" ? validateDayDraft(input, scheduled.schedule, facts) : undefined;
      return { scheduled, validation, success: scheduled.status === "scheduled" && validation?.verdict !== "rejected" };
    };
    let tried = schedule();
    // V2.11（stages/V2.11.md §3.2）：排不开时，卡片上估计的停留由代码逐步缩短再排：先缩超出下限最多的，
    // 每次 30 分钟，到下限为止。用户说的停留不缩；路线查不到时缩也没用，不缩。
    while (!tried.success) {
      const issues = tried.scheduled.status === "not_scheduled" ? tried.scheduled.issues : tried.validation!.issues;
      if (issues.some((item) => item.code === "day_route_unknown")) break;
      const longest = this.activities
        .filter((record) => record.floor !== undefined && action.orderedActivityIds.includes(record.activity.activityId))
        .map((record) => ({
          id: record.activity.activityId,
          now: stays.get(record.activity.activityId) ?? record.activity.stayMinutes,
          floor: record.floor!,
        }))
        .filter((item) => item.now > item.floor)
        .sort((a, b) => (b.now - b.floor) - (a.now - a.floor))[0];
      if (!longest) break;
      stays.set(longest.id, Math.max(longest.floor, longest.now - 30));
      tried = schedule();
    }
    const { scheduled, validation, success } = tried;
    const issue = (scheduled.status === "not_scheduled" ? scheduled.issues : validation!.issues)
      .find((item) => item.kind === "violation" || item.code === "day_route_unknown");
    this.progress("checking", success
      ? `第 ${tryNumber} 种组合排得开，全部按时${stays.size ? "（缩短了估计的停留）" : ""}`
      : `第 ${tryNumber} 种组合排不开：${issueWords(issue?.code)}`);
    // 每次试算保存当时的顺序和问题；只有成功时附 schedule/validation，finish 无法引用失败尝试。
    this.attempts.push(freezeDayProblem({
      attemptId: server ? "attempt-server" : `attempt-${this.options.counts.tries}`,
      runId: this.problem.runId, requirementsFingerprint: this.problem.requirementsFingerprint,
      order: action.orderedActivityIds,
      issues: scheduled.status === "not_scheduled" ? scheduled.issues : validation!.issues,
      ...(success && scheduled.status === "scheduled" ? { schedule: scheduled.schedule, validation } : {}),
      ...(success && stays.size ? { stays: Object.fromEntries(stays) } : {}),
    }));
  }

  /**
   * V4.2（stages/V4.2.md §3.2）：卡片上点名“想去”的地点本轮一次都没试过、这次方案里又有放得下它的空档时，
   * finish 打回一次，给出把它插进那段空档的顺序（D01 实测：只说空档在下午，模型把灵隐寺放到第一站、挤掉了中午的饭，
   * 又重交旧顺序用完修正次数）；试过放不下、或已经打回过，照常结束（没排进去的说明里写原因）。
   * 必去本来就不能省，不在这里管。打回记进快照，恢复后不会再打回。
   */
  private untriedNamed(attempt: DayAttempt): string | null {
    if (this.namedNudged) return null;
    const tried = new Set(this.attempts.flatMap((item) => item.order));
    const missing = this.activities.flatMap((record) => {
      if (record.activity.role !== "optional" || tried.has(record.activity.activityId)) return [];
      const stretch = this.freeStretch(attempt.schedule!, record);
      return stretch ? [{ record, stretch }] : [];
    });
    if (!missing.length) return null;
    this.namedNudged = true;
    const { record, stretch } = missing[0]!;
    const id = record.activity.activityId;
    const order = [...attempt.order.slice(0, stretch.index), id, ...attempt.order.slice(stretch.index)];
    return `named_untried: ${id} (${this.placeName(record.activity.placeId)}) was never in a try; free ${clockOf(stretch.from)}-${clockOf(stretch.to)}, ` +
      `try ${JSON.stringify(order)}; if it does not fit, finish ${attempt.attemptId}`;
  }

  /**
   * 方案里放得下这一站的最长空档（按它的营业时间截取）：出发前、两站之间（上一站结束到出发去下一站，
   * 加上在门口等的时间）、回到终点后到时间窗结束。空档要够它最短的停留再加来回的路，否则返回 null。
   * index 是插进顺序的位置（空档后面那一站的序号；最后一段是站数）。
   */
  private freeStretch(schedule: DaySchedule, record: DayActivityRecord): { from: number; to: number; index: number } | null {
    const window = this.problem.input.window;
    const gaps = schedule.legs.flatMap((leg, index) => {
      const from = index === 0 ? window.startsAt : schedule.activities[index - 1]!.endsAt;
      const wait = schedule.activities[index]?.waitMinutes ?? 0;
      return [{ from, to: leg.departsAt + wait, index }];
    });
    gaps.push({ from: schedule.endArrival, to: window.endsAt, index: schedule.activities.length });
    const opening = record.activity.opening;
    if (opening.status === "closed") return null;
    const open = opening.status === "known" ? opening.windows : [{ startsAt: window.startsAt, endsAt: window.endsAt }];
    const need = (record.floor ?? record.activity.stayMinutes) + NAMED_TRAVEL_MARGIN;
    const stretches = gaps.flatMap((gap) => open.map((hours) => ({
      from: Math.max(gap.from, hours.startsAt),
      to: Math.min(gap.to, hours.endsAt),
      index: gap.index,
    })));
    return stretches.filter((item) => item.to - item.from >= need).sort((a, b) => (b.to - b.from) - (a.to - a.from))[0] ?? null;
  }

  /**
   * V4.2：没排进去的“想去”地点各自的原因：试过的按最近一次包含它的试排为什么排不开说；没试过、方案里也没有
   * 放得下它的空档的说时间不够；其余照旧（排程只保留了必去、固定事项和衔接）。
   */
  private omittedReasons(attempt: DayAttempt): Record<string, string> {
    const reasons: Record<string, string> = {};
    for (const record of this.activities) {
      const id = record.activity.activityId;
      if (record.activity.role !== "optional" || attempt.order.includes(id)) continue;
      const last = [...this.attempts].reverse().find((item) => !item.schedule && item.order.includes(id));
      if (last) {
        const issue = last.issues.find((item) => item.activityId === id && item.kind === "violation") ??
          last.issues.find((item) => item.kind === "violation" || item.code === "day_route_unknown");
        reasons[id] = `试排过，加上它${issueWords(issue?.code)}。`;
      } else if (!this.freeStretch(attempt.schedule!, record)) {
        reasons[id] = `这一天没有够它停留（至少 ${record.floor ?? record.activity.stayMinutes} 分钟）再加来回路程的空档。`;
      }
    }
    return reasons;
  }

  finish(attemptId: string, reasons: Readonly<Record<string, string>> = {}) {
    this.active();
    const attempt = this.attempts.find((a) => a.attemptId === attemptId)!;
    // 推荐理由仅绑定本次方案中实际采用的新发现站；多余 ID 被丢弃，不能给未访问地点编排说明。
    const discovered = new Set(attempt.order.filter((id) =>
      this.activities.find((r) => r.activity.activityId === id)?.activity.role === "discovered"));
    // 从试算到 finish 可能又经过多次模型调用；再按当前时钟复核证据，避免交付已经过期的方案。
    const stays = new Map(Object.entries(attempt.stays ?? {}));
    const validation = validateDayDraft(this.input(stays), attempt.schedule!, this.routeFacts());
    if (validation.verdict === "rejected") throw new DayRunError("provider_error");
    return buildDayDraft({
      stays,
      omitted: this.omittedReasons(attempt),
      problem: this.problem, places: this.places, activities: this.activities,
      schedule: attempt.schedule!, validation, routeEvidence: this.routeEvidence,
      createdAt: new Date(this.now()).toISOString(),
      routes: this.routeFacts(),
      reasons: Object.fromEntries(Object.entries(reasons)
        .filter(([id]) => discovered.has(id))
        .map(([id, text]) => [id, cleanReason(text)])),
    });
  }

  /**
   * V2.2：失败顺序重复提交时，优先建议尚未试过的受保护最小组合，
   * 否则去掉最后一个普通站再试；提示给出具体动作，减少模型在同一错误上空转。
   */
  private duplicateHint(order: readonly string[]): string {
    const tried = (candidate: readonly string[]) => this.orderKeys.has(JSON.stringify(candidate));
    const protectedOrder = this.protectedOrder();
    const alone = protectedOrder.length
      ? this.attempts.find((attempt) => JSON.stringify(attempt.order) === JSON.stringify(protectedOrder))
      : undefined;
    if (alone?.schedule) return `duplicate_order: ${alone.attemptId} (protected stops only) succeeded; finish it or try a new order`;
    if (protectedOrder.length && !alone) return `duplicate_order: try ${JSON.stringify(protectedOrder)}`;
    const protectedIds = new Set(protectedOrder);
    const lastSoft = [...order].reverse().find((id) => !protectedIds.has(id));
    const smaller = lastSoft ? order.filter((id) => id !== lastSoft) : [];
    if (smaller.length && !tried(smaller)) return `duplicate_order: it did not fit; try ${JSON.stringify(smaller)}`;
    return protectedOrder.length
      ? "duplicate_order: protected stops alone do not fit either; stop constraints_not_met"
      : "duplicate_order: smaller orders did not fit either; stop constraints_not_met";
  }

  /** 受保护的最小顺序：固定站按预约开始时刻排序，再接必去站；用于停止证据和确定性兜底。 */
  protectedOrder(): string[] {
    const kept = [...this.activities]
      .filter((record) => record.activity.role === "fixed" || record.activity.role === "required");
    if (kept.some((record) => record.activity.role === "fixed")) {
      return kept
        .sort((a, b) => (a.activity.fixed?.startsAt ?? Infinity) - (b.activity.fixed?.startsAt ?? Infinity))
        .map((record) => record.activity.activityId);
    }
    // V2.11：只有必去时按从起点最近的先去（卡片里的先后不是路线顺序；出游里一天的两处常隔几十公里）。
    return this.nearestFirst(kept);
  }

  /**
   * V2.11 第一次可以试的顺序：有固定或必去时同 protectedOrder；没有时是卡片上的“想去”地点（不含按兴趣找的），
   * 从起点最近的先去。只有“想去”的一天（出游里“28 号逛拙政园”），模型一次都没试就放弃时用它补试。
   */
  firstOrder(): string[] {
    const kept = this.protectedOrder();
    return kept.length ? kept : this.nearestFirst(this.activities.filter((record) => record.activity.role === "optional"));
  }

  private nearestFirst(records: readonly DayActivityRecord[]): string[] {
    const where = (placeId: string) => this.places.find((place) => place.placeId === placeId)!.selection.place.location;
    const order: string[] = [];
    let at = where(this.problem.input.startPlaceId);
    const left = [...records];
    while (left.length) {
      left.sort((a, b) => straightMeters(at, where(a.activity.placeId)) - straightMeters(at, where(b.activity.placeId)));
      const next = left.shift()!;
      order.push(next.activity.activityId);
      at = where(next.activity.placeId);
    }
    return order;
  }

  /**
   * D-048：固定站迟到时，建议把它前面最近的普通站移到它后面，固定时刻保持不变。
   * 只提供未试过的顺序作为下一步线索；建议本身不算排程成功，仍须重新查询和试算。
   */
  private suggestOrder(attempt: DayAttempt): string[] | null {
    if (attempt.schedule) return null;
    // V2.3：兴趣时段不符时，晚间站移到末尾、上午站移到开头；已试过的调整不重复建议。
    const timed = attempt.issues.find((issue) => issue.code === "day_time_of_day")?.activityId;
    const within = timed ? this.activities.find((r) => r.activity.activityId === timed)?.activity.within : undefined;
    if (timed && within) {
      const order = attempt.order.filter((id) => id !== timed);
      if (within.startsAt >= 15 * 60) order.push(timed);
      else if (within.endsAt <= 13 * 60) order.unshift(timed);
      else return null;
      return this.orderKeys.has(JSON.stringify(order)) || JSON.stringify(order) === JSON.stringify(attempt.order) ? null : order;
    }
    const late = attempt.issues.find((issue) => issue.code === "day_fixed_late")?.activityId;
    const at = late ? attempt.order.indexOf(late) : -1;
    if (at <= 0) return null;
    const role = (id: string) => this.activities.find((r) => r.activity.activityId === id)?.activity.role;
    const before = attempt.order.slice(0, at);
    const soft = [...before].reverse().find((id) => role(id) === "optional" || role(id) === "discovered");
    if (!soft) return null;
    const order = attempt.order.filter((id) => id !== soft);
    order.splice(order.indexOf(late!) + 1, 0, soft);
    return this.orderKeys.has(JSON.stringify(order)) ? null : order;
  }

  /**
   * 模型视图只包含决策需要的本地编号、需求、观察摘要与剩余额度，不把供应商客户端或密钥放进去。
   * 全量失败顺序用于去重，最近一次问题用于修复；模型看不到评测真值或隐藏路线世界。
   */
  context(feedback: DayDecisionContext["feedback"]): DayDecisionContext {
    const latest = this.attempts.at(-1);
    const counts = this.options.counts;
    return freezeDayProblem({
      protocolVersion: "day-planning.v1",
      requirements: {
        date: this.problem.input.date, window: this.problem.input.window,
        startPlaceId: this.problem.input.startPlaceId, endPlaceId: this.problem.input.endPlaceId,
        interests: planningInterestSpecs(this.problem.requirements), pace: this.problem.requirements.pace,
        bufferMinutes: this.problem.input.bufferMinutes,
        ...(this.problem.requirements.notes ? { notes: this.problem.requirements.notes } : {}),
        ...(this.problem.weather ? { weather: this.problem.weather } : {}),
        travel: planningTravel(this.problem.requirements),
      },
      places: this.places.map((p) => ({ placeId: p.placeId, name: p.selection.place.name })),
      activities: structuredClone(this.activities),
      searches: this.searches.map((s) => ({
        interest: s.interest, query: s.query,
        ...(s.area ? { area: s.area } : {}),
        ...(s.anchorPlaceId ? { anchorPlaceId: s.anchorPlaceId } : {}),
        activityIds: s.activityIds,
        excludedCount: s.excludedCount, ...(s.failureCode ? { failureCode: s.failureCode } : {}),
        ...(s.radiusMeters ? { radiusMeters: s.radiusMeters } : {}),
        ...(s.cityWide ? { cityWide: s.cityWide } : {}),
      })),
      triedOrders: this.attempts.map((a) => a.order),
      latestAttempt: latest ? {
        attemptId: latest.attemptId, order: latest.order,
        status: latest.schedule ? "success" : "not_scheduled", issues: latest.issues,
        ...(latest.schedule ? { endArrival: latest.schedule.endArrival } : {}),
        ...(this.suggestOrder(latest) ? { suggestedOrder: this.suggestOrder(latest)! } : {}),
      } : null,
      routes: this.routeFacts().map((route) => ({
        fromPlaceId: route.fromPlaceId, toPlaceId: route.toPlaceId, status: route.status,
        ...(route.status === "known" ? { travelMinutes: Math.ceil(route.durationSeconds / 60) } : {}),
        ...(route.status === "known" && route.mode ? { mode: route.mode } : {}),
      })),
      feedback,
      remaining: {
        model: this.limits.model - counts.model, searches: this.limits.searches - counts.searches,
        tries: this.limits.tries - counts.tries, routes: this.limits.routes - counts.routes,
        semanticRepairs: this.limits.semanticRepairs - counts.semanticRepairs,
      },
    });
  }
}

/** 推荐理由只作展示，清洗时合并空白、移除链接并限长；路线和营业校验不依赖这段文字。 */
function cleanReason(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "符合你的兴趣";
}

/** 把校验码映射为进度行的短解释；只影响展示，不改变试算失败原因与后续 guard 的判定。 */
function issueWords(code: string | undefined): string {
  switch (code) {
    case "day_fixed_late":
      return "会赶不上固定预约";
    case "day_window_exceeded":
      return "回到终点会太晚";
    case "day_time_of_day":
      return "有一站不在想要的时段";
    case "day_route_unknown":
      return "有一段路线查不到";
    case "day_opening_conflict":
      return "营业时间对不上";
    default:
      return "时间衔接不上";
  }
}
