import {
  DAY_INTEREST_QUERIES,
  DAY_STAY_MINUTES,
  freezeDayProblem,
} from "@tripquest/application/day-planning";
import {
  buildReplanCandidate,
  compareReplan,
  evaluateReplan,
  replanEdges,
  replanInput,
  replanUnchanged,
  type DayReplanProblem,
  type ReplanActivityRecord,
  type ReplanEvaluation,
  type ReplanPlaceRecord,
  type ReplanProgress,
} from "@tripquest/application/day-replan";
import type { ReplanCounts } from "@tripquest/application/day-state";
import { planningPlaceSchema } from "@tripquest/application/planning";
import {
  futureDayInput,
  inspectDayOrder,
  inspectReplanOrder,
  validateReplan,
  type DayIssue,
  type DayRoute,
} from "@tripquest/domain";
import { PLANNING_FIXTURE_PROVIDER, PLANNING_FIXTURE_VERSION } from "@tripquest/providers/planning-fixture";
import type { ProviderEvidence } from "@tripquest/providers";
import { DayRunError } from "./day-contracts";
import { dayOperation } from "./day-runtime";
import type {
  ReplanAction,
  ReplanDecisionContext,
  ReplanLimits,
  ReplanRunnerDependencies,
  ReplanSearchObservation,
} from "./replan-contracts";

export interface ReplanAttempt {
  readonly attemptId: string;
  readonly order: readonly string[];
  readonly evaluation: ReplanEvaluation;
}

/** 检查点需要保存的地点、活动、路线和去重状态；恢复后不重复调查已知事实。 */
export interface ReplanToolSnapshot {
  readonly places: ReplanPlaceRecord[];
  readonly activities: ReplanActivityRecord[];
  readonly searches: ReplanSearchObservation[];
  readonly attempts: ReplanAttempt[];
  readonly routes: [string, DayRoute][];
  readonly searchKeys: string[];
  readonly orderKeys: string[];
}

/** 本轮共享一份逻辑执行器，图节点间通过快照重建实例，不依赖进程内全局缓存。 */
export class ReplanToolExecutor {
  readonly places: ReplanPlaceRecord[];
  readonly activities: ReplanActivityRecord[];
  readonly searches: ReplanSearchObservation[];
  readonly attempts: ReplanAttempt[];
  private readonly routes: Map<string, DayRoute>;
  private readonly searchKeys: Set<string>;
  private readonly orderKeys: Set<string>;

  constructor(
    readonly problem: DayReplanProblem,
    private readonly dependencies: ReplanRunnerDependencies,
    private readonly limits: ReplanLimits,
    private readonly options: {
      signal: AbortSignal;
      onProgress: (progress: ReplanProgress) => void;
      counts: ReplanCounts;
    },
    snapshot?: ReplanToolSnapshot,
  ) {
    const saved = snapshot ? structuredClone(snapshot) : undefined;
    this.places = saved?.places ?? structuredClone(problem.places) as ReplanPlaceRecord[];
    this.activities = saved?.activities ?? structuredClone(problem.activities) as ReplanActivityRecord[];
    this.searches = saved?.searches ?? [];
    this.attempts = saved?.attempts ?? [];
    this.routes = new Map(saved?.routes ?? []);
    this.searchKeys = new Set(saved?.searchKeys ?? []);
    this.orderKeys = new Set(saved?.orderKeys ?? []);
  }

  snapshot(): ReplanToolSnapshot {
    return structuredClone({
      places: this.places,
      activities: this.activities,
      searches: this.searches,
      attempts: this.attempts,
      routes: [...this.routes.entries()],
      searchKeys: [...this.searchKeys],
      orderKeys: [...this.orderKeys],
    });
  }

