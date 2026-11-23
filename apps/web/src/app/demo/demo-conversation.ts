import { dayTime, type DayIssue, type DaySchedule } from "@tripquest/domain";
import { readDemoInput, type DemoInput, type DemoTimePrompt } from "./demo-input";
import {
  DEMO_INTERESTS,
  bestTrial,
  coveredInterests,
  demoPlaceName,
  scheduleDemo,
  stopsForInterest,
  tryRemainder,
  type DemoInterest,
  type DemoRequest,
  type DemoStop,
  type DemoTrial,
} from "./demo-schedule";

type Requirements = Pick<DemoRequest, "interests" | "namedStops"> &
  Partial<Pick<DemoRequest, "departure" | "returnBy">> & { booking?: true };

export type DemoPlan = DemoRequest & {
  version: number;
  stops: readonly DemoStop[];
  resumeFrom?: DemoStop;
  schedule: DaySchedule;
  trials: readonly DemoTrial[];
};

type Report = { completedStop?: DemoStop; resumeAt?: number };

export type DemoOffer = {
  base: DemoPlan;
  report: Report;
  next: DemoPlan;
};

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; work?: "adjustment" };

export type DemoConversation = {
  messages: readonly Message[];
  requirements: Requirements;
  plan: DemoPlan | null;
  report: Report;
  requested: { interest?: DemoInterest; returnBy?: number };
  offer: DemoOffer | null;
};

export const FIRST_REQUEST = "10:45 从游客中心出发，想尝尝当地小吃，也想看看当地文化，14:00 有一小时博物馆导览。";
export const LAKE_REQUEST = "10:45 从游客中心出发，想沿湖散步，也想看看当地文化，14:00 有一小时博物馆导览。";
export const TEA_REQUEST = "第一站逛完了，12:50 从这里继续，下一站换成茶馆，导览别动。";
export const LATE_REQUEST = "13:55 才能从这里走，导览别动。";

export function newDemoConversation(): DemoConversation {
  return {
    messages: [],
    requirements: { interests: [], namedStops: [] },
    plan: null,
    report: {},
    requested: {},
    offer: null,
  };
}

export function demoQuestions(requirements: Requirements) {
  return [
    requirements.departure === undefined ? { time: "departure", text: "想几点从游客中心出发？" } : null,
    requirements.interests.length === 0 && requirements.namedStops.length === 0
      ? { time: null, text: "你想尝小吃、沿湖散步，还是看看当地文化？" }
      : null,
    !requirements.booking ? { time: "booking", text: "已预约的博物馆导览几点开始？" } : null,
    requirements.returnBy === undefined ? { time: "returnBy", text: "最晚几点要到松风湖站？" } : null,
  ].filter((question): question is { time: DemoTimePrompt | null; text: string } => question !== null);
}

function reply(state: DemoConversation, text: string, work?: "adjustment"): DemoConversation {
  return { ...state, messages: [...state.messages, { role: "assistant", text, work }] };
}

function addRequirements(state: DemoConversation, input: DemoInput): DemoConversation {
  const before = state.requirements;
  const requirements: Requirements = {
    departure: input.departure ?? before.departure,
    returnBy: input.returnBy ?? before.returnBy,
    interests: [...new Set([...(input.replaceInterests ? [] : before.interests), ...(input.interests ?? [])])],
    namedStops: [...new Set([...before.namedStops, ...(input.namedStops ?? [])])],
    booking: input.booking ?? before.booking,
  };
  const [question] = demoQuestions(requirements);
  return reply(
    { ...state, requirements },
    question ? `我把这次说的条件记下了。${question.text}` : "需求齐了。我可以挑选地点并试排路线。",
  );
}

export function issueText(issues: readonly DayIssue[]) {
  const issue = issues[0];
  if (issue?.code === "day_fixed_late" && issue.actual !== undefined) {
    return `预计 ${dayTime(issue.actual)} 到馆，赶不上 14:00 的导览。`;
  }
  if (issue?.code === "day_window_exceeded" && issue.actual !== undefined) {
    return `预计 ${dayTime(issue.actual)} 到站，超过了你的截止时间。`;
  }
  return "按这些条件排不开。可以提前出发，或放宽最晚到站时间。";
}

export function trialRoute(stops: readonly DemoStop[]) {
  return stops.length ? stops.map(demoPlaceName).join(" → ") : "直接去博物馆";
}

