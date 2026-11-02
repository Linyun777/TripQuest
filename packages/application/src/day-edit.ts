import { z } from "zod";
import {
  scheduleDay,
  validateDayDraft,
  sameDayPlace,
  type DayPlanningInput,
  type ChinaDateTime,
} from "@tripquest/domain";
import {
  PlanningFixtureProvider,
  planningFixturePlaces,
  planningFixtureEvidence,
  PLANNING_FIXTURE_PROVIDER,
  PLANNING_FIXTURE_VERSION,
} from "@tripquest/providers/planning-fixture";
import type {
  JourneyRepository,
  StoredJourney,
  JourneyIdGenerator,
} from "./contracts";
import { buildDayDraft } from "./day-planning";
import {
  assertStoredDayMatchesJourney,
  storedDayPlanDetailsSchema,
} from "./generated-day";
import { fingerprint, canonicalJson } from "./fingerprint";
import { toChinaDateTime } from "./runtime-values";
import {
  editedDayDetailsSchema,
  dayEditChangeSchema,
  toSavedDayView,
  type SavedDayFacts,
  type SavedDayView,
  type SavedDayDetails,
  type DayEditChange,
  type DayEditComparison,
  type DayEditConfirmReply,
} from "./saved-day";
import { routeBetween } from "./route-request";

export const savedDayDetailsSchema = z.union([
  storedDayPlanDetailsSchema,
  editedDayDetailsSchema,
]);
export const DAY_EDIT_PURPOSE = "generated-day-edit.v1";
export interface DayEditReceipt {
  purpose: typeof DAY_EDIT_PURPOSE;
  editId: string;
  journeyId: string;
  basePlanVersion: number;
  baseObservationVersion: number;
  baseFingerprint: string;
  candidateFingerprint: string;
  change: DayEditChange;
  datasetVersion: string;
  issuedAt: number;
  expiresAt: number;
}
export interface StoredDayEditConfirmation {
  intentFingerprint: string;
  resultPlanVersion: number;
}
export interface ConfirmedDayEdit {
  receipt: DayEditReceipt;
  intentFingerprint: string;
  next: StoredJourney;
  confirmedAt: ChinaDateTime;
}
export interface DayEditRepository extends JourneyRepository {
  findDayEditConfirmation(
    journeyId: string,
    editId: string,
  ): Promise<StoredDayEditConfirmation | null>;
  commitDayEdit(command: ConfirmedDayEdit): Promise<DayEditConfirmReply>;
}

function invariant(ok: unknown): asserts ok {
  if (!ok) throw new Error("Stored day plan is inconsistent");
}
const edgeKey = (from: string, to: string) => JSON.stringify([from, to]);
const at = (date: string, minutes: number) =>
  `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00` as const;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function inputFor(facts: SavedDayFacts, nowMs: number): DayPlanningInput {
  return {
    ...facts.context,
    places: facts.places.map(({ placeId, selection }) => ({
      placeId,
      ...selection.place.ref,
      snapshot: JSON.stringify(selection.place),
    })),
    activities: facts.activities.map((record) => record.activity),
    nowMs,
  };
}

function buildSavedDraft(facts: SavedDayFacts, now: number) {
  const input = inputFor(facts, now);
  const scheduled = scheduleDay(
    input,
    facts.activities.map((record) => record.activity.activityId),
    facts.routes,
  );
  if (scheduled.status !== "scheduled")
    return { status: "not_feasible" as const, issues: scheduled.issues };
  const validation = validateDayDraft(input, scheduled.schedule, facts.routes);
  if (validation.verdict === "rejected")
    return { status: "not_feasible" as const, issues: validation.issues };
  const evidence = new Map(
    facts.routes.flatMap((route) =>
      route.status === "known"
        ? [
            [
              edgeKey(route.fromPlaceId, route.toPlaceId),
              planningFixtureEvidence(Date.parse(route.retrievedAt)),
            ] as const,
          ]
        : [],
    ),
  );
  return {
    status: "ready" as const,
    draft: buildDayDraft({
      problem: { ...facts.context, input, activities: facts.activities },
      places: facts.places,
      activities: facts.activities,
      schedule: scheduled.schedule,
      validation,
      routeEvidence: evidence,
      createdAt: facts.draft.createdAt,
    }),
  };
}