  private now() {
    return (this.dependencies.now ?? Date.now)();
  }
  private active() {
    if (this.options.signal.aborted) throw new DayRunError("timeout");
  }
  private progress(phase: ReplanProgress["phase"]) {
    this.active();
    this.options.onProgress({ phase, counts: { ...this.options.counts } });
  }
  input() {
    return replanInput(this.problem, this.places, this.activities, this.now());
  }
  // 这条演示链只接收指定版本的 fixture；真实地点调整走 real-adjust，不能把真实快照混进持久演示任务。
  private validEvidence(evidence: ProviderEvidence) {
    const time = Date.parse(evidence.retrievedAt);
    if (
      evidence.provider !== PLANNING_FIXTURE_PROVIDER || evidence.sourceKind !== "fixture" ||
      evidence.datasetVersion !== PLANNING_FIXTURE_VERSION ||
      !Number.isFinite(time) || time > this.now() || this.now() - time > 300_000
    ) {
      throw new DayRunError("provider_error");
    }
  }
  /** 搜索中心限制为继续地点、可调整站和冻结锚点/终点，不能把局部调整扩成任意区域搜索。 */
  searchAnchors(): string[] {
    const anchor = this.activities.find((item) =>
      item.activity.activityId === this.problem.anchorActivityId);
    return [...new Set([
      this.problem.input.resumePlaceId,
      ...this.problem.adjustable.map((id) =>
        this.activities.find((item) => item.activity.activityId === id)!.activity.placeId),
      anchor ? anchor.activity.placeId : this.problem.input.endPlaceId,
    ])];
  }
  private adjustable(): Set<string> {
    return new Set([
      ...this.problem.adjustable,
      ...this.activities.filter((item) => !item.storedId).map((item) => item.activity.activityId),
    ]);
  }

  guard(action: ReplanAction): string | null {
    switch (action.action) {
      case "search_places": {
        if (!this.problem.interests.includes(action.interest)) return "interest_not_selected";
        if (!this.searchAnchors().includes(action.anchorPlaceId)) return "unknown_anchor";
        if (this.searchKeys.has(`${action.interest}@${action.anchorPlaceId}`)) return "duplicate_search";
        return null;
      }
      case "try_replan": {
        const order = action.orderedActivityIds;
        const input = this.input();
        const adjustable = this.adjustable();
        const unknown = order.find((id) =>
          !adjustable.has(id) && !input.frozen.some((item) => item.activityId === id));
        if (unknown) return "day_unknown_activity";
        const scope = inspectReplanOrder(input, order);
        if (scope.length) return scope[0].code;
        // 模型只排列可调整部分；冻结尾部由代码接回，再对完整顺序检查必去与固定事项。
        // 这样局部修改也覆盖与下一段的衔接，不能靠遗漏冻结活动来绕过约束。
        const full = [...order, ...input.frozen.map((item) => item.activityId)];
        if (full.length) {
          const issues = inspectDayOrder(futureDayInput(input), full);
          if (issues.length) return issues[0].code;
        } else if (input.activities.some((item) => ["required", "fixed"].includes(item.role))) {
          return "day_missing_protected";
        }
        if (this.orderKeys.has(JSON.stringify(order))) return "duplicate_order";
        return null;
      }
      // 模型只能选择已有 scheduled 尝试，不能自己补时间；stop 同样需要失败证据且不能忽略已有可行尝试。
      case "finish": {
        const attempt = this.attempts.find((item) => item.attemptId === action.attemptId);
        return attempt?.evaluation.status === "scheduled" ? null : "unverified_attempt";
      }
      case "stop": {
        if (this.attempts.some((item) => item.evaluation.status === "scheduled")) return "unsupported_stop";
        const issues = this.attempts.flatMap((item) =>
          item.evaluation.status === "not_scheduled" ? item.evaluation.issues : []);
        if (action.reason === "insufficient_information") {
          return issues.some((issue) => issue.kind === "unknown") ||
            this.searches.some((search) => search.failureCode) ? null : "unsupported_stop";
        }
        return issues.some((issue) => issue.kind === "violation") ? null : "unsupported_stop";
      }
    }
  }

