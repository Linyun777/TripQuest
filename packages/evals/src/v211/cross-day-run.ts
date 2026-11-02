import { createChatRunner, type ChatDecisionModel, type ChatOutingTrip, type ChatTrip } from "@tripquest/agent/chat";
import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { planOutingChange, type OutingChangePlan } from "@tripquest/agent/outing-change";
import { forecastLookup, generateOuting, type GeneratedDay } from "@tripquest/agent/outing-generate";
import type { ReviewRequest } from "@tripquest/agent/outing-review";
import { requirementsDraftSchema, type DraftPlace, type RequirementsDraft } from "@tripquest/application/conversation";
import { outingBaseIsCurrent } from "@tripquest/application/outing-trip";
import { DEFAULT_TRAVEL } from "@tripquest/application/planning";
import { FORECASTS, V21_NOW, V21World, worldPlaceByName, worldSelection, YUNLING } from "../v21/world";
import { allocationInput } from "./allocation-run";
import { ALLOCATION_CASES, type AllocationCase, type CrossDayCase } from "./outing-plan-dataset";

/**
 * V2.11 跨天调整与改车次（§4.7）：一趟已经排好的出游（按下面的基础分配，用脚本规划器排出各天），在第 today 天
 * now 时用户说一句话。对话 Agent 理解成 change_outing（或回答、或被挡下），产品的 planOutingChange 做代码检查
 * 并重排受影响的天（模型规划器）。M08 另外检查：确认时另一天已经变了，整体拒绝。
 *
 * 题目只写了用哪趟出游，没写分配；这里按题意定下基础出游（写进“结果”）：
 * - X01：L01 的地点，第一天山和古镇、第二天海边、第三天欢乐谷；两晚都住山居酒店（M06 改第二晚）；
 *   欢乐谷按用户说的玩 6 小时（M04 要放不下）。
 * - X02：L04 的卡片去掉古镇：第一天杭州两处、第二天坐高铁、第三天山（M05 只看改车次后重新切段）。
 * - L02：第一天古镇、第二天博物馆讲座（固定）和海边、第三天山。
 */
const BASES: Record<CrossDayCase["trip"], { readonly card: AllocationCase; readonly days: readonly (readonly string[])[] }> = {
  X01: {
    card: {
      ...ALLOCATION_CASES.find((item) => item.id === "L01")!,
      lodging: ["Y-HOTEL", "Y-HOTEL"],
      visits: ALLOCATION_CASES.find((item) => item.id === "L01")!.visits
        .map((visit) => (visit.place === "Y-PARK" ? { place: "Y-PARK", role: "required" as const, stayMinutes: 360 } : visit)),
    },
    days: [["Y-GATE", "Y-TOWN"], ["Y-BEACH"], ["Y-PARK"]],
  },
  X02: {
    card: {
      ...ALLOCATION_CASES.find((item) => item.id === "L04")!,
      visits: ALLOCATION_CASES.find((item) => item.id === "L04")!.visits.filter((visit) => visit.place !== "Y-TOWN"),
    },
    days: [["V21-MUSEUM", "V21-STREET"], [], ["Y-GATE"]],
  },
  L02: { card: ALLOCATION_CASES.find((item) => item.id === "L02")!, days: [["Y-TOWN"], ["Y-MUSEUM", "Y-BEACH"], ["Y-GATE"]] },
};

export interface CrossDayRow {
  readonly suite: "crossday";
  readonly caseId: string;
  readonly heldOut: boolean;
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly reply: string;
  readonly change: unknown;
  readonly refused?: string;
  readonly plan: { readonly status: string; readonly reason?: string; readonly affected?: readonly number[]; readonly days?: readonly string[] } | null;
  readonly failures: readonly string[];
}

const bound = (id: string): DraftPlace => {
  const place = worldSelection(id).place;
  return { status: "bound", externalId: id, name: place.name, ...(place.cityAdcode ? { city: place.cityAdcode } : {}) };
};

