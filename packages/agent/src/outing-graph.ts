import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { RequirementsDraft } from "@tripquest/application/conversation";
import { checkAllocation, lodgingSegments, outingFrames, type Allocation, type OutingPlanInput } from "@tripquest/application/outing-allocation";
import type { SuggestionFix } from "@tripquest/application/outing-review-contract";
import { inAgent } from "./agents/run-agent";
import { runOutingAllocator, type AllocateOptions, type AllocationResult } from "./outing-allocate";
import {
  changePlan,
  resolveOutingChange,
  type AdoptedChange,
  type OutingChangeDependencies,
  type OutingChangePlan,
  type OutingChangeRequest,
  type OutingProgress,
  type ResolvedChange,
} from "./outing-change";
import {
  outingSegmentBudget,
  planOutingDay,
  type GeneratedDay,
  type OutingDependencies,
  type OutingGenerateOptions,
  type OutingInput,
} from "./outing-generate";
import { chooseLodging, LODGING_SEARCHES_PER_STAY, lodgingSuggestions, type LodgingChoice } from "./outing-lodging";
import {
  checkFixes,
  fixKey,
  fixNote,
  improved,
  movedAllocation,
  proposeFixes,
  reviewContext,
  reviewFindings,
  reviewScore,
  suggestionKey,
  suggestionText,
  type CheckedFixes,
  type ReviewFix,
  type ReviewScore,
} from "./outing-review";
import { currentRun } from "./runs";

/**
 * V3.1 出游总控（stages/V3.1.md §3）：一张 StateGraph，三个入口（分配、生成、改动），共用逐天规划的节点。
 * 路由全由代码决定，不问模型。图里各节点调用的还是原来的分配、一日规划、固定交通切段和改动换算，结果不变；
 * 变的只是谁来编排。
 *
 * V3.2 审查（stages/V3.2.md §3.1）：排完以后走 review：代码找问题，有问题才问审查 Agent；通过检查的直接修改由
 * apply_fixes 换成新的分配、把受影响的天放回待排，复用逐天节点重排，回到 review 比较前后，变好才留下、否则退回；
 * 最多两轮。其余修改作为建议交给用户。
 *
 * V3.3 住处（stages/V3.3.md §3.4）：生成时 prepare 之后走 lodging，给住处没定的连住段定一家（代码按高德结果选），
 * 写进这次的输入，各天按它排；排完给每段 2 个可换的候选，和审查的建议放在一起。已经定过的（卡片上有）不再选。
 *
 * 状态只放可序列化的最小业务数据（要排的天、每天的结果状态、排除列表、分配、审查的修改和建议、停止原因）；规划
 * 输入、依赖、回调和每天的完整结果放在这一次调用的上下文里（图按每次调用建，和一日规划图一样）。
 */
/** V3.2：排完审查，缺省开（审查评测达到 §4.2 通过标准后切换）；OUTING_REVIEW=off 关掉。 */
export function outingReview(environment: Readonly<Record<string, string | undefined>> = process.env): "on" | "off" {
  return environment.OUTING_REVIEW === "off" ? "off" : "on";
}

/** 审查的结果（交给页面：直接改了什么、给用户的建议）。 */
export interface OutingReviewOutcome {
  readonly rounds: number;
  readonly applied: readonly { readonly action: string; readonly note: string }[];
  /** 改了、但重排后没变好退回的修改条数。 */
  readonly reverted: number;
  /** V3.3：也有代码给的换住处（choose_lodging）。 */
  readonly suggestions: readonly { readonly fix: SuggestionFix; readonly text: string }[];
  /** 审查后的分到各天（直接改过时和原来的不同；页面要把卡片上的分配换成它）。 */
  readonly allocation: Allocation;
}

/** 审查最多改两轮（§3.1）。 */
const REVIEW_ROUNDS = 2;

type Phase = "allocate" | "generate" | "change";
export interface OutingDayRecord {
  readonly day: number;
  readonly status: GeneratedDay["result"]["status"] | "skipped";
  readonly reason?: string;
}