  async search(action: Extract<ReplanAction, { action: "search_places" }>): Promise<void> {
    this.active();
    if (this.options.counts.searches >= this.limits.searches) throw new DayRunError("budget_exhausted");
    this.searchKeys.add(`${action.interest}@${action.anchorPlaceId}`);
    this.options.counts.searches += 1;
    this.progress("searching");
    const anchor = this.places.find((item) => item.placeId === action.anchorPlaceId)!;
    let reply;
    try {
      reply = await dayOperation({
        signal: this.options.signal,
        timeoutMs: this.limits.providerMs,
        operation: (signal) => this.dependencies.provider.searchPlaces({
          query: DAY_INTEREST_QUERIES[action.interest],
          scope: {
            kind: "nearby",
            cityAdcode: "330100",
            center: anchor.selection.place.location,
            radiusMeters: 3000,
          },
          limit: 5,
        }, { signal }),
      });
    } catch (error) {
      this.active();
      if (error instanceof DayRunError && error.code !== "timeout") throw error;
      this.searches.push({ ...action, activityIds: [], failureCode: "unavailable" });
      return;
    }
    this.active();
    this.validEvidence(reply.evidence);
    if (reply.status !== "ok") {
      if (reply.failure.code === "cancelled") throw new DayRunError("timeout");
      this.searches.push({ ...action, activityIds: [], failureCode: reply.failure.code });
      return;
    }
    const selections = reply.data.items.map((place) => {
      const parsed = planningPlaceSchema.safeParse({ place, evidence: reply.evidence });
      if (!parsed.success || parsed.data.place.ref.provider !== PLANNING_FIXTURE_PROVIDER) {
        throw new DayRunError("provider_error");
      }
      return parsed.data;
    });
    const activityIds: string[] = [];
    for (const selection of selections) {
      // 原行程里的地点不再作为新推荐，包含完成、跳过、计划中及范围外地点，避免归档事实重新入队。
      if (this.places.some((item) =>
        item.selection.place.ref.externalId === selection.place.ref.externalId)) continue;
      if (this.activities.length >= this.limits.pool) break;
      const placeId = `p${this.places.length + 1}`;
      const activityId = `a${this.activities.length + 1}`;
      this.places.push(freezeDayProblem({ placeId, selection }));
      this.activities.push(freezeDayProblem({
        activity: {
          activityId,
          placeId,
          role: "discovered" as const,
          stayMinutes: DAY_STAY_MINUTES[action.interest],
          staySource: "system_estimate" as const,
          opening: { status: "unknown" as const },
          tickets: "unknown" as const,
        },
        interest: action.interest,
      }));
      activityIds.push(activityId);
    }
    this.searches.push({ ...action, activityIds });
  }

  /** 基线和模型试算共用相同输入、供应商、路线缓存与校验器，比较时不会给某一方额外事实。 */
  async attempt(attemptId: string, order: readonly string[]): Promise<void> {
    this.active();
    this.orderKeys.add(JSON.stringify(order));
    const input = this.input();
    // 由完整未来时间线推导边，包含可调整段到冻结尾部的衔接；只查模型列出的站会漏掉范围边界。
    const edges = replanEdges(input, order);
    const needed = edges.filter((edge) => !edge.samePlace && !this.routes.has(`${edge.fromPlaceId}>${edge.toPlaceId}`));
    if (this.options.counts.routes + needed.length > this.limits.routes) {
      throw new DayRunError("budget_exhausted");
    }
    for (const edge of edges) {
      this.active();
      const key = `${edge.fromPlaceId}>${edge.toPlaceId}`;
      if (this.routes.has(key)) continue;
      const base = { fromPlaceId: edge.fromPlaceId, toPlaceId: edge.toPlaceId };
      if (edge.samePlace) {
        this.routes.set(key, { ...base, status: "same_place_assumption" });
        continue;
      }
      this.options.counts.routes += 1;
      this.progress("routing");
      const from = this.places.find((item) => item.placeId === edge.fromPlaceId)!.selection.place;
      const to = this.places.find((item) => item.placeId === edge.toPlaceId)!.selection.place;
      let reply;
      try {
        reply = await dayOperation({
          signal: this.options.signal,
          timeoutMs: this.limits.providerMs,
          operation: (signal) => this.dependencies.provider.findRoutes({
            origin: { place: from.ref, location: from.location },
            destination: { place: to.ref, location: to.location },
            mode: "walking",
            cityAdcode: "330100",
            departureAt: `${input.date}T00:00:00+08:00`,
          }, { signal }),
        });
      } catch (error) {
        this.active();
        if (error instanceof DayRunError && error.code !== "timeout") throw error;
        this.routes.set(key, { ...base, status: "unknown", reason: "unavailable" });
        continue;
      }
      this.active();
      this.validEvidence(reply.evidence);
      if (reply.status === "failure" && reply.failure.code === "cancelled") throw new DayRunError("timeout");
      const walking = reply.status === "ok"
        ? reply.routes.filter((route) => route.mode === "walking")
          .sort((a, b) => a.durationSeconds - b.durationSeconds || a.distanceMeters - b.distanceMeters)[0]
        : undefined;
      // 无路线或查询失败仍记 unknown，不能用常识补分钟数后伪装为已验证路线。
      this.routes.set(key, walking
        ? {
            ...base,
            status: "known",
            durationSeconds: walking.durationSeconds,
            distanceMeters: walking.distanceMeters,
            provider: reply.evidence.provider,
            sourceKind: reply.evidence.sourceKind,
            retrievedAt: reply.evidence.retrievedAt,
          }
        : { ...base, status: "unknown", reason: reply.status === "no_route" ? reply.reason : "unavailable" });
    }
    this.progress("checking");
    this.attempts.push(freezeDayProblem({
      attemptId,
      order: [...order],
      evaluation: evaluateReplan(this.input(), order, [...this.routes.values()]),
    }));
  }