function planFromRequest(request: DemoRequest, version: number) {
  const trials = scheduleDemo(request);
  const best = bestTrial(trials, request.interests);
  if (!best) {
    const result = trials[0]?.result;
    return { issue: issueText(result?.status === "not_scheduled" ? result.issues : []) };
  }

  const plan: DemoPlan = {
    ...request,
    version,
    stops: best.stops,
    schedule: best.schedule,
    trials,
  };
  const chosen = trialRoute(plan.stops);
  const covered = coveredInterests(plan.stops, request.interests);
  const omitted = request.interests.filter((interest) => !covered.includes(interest));
  const rundown = `试排了 ${trials.length} 条走法，选了${chosen}。全程步行 ${plan.schedule.totalWalkingMinutes} 分钟，14:00 参加导览，预计 ${dayTime(plan.schedule.endArrival)} 到站。`;
  const tradeoff = omitted.length ? `这次先给导览和返程留足时间，${omitted.map((interest) => DEMO_INTERESTS[interest]).join("、")}暂缓。` : "";
  return { plan, summary: rundown + tradeoff };
}

export function generateDemo(state: DemoConversation): DemoConversation {
  const { departure, returnBy, interests, namedStops } = state.requirements;
  if (state.plan || departure === undefined || returnBy === undefined || demoQuestions(state.requirements).length) {
    return state;
  }

  const result = planFromRequest({ departure, returnBy, interests, namedStops }, 1);
  return result.plan
    ? reply({ ...state, plan: result.plan }, `排好了。${result.summary}`)
    : reply(state, result.issue);
}

function preview(state: DemoConversation, base: DemoPlan, next: DemoPlan, message: string) {
  const offer = { base, report: state.report, next };
  return reply({ ...state, offer }, message, "adjustment");
}

function previewRemainder(state: DemoConversation, base: DemoPlan, from: DemoStop, resumeAt: number) {
  const returnBy = state.requested.returnBy ?? base.returnBy;
  const interest = state.requested.interest;
  const alternatives = interest ? stopsForInterest(interest).filter((id) => id !== from) : [base.stops[1] ?? null];
  const trials = alternatives.map((stop) => tryRemainder(from, resumeAt, returnBy, stop));
  const best = bestTrial(trials, interest ? [interest] : []);

  if (!best) {
    const direct = tryRemainder(from, resumeAt, returnBy, null).result;
    const issue = direct.status === "not_scheduled" ? direct.issues[0] : undefined;
    if (issue?.code === "day_fixed_late" && issue.actual !== undefined) {
      return reply(
        state,
        `从${demoPlaceName(from)}直接去博物馆也要到 ${dayTime(issue.actual)}，会错过 14:00 的导览。当前方案已保留，可以提前继续时间再试。`,
        "adjustment",
      );
    }
    return reply(
      state,
      issue?.code === "day_window_exceeded"
        ? `${issueText([issue])} 当前方案已保留，可以放宽到站时间再试。`
        : "这个时段排不开你要的站点、导览和到站截止。当前方案已保留。",
      "adjustment",
    );
  }

  const next: DemoPlan = {
    ...base,
    version: base.version + 1,
    returnBy,
    stops: [from, ...best.stops],
    namedStops: interest ? base.namedStops.filter((id) => id === from) : base.namedStops,
    resumeFrom: from,
    schedule: best.schedule,
    trials,
  };
  const route = best.stops.length ? `先去${trialRoute(best.stops)}` : "直接去博物馆";
  return preview(
    state,
    base,
    next,
    `从${demoPlaceName(from)} ${dayTime(resumeAt)} 继续，${route}。14:00–15:00 的导览照旧，请确认这个调整。`,
  );
}