/** 题目的卡片 → 出游卡片（含基础分配）。 */
export function baseDraft(trip: CrossDayCase["trip"]): RequirementsDraft {
  const { card, days } = BASES[trip];
  const keyOf = (id: string) => `v${card.visits.findIndex((visit) => visit.place === id) + 1}`;
  return requirementsDraftSchema.parse({
    version: "requirements-draft.v1",
    mode: "outing",
    city: { adcode: YUNLING.adcode, name: YUNLING.name, source: "said" },
    date: null,
    startsAt: null,
    endsAt: null,
    start: bound(card.start.place),
    end: bound(card.end.place),
    visits: card.visits.map((visit, index) => ({
      key: `v${index + 1}`,
      place: bound(visit.place),
      role: visit.role,
      stayMinutes: visit.stayMinutes ?? (visit.startsAt && visit.endsAt ? null : 60),
      ...(visit.estimate ? { staySource: "estimate" } : {}),
      startsAt: visit.startsAt ?? null,
      endsAt: visit.endsAt ?? null,
      ...(visit.day ? { day: visit.day } : {}),
    })),
    interests: [],
    travel: card.travel,
    pace: "standard",
    notes: null,
    outing: {
      dates: card.dates,
      startAt: card.start.at ?? null,
      endAt: card.end.at ?? null,
      dailyWindow: card.dailyWindow ?? { startsAt: "09:00", endsAt: "20:00" },
      lodging: card.lodging.map((night, index) => (night === "onBoard"
        ? { night: index + 1, place: null, onBoard: true }
        : { night: index + 1, place: bound(night) })),
      transports: card.transfers.map((ride, index) => ({
        id: `t${index + 1}`, day: ride.day, mode: ride.mode, from: bound(ride.from), to: bound(ride.to),
        departAt: ride.departAt ?? null, arriveAt: ride.arriveAt ?? null, arriveDay: ride.arriveDay ?? "same",
      })),
      allocation: {
        days: days.map((ids, index) => ({ day: index + 1, visits: ids.map(keyOf), interests: [] })),
        source: "rules",
        problems: [],
      },
    },
  });
}

/** 卡片 → 规划输入（评测世界里按编号找地点）。 */
function worldInput(draft: RequirementsDraft) {
  const outing = draft.outing!;
  const id = (place: DraftPlace | null | undefined) => (place?.status === "bound" ? place.externalId : null);
  const card: AllocationCase = {
    id: "card", note: "", dates: outing.dates!, dailyWindow: outing.dailyWindow,
    start: { place: id(draft.start)!, ...(outing.startAt ? { at: outing.startAt } : {}) },
    end: { place: id(draft.end ?? draft.start)!, ...(outing.endAt ? { at: outing.endAt } : {}) },
    lodging: Array.from({ length: Math.max(0, (outing.dates ? Math.round((Date.parse(outing.dates.to) - Date.parse(outing.dates.from)) / 86_400_000) : 0)) }, (_, index) => {
      const night = outing.lodging.find((item) => item.night === index + 1);
      return night?.onBoard ? "onBoard" : id(night?.place) ?? id(draft.start)!;
    }),
    transfers: outing.transports.map((ride) => ({
      day: ride.day, mode: ride.mode, from: id(ride.from)!, to: id(ride.to)!,
      ...(ride.departAt ? { departAt: ride.departAt } : {}), ...(ride.arriveAt ? { arriveAt: ride.arriveAt } : {}), arriveDay: ride.arriveDay,
    })),
    visits: draft.visits.map((visit) => ({
      place: id(visit.place)!, role: visit.role,
      ...(visit.stayMinutes ? { stayMinutes: visit.stayMinutes } : {}),
      ...(visit.staySource === "estimate" ? { estimate: true as const } : {}),
      ...(visit.startsAt ? { startsAt: visit.startsAt, endsAt: visit.endsAt! } : {}),
      ...(visit.day ? { day: visit.day } : {}),
    })),
    interests: [],
    travel: (draft.travel ?? DEFAULT_TRAVEL) as AllocationCase["travel"],
  };
  return allocationInput(card);
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const idOf = (name: string) => worldPlaceByName(name)?.id ?? name;
const stopsOf = (day: GeneratedDay) => day.result.status !== "draft" ? [] : day.result.parts.flatMap((part) => part.kind === "plan"
  ? part.draft.activities.map((activity) => idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name))
  : []);

