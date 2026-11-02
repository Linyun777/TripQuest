import type { PlannedActivity } from "./model";
import type { CandidateValidationInput, ValidationIssue } from "./candidate-validation-types";

const OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;

export interface TimedActivity {
  readonly activity: PlannedActivity;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export interface PreparedInput {
  readonly input: CandidateValidationInput;
  readonly planActivities: readonly TimedActivity[];
  readonly candidateActivities: readonly TimedActivity[];
  readonly dayStartMs: number;
  readonly dayEndMs: number;
  readonly observedAtMs: number;
  readonly earliestResumeAtMs: number;
  readonly scopeStartMs: number;
  readonly scopeEndMs: number;
}

export type PreparationResult =
  | { readonly valid: true; readonly value: PreparedInput }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

function invalid(
  issues: ValidationIssue[],
  code: ValidationIssue["code"],
  fieldPath: string,
): void {
  issues.push({ category: "invalid_input", code, fieldPath });
}

function record(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(issues, "invalid_shape", path);
    return null;
  }
  return value as Record<string, unknown>;
}

// 除了 Array.isArray，还检查稀疏数组的空洞，避免 forEach 跳过空项后把坏输入当完整活动列表。
function array(value: unknown, path: string, issues: ValidationIssue[]): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    invalid(issues, "invalid_shape", path);
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(issues, "invalid_shape", `${path}[${index}]`);
    }
  }
  return value;
}

function text(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string") invalid(issues, "invalid_shape", path);
}

function id(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(issues, "invalid_shape", path);
  }
}

function integer(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  minimum: number,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(issues, "invalid_number", path);
  }
}

function oneOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(issues, "invalid_shape", path);
  }
}

function timeWindowShape(value: unknown, path: string, issues: ValidationIssue[]): void {
  const item = record(value, path, issues);
  if (item === null) return;
  text(item.startsAt, `${path}.startsAt`, issues);
  text(item.endsAt, `${path}.endsAt`, issues);
}

function activityShape(value: unknown, path: string, issues: ValidationIssue[]): void {
  const item = record(value, path, issues);
  if (item === null) return;
  id(item.id, `${path}.id`, issues);
  id(item.placeId, `${path}.placeId`, issues);
  text(item.startsAt, `${path}.startsAt`, issues);
  text(item.endsAt, `${path}.endsAt`, issues);
  oneOf(item.priority, ["high", "normal", "low"], `${path}.priority`, issues);
  if (typeof item.locked !== "boolean") invalid(issues, "invalid_shape", `${path}.locked`);
  if (item.reservationId !== undefined) id(item.reservationId, `${path}.reservationId`, issues);
}

function activitiesShape(value: unknown, path: string, issues: ValidationIssue[]): void {
  const items = array(value, path, issues);
  items?.forEach((item, index) => activityShape(item, `${path}[${index}]`, issues));
}

function planShape(value: unknown, issues: ValidationIssue[]): void {
  const plan = record(value, "plan", issues);
  if (plan === null) return;
  id(plan.journeyId, "plan.journeyId", issues);
  text(plan.date, "plan.date", issues);
  oneOf(plan.timeZone, ["Asia/Shanghai"], "plan.timeZone", issues);
  integer(plan.version, "plan.version", issues, 1);
  if (plan.parentVersion !== undefined) integer(plan.parentVersion, "plan.parentVersion", issues, 1);
  if (plan.changeReason !== undefined) text(plan.changeReason, "plan.changeReason", issues);
  activitiesShape(plan.activities, "plan.activities", issues);
}