/** 排除查询、复查时间等元数据，保留身份与所有业务事实，供新旧方案比较。 */
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !["retrievedAt", "createdAt", "recheckedAt"].includes(key),
        )
        .map(([key, item]) => [key, semantic(item)]),
    );
  }
  return value;
}
export function savedDayFingerprint(stored: StoredJourney): string {
  invariant(stored.dayDetails && stored.dayDetails.schemaVersion !== "stored-day-plan.v3");
  return fingerprint(
    semantic({
      journeyId: stored.journeyId,
      planVersion: stored.currentPlan.version,
      observationVersion: stored.currentObservationVersion,
      day: toSavedDayView(stored.dayDetails),
    }),
  );
}

function candidateFingerprint(
  baseFingerprint: string,
  change: DayEditChange,
  candidate: SavedDayView,
) {
  return fingerprint(semantic({ baseFingerprint, change, candidate }));
}

/** 仓库写入前再次证明：分配正式 ID 后的新版本仍是这张凭据绑定的同一份预览。 */
export function assertDayEditCommit(
  current: StoredJourney,
  command: ConfirmedDayEdit,
): void {
  const { receipt, next } = command;
  const details = next.dayDetails;
  invariant(
    details?.schemaVersion === "stored-day-plan.v2" &&
      current.dayDetails &&
      current.dayDetails.schemaVersion !== "stored-day-plan.v3",
  );
  invariant(
    next.journeyId === receipt.journeyId &&
      details.planVersion === receipt.basePlanVersion + 1 &&
      details.parentVersion === receipt.basePlanVersion &&
      next.currentObservationVersion === 0,
  );
  invariant(
    equal(details.edit, {
      editId: receipt.editId,
      change: receipt.change,
      baseFingerprint: receipt.baseFingerprint,
      candidateFingerprint: receipt.candidateFingerprint,
      ...(receipt.change.kind === "replace"
        ? { replacedActivityId: receipt.change.activityId }
        : {}),
    }),
  );
  invariant(
    command.intentFingerprint ===
      dayEditIntentFingerprint(receipt, details.acknowledgeUnknowns),
  );
  const before = toSavedDayView(current.dayDetails);
  const candidate = toSavedDayView(details);
  // 预览时还没有新 UUID；只还原本次分配的绑定再算指纹，不能抹掉原有活动的身份差异。
  const previousPlaces = new Set(
    before.placeBindings.map((item) => item.draftPlaceId),
  );
  candidate.placeBindings = candidate.placeBindings.filter((item) =>
    previousPlaces.has(item.draftPlaceId),
  );
  if (receipt.change.kind === "replace") {
    const target = before.activityBindings.find(
      (item) => item.activityId === receipt.change.activityId,
    );
    invariant(target);
    const replacement = candidate.activityBindings.find(
      (item) => item.draftActivityId === target.draftActivityId,
    );
    invariant(replacement && replacement.activityId !== target.activityId);
    replacement.activityId = target.activityId;
  }
  invariant(
    candidateFingerprint(receipt.baseFingerprint, receipt.change, candidate) ===
      receipt.candidateFingerprint,
  );
  assertSavedDayMatchesJourney(details, next);
}