const OutingState = Annotation.Root({
  phase: Annotation<Phase>(),
  /** 还要排的天（按日期先后）。 */
  pending: Annotation<number[]>(),
  current: Annotation<number | null>(),
  days: Annotation<OutingDayRecord[]>(),
  /** 前几天按兴趣新找到的地点（高德编号），后面的天不再用。 */
  exclude: Annotation<string[]>(),
  /** 现在用的分到各天（审查直接改了会换）。 */
  allocation: Annotation<Allocation | null>(),
  allocationProblems: Annotation<string[]>(),
  /** 审查已经改了几轮；trial 是这一轮改了哪几天、改之前的分数和分配（重排后比较，不好就退回）。 */
  round: Annotation<number>(),
  trial: Annotation<{ days: number[]; before: ReviewScore; allocation: Allocation; fixes: ReviewFix[] } | null>(),
  applied: Annotation<{ action: string; note: string }[]>(),
  reverted: Annotation<number>(),
  /** 试过、没变好退回的修改（不再接受同一条）。 */
  tried: Annotation<string[]>(),
  suggestions: Annotation<ReviewFix[]>(),
  reviewed: Annotation<boolean>(),
  stop: Annotation<"cancelled" | "budget_exhausted" | null>(),
  status: Annotation<"running" | "needs_user" | "completed" | "refused">(),
});
type State = typeof OutingState.State;

/** 这一次调用的上下文：输入、依赖、回调、每天的完整结果（不进状态）。 */
interface Context {
  readonly signal: AbortSignal;
  plan?: {
    readonly input: OutingInput;
    readonly allocation: Allocation;
    readonly dependencies: OutingDependencies;
    readonly options: OutingGenerateOptions;
  };
  allocate?: { readonly input: OutingPlanInput; readonly options: AllocateOptions; result?: AllocationResult };
  change?: {
    readonly draft: RequirementsDraft;
    readonly request: OutingChangeRequest | AdoptedChange;
    readonly progress: OutingProgress;
    readonly dependencies: OutingChangeDependencies;
    resolved?: ResolvedChange;
    result?: OutingChangePlan;
  };
  /** 每天最新的结果（审查重排会替换那天）；previous 是这一轮重排前的版本（退回用）。 */
  readonly byDay: Map<number, GeneratedDay>;
  previous?: Map<number, GeneratedDay>;
  latest?: GeneratedDay;
  /** V3.3：这次生成定的住处（收尾时给候选）。 */
  lodging?: readonly LodgingChoice[];
  /** 审查开着时，每天的结果等审查完再交给页面（用户只看到审查后的版本）。 */
  readonly reviewing: boolean;
}

const generatedOf = (context: Context) => [...context.byDay.values()].sort((a, b) => a.day - b.day);

/** 运行记录里总控走过的每一步（总控不是 Agent，记成根运行下的步骤）。 */
const mark = (node: string, summary: Record<string, unknown> = {}) =>
  currentRun()?.step(node === "plan_day" ? "handoff" : "check", `outing:${node}`, summary);

/** 预算用完后没排的天：照实说没做完，可以重排这一天（不是“排不开”）。 */
function skipped(frame: GeneratedDay["frame"]): GeneratedDay {
  return {
    day: frame.day,
    date: frame.date,
    frame,
    result: { status: "failed", segment: -1, code: "budget_exhausted" },
    snapshots: new Map(),
    discovered: [],
  };
}

