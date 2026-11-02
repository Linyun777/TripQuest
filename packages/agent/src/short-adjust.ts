import { shortStepDeparture } from "@tripquest/application/conversation";
import type { DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import type { DayPlanningResult } from "@tripquest/application/day-planning";
import { requirementsCity, type PlanningPlace, type PlanningRequirements, type TravelPreference } from "@tripquest/application/planning";
import type { MobilityProvider } from "@tripquest/providers";
import {
  planAdjustment,
  shortAdjustSlots,
  type AdjustRequest,
  type PlannedAdjustment,
  type PreparedAdjustment,
} from "@tripquest/application/real-adjust";
import type { StoredRealDay } from "@tripquest/application/real-day";
import type { CandidateResult, CandidateStep } from "./short-candidates";
import { planShortTrip } from "./short-plan";

/**
 * 短途调整保留用户原顺序：保留站不动，替换兴趣占原位置，新增兴趣接到末尾。
 * 新兴趣逐一以上一站为中心找地点，再按这条序列试排；最终仍由用户确认后保存。
 */
export type ShortSlot =
  | { readonly kind: "kept"; readonly externalId: string; readonly stayMinutes: number }
  | { readonly kind: "new"; readonly interest: { readonly text: string; readonly when?: string } };

export type ShortSequenceItem = {
  readonly externalId: string;
  readonly kept: boolean;
  readonly place: PlanningPlace;
  readonly stayMinutes: number;
};

/** 依次填补序列里的新兴趣位置；每步中心取已解析的上一站，而不是始终取最初起点。 */
export async function resolveShortSlots(options: {
  slots: readonly ShortSlot[];
  /** 保留站的实时地点信息按高德编号查表，不从历史消息取坐标。 */
  kept: ReadonlyMap<string, PlanningPlace>;
  start: PlanningPlace;
  date: string;
  /** 剩余行程的继续时刻，用于估计后续候选开始查询时的营业可用性。 */
  resumeAt: string;
  travel: TravelPreference;
  /** 原行程出现过的地点都排除，包含已完成、已跳过和待访问，避免调整后又推荐回去。 */
  exclude: readonly string[];
  candidates: { run(step: CandidateStep, options: { signal: AbortSignal }): Promise<CandidateResult> };
  signal: AbortSignal;
  /** V2.11：日常只在行程的城市里找新地点。 */
  cityAdcode?: string;
}): Promise<
  | { readonly status: "ok"; readonly sequence: readonly ShortSequenceItem[]; readonly model: number }
  | { readonly status: "none"; readonly interest: string; readonly model: number }
  | { readonly status: "failed"; readonly model: number }
> {
  const sequence: ShortSequenceItem[] = [];
  let model = 0;
  for (const slot of options.slots) {
    if (slot.kind === "kept") {
      sequence.push({ externalId: slot.externalId, kept: true, place: options.kept.get(slot.externalId)!, stayMinutes: slot.stayMinutes });
      continue;
    }
    const anchor = sequence.at(-1)?.place ?? options.start;
    const result = await options.candidates.run({
      interest: slot.interest,
      anchor,
      anchorIsStart: !sequence.length,
      exclude: [...options.exclude, ...sequence.map((item) => item.externalId)],
      travel: options.travel,
      departureAt: shortStepDeparture(options.date, options.resumeAt, sequence.map((item) => item.stayMinutes)),
      ...(options.cityAdcode ? { cityAdcode: options.cityAdcode } : {}),
    }, { signal: options.signal });
    model += result.counts.model;
    if (result.status === "none") return { status: "none", interest: slot.interest.text, model };
    if (result.status !== "ok") return { status: "failed", model };
    // 调整中的新兴趣按本批排序第一项生成候选方案；这里尚未写正式计划，用户仍会看到差异后确认。
    const best = result.candidates[0];
    sequence.push({ externalId: best.selection.place.ref.externalId, kept: false, place: best.selection, stayMinutes: best.stayMinutes });
  }
  return { status: "ok", sequence, model };
}

/**
 * 为一次调整试排构造固定序列；“建议少一站”的试排只删除被允许的保留站。
 * 原本在最后站结束的仍在最后站结束，明确要返程的仍保留返程。
 */
export function shortSequencePlanner(options: {
  sequence: readonly ShortSequenceItem[];
  provider: MobilityProvider;
  now: () => number;
  signal: AbortSignal;
  onProgress?: (detail: string) => void;
}) {
  return async (requirements: PlanningRequirements): Promise<{ result: DayPlanningResult | null; snapshot: DayDraftConfirmationSnapshot | null }> => {
    const asked = new Map(requirements.visits.map((visit) => [visit.place.place.ref.externalId, visit.place]));
    const stops = options.sequence
      .filter((item) => !item.kept || asked.has(item.externalId))
      .map((item) => ({ place: item.kept ? asked.get(item.externalId)! : item.place, stayMinutes: item.stayMinutes }));
    const endId = requirements.endPlace.place.ref.externalId;
    const back = options.sequence.some((item) => item.externalId === endId) ? undefined : requirements.endPlace;
    try {
      return await planShortTrip({
        date: requirements.date,
        window: requirements.window,
        start: requirements.startPlace,
        city: requirementsCity(requirements),
        ...(back ? { back } : {}),
        stops,
        travel: requirements.travel ?? { allowed: ["walking"], prefer: "balanced" },
        provider: options.provider,
        now: options.now,
        signal: options.signal,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch {
      return { result: null, snapshot: null };
    }
  };
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 先把新增兴趣逐步解析成地点，再固定顺序调用一日排程与相同的删站建议机制。
 * no_place 表示某兴趣附近确实没有合适候选；null 表示存在固定预约等不适用短途序列的形状。
 */
export async function planShortAdjustment(options: {
  details: StoredRealDay;
  prepared: PreparedAdjustment;
  request: AdjustRequest;
  candidates: { run(step: CandidateStep, options: { signal: AbortSignal }): Promise<CandidateResult> };
  provider: MobilityProvider;
  now: () => number;
  signal: AbortSignal;
  onProgress?: (detail: string) => void;
}): Promise<PlannedAdjustment | { readonly status: "no_place"; readonly interest: string } | null> {
  const slots = shortAdjustSlots(options.details, options.prepared, options.request);
  if (!slots) return null;
  const { asked } = options.prepared;
  const kept = new Map(asked.visits.map((visit) => [visit.place.place.ref.externalId, visit.place]));
  const resolved = await resolveShortSlots({
    slots,
    kept,
    start: asked.startPlace as PlanningPlace,
    date: options.details.context.date,
    resumeAt: clock(options.prepared.resumeAt),
    travel: (asked.travel as TravelPreference | undefined) ?? { allowed: ["walking"], prefer: "balanced" },
    exclude: options.details.places.map((place) => place.externalId),
    candidates: options.candidates,
    signal: options.signal,
    ...(typeof asked.cityAdcode === "string" ? { cityAdcode: asked.cityAdcode } : {}),
  });
  if (resolved.status === "none") return { status: "no_place", interest: resolved.interest };
  if (resolved.status === "failed") return { status: "none", result: null, noFit: false };
  return planAdjustment(options.prepared, shortSequencePlanner({
    sequence: resolved.sequence,
    provider: options.provider,
    now: options.now,
    signal: options.signal,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }));
}
