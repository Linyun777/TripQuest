import { closedThatDay, isStale, NOTE_MAX_STOPS, noteEligible, noteQuery } from "@tripquest/application/trip-notes";
import type { WebSearchResult } from "@tripquest/providers";
import { z } from "zod";
import type { WebSource } from "./chat-contracts";
import { DecisionModelError } from "./contracts";
import { inAgent } from "./agents/run-agent";
import {
  NOTES_LIMITS,
  notesOutputSchema,
  type NotesDecisionContext,
  type TripNote,
  type TripNotesCounts,
  type TripNotesDependencies,
  type TripNotesInput,
  type TripNotesResult,
  type TripNotesStop,
} from "./notes-contracts";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const LINK = /https?:\/\/|www\./i;
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).passthrough().nullable();

class NotesError extends Error {
  constructor(readonly code: Extract<TripNotesResult, { status: "failed" }>["code"]) {
    super(code);
  }
}

/** 一站的本轮搜索结果与失败原因；w 编号在整份行程内唯一，后续按站归属校验引用。 */
interface Looked {
  readonly key: string;
  readonly name: string;
  readonly results: readonly (WebSearchResult & { readonly id: string })[];
  readonly failure?: string;
}

export function createTripNotesRunner(dependencies: TripNotesDependencies) {
  return {
    run: (input: TripNotesInput, options: { signal: AbortSignal }) => inAgent(
      "trip-notes",
      {},
      () => runNotes(input, options, dependencies),
      (result) => result.status === "completed" ? { status: "ok" } : { status: "failed", outcome: result.code },
    ),
  };
}