function adjust(state: DemoConversation, base: DemoPlan, input: DemoInput) {
  const describesRemainder = input.resumeAt !== undefined || input.completedFirst || input.replacement;
  if (input.departure !== undefined && (state.report.completedStop || describesRemainder)) {
    return reply(state, "已经开始出游。告诉我几点从当前位置继续，我会重排后半段。");
  }

  if (describesRemainder || state.report.completedStop) {
    const first = base.stops[0];
    if (!first) return reply(state, "当前行程从游客中心直接去导览。可以调整出发或到站时间。");
    if (input.replacementTarget && input.replacementTarget !== base.stops[1]) {
      return reply(state, "请按当前方案的下一站提出替换，也可以直接说「下一站换成茶馆」。");
    }
    if (input.namedStops?.length || (input.interests?.length ?? 0) > 1) {
      return reply(state, "途中可以按一个兴趣重选下一站。可以试试「下一站换成茶馆」。");
    }
    if (input.atMarket && first !== "market") {
      return reply(state, `当前方案第一站是${demoPlaceName(first)}，请按实际走过的站点报告进度。`);
    }
    if (input.resumeAt !== undefined && input.resumeAt < base.departure) {
      return reply(state, "继续时间早于原行程的出发时间。请再确认一下时间。");
    }

    const report = {
      completedStop: input.completedFirst ? first : state.report.completedStop,
      resumeAt: input.resumeAt ?? state.report.resumeAt,
    };
    const requested = {
      interest: input.replacement ?? input.interests?.[0] ?? state.requested.interest,
      returnBy: input.returnBy ?? state.requested.returnBy,
    };
    const updated = { ...state, report, requested };
    if (!report.completedStop) return reply(updated, `${demoPlaceName(first)}已经逛完了吗？确认后我可以从这里重排。`);
    if (report.resumeAt === undefined) return reply(updated, `已记下${demoPlaceName(first)}逛完了。你想几点继续？`);
    if (!requested.interest && requested.returnBy === undefined && input.resumeAt === undefined && !base.resumeFrom) {
      return reply(updated, "已记下第一站逛完了。接下来想换一站，还是调整继续时间？");
    }
    return previewRemainder(updated, base, report.completedStop, report.resumeAt);
  }

  if (input.departure === undefined && input.returnBy === undefined && !input.interests?.length && !input.namedStops?.length) {
    return reply(state, "你可以换个兴趣再试排，也可以调整出发或到站时间。");
  }

  const request = {
    departure: input.departure ?? base.departure,
    returnBy: input.returnBy ?? base.returnBy,
    interests: input.interests ? [...new Set(input.interests)] : base.interests,
    namedStops: [...new Set([...base.namedStops, ...(input.namedStops ?? [])])],
  };
  const result = planFromRequest(request, base.version + 1);
  return result.plan
    ? preview(state, base, result.plan, result.summary)
    : reply(state, result.issue, "adjustment");
}

export function sendDemoMessage(state: DemoConversation, raw: string): DemoConversation {
  const text = raw.trim();
  if (!text) return state;
  const next: DemoConversation = {
    ...state,
    offer: null,
    messages: [...state.messages, { role: "user", text }],
  };
  const waitingFor = state.plan
    ? state.report.completedStop && state.report.resumeAt === undefined ? "resumeAt" : null
    : demoQuestions(state.requirements)[0]?.time ?? null;
  const result = readDemoInput(text, waitingFor);

  if (result.kind === "booking") return reply(next, "这场示例的导览已预约在 14:00–15:00。你可以调整出发时间或其他站点。");
  if (result.kind === "unknown") {
    return reply(next, state.plan
      ? "可以试着换个兴趣、调整时间或发送途中调整示例。"
      : "可以告诉我出发时间、喜欢的小吃或活动，以及最晚到站时间。下方示例可以直接编辑。");
  }

  const { input } = result;
  if (!state.plan && (input.completedFirst || input.replacement || input.resumeAt !== undefined)) {
    return reply(next, "先完成需求卡，生成一份行程，再试着调整剩余的站点。");
  }
  return state.plan ? adjust(next, state.plan, input) : addRequirements(next, input);
}

export function decideDemoOffer(state: DemoConversation, offer: DemoOffer, accept: boolean): DemoConversation {
  if (state.offer !== offer || state.plan !== offer.base || state.report !== offer.report) return state;
  return reply(
    { ...state, offer: null, requested: {}, plan: accept ? offer.next : offer.base },
    accept ? "已采用调整。导览保留在 14:00–15:00。" : "已保留原方案。",
  );
}

export function trialText(trial: DemoTrial) {
  const { result } = trial;
  if (result.status === "not_scheduled") return issueText(result.issues);
  const museum = result.schedule.activities.find(({ activityId }) => activityId === "museum")!;
  return `步行共 ${result.schedule.totalWalkingMinutes} 分钟，预计 ${dayTime(museum.arrivesAt)} 到馆，赶得上 14:00 导览。`;
}
