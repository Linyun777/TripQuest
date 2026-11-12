import { z } from "zod";
import type { ModelReply } from "./contracts";
import { DecisionModelError } from "./contracts";
import { hasPrivateNumber } from "@tripquest/application/preferences";
import type { GeneratedDay, OutingInput } from "./outing-generate";
import { stopsOf } from "./outing-review";
import { clock } from "@tripquest/application/transfer-day";

/**
 * V4.7 出游整体判断（stages/V4.7.md §3.1–3.3）：一趟排完后，单步模型对照需求清单（卡片、长期偏好、用户原话）判断“合不合要求、
 * 排得好不好”，代码校验防编造。时间、可达、固定事项、车次仍由代码校验，这里不判断（AGENTS §4）。发给模型的只有编号、名称、
 * 时刻、数字，不含坐标地址（D-045/D-046）；用户原话只送模型、不存。
 */
export const JUDGE_PROMPT_VERSION = "outing-judge.v1";

/** 一条需求。scope：stop 要落到站点上（兴趣、必去、想去）；trip 是整趟的（节奏、备注、长期偏好），满足时可以只给天。 */
export const judgeNeedSchema = z.strictObject({
  id: z.string().regex(/^[np]\d{1,2}$/),
  source: z.enum(["card", "saved"]),
  kind: z.enum(["interest", "must", "want", "pace", "notes", "preference"]),
  scope: z.enum(["stop", "trip"]),
  text: z.string().min(1).max(200),
});
export type JudgeNeed = z.infer<typeof judgeNeedSchema>;