async function runNotes(input: TripNotesInput, options: { signal: AbortSignal }, dependencies: TripNotesDependencies): Promise<TripNotesResult> {
  const counts: TripNotesCounts = { model: 0, webSearches: 0, details: 0, dropped: 0 };
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(NOTES_LIMITS.turnMs)]);
  try {
    // 先实时查地点分类，只给景点、文化与演出类站生成须知，最多五站；不凭模型记忆判断类型。
    const ids = [...new Set(input.stops.map((stop) => stop.externalId))].slice(0, 10);
    counts.details += 1;
    const details = await dependencies.places.findPlacesById(ids, { signal });
    if (details.status !== "ok") throw new NotesError("lookup_failed");
    const category = new Map(details.data.items.map((item) => [item.ref.externalId, item.categoryCode]));
    const chosen = input.stops.filter((stop) => noteEligible(category.get(stop.externalId))).slice(0, NOTE_MAX_STOPS);

    // 每站按名称独立搜索，错开请求启动时间以控制突发频率；检索词不带用户位置。
    let next = 1;
    const looked: Looked[] = await Promise.all(chosen.map(async (stop, index): Promise<Looked> => {
      await new Promise((resolve) => setTimeout(resolve, index * (dependencies.searchGapMs ?? 250)));
      counts.webSearches += 1;
      const found = await dependencies.web.searchWeb({ query: noteQuery(stop.name), count: 5 }, { signal })
        .catch(() => null);
      if (!found || found.status !== "ok") {
        return { key: stop.key, name: stop.name, results: [], failure: found?.status === "failure" ? found.failure.code : "unavailable" };
      }
      return { key: stop.key, name: stop.name, results: found.data.results.slice(0, 5).map((result) => ({ ...result, id: "" })) };
    }));
    // 并发完成顺序不可预测，统一在结果回齐后按计划顺序分配 ID，保持模型输入与引用校验一致。
    const numbered = looked.map((stop) => ({ ...stop, results: stop.results.map((result) => ({ ...result, id: `w${next++}` })) }));

    // 默认一次模型调用处理所有有结果的站；per_stop 仅作逐站调用的成本与效果对照。
    const withResults = numbered.filter((stop) => stop.results.length);
    const groups = dependencies.calls === "per_stop" ? withResults.map((stop) => [stop]) : withResults.length ? [withResults] : [];
    const decided = new Map<string, { kind: TripNote["kind"]; text: string; sources: string[] }[]>();
    for (const group of groups) {
      const output = await decide(group, input.date, dependencies, signal, counts, (reported) => {
        if (!reported) return;
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + reported.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + reported.outputTokens,
          totalTokens: (usage?.totalTokens ?? 0) + reported.totalTokens,
        };
      });
      // 模型返回额外站名也不会扩大处理范围；只接受这批输入中已有的 stop.key。
      for (const stop of output.stops) if (group.some((entry) => entry.key === stop.key)) decided.set(stop.key, stop.notes);
    }

    // 输出逐站核验：只能引用本站搜索结果，正文不得夹链接，闭馆星期警告由确定性代码推导。
    const stops = input.stops.map((stop): TripNotesStop => {
      const own = numbered.find((entry) => entry.key === stop.key);
      if (!own) return { key: stop.key, name: stop.name, checked: false, notes: [], warning: null };
      const byId = new Map(own.results.map((result) => [result.id, result]));
      const notes: TripNote[] = [];
      for (const note of decided.get(stop.key) ?? []) {
        // 引用必须属于这一站本轮查到的结果，不能把别站的信息挪过来背书。
        // 这里只证明出处存在且归属正确，文字是否忠于摘要仍需回答评测检查，不能当作事实核验。
        const cited = note.sources.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
        if (!cited.length || cited.length !== note.sources.length || LINK.test(note.text)) {
          counts.dropped += 1;
          continue;
        }
        notes.push({
          kind: note.kind,
          text: note.text,
          sources: [...new Set(cited)].map((result): WebSource => ({ url: result.url, title: result.title, site: result.site, date: result.date })),
          // 只有引用来源全部偏旧才标记 stale；日期未知不被编成“最新已核实”。
          stale: cited.every((result) => isStale(result.date, input.today)),
        });
      }
      // 闭馆警告检查本站全部摘要，不只检查模型引用的几条；authority 分数不等于官方认证。
      // 2026-10-18 实测聚合页得分 3 却写周一，另一得分 2 的结果写周二，不能单按分数认定事实。
      return {
        key: stop.key,
        name: stop.name,
        checked: true,
        notes,
        warning: closedThatDay(input.date, own.results.map((result) => result.summary)),
        ...(own.failure ? { failure: own.failure } : {}),
      };
    });
    return { status: "completed", stops, counts: { ...counts }, usage };
  } catch (error) {
    const code = error instanceof NotesError ? error.code
      : signal.aborted ? "timeout"
        : error instanceof DecisionModelError
          ? error.code === "invalid_output" ? "invalid_output" : error.code === "quota" ? "live_budget" : "model_error"
          : "model_error";
    return { status: "failed", code, counts: { ...counts }, usage };
  }
}

/** 结构错误最多反馈修正一次；不因修复重查网页，且共享本轮耗时与模型计数。 */
async function decide(
  group: readonly Looked[],
  date: string,
  dependencies: TripNotesDependencies,
  signal: AbortSignal,
  counts: TripNotesCounts,
  addUsage: (usage: z.infer<typeof usageSchema>) => void,
) {
  let feedback: NotesDecisionContext["feedback"] = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context: NotesDecisionContext = {
      protocolVersion: "trip-notes.v1",
      date,
      weekday: WEEKDAYS[new Date(`${date}T12:00:00+08:00`).getUTCDay()],
      stops: group.map((stop) => ({
        key: stop.key,
        name: stop.name,
        results: stop.results.map((result) => ({
          id: result.id, title: result.title, site: result.site, date: result.date, authority: result.authority, summary: result.summary.slice(0, 300),
        })),
      })),
      feedback,
    };
    if (new TextEncoder().encode(JSON.stringify(context)).byteLength > NOTES_LIMITS.contextBytes) throw new NotesError("invalid_output");
    counts.model += 1;
    const reply = await dependencies.model.decide(context, { signal: AbortSignal.any([signal, AbortSignal.timeout(NOTES_LIMITS.modelMs)]) });
    const reported = usageSchema.safeParse(reply.usage);
    if (reported.success) addUsage(reported.data);
    const parsed = notesOutputSchema.safeParse(reply.decision);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
    feedback = { code: `invalid_shape; ${issues.join("; ")}` };
  }
  throw new NotesError("invalid_output");
}