export async function runCrossDayCase(
  item: CrossDayCase,
  models: {
    readonly chat: () => ChatDecisionModel;
    readonly day: () => DayPlanningDecisionModel;
    /** V3.2：改动重排后审查（审查开着时），和产品一样。 */
    readonly reviewer?: () => ReviewRequest;
  },
): Promise<CrossDayRow> {
  const world = new V21World(FORECASTS.dry);
  const signal = new AbortController().signal;
  const draft = baseDraft(item.trip);
  const input = worldInput(draft);
  // 评测世界的地点数据时间是 V21_NOW：规划器用它的时钟（数据不算过期）；对话用出游当天的时刻。
  const scripted = createDayPlanningRunner({ provider: world, model: createDayScriptedModel(), now: () => V21_NOW });
  // 已经排好的出游（脚本规划器，确定的结果）：今天的各站和其他天找到的地点。
  const saved = await generateOuting({ ...input, pace: "standard", cityAdcode: YUNLING.adcode }, draft.outing!.allocation!, {
    runner: scripted, provider: world, now: () => V21_NOW,
  }, { signal });
  const date = saved.find((day) => day.day === item.today)!.date;
  const nowMs = Date.parse(`${date}T${item.now}:00+08:00`);
  const keyOf = (id: string) => draft.visits.find((visit) => visit.place.status === "bound" && visit.place.externalId === id)?.key;
  const done = (item.done ?? []).flatMap((id) => (keyOf(id) ? [keyOf(id)!] : []));
  const outing: ChatOutingTrip = {
    today: item.today,
    days: saved.map((day) => ({
      day: day.day,
      date: day.date,
      places: stopsOf(day).map((id) => {
        const key = keyOf(id);
        const visit = draft.visits.find((entry) => entry.key === key);
        return {
          ...(key ? { key } : {}),
          name: worldSelection(id).place.name,
          status: key && done.includes(key) ? "done" as const : "todo" as const,
          ...(visit?.role === "fixed" ? { fixed: true as const } : {}),
        };
      }),
      ...(day.day < saved.length ? { lodging: draft.outing!.lodging.find((night) => night.night === day.day)?.place?.status === "bound"
        ? (draft.outing!.lodging.find((night) => night.night === day.day)!.place as { name: string }).name : undefined } : {}),
    })),
    transports: draft.outing!.transports.map((ride) => ({
      id: ride.id, day: ride.day,
      from: ride.from?.status === "bound" ? ride.from.name : "?", to: ride.to?.status === "bound" ? ride.to.name : "?",
      departAt: ride.departAt, arriveAt: ride.arriveAt,
    })),
  };
  const today = saved.find((day) => day.day === item.today)!;
  const todayStops = today.result.status !== "draft" ? [] : today.result.parts.flatMap((part) => part.kind !== "plan" ? []
    : part.draft.activities.map((activity) => ({ activity, name: part.draft.places.find((place) => place.placeId === activity.placeId)!.name })));
  const trip: ChatTrip = {
    version: 1,
    date,
    stops: todayStops.map(({ activity, name }, index) => ({
      key: `s${index + 1}`,
      name,
      startsAt: clock(activity.startsAt),
      endsAt: clock(activity.endsAt),
      status: keyOf(idOf(name)) && done.includes(keyOf(idOf(name))!) ? "done" as const : "todo" as const,
      ...(activity.role === "fixed" ? { fixed: true } : {}),
    })),
    outing,
  };
  const history = [
    { role: "user" as const, text: "这几天的出游就按这个来" },
    { role: "assistant" as const, text: "（出游已保存为行程）" },
  ];
  const result = await createChatRunner({ model: models.chat(), places: world, weather: world, cities: world })
    .run({ draft, history, userText: item.text, nowMs, trip }, { signal });
  if (result.status !== "completed") {
    return {
      suite: "crossday", caseId: item.id, heldOut: !!item.heldOut, checks: [{ name: "turn_completed", passed: false }], passed: false,
      reply: "", change: null, plan: null, failures: [`${result.code}: ${result.hints.join(", ")}`],
    };
  }
  let plan: OutingChangePlan | null = null;
  if (result.outingChange) {
    const change = result.outingChange;
    const found = "lodging" in change ? worldPlaceByName(change.lodging.mention) : undefined;
    plan = await planOutingChange(draft, change, { today: item.today, done }, {
      toInput: async (next) => worldInput(next),
      ...(found ? { lodging: { externalId: found.id, name: worldSelection(found.id).place.name, cityAdcode: worldSelection(found.id).place.cityAdcode } } : {}),
      exclude: (affected) => saved.filter((day) => !affected.includes(day.day)).flatMap((day) => day.discovered),
      runner: createDayPlanningRunner({ provider: world, model: models.day(), now: () => V21_NOW }),
      provider: world,
      now: () => V21_NOW,
      weather: forecastLookup(world, signal),
      ...(models.reviewer ? { reviewer: models.reviewer() } : {}),
    }, signal);
  }
  const unchanged = !result.outingChange && !result.adjust && !result.draftChanged;
  const generatedOk = plan?.status === "ok" && plan.generated.every((day) => day.result.status === "draft");
  const expect = item.expect;
  const checks: { name: string; passed: boolean }[] = [];
  if ("move" in expect) {
    const moved = plan?.status === "ok" ? plan.generated.find((day) => day.day === expect.toDay) : undefined;
    checks.push({ name: "understood", passed: !!result.outingChange && "move" in result.outingChange && result.outingChange.move.toDay === expect.toDay });
    checks.push({ name: "replanned", passed: !!generatedOk && !!moved && stopsOf(moved).includes(expect.move) });
  } else if ("refused" in expect) {
    const reason = result.outingRefused ?? (plan?.status === "refused" ? plan.reason : undefined);
    // 模型自己就说不行、什么都没发，也算挡住了（没有改动）。
    checks.push({ name: `refused_${expect.refused}`, passed: reason === expect.refused || (unchanged && expect.refused !== "no_room") });
    checks.push({ name: "nothing_changed", passed: plan?.status !== "ok" && !result.draftChanged });
  } else if ("askOnly" in expect) {
    checks.push({ name: "answered_only", passed: unchanged });
  } else if ("transferAt" in expect) {
    const day = plan?.status === "ok" ? plan.generated.find((entry) => entry.day === expect.day) : undefined;
    const ride = day?.result.status === "draft" ? day.result.parts.find((part) => part.kind === "transfer") : undefined;
    checks.push({ name: "understood", passed: !!result.outingChange && "transport" in result.outingChange });
    checks.push({ name: "resplit", passed: !!generatedOk && ride?.kind === "transfer" && ride.departAt === minutes(expect.transferAt) });
  } else if ("lodging" in expect) {
    const night = plan?.status === "ok" ? plan.draft.outing!.lodging.find((entry) => entry.night === expect.days[0]) : undefined;
    checks.push({ name: "understood", passed: !!result.outingChange && "lodging" in result.outingChange });
    checks.push({
      name: "both_days_replanned",
      passed: !!generatedOk && plan?.status === "ok" && JSON.stringify(plan.affected) === JSON.stringify(expect.days) &&
        night?.place?.status === "bound" && night.place.externalId === expect.lodging,
    });
  } else {
    // 确认前另一天的行程变了（出游版本加一）：整体拒绝。
    const base = { tripVersion: 1, journeys: saved.map((day) => ({ journeyId: `j${day.day}`, planVersion: 1, observationVersion: 0 })) };
    const later = { ...base, journeys: base.journeys.map((journey, index) => (index === 2 ? { ...journey, planVersion: 2 } : journey)) };
    checks.push({ name: "understood", passed: !!result.outingChange && plan?.status === "ok" });
    checks.push({ name: "stale_refused", passed: outingBaseIsCurrent(base, base) && !outingBaseIsCurrent(base, later) });
  }
  return {
    suite: "crossday",
    caseId: item.id,
    heldOut: !!item.heldOut,
    checks,
    passed: checks.every((check) => check.passed),
    reply: result.reply.text,
    change: result.outingChange ?? null,
    ...(result.outingRefused ? { refused: result.outingRefused } : {}),
    plan: plan === null ? null : plan.status === "refused"
      ? { status: "refused", reason: plan.reason }
      : { status: "ok", affected: plan.affected, days: plan.generated.map((day) => `${day.day}:${day.result.status}:${day.result.status === "failed" ? day.result.code : stopsOf(day).join(" ")}`) },
    failures: [],
  };
}