function build(context: Context) {
  const plan = () => context.plan!;
  const frameOf = (day: number) => outingFrames(plan().input).find((frame) => frame.day === day)!;
  const emit = async (day: GeneratedDay) => {
    if (!context.reviewing) await plan().options.onDay?.(day);
  };
  const scope = () => context.change?.resolved?.status === "ready" ? context.change.resolved.affected : undefined;
  /**
   * 审查重排到一半就停了（取消、预算用完）：trial 还在，说明没回到 review 比较。退回这几天重排前的版本、分配退回改之前的，
   * 不写“审查后调整”，交出的分配和各天的方案才对得上。
   */
  const settle = (state: State): Allocation | null => {
    if (!state.trial) return state.allocation;
    for (const day of state.trial.days) {
      const before = context.previous?.get(day);
      if (before) context.byDay.set(day, before);
    }
    mark("review", { round: state.round, unfinished: state.trial.fixes.length });
    return state.trial.allocation;
  };

  const graph = new StateGraph(OutingState)
    .addNode("prepare", (state: State) => {
      if (state.phase !== "generate") {
        mark("prepare", { phase: state.phase });
        return {};
      }
      const { input, allocation, options } = plan();
      const frames = outingFrames(input).filter((frame) => !options.days || options.days.includes(frame.day));
      const stays = lodgingSegments(input, allocation).filter((segment) => !segment.given).length;
      const base = withReview(outingSegmentBudget(input, allocation, frames), context.reviewing);
      const budget = { ...base, amap: (base.amap ?? 0) + stays * LODGING_SEARCHES_PER_STAY };
      currentRun()?.root.limit(budget);
      mark("prepare", { phase: state.phase, days: frames.map((frame) => frame.day), model: budget.model, amap: budget.amap });
      return { pending: frames.map((frame) => frame.day), exclude: [...(options.exclude ?? [])], allocation };
    })
    // V3.3：住处没定的连住段各定一家，写进这次的输入（之后每天的终点、第二天的起点按它算）。
    .addNode("lodging", async () => {
      const { input, allocation, dependencies, options } = plan();
      const segments = lodgingSegments(input, allocation);
      if (!segments.length) return {};
      const choices = await chooseLodging(segments, input, allocation, outingFrames(input), dependencies.provider, context.signal);
      const lodging = [...input.lodging];
      for (const choice of choices) {
        for (const night of choice.nights) if (choice.place) lodging[night - 1] = choice.place;
      }
      context.plan = { ...plan(), input: { ...input, lodging } };
      context.lodging = choices;
      options.onLodging?.(choices);
      mark("lodging", {
        stays: choices.map((choice) => ({
          nights: choice.nights,
          from: choice.from,
          ...(choice.center ? { center: choice.center } : {}),
          picked: choice.place ? { id: choice.place.place.ref.externalId, name: choice.place.place.name } : null,
          candidates: choice.candidates.length,
        })),
      });
      return {};
    })
    .addNode("allocate", async () => {
      const job = context.allocate!;
      job.result = await runOutingAllocator(job.input, job.options);
      mark("allocate", { source: job.result.source, repairs: job.result.repairs, modelRequests: job.result.modelRequests });
      return {};
    })
    // 不假定规则兜底一定合法：分配的结果单独再检查一遍，问题写进状态。
    .addNode("check_allocation", () => {
      const job = context.allocate!;
      const problems = checkAllocation(job.input, outingFrames(job.input), job.result!.allocation).slice(0, 8);
      mark("check_allocation", { problems: problems.length });
      return { allocationProblems: problems, status: "needs_user" as const };
    })
    .addNode("resolve_change", async () => {
      const job = context.change!;
      job.resolved = await resolveOutingChange(job.draft, job.request, job.progress, job.dependencies);
      if (job.resolved.status === "refused") {
        mark("resolve_change", { refused: job.resolved.reason });
        return { status: "refused" as const };
      }
      const { input, allocation, affected } = job.resolved;
      const dependencies = job.dependencies;
      context.plan = {
        input,
        allocation,
        dependencies: {
          runner: dependencies.runner,
          provider: dependencies.provider,
          now: dependencies.now,
          ...(dependencies.weather ? { weather: dependencies.weather } : {}),
          ...(dependencies.reviewer ? { reviewer: dependencies.reviewer } : {}),
        },
        options: { signal: context.signal },
      };
      const frames = outingFrames(input).filter((frame) => affected.includes(frame.day));
      currentRun()?.root.limit(withReview(outingSegmentBudget(input, allocation, frames), context.reviewing));
      mark("resolve_change", { affected: [...affected] });
      return { pending: frames.map((frame) => frame.day), exclude: [...dependencies.exclude(affected)], allocation };
    })
    // 停止由代码决定：取消、超时就停（已排好的天保留）；共用预算用完就停，剩下的天照实说没做完。
    .addNode("next_day", async (state: State) => {
      const stop = context.signal.aborted ? "cancelled" as const : currentRun()?.root.exhausted ? "budget_exhausted" as const : null;
      if (stop === "budget_exhausted" && state.pending.length) {
        const rest = state.pending.map((day) => skipped(frameOf(day)));
        for (const day of rest) {
          context.byDay.set(day.day, day);
          await emit(day);
        }
        mark("next_day", { stop, skipped: state.pending });
        return {
          stop,
          pending: [],
          current: null,
          days: [...state.days, ...rest.map((day) => ({ day: day.day, status: "skipped" as const, reason: stop }))],
        };
      }
      if (stop || !state.pending.length) {
        if (stop) mark("next_day", { stop });
        return { stop, current: null };
      }
      const [current, ...pending] = state.pending;
      return { current: current!, pending };
    })
    .addNode("plan_day", async (state: State) => {
      const { input, dependencies, options } = plan();
      mark("plan_day", { day: state.current, excluded: state.exclude.length });
      context.latest = await planOutingDay(input, state.allocation!, frameOf(state.current!), state.exclude, dependencies, options);
      return {};
    })
    .addNode("record_day", async (state: State) => {
      const day = context.latest!;
      context.byDay.set(day.day, day);
      await emit(day);
      const reason = day.result.status === "no_plan" ? day.result.reason : day.result.status === "failed" ? day.result.code : undefined;
      mark("record_day", { day: day.day, status: day.result.status, ...(reason ? { reason } : {}), found: day.discovered.length });
      return {
        current: null,
        exclude: [...state.exclude, ...day.discovered.filter((id) => !state.exclude.includes(id))],
        days: [...state.days.filter((item) => item.day !== day.day), { day: day.day, status: day.result.status, ...(reason ? { reason } : {}) }],
      };
    })
    // V3.2 审查：先看上一轮直接改的是否变好（不好就退回），再找问题、问审查 Agent。
    .addNode("review", async (state: State) => {
      const { input, dependencies } = plan();
      let allocation = state.allocation!;
      const { round } = state;
      let { applied, reverted, tried } = state;
      const days = state.days;
      if (state.trial) {
        const after = reviewScore(reviewFindings(input, allocation, generatedOf(context), scope()));
        if (improved(state.trial.before, after)) {
          // 留下：方案上写明审查后调整了什么。
          const notes = state.trial.fixes.map((fix) => ({ action: fix.action, note: fixNote(input, state.trial!.allocation, fix) }));
          for (const day of state.trial.days) {
            const kept = context.byDay.get(day);
            const note = notes.map((item) => item.note).join("；").slice(0, 200);
            if (kept) context.byDay.set(day, { ...kept, reviewNote: note });
          }
          applied = [...applied, ...notes];
          mark("review", { round, kept: state.trial.fixes.length, before: state.trial.before, after });
        } else {
          for (const day of state.trial.days) {
            const before = context.previous?.get(day);
            if (before) context.byDay.set(day, before);
          }
          allocation = state.trial.allocation;
          reverted += state.trial.fixes.length;
          tried = [...tried, ...state.trial.fixes.map(fixKey)];
          mark("review", { round, reverted: state.trial.fixes.length, before: state.trial.before, after });
        }
      }
      if (!state.reviewed) plan().options.onReviewStart?.();
      const done = { allocation, applied, reverted, tried, trial: null, reviewed: true, days };
      if (round >= REVIEW_ROUNDS || state.stop || !dependencies.reviewer) return done;
      const findings = reviewFindings(input, allocation, generatedOf(context), scope());
      if (!findings.length) {
        mark("review", { round, findings: 0 });
        return done;
      }
      const generated = generatedOf(context);
      const checked = await inAgent(
        "outing-reviewer",
        { input: reviewContext(input, allocation, generated, findings) },
        async (run) => {
          const result = await proposeFixes(
            dependencies.reviewer!,
            reviewContext(input, allocation, generated, findings),
            (fixes) => checkFixes(fixes, { input, allocation, days: generated, findings, tried }),
            context.signal,
          );
          run?.step("check", "findings", { kinds: findings.map((item) => `${item.kind}:d${item.day}`).slice(0, 20) });
          for (const item of result.checked.rejected) run?.step("check", "rejected", { ...item });
          run?.step("check", "result", {
            direct: result.checked.direct.map((fix) => fix.action),
            suggestions: result.checked.suggestions.map((fix) => fix.action),
            repairs: result.repairs,
          });
          return result.checked;
        },
        (result: CheckedFixes) => (result.direct.length || result.suggestions.length ? { status: "ok" } : { status: "none" }),
      );
      // 改动阶段只改受影响的那几天之间；建议不在改动卡片上出现。
      const inScope = (fix: ReviewFix) => {
        const range = scope();
        if (!range) return true;
        if (fix.action !== "move_visit" && fix.action !== "move_interest") return false;
        const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
        const from = allocation.days.find((entry) => entry.visits.includes(ref) || entry.interests.includes(ref))?.day;
        return from !== undefined && range.includes(from) && range.includes(fix.toDay);
      };
      const direct = checked.direct.filter(inScope);
      const known = new Set(state.suggestions.map(suggestionKey));
      const suggestions = scope() ? state.suggestions : [
        ...state.suggestions,
        ...checked.suggestions.filter((fix) => !known.has(suggestionKey(fix)) && known.add(suggestionKey(fix))),
      ];
      if (!direct.length) return { ...done, suggestions };
      return { ...done, suggestions, trial: { days: [], before: reviewScore(findings), allocation, fixes: direct } };
    })
    // 把通过检查的直接修改换成新的分配，受影响的天放回待排（排除列表只留没重排的那几天找到的地点）。
    .addNode("apply_fixes", (state: State) => {
      const trial = state.trial!;
      let allocation = trial.allocation;
      const affected = new Set<number>();
      for (const fix of trial.fixes) {
        if (fix.action !== "move_visit" && fix.action !== "move_interest") continue;
        const ref = fix.action === "move_visit" ? fix.visit : fix.interest;
        const from = allocation.days.find((entry) => entry.visits.includes(ref) || entry.interests.includes(ref))?.day;
        if (from !== undefined) affected.add(from);
        affected.add(fix.toDay);
        allocation = movedAllocation(allocation, ref, fix.toDay);
      }
      const days = [...affected].sort((a, b) => a - b);
      context.previous = new Map(days.flatMap((day) => (context.byDay.has(day) ? [[day, context.byDay.get(day)!] as const] : [])));
      const kept = generatedOf(context).filter((day) => !affected.has(day.day)).flatMap((day) => day.discovered);
      mark("apply_fixes", { round: state.round + 1, fixes: trial.fixes.map((fix) => fix.action), days });
      return {
        allocation,
        round: state.round + 1,
        trial: { ...trial, days },
        pending: days,
        exclude: [...new Set([...(plan().options.exclude ?? []), ...kept])],
      };
    })
    .addNode("finish", async (state: State) => {
      const allocation = settle(state);
      mark("finish", { days: state.days.length, ...(state.stop ? { stop: state.stop } : {}) });
      // V3.3：换住处的候选（代码给的）跟审查的建议一起交出；审查关着时也给。
      const lodging = state.stop ? [] : lodgingSuggestions(context.lodging ?? [], generatedOf(context));
      if (context.reviewing) {
        for (const day of generatedOf(context)) await plan().options.onDay?.(day);
      }
      if (context.reviewing || lodging.length) {
        const { input } = plan();
        plan().options.onReview?.({
          rounds: state.round,
          applied: state.applied,
          reverted: state.reverted,
          suggestions: [...state.suggestions.map((fix) => ({ fix, text: suggestionText(input, allocation!, fix) })), ...lodging],
          allocation: allocation!,
        });
      }
      return {
        allocation,
        trial: null,
        status: state.stop === "cancelled" ? "completed" as const : "needs_user" as const,
      };
    })
    .addNode("diff", (state: State) => {
      const job = context.change!;
      const resolved = job.resolved as Extract<ResolvedChange, { status: "ready" }>;
      const allocation = settle(state) ?? resolved.allocation;
      // 审查在受影响的天之间挪过东西时，改动后的卡片也换成审查后的分配。
      const outing = resolved.draft.outing!;
      const draft = outing.allocation
        ? { ...resolved.draft, outing: { ...outing, allocation: { ...outing.allocation, days: allocation.days.map((entry) => ({ ...entry, visits: [...entry.visits], interests: [...entry.interests] })) } } }
        : resolved.draft;
      job.result = changePlan({ ...resolved, draft, allocation }, generatedOf(context));
      mark("diff", { days: state.days.length, ...(state.stop ? { stop: state.stop } : {}) });
      return { allocation, trial: null, status: "needs_user" as const };
    })
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", (state: State) =>
      state.phase === "allocate" ? "allocate" : state.phase === "change" ? "resolve_change" : "lodging")
    .addEdge("lodging", "next_day")
    .addEdge("allocate", "check_allocation")
    .addEdge("check_allocation", END)
    .addConditionalEdges("resolve_change", (state: State) => (state.status === "refused" ? END : "next_day"))
    .addConditionalEdges("next_day", (state: State) => {
      if (state.current !== null) return "plan_day";
      // 都排完（或停了）：审查开着且还没审完就去审查，否则收尾。
      if (context.reviewing && !state.stop && (!state.reviewed || state.trial)) return "review";
      return state.phase === "change" ? "diff" : "finish";
    })
    .addEdge("plan_day", "record_day")
    .addEdge("record_day", "next_day")
    .addConditionalEdges("review", (state: State) => (state.trial ? "apply_fixes" : state.phase === "change" ? "diff" : "finish"))
    .addEdge("apply_fixes", "next_day")
    .addEdge("finish", END)
    .addEdge("diff", END);
  return graph.compile();
}

