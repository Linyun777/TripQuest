import { randomUUID } from "node:crypto";
import { createDayPlanningProblem, type DayPlanningResult } from "@tripquest/application/day-planning";
import { fingerprintRequirements, type DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { planningRequirementsSchema, type PlanningPlace, type TravelPreference } from "@tripquest/application/planning";
import type { MobilityProvider } from "@tripquest/providers";
import { createDayPlanningRunner } from "./day-graph";
import { createDayScriptedModel } from "./day-scripted";

/**
 * 每站都由用户选定，顺序也已确定；这里复用一日规划的路线、排程、校验与确认快照。
 * 决策器使用“试原顺序 → 引用成功试算”的固定策略，不能擅自重排或删除用户选中的站。
 */
export async function planShortTrip(options: {
  date: string;
  window: { startsAt: string; endsAt: string };
  start: PlanningPlace;
  /** V2.10：卡片的主要城市；缺省取出发点所在的城市。 */
  city?: { adcode: string; name: string };
  /** 用户明确要求返回的地点；缺省就在最后选中的站结束，不强制回到起点。 */
  back?: PlanningPlace;
  stops: readonly { place: PlanningPlace; stayMinutes: number }[];
  travel: TravelPreference;
  provider: MobilityProvider;
  now: () => number;
  signal: AbortSignal;
  onProgress?: (detail: string) => void;
  /** 地图折线只随本次响应返回，不进入正式持久化。 */
  onRoutePath?: (fromPlaceId: string, toPlaceId: string, path: readonly (readonly [number, number])[]) => void;
}): Promise<{ result: DayPlanningResult; snapshot: DayDraftConfirmationSnapshot | null }> {
  // 已选站全部临时作为 required，禁止规划器为了排得下而删站；停留时间仍采用用户选择时看到的值。
  const requirements = planningRequirementsSchema.parse({
    schemaVersion: "planning-requirements.v1",
    cityAdcode: options.city?.adcode ?? options.start.place.cityAdcode,
    ...(options.city ? { cityName: options.city.name } : {}),
    timeZone: "Asia/Shanghai",
    travelMode: "walking",
    date: options.date,
    window: options.window,
    startPlace: options.start,
    endPlace: options.back ?? options.stops.at(-1)!.place,
    interests: [],
    pace: "standard",
    travel: options.travel,
    visits: options.stops.map((stop) => ({ place: stop.place, role: "required", stayMinutes: stop.stayMinutes })),
  });
  const problem = createDayPlanningProblem({
    requirements,
    runId: randomUUID(),
    requirementsFingerprint: fingerprintRequirements(requirements),
    nowMs: options.now(),
    leaveLate: true,
  });
  const order = problem.activities.map((record) => record.activity.activityId);
  // 固定策略仍走正常动作协议：成功引用 attemptId，失败按未知信息或明确约束分别停止。
  // 复用执行图不等于又让模型重新决定用户已作出的选择。
  const model = createDayScriptedModel((context) => context.latestAttempt?.status === "success"
    ? { action: "finish", attemptId: context.latestAttempt.attemptId }
    : context.latestAttempt
      ? { action: "stop", reason: context.latestAttempt.issues.some((issue) => issue.kind === "unknown") ? "insufficient_information" : "constraints_not_met" }
      : { action: "try_itinerary", orderedActivityIds: order });
  let snapshot: DayDraftConfirmationSnapshot | null = null;
  const result = await createDayPlanningRunner({ provider: options.provider, model, now: options.now }).run(problem, {
    signal: options.signal,
    onProgress: (progress) => {
      if (progress.detail) options.onProgress?.(progress.detail);
    },
    onDraftReady: (ready) => (snapshot = ready),
    ...(options.onRoutePath ? { onRoutePath: options.onRoutePath } : {}),
  });
  return { result, snapshot };
}