export function assertSavedDayMatchesJourney(
  details: SavedDayDetails,
  stored: StoredJourney,
): void {
  if (details.schemaVersion === "stored-day-plan.v1") {
    assertStoredDayMatchesJourney(details, stored);
    return;
  }
  const { facts, placeBindings, activityBindings } = details;
  const { draft } = facts;
  invariant(
    stored.currentPlan.version === details.planVersion &&
      stored.currentPlan.parentVersion === details.parentVersion &&
      stored.currentPlan.date === facts.context.date &&
      stored.currentPlan.timeZone === facts.context.timeZone &&
      (details.acknowledgeUnknowns || draft.verification !== "pending"),
  );
  const places = new Map(
    placeBindings.map((item) => [item.draftPlaceId, item.placeId]),
  );
  const activities = new Map(
    activityBindings.map((item) => [item.draftActivityId, item.activityId]),
  );
  invariant(
    places.size === facts.places.length &&
      places.size === placeBindings.length &&
      new Set(places.values()).size === places.size &&
      activities.size === facts.activities.length &&
      activities.size === activityBindings.length &&
      new Set(activities.values()).size === activities.size &&
      stored.currentPlan.activities.length === draft.activities.length &&
      stored.activitySnapshots.length === draft.activities.length,
  );
  invariant(
    facts.places.every(
      (place) =>
        places.has(place.placeId) &&
        place.selection.place.ref.provider === PLANNING_FIXTURE_PROVIDER &&
        place.selection.evidence.provider === PLANNING_FIXTURE_PROVIDER &&
        place.selection.evidence.sourceKind === "fixture",
    ),
  );
  const rebuilt = buildSavedDraft(facts, Date.parse(details.recheckedAt));
  invariant(rebuilt.status === "ready" && equal(rebuilt.draft, draft));
  let fixedCount = 0;
  for (const [position, activity] of draft.activities.entries()) {
    const row = stored.currentPlan.activities[position];
    const label = stored.activitySnapshots[position];
    const place = facts.places.find(
      (item) => item.placeId === activity.placeId,
    )!;
    invariant(
      row.id === activities.get(activity.activityId) &&
        row.placeId === places.get(activity.placeId) &&
        row.startsAt === at(draft.date, activity.startsAt) &&
        row.endsAt === at(draft.date, activity.endsAt) &&
        row.locked === (activity.role === "fixed") &&
        row.priority ===
          (["required", "fixed"].includes(activity.role) ? "high" : "normal") &&
        label.activityId === row.id &&
        label.position === position &&
        label.placeName === place.selection.place.name,
    );
    if (activity.role !== "fixed") {
      invariant(row.reservationId === undefined);
      continue;
    }
    fixedCount += 1;
    const reservation = stored.reservations.find(
      (item) => item.reservation.id === row.reservationId,
    );
    invariant(
      reservation &&
        reservation.placeName === label.placeName &&
        reservation.reservation.placeId === row.placeId &&
        reservation.reservation.startsAt === row.startsAt &&
        reservation.reservation.endsAt === row.endsAt &&
        reservation.reservation.confirmation.status === "unknown" &&
        reservation.reservation.confirmation.source.kind === "user_reported",
    );
  }
  invariant(stored.reservations.length === fixedCount);
}

export function assertSavedDayPreservesInitial(
  details: SavedDayDetails,
  initial: z.infer<typeof storedDayPlanDetailsSchema>,
) {
  if (details.schemaVersion === "stored-day-plan.v1") return;
  const current = toSavedDayView(details);
  const before = toSavedDayView(initial);
  invariant(equal(current.facts.context, before.facts.context));
  for (const record of before.facts.activities.filter((item) =>
    ["required", "fixed"].includes(item.activity.role),
  )) {
    const id = record.activity.activityId;
    invariant(
      equal(
        record,
        current.facts.activities.find(
          (item) => item.activity.activityId === id,
        ),
      ) &&
        equal(
          before.activityBindings.find((item) => item.draftActivityId === id),
          current.activityBindings.find((item) => item.draftActivityId === id),
        ) &&
        equal(
          before.placeBindings.find(
            (item) => item.draftPlaceId === record.activity.placeId,
          ),
          current.placeBindings.find(
            (item) => item.draftPlaceId === record.activity.placeId,
          ),
        ),
    );
  }
}

function comparison(
  before: SavedDayView,
  after: SavedDayView,
  change: DayEditChange,
): DayEditComparison {
  const summary = (view: SavedDayView) => ({
    walking: view.facts.draft.totalWalkingMinutes,
    distance: view.facts.draft.legs.reduce(
      (sum, leg) => sum + leg.distanceMeters,
      0,
    ),
    longest: view.facts.draft.longestWalkingMinutes,
    waiting: view.facts.draft.activities.reduce(
      (sum, activity) => sum + activity.waitMinutes,
      0,
    ),
    endArrival: view.facts.draft.endArrival,
  });
  return {
    before: summary(before),
    after: summary(after),
    activities: before.facts.draft.activities.flatMap((activity) => {
      const next =
        after.facts.draft.activities.find(
          (item) => item.activityId === activity.activityId,
        ) ?? null;
      const binding = before.activityBindings.find(
        (item) => item.draftActivityId === activity.activityId,
      )!;
      if (binding.activityId !== change.activityId && equal(activity, next))
        return [];
      return [
        {
          activityId: binding.activityId,
          before: activity,
          after: next,
          beforeName: before.facts.places.find(
            (item) => item.placeId === activity.placeId,
          )!.selection.place.name,
          afterName: next
            ? after.facts.places.find((item) => item.placeId === next.placeId)!
                .selection.place.name
            : null,
        },
      ];
    }),
  };
}