function stateShape(value: unknown, issues: ValidationIssue[]): void {
  const state = record(value, "state", issues);
  if (state === null) return;
  id(state.journeyId, "state.journeyId", issues);
  integer(state.version, "state.version", issues, 1);
  for (const name of ["completedActivityIds", "skippedActivityIds"] as const) {
    const items = array(state[name], `state.${name}`, issues);
    items?.forEach((item, index) => id(item, `state.${name}[${index}]`, issues));
  }
  if (state.currentActivityId !== null) {
    id(state.currentActivityId, "state.currentActivityId", issues);
  }
  text(state.observedAt, "state.observedAt", issues);
  const location = record(state.location, "state.location", issues);
  if (location === null) return;
  oneOf(location.kind, ["known", "unknown"], "state.location.kind", issues);
  if (location.kind === "known") id(location.placeId, "state.location.placeId", issues);
  if (location.kind === "unknown") {
    if ("placeId" in location) invalid(issues, "invalid_shape", "state.location.placeId");
    if (location.reason !== undefined) text(location.reason, "state.location.reason", issues);
  }
}

function requestShape(value: unknown, issues: ValidationIssue[]): void {
  const request = record(value, "request", issues);
  if (request === null) return;
  id(request.id, "request.id", issues);
  id(request.journeyId, "request.journeyId", issues);
  integer(request.basePlanVersion, "request.basePlanVersion", issues, 1);
  integer(request.baseStateVersion, "request.baseStateVersion", issues, 1);
  const delay = record(request.delay, "request.delay", issues);
  if (delay !== null) {
    text(delay.observedAt, "request.delay.observedAt", issues);
    text(delay.earliestResumeAt, "request.delay.earliestResumeAt", issues);
  }
  const scope = record(request.scope, "request.scope", issues);
  if (scope === null) return;
  oneOf(scope.kind, ["selected_window", "rest_of_day"], "request.scope.kind", issues);
  if (scope.kind === "selected_window") {
    timeWindowShape(scope.window, "request.scope.window", issues);
  } else if (scope.kind === "rest_of_day") {
    text(scope.from, "request.scope.from", issues);
  }
}

function candidateShape(value: unknown, issues: ValidationIssue[]): void {
  const candidate = record(value, "candidate", issues);
  if (candidate === null) return;
  id(candidate.id, "candidate.id", issues);
  id(candidate.journeyId, "candidate.journeyId", issues);
  integer(candidate.basePlanVersion, "candidate.basePlanVersion", issues, 1);
  integer(candidate.baseStateVersion, "candidate.baseStateVersion", issues, 1);
  activitiesShape(candidate.activities, "candidate.activities", issues);
}

function reservationsShape(value: unknown, issues: ValidationIssue[]): void {
  const items = array(value, "reservations", issues);
  items?.forEach((value, index) => {
    const path = `reservations[${index}]`;
    const reservation = record(value, path, issues);
    if (reservation === null) return;
    id(reservation.id, `${path}.id`, issues);
    id(reservation.placeId, `${path}.placeId`, issues);
    text(reservation.startsAt, `${path}.startsAt`, issues);
    text(reservation.endsAt, `${path}.endsAt`, issues);
    const confirmation = record(reservation.confirmation, `${path}.confirmation`, issues);
    if (confirmation === null) return;
    oneOf(
      confirmation.status,
      ["confirmed", "pending", "cancelled", "unknown"],
      `${path}.confirmation.status`,
      issues,
    );
    text(confirmation.recordedAt, `${path}.confirmation.recordedAt`, issues);
    const source = record(confirmation.source, `${path}.confirmation.source`, issues);
    if (source === null) return;
    oneOf(
      source.kind,
      ["fixture", "user_reported", "provider_record"],
      `${path}.confirmation.source.kind`,
      issues,
    );
    if (source.reference !== undefined) text(source.reference, `${path}.confirmation.source.reference`, issues);
  });
}