/** 审查开着时多留出审查和重排的余量：模型多 4 次（两轮，每轮打回一次），重排最多再用一遍逐天的额度。 */
function withReview(budget: ReturnType<typeof outingSegmentBudget>, reviewing: boolean): ReturnType<typeof outingSegmentBudget> {
  if (!reviewing) return budget;
  return { ...budget, model: (budget.model ?? 0) * 2 + 4, amap: (budget.amap ?? 0) * 2, ms: (budget.ms ?? 0) * 2 };
}

/** 跑一遍总控图；一趟最多 7 天，每天 3 个节点，审查两轮再重排几天。 */
async function run(phase: Phase, context: Context): Promise<State> {
  const initial: State = {
    phase, pending: [], current: null, days: [], exclude: [], allocation: null, allocationProblems: [],
    round: 0, trial: null, applied: [], reverted: 0, tried: [], suggestions: [], reviewed: false, stop: null, status: "running",
  };
  return await build(context).invoke(initial, { recursionLimit: 128 }) as State;
}

const reviewing = (dependencies: OutingDependencies) => outingReview() === "on" && !!dependencies.reviewer;

export async function generateWithGraph(
  input: OutingInput,
  allocation: Allocation,
  dependencies: OutingDependencies,
  options: OutingGenerateOptions,
): Promise<GeneratedDay[]> {
  return (await generateWithState(input, allocation, dependencies, options)).generated;
}