/**
 * 演示行程的高级编辑只改一项普通活动，随后重排并复核整天，包含改动前后的路线衔接。
 * 已有进度报告后转入重规划链路，不能继续用出发前的编辑规则覆盖旅途中事实。
 */
export async function previewDayEdit(
  stored: StoredJourney,
  command: {
    basePlanVersion: number;
    baseObservationVersion: number;
    change: DayEditChange;
  },
  now: number,
) {
  if (stored.creationKind !== "generated_day" || !stored.dayDetails)
    return { status: "source_not_allowed" as const };
  // 出发前编辑仅允许观测版本为 0；一旦上报进度或进入重排版本，就要走带事实保护的调整流程。
  if (
    stored.currentPlan.version !== command.basePlanVersion ||
    stored.currentObservationVersion !== command.baseObservationVersion ||
    command.baseObservationVersion !== 0 ||
    stored.dayDetails.schemaVersion === "stored-day-plan.v3"
  ) {
    return { status: "stale" as const };
  }
  const change = dayEditChangeSchema.parse(command.change);
  const before = toSavedDayView(stored.dayDetails);
  const directory = planningFixturePlaces();
  if (
    before.facts.places.some(
      ({ selection }) =>
        selection.evidence.datasetVersion !== PLANNING_FIXTURE_VERSION ||
        selection.evidence.sourceKind !== "fixture" ||
        !directory.some((place) => equal(place, selection.place)),
    )
  )
    return { status: "source_not_allowed" as const };
  const binding = before.activityBindings.find(
    (item) => item.activityId === change.activityId,
  );
  const target = before.facts.activities.findIndex(
    (item) => item.activity.activityId === binding?.draftActivityId,
  );
  if (
    target < 0 ||
    !["optional", "discovered"].includes(
      before.facts.activities[target].activity.role,
    )
  ) {
    return { status: "invalid_change" as const };
  }
  // 只编辑副本，原版本仍用于比较与确认。目标必须是普通或发现活动，必去和固定事项不能从此入口改动。
  const candidate = structuredClone(before);
  const record = candidate.facts.activities[target];
  if (change.kind === "remove") {
    if (candidate.facts.activities.length === 1)
      return { status: "invalid_change" as const };
    candidate.facts.activities.splice(target, 1);
    candidate.activityBindings = candidate.activityBindings.filter(
      (item) => item.draftActivityId !== record.activity.activityId,
    );
  } else if (change.kind === "change_stay") {
    if (record.activity.stayMinutes === change.stayMinutes)
      return { status: "invalid_change" as const };
    record.activity.stayMinutes = change.stayMinutes;
    record.activity.staySource = "user";
  } else {
    const replacement = directory.find(
      (place) =>
        place.ref.externalId === change.externalId &&
        place.categoryCode !== "fixture:start",
    );
    if (
      !replacement ||
      before.facts.activities.some(
        (item) =>
          before.facts.places.find(
            (place) => place.placeId === item.activity.placeId,
          )?.selection.place.ref.externalId === change.externalId,
      )
    ) {
      return { status: "invalid_change" as const };
    }
    let place = candidate.facts.places.find(
      (item) => item.selection.place.ref.externalId === change.externalId,
    );
    if (!place) {
      place = {
        placeId: `edit-${change.externalId}`,
        selection: {
          place: replacement,
          evidence: planningFixtureEvidence(now),
        },
      };
      candidate.facts.places.push(place);
    }
    // 替换代表用户新选的普通活动，清掉原兴趣归因；不能把旧推荐理由带到另一个地点上。
    record.activity = {
      ...record.activity,
      placeId: place.placeId,
      role: "optional",
      stayMinutes: change.stayMinutes,
      staySource: "user",
    };
    delete record.interest;
  }
  const used = new Set([
    candidate.facts.context.startPlaceId,
    candidate.facts.context.endPlaceId,
    ...candidate.facts.activities.map((item) => item.activity.placeId),
  ]);
  candidate.facts.places = candidate.facts.places.filter((item) =>
    used.has(item.placeId),
  );
  candidate.placeBindings = candidate.placeBindings.filter((item) =>
    used.has(item.draftPlaceId),
  );
  candidate.facts.routes = [];
  candidate.facts.draft.createdAt = new Date(now).toISOString();
  const input = inputFor(candidate.facts, now);
  // 删除或替换会改变相邻路段，必须按完整新路径重取路线，包含最后回到终点的一段。
  const path = [
    input.startPlaceId,
    ...input.activities.map((item) => item.placeId),
    input.endPlaceId,
  ];
  const provider = new PlanningFixtureProvider(() => now);
  for (let i = 1; i < path.length; i += 1) {
    const from = candidate.facts.places.find(
      (item) => item.placeId === path[i - 1],
    )!;
    const to = candidate.facts.places.find((item) => item.placeId === path[i])!;
    if (
      candidate.facts.routes.some(
        (route) =>
          route.fromPlaceId === from.placeId && route.toPlaceId === to.placeId,
      )
    )
      continue;
    if (
      sameDayPlace(
        input.places.find((item) => item.placeId === from.placeId)!,
        input.places.find((item) => item.placeId === to.placeId)!,
      )
    ) {
      candidate.facts.routes.push({
        fromPlaceId: from.placeId,
        toPlaceId: to.placeId,
        status: "same_place_assumption",
      });
      continue;
    }
    const reply = await provider.findRoutes({
      ...routeBetween(from.selection.place, to.selection.place),
      mode: "walking",
      departureAt: at(input.date, 0),
    });
    if (reply.status !== "ok")
      return {
        status: "not_feasible" as const,
        issues: [
          {
            code: "day_route_unknown" as const,
            kind: "unknown" as const,
            fromPlaceId: from.placeId,
            toPlaceId: to.placeId,
          },
        ],
      };
    const route = reply.routes[0];
    candidate.facts.routes.push({
      fromPlaceId: from.placeId,
      toPlaceId: to.placeId,
      status: "known",
      durationSeconds: route.durationSeconds,
      distanceMeters: route.distanceMeters,
      provider: reply.evidence.provider,
      sourceKind: "fixture",
      retrievedAt: reply.evidence.retrievedAt,
    });
  }
  const result = buildSavedDraft(candidate.facts, now);
  if (result.status !== "ready") return result;
  candidate.facts.draft = result.draft;
  // 局部编辑允许后续顺延，但目标之前的活动必须原样保留，避免用户改一项却影响已浏览的前半段。
  invariant(
    before.facts.draft.activities
      .slice(0, target)
      .every((activity, index) =>
        equal(activity, candidate.facts.draft.activities[index]),
      ),
  );
  const baseFingerprint = savedDayFingerprint(stored);
  const fingerprintOfCandidate = candidateFingerprint(
    baseFingerprint,
    change,
    candidate,
  );
  return {
    status: "ready" as const,
    candidate,
    baseFingerprint,
    candidateFingerprint: fingerprintOfCandidate,
    comparison: comparison(before, candidate, change),
  };
}