function travelShape(value: unknown, issues: ValidationIssue[]): void {
  const items = array(value, "travelLegs", issues);
  items?.forEach((value, index) => {
    const path = `travelLegs[${index}]`;
    const leg = record(value, path, issues);
    if (leg === null) return;
    id(leg.fromPlaceId, `${path}.fromPlaceId`, issues);
    id(leg.toPlaceId, `${path}.toPlaceId`, issues);
    const duration = record(leg.duration, `${path}.duration`, issues);
    if (duration === null) return;
    oneOf(duration.kind, ["known", "unknown"], `${path}.duration.kind`, issues);
    if (duration.kind === "known") {
      integer(duration.minutes, `${path}.duration.minutes`, issues, 0);
    } else if (duration.kind === "unknown") {
      if ("minutes" in duration) invalid(issues, "invalid_shape", `${path}.duration.minutes`);
      if (duration.reason !== undefined) text(duration.reason, `${path}.duration.reason`, issues);
    }
  });
}

function shapeIssues(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const input = record(value, "input", issues);
  if (input === null) return issues;
  planShape(input.plan, issues);
  stateShape(input.state, issues);
  requestShape(input.request, issues);
  candidateShape(input.candidate, issues);
  reservationsShape(input.reservations, issues);
  travelShape(input.travelLegs, issues);
  integer(input.transferBufferMinutes, "transferBufferMinutes", issues, 0);
  return issues;
}

function civilMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date.getTime() - OFFSET_MS;
}