/** 同上，另外交出图的最终状态（测试看停止原因、排除列表、状态能不能序列化）。 */
export async function generateWithState(
  input: OutingInput,
  allocation: Allocation,
  dependencies: OutingDependencies,
  options: OutingGenerateOptions,
): Promise<{ state: State; generated: GeneratedDay[] }> {
  const context: Context = {
    signal: options.signal, plan: { input, allocation, dependencies, options }, byDay: new Map(), reviewing: reviewing(dependencies),
  };
  const state = await run("generate", context);
  return { state, generated: generatedOf(context) };
}

export async function allocateWithGraph(input: OutingPlanInput, options: AllocateOptions): Promise<AllocationResult> {
  const context: Context = { signal: options.signal, allocate: { input, options }, byDay: new Map(), reviewing: false };
  await run("allocate", context);
  return context.allocate!.result!;
}

export async function changeWithGraph(
  draft: RequirementsDraft,
  request: OutingChangeRequest | AdoptedChange,
  progress: OutingProgress,
  dependencies: OutingChangeDependencies,
  signal: AbortSignal,
): Promise<OutingChangePlan> {
  const context: Context = {
    signal, change: { draft, request, progress, dependencies }, byDay: new Map(),
    reviewing: outingReview() === "on" && !!dependencies.reviewer,
  };
  await run("change", context);
  const job = context.change!;
  return job.resolved?.status === "refused" ? job.resolved : job.result!;
}