export function dayEditIntentFingerprint(
  receipt: DayEditReceipt,
  acknowledgeUnknowns: boolean,
): string {
  return fingerprint({
    purpose: receipt.purpose,
    editId: receipt.editId,
    journeyId: receipt.journeyId,
    basePlanVersion: receipt.basePlanVersion,
    baseObservationVersion: receipt.baseObservationVersion,
    baseFingerprint: receipt.baseFingerprint,
    candidateFingerprint: receipt.candidateFingerprint,
    change: receipt.change,
    datasetVersion: receipt.datasetVersion,
    acknowledgeUnknowns,
  });
}

/**
 * 确认时按凭据重新预览并比对基础、候选指纹；预览通过后才分配正式 ID。
 * 仓储仍会在锁内检查版本与聚合一致性，挡住复核结束到实际落库之间的并发修改。
 */
export async function confirmDayEdit(options: {
  receipt: DayEditReceipt;
  acknowledgeUnknowns: boolean;
  enabled: boolean;
  now: number;
  repository: DayEditRepository;
  idGenerator: JourneyIdGenerator;
}): Promise<DayEditConfirmReply> {
  const { receipt, repository, now } = options;
  const intentFingerprint = dayEditIntentFingerprint(
    receipt,
    options.acknowledgeUnknowns,
  );
  // 成功回执优先于过期和版本判断；同一次确认重试应返回原结果，不能因版本已经推进而误报失败。
  const prior = await repository.findDayEditConfirmation(
    receipt.journeyId,
    receipt.editId,
  );
  if (prior)
    return prior.intentFingerprint === intentFingerprint
      ? {
          status: "already_saved",
          journeyId: receipt.journeyId,
          planVersion: prior.resultPlanVersion,
        }
      : { status: "intent_conflict" };
  if (!options.enabled) return { status: "disabled" };
  if (now >= receipt.expiresAt) return { status: "expired" };
  const current = await repository.findCurrentJourney(receipt.journeyId);
  if (!current) return { status: "not_found" };
  if (
    current.currentObservationVersion !== 0 ||
    current.dayDetails?.schemaVersion === "stored-day-plan.v3" ||
    savedDayFingerprint(current) !== receipt.baseFingerprint
  )
    return { status: "stale" };
  // 从当前保存的事实重做预览并比较候选指纹，不能直接把客户端提交的预览内容写进数据库。
  const preview = await previewDayEdit(current, receipt, now);
  if (preview.status !== "ready")
    return {
      status:
        preview.status === "not_feasible"
          ? "candidate_changed"
          : preview.status,
    };
  if (
    receipt.datasetVersion !== PLANNING_FIXTURE_VERSION ||
    preview.candidateFingerprint !== receipt.candidateFingerprint
  ) {
    return { status: "candidate_changed" };
  }
  if (
    preview.candidate.facts.draft.verification === "pending" &&
    !options.acknowledgeUnknowns
  ) {
    return { status: "acknowledgment_required" };
  }
  // 所有复核通过后才分配正式身份。替换活动获得新 ID；只改停留时间则保留原活动 ID。
  const view = preview.candidate;
  for (const place of view.facts.places) {
    if (
      !view.placeBindings.some((item) => item.draftPlaceId === place.placeId)
    ) {
      view.placeBindings.push({
        draftPlaceId: place.placeId,
        placeId: options.idGenerator.next("place"),
      });
    }
  }
  if (receipt.change.kind === "replace") {
    view.activityBindings.find(
      (item) => item.activityId === receipt.change.activityId,
    )!.activityId = options.idGenerator.next("activity");
  }
  const details = editedDayDetailsSchema.parse({
    schemaVersion: "stored-day-plan.v2",
    planVersion: receipt.basePlanVersion + 1,
    parentVersion: receipt.basePlanVersion,
    ...view,
    edit: {
      editId: receipt.editId,
      change: receipt.change,
      baseFingerprint: receipt.baseFingerprint,
      candidateFingerprint: receipt.candidateFingerprint,
      ...(receipt.change.kind === "replace"
        ? { replacedActivityId: receipt.change.activityId }
        : {}),
    },
    recheckedAt: new Date(now).toISOString(),
    acknowledgeUnknowns: options.acknowledgeUnknowns,
  });
  const activities = view.facts.draft.activities.map((activity) => ({
    id: view.activityBindings.find(
      (item) => item.draftActivityId === activity.activityId,
    )!.activityId,
    placeId: view.placeBindings.find(
      (item) => item.draftPlaceId === activity.placeId,
    )!.placeId,
    startsAt: at(view.facts.context.date, activity.startsAt),
    endsAt: at(view.facts.context.date, activity.endsAt),
    locked: activity.role === "fixed",
    priority: ["fixed", "required"].includes(activity.role)
      ? ("high" as const)
      : ("normal" as const),
    ...(activity.role === "fixed"
      ? {
          reservationId: current.currentPlan.activities.find(
            (row) =>
              row.id ===
              view.activityBindings.find(
                (item) => item.draftActivityId === activity.activityId,
              )!.activityId,
          )!.reservationId,
        }
      : {}),
  }));
  const confirmedAt = toChinaDateTime(new Date(now));
  const next: StoredJourney = {
    ...current,
    dayDetails: details,
    updatedAt: confirmedAt,
    currentPlan: {
      ...current.currentPlan,
      version: details.planVersion,
      parentVersion: details.parentVersion,
      changeReason: "user_confirmed_day_edit",
      activities,
    },
    activitySnapshots: activities.map((row, position) => ({
      activityId: row.id,
      position,
      placeName: view.facts.places.find(
        (place) =>
          place.placeId === view.facts.draft.activities[position].placeId,
      )!.selection.place.name,
    })),
  };
  // 聚合表与详细快照必须描述同一安排；仓库随后在事务内再次校验基础版本和凭据。
  assertSavedDayMatchesJourney(details, next);
  return repository.commitDayEdit({
    receipt,
    intentFingerprint,
    next,
    confirmedAt,
  });
}
