import { createDayPlanningRunner, createDayScriptedModel, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { forecastLookup, generateOuting, type GeneratedDay, type OutingGenerateOptions, type OutingInput } from "@tripquest/agent/outing-generate";
import type { OutingReviewOutcome } from "@tripquest/agent/outing-graph";
import { applyDraftPatch, emptyOutingDraft } from "@tripquest/application/conversation";
import { allocateByRules, outingFrames, type OutingPlanInput } from "@tripquest/application/outing-allocation";
import { timeTransfer, type TimedTransfer } from "@tripquest/application/transfer-day";
import { FORECASTS, V21_NOW, V21World, worldPlace, worldPlaceByName, worldSelection } from "../v21/world";
import type { Policy } from "../v21/run";
import type { LodgingCase } from "./lodging-dataset";

/**
 * V3.3 住处评测（stages/V3.3.md §4）：卡片按题目写（没定的住处是 null，兴趣按原话经卡片补丁加进去，“住古镇附近”
 * 由产品自己识别），规则分配，再用产品的逐天生成排出来。产品定的暂定住处从 onLodging 回调读，换住处的候选从
 * 建议（choose_lodging）读；基线没有这两样，回调不会被调用。判分规则见 lodging-dataset.ts。
 */
export interface LodgingRow {
  readonly suite: "lodging";
  readonly caseId: string;
  readonly policy: Policy;
  readonly heldOut: boolean;
  readonly days: readonly { readonly day: number; readonly outcome: string; readonly stops: readonly string[] }[];
  /** 每晚最后住哪（世界编号；null 是没定，onBoard 是车上）。 */
  readonly nights: readonly (string | null)[];
  readonly candidates: readonly { readonly nights: readonly number[]; readonly place: string }[];
  /** 每趟要估计的交通：实际按的车程和应有的车程（分钟）。 */
  readonly estimates: readonly { readonly day: number; readonly minutes: number; readonly expected: number }[];
  readonly checks: readonly { readonly name: string; readonly passed: boolean }[];
  readonly passed: boolean;
  readonly mapRequests: number;
  readonly modelRequests: number;
  readonly elapsedMs: number;
  /** V3.5 诊断：一日规划每次搜兴趣用的词和它给的地点类型（kind，没给是 null）。 */
  readonly daySearches?: readonly { readonly query: string; readonly kind: string | null }[];
}

/** 产品交出的暂定住处（V3.3 新加的回调；基线没有）。 */
interface LodgingChoice {
  readonly nights: readonly number[];
  readonly place: { readonly place: { readonly ref: { readonly externalId: string } } } | null;
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const idOf = (name: string) => worldPlaceByName(name)?.id ?? name;
const cityOf = (id: string) => worldSelection(id).place.cityAdcode;
const isLodging = (id: string) => {
  try {
    return /^10\d{4}$/.test(worldPlace(id).category ?? "");
  } catch {
    return false;
  }
};

/** 两点的直线距离（米），按评测世界给的经纬度。 */
function meters(a: string, b: string): number {
  const [p, q] = [worldSelection(a).place.location, worldSelection(b).place.location];
  const rad = (value: number) => (value * Math.PI) / 180;
  const h = Math.sin(rad(q.latitude - p.latitude) / 2) ** 2 +
    Math.cos(rad(p.latitude)) * Math.cos(rad(q.latitude)) * Math.sin(rad(q.longitude - p.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** §3.7 的车程：直线 × 1.3 ÷ 速度 + 20 分钟，向上取到 10 分钟，至少 30 分钟。 */
function expectedMinutes(mode: string, from: string, to: string): number {
  const km = (meters(from, to) / 1000) * 1.3;
  const raw = mode === "flight" ? (km / 700) * 60 + 60 + 20 : (km / 200) * 60 + 20;
  return Math.max(30, Math.ceil(raw / 10) * 10);
}

/** 题目 → 卡片的兴趣（经产品的卡片补丁）和住处区域（产品识别出来的；基线没有）。 */
function cardInterests(item: LodgingCase) {
  const addInterests = item.interests.map((interest) => ({
    text: interest.text,
    ...(interest.when ? { when: interest.when } : {}),
    ...(interest.day ? { day: interest.day } : {}),
  }));
  const applied = applyDraftPatch(emptyOutingDraft(), { addInterests });
  if (applied.status !== "ok") throw new Error(`card ${item.id}: ${applied.code}`);
  const areas = (applied.draft.outing as { lodgingAreas?: readonly unknown[] } | undefined)?.lodgingAreas ?? [];
  return { interests: applied.draft.interests, areas };
}

export function lodgingInput(item: LodgingCase): OutingInput {
  const { interests, areas } = cardInterests(item);
  const input: OutingPlanInput = {
    dates: item.dates,
    dailyWindow: item.dailyWindow ?? { startsAt: "09:00", endsAt: "20:00" },
    start: { place: worldSelection(item.start.place), at: item.start.at ?? null },
    end: { place: worldSelection(item.end.place), at: item.end.at ?? null },
    lodging: item.lodging.map((night) => (night === null ? null : night === "onBoard" ? "onBoard" : worldSelection(night))),
    transports: item.transfers.map((transfer) => ({
      day: transfer.day,
      mode: transfer.mode,
      from: worldSelection(transfer.from),
      to: worldSelection(transfer.to),
      departAt: transfer.departAt ?? null,
      arriveAt: transfer.arriveAt ?? null,
      arriveDay: transfer.arriveDay ?? "same",
      ...(transfer.confirmed ? { overnightConfirmed: true as const } : {}),
    })),
    visits: item.visits.map((visit, index) => ({
      key: `v${index + 1}`,
      place: worldSelection(visit.place),
      role: visit.role,
      stayMinutes: visit.stayMinutes ?? 60,
      ...(visit.startsAt ? { startsAt: visit.startsAt, endsAt: visit.endsAt } : {}),
      ...(visit.day ? { day: visit.day } : {}),
    })),
    interests: interests.map((interest) => ({
      id: interest.id, text: interest.text, ...(interest.when ? { when: interest.when } : {}), ...(interest.day ? { day: interest.day } : {}),
    })),
    travel: item.travel as OutingPlanInput["travel"],
  };
  // 住处区域是 V3.3 的输入字段；基线的卡片里没有，这里也就不带。
  return {
    ...input,
    ...(areas.length ? { lodgingAreas: areas } : {}),
    pace: "standard",
    cityAdcode: input.start.place.place.cityAdcode ?? "330100",
  } as OutingInput;
}

export async function runLodgingCase(
  item: LodgingCase,
  policy: Policy,
  models?: { readonly day: () => DayPlanningDecisionModel },
): Promise<LodgingRow> {
  const started = Date.now();
  const world = new V21World(FORECASTS.dry);
  const signal = new AbortController().signal;
  let modelRequests = 0;
  const daySearches: { query: string; kind: string | null }[] = [];
  const decisions = policy === "live" && models ? models.day() : createDayScriptedModel();
  const counting: DayPlanningDecisionModel = {
    ...decisions,
    decide: async (context, options) => {
      modelRequests += 1;
      const reply = await decisions.decide(context, options);
      const decision = reply.decision as { action?: string; actions?: unknown[] } | null;
      for (const item of [decision, ...(Array.isArray(decision?.actions) ? decision.actions : [])]) {
        const action = item as { action?: string; query?: string; kind?: string } | null;
        if (action?.action === "search_places") daySearches.push({ query: action.query ?? "", kind: action.kind ?? null });
      }
      return reply;
    },
  };
  const input = lodgingInput(item);
  const allocation = allocateByRules(input, outingFrames(input));
  let choices: readonly LodgingChoice[] = [];
  let candidates: LodgingRow["candidates"] = [];
  // onLodging 是 V3.3 新加的回调：先放进变量再传，基线的类型里没有它也能编译。
  const options = {
    signal,
    onLodging: (given: readonly LodgingChoice[]) => {
      choices = given;
    },
    onReview: (outcome: OutingReviewOutcome) => {
      candidates = outcome.suggestions.flatMap(({ fix }) => {
        const lodging = fix as unknown as { action: string; nights?: number[]; place?: { externalId: string } };
        return lodging.action === "choose_lodging" ? [{ nights: lodging.nights!, place: lodging.place!.externalId }] : [];
      });
    },
  };
  const generated = await generateOuting(input, allocation, {
    runner: createDayPlanningRunner({ provider: world, model: counting, now: () => V21_NOW }),
    provider: world,
    now: () => V21_NOW,
    weather: forecastLookup(world, signal),
  }, options as OutingGenerateOptions);
  const row = score(item, policy, input, generated, choices, candidates, {
    modelRequests,
    mapRequests: world.searches.length + world.routes + world.details + world.weatherCalls,
    elapsedMs: Date.now() - started,
  });
  return { ...row, daySearches };
}

function score(
  item: LodgingCase,
  policy: Policy,
  input: OutingInput,
  generated: readonly GeneratedDay[],
  choices: readonly LodgingChoice[],
  candidates: LodgingRow["candidates"],
  cost: { readonly modelRequests: number; readonly mapRequests: number; readonly elapsedMs: number },
): LodgingRow {
  const checks: { name: string; passed: boolean }[] = [];
  const check = (name: string, passed: boolean) => checks.push({ name, passed });

  const days = generated.map((entry) => {
    const { result } = entry;
    if (result.status !== "draft") return { day: entry.day, outcome: result.status, stops: [] as string[] };
    const stops = result.parts.flatMap((part) => (part.kind === "plan"
      ? part.draft.activities.map((activity) => idOf(part.draft.places.find((place) => place.placeId === activity.placeId)!.name))
      : []));
    return { day: entry.day, outcome: "draft", stops };
  });
  const dayCount = item.expect.cities.length;
  check("all_days_planned", days.length === dayCount && days.every((day) => day.outcome === "draft"));
  check("right_city", days.every((day) => {
    const allowed = item.expect.cities[day.day - 1];
    return !allowed || day.stops.every((stop) => allowed.includes(cityOf(stop)));
  }));
  // 住宿不能当成一站排进去（“住古镇附近”被当成兴趣时就会这样）。
  check("no_lodging_stop", days.every((day) => day.stops.every((stop) => !isLodging(stop))));

  // 每晚最后住哪：用户给的，加上产品暂定的。
  const nights: (string | null)[] = item.lodging.map((night) => night);
  for (const choice of choices) {
    for (const night of choice.nights) {
      if (nights[night - 1] === null) nights[night - 1] = choice.place?.place.ref.externalId ?? null;
      else if (nights[night - 1] !== choice.place?.place.ref.externalId) nights[night - 1] = `changed:${nights[night - 1]}`;
    }
  }
  item.expect.nights.forEach((expect, index) => {
    const night = index + 1;
    const got = nights[index] ?? null;
    if (expect === "onBoard") check(`night${night}_onboard`, got === "onBoard");
    else if (expect === "none") check(`night${night}_none`, got === null);
    else if ("given" in expect) check(`night${night}_kept`, got === expect.given);
    else if ("same" in expect) check(`night${night}_same`, !!got && got === nights[expect.same - 1]);
    else {
      check(`night${night}_real`, !!got && isLodging(got) && cityOf(got) === expect.city);
      const first = item.expect.nights.findIndex((other) => typeof other === "object" && "segment" in other && other.segment === expect.segment);
      if (first !== index) check(`night${night}_same_segment`, !!got && got === nights[first]);
    }
  });
  if (candidates.length) {
    check("candidates_real", candidates.every((candidate) => {
      const expect = item.expect.nights[candidate.nights[0]! - 1];
      return isLodging(candidate.place) && typeof expect === "object" && "city" in expect && cityOf(candidate.place) === expect.city;
    }));
  }
  if (item.expect.area) {
    const { place, nights: areaNights } = item.expect.area;
    check("near_area", areaNights.every((night) => {
      const got = nights[night - 1];
      return !!got && isLodging(got) && meters(got, place) <= 3000;
    }));
  }
  if (item.expect.unsettledNote) {
    check("unsettled_note", generated.some((day) => {
      const notes = day.result.status === "draft" ? day.result.notes : [day.result.status === "no_plan" ? day.result.explanation : ""];
      return notes.some((note) => note.includes("住处未定"));
    }));
  }

  const estimates = (item.expect.estimated ?? []).map(({ day, index }) => {
    const given = item.transfers.filter((transfer) => transfer.day === day)[index]!;
    const ride = input.transports.filter((transfer) => transfer.day === day)[index]!;
    const entry = generated.find((other) => other.day === day);
    const split = entry?.result.status === "draft" ? entry.result.split.transfers : undefined;
    const timed: TimedTransfer = split?.find((other) => other.transfer.from.place.ref.externalId === given.from &&
      other.transfer.to.place.ref.externalId === given.to) ?? timeTransfer(ride);
    const expected = expectedMinutes(given.mode, given.from, given.to);
    const kept = (!given.departAt || timed.departAt === minutes(given.departAt)) && (!given.arriveAt || timed.arriveAt === minutes(given.arriveAt));
    check(`estimate_day${day}`, kept && Math.abs(timed.arriveAt - timed.departAt - expected) <= 10);
    return { day, minutes: timed.arriveAt - timed.departAt, expected };
  });

  return {
    suite: "lodging",
    caseId: item.id,
    policy,
    heldOut: !!item.heldOut,
    days,
    nights,
    candidates,
    estimates,
    checks,
    passed: checks.every((entry) => entry.passed),
    ...cost,
  };
}