const clockText = z.string().regex(/^\d{2}:\d{2}$/);
export const judgeInputSchema = z.strictObject({
  needs: z.array(judgeNeedSchema).max(40),
  /** 这段对话最近的用户消息（最多 10 条、1500 字）。 */
  said: z.array(z.string().max(1500)).max(10),
  days: z.array(z.strictObject({
    day: z.number().int().min(1).max(7),
    date: z.iso.date(),
    lodging: z.string().max(80).optional(),
    weather: z.string().max(40).optional(),
    stops: z.array(z.strictObject({
      /** 整趟唯一的站点编号（s1…）。 */
      ref: z.string().regex(/^s\d{1,3}$/),
      name: z.string().max(80),
      from: clockText,
      to: clockText,
      type: z.string().max(20).optional(),
      outdoor: z.boolean(),
      /** 从上一站过来的路上要几分钟（当天第一站没有）。 */
      travelMinutes: z.number().int().min(0).optional(),
    })).max(16),
    transfers: z.array(z.strictObject({
      mode: z.string().max(10),
      from: z.string().max(80),
      to: z.string().max(80),
      departAt: clockText,
      arriveAt: clockText,
    })).max(4),
  })).min(1).max(7),
  /** 代码已经找到的问题（一句话），模型不用重复。 */
  found: z.array(z.string().max(120)).max(30),
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

const NEED_STATUS = ["met", "partly", "unmet", "unknown"] as const;
const ISSUE_KINDS = ["pace", "monotony", "meal", "detour", "mismatch"] as const;
const note = z.string().max(200).catch("");
const dayList = z.array(z.number().int()).max(14).catch([]);
const stopList = z.array(z.string().max(10)).max(20).catch([]);

/** 模型的原始回答：形状不对才算不合格（条数、编号的对错由 validateJudgment 处理）。 */
export const judgeOutputSchema = z.object({
  overall: z.number().int().min(1).max(5),
  summary: z.string().min(1).max(200),
  needs: z.array(z.object({ id: z.string().max(10), status: z.enum(NEED_STATUS), days: dayList.default([]), stops: stopList.default([]), note: note.default("") })).max(45),
  extra: z.array(z.object({ quote: z.string().max(200), text: z.string().max(200), status: z.enum(NEED_STATUS), days: dayList.default([]), stops: stopList.default([]), note: note.default("") })).max(10).default([]),
  issues: z.array(z.object({
    kind: z.enum(ISSUE_KINDS),
    severity: z.enum(["minor", "major"]),
    day: z.number().int(),
    stops: stopList.default([]),
    // 模型常把用不上的 need 写成 null（开思考时整份回答因此被拒），当作没写。
    need: z.string().max(10).nullish(),
    note: note.default(""),
  })).max(12).default([]),
});
export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export type NeedStatus = (typeof NEED_STATUS)[number];
export type JudgeIssueKind = (typeof ISSUE_KINDS)[number];

/** 校验之后的判断：需求逐条都有状态，引用的天和站点都真在方案上。 */
export interface Assessment {
  readonly overall: number;
  readonly summary: string;
  readonly needs: readonly (JudgeNeed & { readonly status: NeedStatus; readonly days: readonly number[]; readonly stops: readonly string[]; readonly note: string })[];
  readonly extra: readonly { readonly quote: string; readonly text: string; readonly status: NeedStatus; readonly days: readonly number[]; readonly stops: readonly string[]; readonly note: string }[];
  readonly issues: readonly { readonly kind: JudgeIssueKind; readonly severity: "minor" | "major"; readonly day: number; readonly stops: readonly string[]; readonly need?: string; readonly note: string }[];
  /** 校验时改掉或丢掉的（评测和运行记录看）。 */
  readonly corrected: { readonly downgraded: number; readonly droppedExtra: number; readonly droppedIssues: number; readonly missingNeeds: number };
}

/** 吃饭、喝东西的站：不算“连续同类”，午饭晚饭只认餐厅。 */
const MEAL_TYPE = /餐|小吃|食/;
const BREAK_TYPE = /餐|小吃|食|咖啡|茶|酒吧|甜品/;
/** 笼统的类型看不出是不是同一类（高德的“风景名胜”就是一大类），不算连续同类。 */
const GENERIC_TYPE = /^(景点|风景名胜|其他|)$/;
const MONOTONY_STOPS = 3;
const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** 高德分类码（可能用 | 连着几个）和名字换成中文类型：分类码打底；寺庙、古镇、塔在高德上多半是笼统的“风景名胜”，按名字细化。 */
export function stopTypeLabel(categoryCode: string | undefined, name: string): string {
  const code = (categoryCode ?? "").split("|")[0] ?? "";
  if (code.startsWith("0505")) return "咖啡厅";
  if (code.startsWith("0506")) return "茶馆";
  if (code.startsWith("0507") || code.startsWith("0508")) return "甜品";
  if (code.startsWith("05")) return "餐厅";
  if (code === "080304") return "酒吧";
  if (code.startsWith("1401")) return "博物馆";
  if (code.startsWith("1402") || code.startsWith("1403")) return "展览馆";
  if (code.startsWith("1404")) return "美术馆";
  if (code.startsWith("1101")) return "公园";
  if (code.startsWith("0610")) return "步行街";
  if (code.startsWith("06")) return "商场";
  if (/寺|禅院|庵$|道观/.test(name)) return "寺庙";
  if (/古镇/.test(name)) return "古镇";
  if (code.startsWith("11")) return "景点";
  return "";
}

export type StopTyper = (name: string, categoryCode: string | undefined) => string;

const inRange = (time: string, from: string, to: string) => minuteOf(time) >= minuteOf(from) && minuteOf(time) <= minuteOf(to);

/**
 * 饭点和连续同类由代码按类型和时刻算（V4.7 闸门第一次没过之后用户定，stages/V4.7.md §3.2）：模型判这两类时严重程度来回变，
 * 提示词补一句还会影响别处。规划器没被要求就不排吃饭，所以当天没有餐厅不算问题；排了餐厅、午饭却晚到 14 点以后（上午就出门的
 * 一天）才算。中间夹着吃饭的也算连着，三站同一类算连续同类。
 */
export function codeIssues(input: JudgeInput): Assessment["issues"] {
  const issues: Assessment["issues"][number][] = [];
  for (const day of input.days) {
    const meals = day.stops.filter((stop) => MEAL_TYPE.test(stop.type ?? ""));
    const before11 = day.stops.some((stop) => minuteOf(stop.from) < minuteOf("11:00"));
    const late = meals.find((stop) => minuteOf(stop.from) > minuteOf("14:00") && minuteOf(stop.from) < minuteOf("17:00"));
    if (before11 && late && !meals.some((stop) => inRange(stop.from, "11:00", "14:00"))) {
      issues.push({ kind: "meal", severity: "major", day: day.day, stops: [late.ref], note: `午饭 ${late.from} 才开始` });
    }
    const sights = day.stops.filter((stop) => !BREAK_TYPE.test(stop.type ?? ""));
    let start = 0;
    for (let index = 1; index <= sights.length; index += 1) {
      if (index < sights.length && sights[index]!.type === sights[start]!.type) continue;
      const type = sights[start]!.type ?? "";
      if (index - start >= MONOTONY_STOPS && !GENERIC_TYPE.test(type)) {
        issues.push({ kind: "monotony", severity: "major", day: day.day, stops: sights.slice(start, index).map((stop) => stop.ref), note: `连着 ${index - start} 站都是${type}` });
      }
      start = index;
    }
  }
  return issues;
}

const MAX_EXTRA = 3;
const MAX_ISSUES = 4;

/** 代码校验（§3.3）：清单外的编号丢掉，没判断的记 unknown，引用不存在的去掉，“满足”却引用不到实际内容的降成 unknown。 */
export function validateJudgment(output: JudgeOutput, input: JudgeInput): Assessment {
  const allDays = new Set(input.days.map((day) => day.day));
  const allStops = new Map(input.days.flatMap((day) => day.stops.map((stop) => [stop.ref, day.day] as const)));
  const realDays = (days: readonly number[]) => [...new Set(days)].filter((day) => allDays.has(day));
  const realStops = (stops: readonly string[]) => [...new Set(stops)].filter((stop) => allStops.has(stop));
  let downgraded = 0;
  const settle = (status: NeedStatus, days: readonly number[], stops: readonly string[], scope: "stop" | "trip"): NeedStatus => {
    if (status !== "met" || stops.length || (scope === "trip" && days.length)) return status;
    downgraded += 1;
    return "unknown";
  };
  const seen = new Map<string, JudgeOutput["needs"][number]>();
  for (const item of output.needs) if (!seen.has(item.id)) seen.set(item.id, item);
  let missingNeeds = 0;
  const needs = input.needs.map((need) => {
    const answer = seen.get(need.id);
    if (!answer) {
      missingNeeds += 1;
      return { ...need, status: "unknown" as const, days: [], stops: [], note: "" };
    }
    const days = realDays(answer.days);
    const stops = realStops(answer.stops);
    return { ...need, status: settle(answer.status, days, stops, need.scope), days, stops, note: answer.note };
  });
  const said = input.said.join("\n");
  const validExtra = output.extra.filter((item) => item.quote.trim().length >= 2 && said.includes(item.quote));
  const extra = validExtra.slice(0, MAX_EXTRA).map((item) => {
    const days = realDays(item.days);
    const stops = realStops(item.stops);
    return { quote: item.quote, text: item.text, status: settle(item.status, days, stops, "trip"), days, stops, note: item.note };
  });
  const needIds = new Set(input.needs.map((need) => need.id));
  const validIssues = output.issues.flatMap((issue) => {
    // 饭点和连续同类只由代码给（模型照写也不要）。
    if (issue.kind === "meal" || issue.kind === "monotony") return [];
    if (!allDays.has(issue.day)) return [];
    if (issue.kind === "mismatch" && !(issue.need && needIds.has(issue.need))) return [];
    // 指到的站点要真在这一天；一个都对不上的不算（整天的问题可以不指站点）。
    const stops = realStops(issue.stops).filter((stop) => allStops.get(stop) === issue.day);
    if (issue.stops.length && !stops.length) return [];
    const { need, ...rest } = issue;
    return [{ ...rest, stops, ...(need && needIds.has(need) ? { need } : {}) }];
  });
  // 重要的问题排前面，超出条数时先留下它们。
  const issues = [...codeIssues(input), ...validIssues].sort((a, b) => Number(b.severity === "major") - Number(a.severity === "major")).slice(0, MAX_ISSUES);
  return {
    overall: output.overall,
    summary: output.summary,
    needs,
    extra,
    issues,
    corrected: {
      downgraded,
      droppedExtra: output.extra.length - extra.length,
      droppedIssues: output.issues.length - validIssues.length,
      missingNeeds,
    },
  };
}

export type JudgeRequest = (system: string, content: string, signal: AbortSignal) => Promise<ModelReply>;

export const JUDGE_SYSTEM_PROMPT = `You judge whether a multi-day trip in China, already planned, fits what this traveller wants and is pleasant as a whole.
Opening hours, reachability, fixed appointments and train times are already checked by code: never comment on them.
Input: "needs" (what the traveller asked for, each with an id; scope "trip" means it applies to the whole trip), "said" (the traveller's own recent words),
"days" (each day's stops in order, with times, type, travelMinutes from the previous stop, lodging, weather, and train or flight transfers), "found" (problems code already found; do not repeat them).
Answer with one JSON object and nothing else:
{"overall":1-5,"summary":"one sentence in Chinese",
"needs":[{"id","status":"met|partly|unmet|unknown","days":[1],"stops":["s1"],"note":"short Chinese fact"}],
"extra":[{"quote","text","status","days","stops","note"}],
"issues":[{"kind":"pace|detour|mismatch","severity":"minor|major","day":1,"stops":["s1"],"need":"n1","note":"short Chinese fact"}]}
Needs:
- Give every id in "needs" one entry.
- Judge only from what is given. If the stop's name and type cannot show it (spicy or not, cheap or not, quiet or not, tasty or not, has seats or not), the status is "unknown", even if the stop looks like the right kind of place.
- "met": name the stops that do it. For something to avoid ("no temples"), "met" means no stop conflicts; give the days you checked and no stops.
- A named kind of food, activity or place counts only if a stop's name or type shows that kind; another kind of restaurant or place does not count, so if none shows it the status is "unmet".
- "unmet": nothing on the trip does it, or a stop goes against it. A need for every day or night that is missing on some of them is "unmet"; list those days.
- "partly": done only in part for another reason, or done at the wrong time of day.
"extra": only a requirement the traveller said in "said" that no entry in "needs" covers (the same wish in other words is a repeat: leave it out), and that this trip can be judged against; at most 3, and most trips have none. "quote" must be copied word for word from "said". Skip logistics such as where they start.
Issues (the plan as a whole, at most 4):
- pace: too packed for the traveller's pace, or a very long day.
- detour: going back and forth, with long trips between stops that could have been ordered better.
- mismatch: a stop that goes against a need; "need" is its id.
"major" means the traveller would clearly want it changed; "minor" is a small flaw. A plan with nothing wrong has no issues: do not invent any, and do not mention preferences the traveller did not state.
"note" states only facts from the input, no advice.`;

/** 一次判断：结构不合格时带着错误再要一次，仍不合格或模型出错时为 null（跳过判断，流程照旧，§3.3）。 */
export async function judgeOuting(request: JudgeRequest, input: JudgeInput, signal: AbortSignal): Promise<Assessment | null> {
  const content = JSON.stringify(input);
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: ModelReply;
    try {
      reply = await request(JUDGE_SYSTEM_PROMPT, feedback ? `${content}\n\nYour last answer was not valid: ${feedback}. Answer with the JSON object only.` : content, signal);
    } catch (error) {
      if (error instanceof DecisionModelError && error.code === "invalid_output" && attempt === 0) {
        feedback = "not a complete JSON object";
        continue;
      }
      return null;
    }
    const parsed = judgeOutputSchema.safeParse(reply.decision);
    if (parsed.success) return validateJudgment(parsed.data, input);
    feedback = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  return null;
}

/** 判断用的材料：输入，以及站点编号、需求编号各对应卡片上的哪一项（交给审查-修复时用）。 */
export interface JudgeMaterial {
  readonly input: JudgeInput;
  readonly stopItems: ReadonlyMap<string, string>;
  readonly needItems: ReadonlyMap<string, string>;
}

const SAID_MESSAGES = 10;
const SAID_CHARS = 1500;

/** 用户原话（§3.1）：最近 10 条，最多 1500 字（超了丢更早的），含手机号、证件号的不带。 */
export function judgeSaid(messages: readonly string[]): string[] {
  const kept: string[] = [];
  let total = 0;
  for (const text of [...messages].filter((message) => !hasPrivateNumber(message)).slice(-SAID_MESSAGES).reverse()) {
    if (total + text.length > SAID_CHARS) break;
    total += text.length;
    kept.unshift(text);
  }
  return kept;
}

/** 需求清单和方案（§3.1–3.2）：卡片的兴趣、必去、想去、节奏、备注，加长期偏好；每天的站只有编号、名称、时刻、类型和数字。 */
export function judgeMaterial(input: OutingInput, days: readonly GeneratedDay[], stopType?: StopTyper): JudgeMaterial {
  const needs: JudgeNeed[] = [];
  const needItems = new Map<string, string>();
  const add = (need: Omit<JudgeNeed, "id" | "source">, item?: string) => {
    const id = `n${needs.filter((entry) => entry.source === "card").length + 1}`;
    needs.push({ id, source: "card", ...need });
    if (item) needItems.set(id, item);
  };
  for (const interest of input.interests) add({ kind: "interest", scope: "stop", text: interest.text.slice(0, 200) }, interest.id);
  for (const visit of input.visits) {
    add({ kind: visit.role === "optional" ? "want" : "must", scope: "stop", text: visit.place.place.name.slice(0, 200) }, visit.key);
  }
  add({ kind: "pace", scope: "trip", text: `节奏：${input.pace === "relaxed" ? "轻松" : "标准"}` });
  if (input.notes) add({ kind: "notes", scope: "trip", text: input.notes.slice(0, 200) });
  (input.preferences ?? []).slice(0, 10).forEach((text, index) => {
    needs.push({ id: `p${index + 1}`, source: "saved", kind: "preference", scope: "trip", text: text.slice(0, 200) });
  });
  const stopItems = new Map<string, string>();
  let next = 0;
  const label = stopType ?? ((name: string, code: string | undefined) => stopTypeLabel(code, name));
  const judged = judgeInputSchema.parse({
    needs,
    said: judgeSaid(input.said ?? []),
    found: [],
    days: days.map((day) => {
      const lodging = input.lodging[day.day - 1];
      const weather = Object.values(day.weather ?? {}).map((item) => item.dayWeather).join("、").slice(0, 40);
      return {
        day: day.day,
        date: day.date,
        ...(lodging && lodging !== "onBoard" ? { lodging: lodging.place.name.slice(0, 80) } : {}),
        ...(weather ? { weather } : {}),
        stops: stopsOf(input, day).slice(0, 16).map((stop) => {
          next += 1;
          const ref = `s${next}`;
          if (stop.ref) stopItems.set(ref, stop.ref);
          const type = label(stop.name, stop.categoryCode);
          return {
            ref,
            name: stop.name.slice(0, 80),
            from: clock(stop.startsAt),
            to: clock(stop.endsAt),
            ...(type ? { type } : {}),
            outdoor: stop.outdoor,
            ...(stop.travelMinutes === undefined ? {} : { travelMinutes: stop.travelMinutes }),
          };
        }),
        transfers: day.result.status !== "draft" ? [] : day.result.parts.flatMap((part) => (part.kind !== "transfer" ? [] : [{
          mode: part.mode,
          from: part.from.slice(0, 80),
          to: part.to.slice(0, 80),
          departAt: clock(part.departAt),
          arriveAt: clock(part.arriveAt),
        }])),
      };
    }),
  });
  return { input: judged, stopItems, needItems };
}

/** 判断结果里要修的（§3.4）：没满足的需求和严重问题；部分满足、轻微的只显示。 */
export interface JudgeProblem {
  readonly id: string;
  readonly kind: "unmet_need" | "quality";
  readonly issue?: JudgeIssueKind;
  readonly days: readonly number[];
  readonly text: string;
  readonly note: string;
  /** 涉及卡片上的哪些项（v、i 编号）。 */
  readonly items: readonly string[];
}

const MAX_PROBLEMS = 6;

export function judgeProblems(assessment: Assessment, material: JudgeMaterial): JudgeProblem[] {
  const itemsOf = (stops: readonly string[], need?: string) => [...new Set([
    ...(need && material.needItems.get(need) ? [material.needItems.get(need)!] : []),
    ...stops.flatMap((stop) => (material.stopItems.get(stop) ? [material.stopItems.get(stop)!] : [])),
  ])];
  const unmet = assessment.needs.filter((need) => need.status === "unmet");
  const raw: Omit<JudgeProblem, "id">[] = [
    ...unmet.map((need) => ({ kind: "unmet_need" as const, days: need.days, text: need.text, note: need.note, items: itemsOf(need.stops, need.id) })),
    ...assessment.extra.filter((item) => item.status === "unmet").map((item) => ({ kind: "unmet_need" as const, days: item.days, text: item.text, note: item.note, items: itemsOf(item.stops) })),
    // 冲突的那一条已经作为没满足的需求列出时不重复。
    ...assessment.issues.filter((issue) => issue.severity === "major" && !(issue.kind === "mismatch" && unmet.some((need) => need.id === issue.need)))
      .map((issue) => ({ kind: "quality" as const, issue: issue.kind, days: [issue.day], text: issue.kind, note: issue.note, items: itemsOf(issue.stops, issue.need) })),
  ];
  return raw.slice(0, MAX_PROBLEMS).map((problem, index) => ({ id: `q${index + 1}`, ...problem }));
}

export const JUDGE_RECHECK_PROMPT = `You compare part of a trip in China before and after a change, to see whether one specific problem is gone.
Input: "problem" (what was wrong), "needs" and "said" (what the traveller wants), "before" and "after" (the affected days).
Answer with one JSON object only: {"resolved":true|false,"newProblem":true|false}.
"resolved": the problem no longer applies after the change. "newProblem": the change clearly goes against something in "needs" or "said" that was fine before; a small shift of times is not a new problem.`;

const recheckOutputSchema = z.object({ resolved: z.boolean(), newProblem: z.boolean() });
export interface JudgeVerdict {
  readonly resolved: boolean;
  readonly newProblem: boolean;
}

/**
 * 一次试排解决了这条问题没有（§3.4）。饭点、连续同类由代码算，不问模型；其余问一次模型，出错或不合格时为 null（当没解决）。
 * 代码能看出的新问题（这几天的饭点、连续同类变多）总是算新问题。
 */
export async function recheckProblem(
  request: JudgeRequest,
  problem: JudgeProblem,
  before: JudgeInput,
  after: JudgeInput,
  affected: readonly number[],
  signal: AbortSignal,
): Promise<(JudgeVerdict & { readonly asked: boolean }) | null> {
  const onDays = (input: JudgeInput) => codeIssues(input).filter((issue) => affected.includes(issue.day));
  const newByCode = onDays(after).length > onDays(before).length;
  if (problem.issue === "meal" || problem.issue === "monotony") {
    const still = codeIssues(after).some((issue) => issue.kind === problem.issue && problem.days.includes(issue.day));
    return { resolved: !still, newProblem: newByCode, asked: false };
  }
  const days = (input: JudgeInput) => input.days.filter((day) => affected.includes(day.day));
  try {
    const reply = await request(JUDGE_RECHECK_PROMPT, JSON.stringify({
      problem: { text: problem.text, note: problem.note },
      needs: after.needs.map((need) => need.text),
      said: after.said,
      before: days(before),
      after: days(after),
    }), signal);
    const parsed = recheckOutputSchema.safeParse(reply.decision);
    return parsed.success ? { ...parsed.data, newProblem: parsed.data.newProblem || newByCode, asked: true } : null;
  } catch {
    return null;
  }
}

/** 给方案页和消息体的总评和清单（§3.6）：只有说明，不带原话和分数。 */
export interface AssessmentView {
  readonly summary: string;
  readonly items: readonly { readonly text: string; readonly status: NeedStatus; readonly note: string }[];
  readonly issues: readonly { readonly day: number; readonly severity: "minor" | "major"; readonly note: string }[];
}

export function assessmentView(assessment: Assessment): AssessmentView {
  return {
    summary: assessment.summary.slice(0, 200),
    items: [
      ...assessment.needs.filter((need) => need.kind !== "pace" || need.status !== "unknown"),
      ...assessment.extra,
    ].slice(0, 20).map((item) => ({ text: item.text.slice(0, 80), status: item.status, note: item.note.slice(0, 120) })),
    issues: assessment.issues.map((issue) => ({ day: issue.day, severity: issue.severity, note: issue.note.slice(0, 120) })),
  };
}