  baselineEvaluation(): ReplanEvaluation | null {
    return this.attempts.find((item) => item.attemptId === "baseline")?.evaluation ?? null;
  }

  finish(attemptId: string) {
    this.active();
    const attempt = this.attempts.find((item) => item.attemptId === attemptId)!;
    if (attempt.evaluation.status !== "scheduled") throw new DayRunError("internal_error");
    const input = this.input();
    // 结束时按当前时间重验路线新鲜度，先前成功不保证经过多次决策后仍可交付。
    const validation = validateReplan(input, attempt.evaluation.schedule, [...this.routes.values()]);
    if (validation.verdict === "rejected") throw new DayRunError("provider_error");
    const built = buildReplanCandidate({
      problem: this.problem,
      places: this.places,
      activities: this.activities,
      schedule: attempt.evaluation.schedule,
      validation,
    });
    return {
      ...built,
      unchanged: replanUnchanged(this.problem, built.candidate),
      comparison: compareReplan({
        problem: this.problem,
        places: this.places,
        activities: this.activities,
        candidate: built.candidate,
        baseline: this.baselineEvaluation(),
      }),
    };
  }

  lastIssues(): DayIssue[] {
    const failed = this.attempts.filter((item) => item.evaluation.status === "not_scheduled").at(-1);
    return failed?.evaluation.status === "not_scheduled" ? [...failed.evaluation.issues] : [];
  }

  /** 模型只看到局部可改身份和冻结顺序，归档数量占用容量；已完成事项不会作为新的可调整站暴露。 */
  context(feedback: ReplanDecisionContext["feedback"]): ReplanDecisionContext {
    const input = this.input();
    const counts = this.options.counts;
    const adjustable = this.adjustable();
    const anchor = this.activities.find((item) =>
      item.activity.activityId === this.problem.anchorActivityId);
    return freezeDayProblem({
      protocolVersion: "day-replanning.v1",
      scope: this.problem.scope,
      goal: this.problem.goal,
      date: input.date,
      bufferMinutes: input.bufferMinutes,
      interests: [...this.problem.interests],
      resume: { placeId: input.resumePlaceId, at: input.resumesAt },
      end: { placeId: input.endPlaceId, by: input.endsAt },
      anchor: anchor ? { activityId: anchor.activity.activityId, startsAt: anchor.activity.fixed!.startsAt } : null,
      maxFutureActivities: input.capacity,
      archivedCount: this.problem.archived.length,
      places: this.places.map((item) => ({ placeId: item.placeId, name: item.selection.place.name })),
      activities: this.activities.map((item) => ({
        activityId: item.activity.activityId,
        placeId: item.activity.placeId,
        role: item.activity.role,
        stayMinutes: item.activity.stayMinutes,
        ...(item.activity.fixed ? { fixed: item.activity.fixed } : {}),
        ...(item.interest ? { interest: item.interest } : {}),
        adjustable: adjustable.has(item.activity.activityId),
      })),
      currentOrder: [...this.problem.adjustable],
      frozenOrder: input.frozen.map((item) => item.activityId),
      searchAnchors: this.searchAnchors(),
      searches: this.searches.map((item) => ({ ...item })),
      attempts: this.attempts.map((item) => ({
        attemptId: item.attemptId,
        order: item.order,
        status: item.evaluation.status === "scheduled" ? "success" as const : "not_scheduled" as const,
        issues: item.evaluation.status === "scheduled" ? item.evaluation.validation.issues : item.evaluation.issues,
        ...(item.evaluation.status === "scheduled" ? {
          endArrival: item.evaluation.schedule.endArrival,
          walkingMinutes: item.evaluation.schedule.totalWalkingMinutes,
          waitingMinutes: item.evaluation.schedule.activities.reduce((sum, a) => sum + a.waitMinutes, 0),
        } : {}),
      })),
      routes: [...this.routes.values()].map((route) => ({
        fromPlaceId: route.fromPlaceId,
        toPlaceId: route.toPlaceId,
        status: route.status,
        ...(route.status === "known" ? { travelMinutes: Math.ceil(route.durationSeconds / 60) } : {}),
      })),
      feedback,
      remaining: {
        model: this.limits.model - counts.model,
        searches: this.limits.searches - counts.searches,
        tries: this.limits.tries - counts.tries,
        routes: this.limits.routes - counts.routes,
        semanticRepairs: this.limits.semanticRepairs - counts.semanticRepairs,
      },
    });
  }
}