export function parseChinaDateTime(value: string): number | null {
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null) return null;
  return civilMs(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

export function formatChinaDateTime(epochMs: number): `${string}+08:00` {
  const date = new Date(epochMs + OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+08:00`;
}

function parsePlanDate(value: string): number | null {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return null;
  return civilMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0);
}

function parseField(value: string, path: string, issues: ValidationIssue[]): number | null {
  const parsed = parseChinaDateTime(value);
  if (parsed === null) invalid(issues, "invalid_datetime", path);
  return parsed;
}

function inDay(
  time: number,
  dayStartMs: number | null,
  allowEnd: boolean,
): boolean {
  if (dayStartMs === null) return true;
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  return time >= dayStartMs && (allowEnd ? time <= dayEndMs : time < dayEndMs);
}

function timedActivities(
  activities: readonly PlannedActivity[],
  path: string,
  dayStartMs: number | null,
  issues: ValidationIssue[],
): TimedActivity[] {
  const result: TimedActivity[] = [];
  activities.forEach((activity, index) => {
    const startsAtMs = parseField(activity.startsAt, `${path}[${index}].startsAt`, issues);
    const endsAtMs = parseField(activity.endsAt, `${path}[${index}].endsAt`, issues);
    if (startsAtMs === null || endsAtMs === null) return;
    if (
      startsAtMs >= endsAtMs ||
      !inDay(startsAtMs, dayStartMs, false) ||
      !inDay(endsAtMs, dayStartMs, true)
    ) {
      invalid(issues, "invalid_interval", `${path}[${index}]`);
      return;
    }
    result.push({ activity, startsAtMs, endsAtMs });
  });
  return result;
}

function uniqueIds(
  items: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  items.forEach((value, index) => {
    if (seen.has(value)) invalid(issues, "duplicate_id", `${path}[${index}]`);
    seen.add(value);
  });
}

/**
 * 结构检查后统一解析时间、身份和预约引用，建立可信基础快照，供后面的业务检查复用。
 * 基础计划自己矛盾属于 invalid_input；合法候选与约束冲突才属于业务上的 known_violation。
 */
function semanticPreparation(input: CandidateValidationInput): PreparationResult {
  const issues: ValidationIssue[] = [];
  const dayStartMs = parsePlanDate(input.plan.date);
  if (dayStartMs === null) invalid(issues, "invalid_datetime", "plan.date");

  const planActivities = timedActivities(input.plan.activities, "plan.activities", dayStartMs, issues);
  const candidateActivities = timedActivities(input.candidate.activities, "candidate.activities", dayStartMs, issues);
  const reservationTimes = input.reservations.map((reservation, index) => {
    const startsAtMs = parseField(reservation.startsAt, `reservations[${index}].startsAt`, issues);
    const endsAtMs = parseField(reservation.endsAt, `reservations[${index}].endsAt`, issues);
    parseField(reservation.confirmation.recordedAt, `reservations[${index}].confirmation.recordedAt`, issues);
    if (startsAtMs !== null && endsAtMs !== null) {
      if (
        startsAtMs >= endsAtMs ||
        !inDay(startsAtMs, dayStartMs, false) ||
        !inDay(endsAtMs, dayStartMs, true)
      ) invalid(issues, "invalid_interval", `reservations[${index}]`);
    }
    return { startsAtMs, endsAtMs };
  });

  // 请求所依据的观察时刻必须与状态快照一致，且最早继续不能早于报告时刻，防止拼接不同观察。
  const observedAtMs = parseField(input.state.observedAt, "state.observedAt", issues);
  const requestObservedAtMs = parseField(input.request.delay.observedAt, "request.delay.observedAt", issues);
  const earliestResumeAtMs = parseField(input.request.delay.earliestResumeAt, "request.delay.earliestResumeAt", issues);
  if (observedAtMs !== null && !inDay(observedAtMs, dayStartMs, false)) {
    invalid(issues, "invalid_interval", "state.observedAt");
  }
  if (requestObservedAtMs !== null && !inDay(requestObservedAtMs, dayStartMs, false)) {
    invalid(issues, "invalid_interval", "request.delay.observedAt");
  }
  if (earliestResumeAtMs !== null && !inDay(earliestResumeAtMs, dayStartMs, false)) {
    invalid(issues, "invalid_interval", "request.delay.earliestResumeAt");
  }
  if (observedAtMs !== null && requestObservedAtMs !== null && observedAtMs !== requestObservedAtMs) {
    invalid(issues, "inconsistent_baseline", "request.delay.observedAt");
  }
  if (requestObservedAtMs !== null && earliestResumeAtMs !== null && earliestResumeAtMs < requestObservedAtMs) {
    invalid(issues, "invalid_interval", "request.delay.earliestResumeAt");
  }

  const scopeStartMs = input.request.scope.kind === "selected_window"
    ? parseField(input.request.scope.window.startsAt, "request.scope.window.startsAt", issues)
    : parseField(input.request.scope.from, "request.scope.from", issues);
  const scopeEndMs = input.request.scope.kind === "selected_window"
    ? parseField(input.request.scope.window.endsAt, "request.scope.window.endsAt", issues)
    : dayStartMs === null ? null : dayStartMs + 24 * 60 * 60 * 1000;
  if (scopeStartMs !== null && !inDay(scopeStartMs, dayStartMs, false)) {
    invalid(issues, "invalid_interval", "request.scope");
  }
  if (scopeEndMs !== null && !inDay(scopeEndMs, dayStartMs, true)) {
    invalid(issues, "invalid_interval", "request.scope");
  }
  if (scopeStartMs !== null && scopeEndMs !== null && scopeStartMs >= scopeEndMs) {
    invalid(issues, "invalid_interval", "request.scope");
  }

  uniqueIds(input.plan.activities.map((activity) => activity.id), "plan.activities", issues);
  uniqueIds(input.candidate.activities.map((activity) => activity.id), "candidate.activities", issues);
  uniqueIds(input.reservations.map((reservation) => reservation.id), "reservations", issues);
  uniqueIds(input.state.completedActivityIds, "state.completedActivityIds", issues);
  uniqueIds(input.state.skippedActivityIds, "state.skippedActivityIds", issues);
  // 每个方向只能有一份交通事实；重复边即使数值相同也视为歧义，不让下游隐式选择某一条。
  const travelPairs = new Set<string>();
  input.travelLegs.forEach((leg, index) => {
    const pair = JSON.stringify([leg.fromPlaceId, leg.toPlaceId]);
    if (travelPairs.has(pair)) invalid(issues, "ambiguous_travel_leg", `travelLegs[${index}]`);
    travelPairs.add(pair);
  });

  if (input.plan.parentVersion !== undefined && input.plan.parentVersion >= input.plan.version) {
    invalid(issues, "inconsistent_baseline", "plan.parentVersion");
  }
  if (input.plan.journeyId !== input.state.journeyId) {
    invalid(issues, "inconsistent_baseline", "state.journeyId");
  }
  const planIds = new Set(input.plan.activities.map((activity) => activity.id));
  const completed = new Set(input.state.completedActivityIds);
  const skipped = new Set(input.state.skippedActivityIds);
  for (const id of [...completed, ...skipped]) {
    if (!planIds.has(id)) invalid(issues, "inconsistent_baseline", "state.completedActivityIds/state.skippedActivityIds");
    if (completed.has(id) && skipped.has(id)) invalid(issues, "inconsistent_baseline", "state.completedActivityIds/state.skippedActivityIds");
  }
  const current = input.state.currentActivityId;
  if (current !== null && (!planIds.has(current) || completed.has(current) || skipped.has(current))) {
    invalid(issues, "inconsistent_baseline", "state.currentActivityId");
  }

  for (let index = 1; index < planActivities.length; index += 1) {
    const previous = planActivities[index - 1];
    const next = planActivities[index];
    if (next.startsAtMs < previous.startsAtMs || next.startsAtMs < previous.endsAtMs) {
      invalid(issues, "inconsistent_baseline", `plan.activities[${index}]`);
    }
  }
  for (let index = 1; index < candidateActivities.length; index += 1) {
    if (candidateActivities[index].startsAtMs < candidateActivities[index - 1].startsAtMs) {
      invalid(issues, "invalid_interval", `candidate.activities[${index}]`);
    }
  }

  // 已确认预约必须且只能关联一条原活动，地点和时段也要一致；先保证基线真实自洽，再谈候选保护。
  const reservationsById = new Map(input.reservations.map((reservation) => [reservation.id, reservation]));
  const references = new Map<string, PlannedActivity[]>();
  for (const activity of input.plan.activities) {
    if (activity.reservationId === undefined) continue;
    const referring = references.get(activity.reservationId) ?? [];
    referring.push(activity);
    references.set(activity.reservationId, referring);
    if (referring.length > 1) invalid(issues, "inconsistent_baseline", `plan.activities.${activity.id}.reservationId`);
    if (reservationsById.get(activity.reservationId)?.confirmation.status === "cancelled") {
      invalid(issues, "inconsistent_baseline", `plan.activities.${activity.id}.reservationId`);
    }
  }
  input.reservations.forEach((reservation, index) => {
    if (reservation.confirmation.status !== "confirmed") return;
    const referring = references.get(reservation.id) ?? [];
    if (referring.length !== 1) {
      invalid(issues, "inconsistent_baseline", `reservations[${index}]`);
      return;
    }
    const activity = referring[0];
    const reservationTime = reservationTimes[index];
    if (
      activity.placeId !== reservation.placeId ||
      parseChinaDateTime(activity.startsAt) !== reservationTime.startsAtMs ||
      parseChinaDateTime(activity.endsAt) !== reservationTime.endsAtMs
    ) {
      invalid(issues, "inconsistent_baseline", `reservations[${index}]`);
    }
  });

  if (
    issues.length > 0 ||
    dayStartMs === null ||
    observedAtMs === null ||
    earliestResumeAtMs === null ||
    scopeStartMs === null ||
    scopeEndMs === null
  ) {
    return { valid: false, issues };
  }
  return {
    valid: true,
    value: {
      input,
      planActivities,
      candidateActivities,
      dayStartMs,
      dayEndMs: dayStartMs + 24 * 60 * 60 * 1000,
      observedAtMs,
      earliestResumeAtMs,
      scopeStartMs,
      scopeEndMs,
    },
  };
}

/** 先分离结构错误与基础快照矛盾，全部通过后才允许后续校验器形成业务结论。 */
export function prepareCandidateInput(value: unknown): PreparationResult {
  const issues = shapeIssues(value);
  if (issues.length > 0) return { valid: false, issues };
  return semanticPreparation(value as CandidateValidationInput);
}
