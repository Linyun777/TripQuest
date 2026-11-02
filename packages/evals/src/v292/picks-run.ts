import { pickWithModel, SHORT_LIMITS, type CandidateDecisionModel, type PickAnswer, type PickContext } from "@tripquest/agent/short";
import { createJevPicker } from "@tripquest/agent/short-jev";
import type { JevClient } from "@tripquest/agent/jev";
import type { PickCase } from "./picks-dataset";

/**
 * V2.9.2 挑地点评测：同一批固定候选交给不同的挑选实现。挑不出来（null）时按产品的做法用
 * 最近的几个兜底，并记为退回。判分只看挑出的编号、顺序和停留时间，不看理由的文笔。
 */
export interface EvalPicker {
  readonly name: string;
  pick(context: PickContext, signal: AbortSignal): Promise<{
    readonly answer: PickAnswer | null;
    readonly requests: number;
    /** 退回的原因（错误码，不含内容）。 */
    readonly failure?: string;
    /** 实现报告的实际模型版本（Jev 返回的 model）。 */
    readonly model?: string;
    readonly inputTokens?: number;
    /** Jev：每个候选“合适”的概率（离线选阈值用）。 */
    readonly scores?: Readonly<Record<string, number>>;
  }>;
}

/** 现有做法：DeepSeek 挑 1–5 个并写理由（V2.4；V2.9.3 起不再要求至少 3 个）。记下输入 tokens 估费用。 */
export function deepSeekPicker(model: () => CandidateDecisionModel): EvalPicker {
  return {
    name: "deepseek",
    async pick(context, signal) {
      let inputTokens = 0;
      const base = model();
      const counting: CandidateDecisionModel = {
        ...base,
        async decide(request, options) {
          const reply = await base.decide(request, options);
          inputTokens += reply.usage?.inputTokens ?? 0;
          return reply;
        },
      };
      const { answer, requests } = await pickWithModel(counting, context, signal);
      return {
        answer,
        requests,
        inputTokens,
        ...(answer ? {} : { failure: "model_failed" }),
      };
    },
  };
}

/** Jev：一次请求，代码排序、模板理由（产品里的同一个实现）。 */
export function jevPicker(client: JevClient, fit?: number): EvalPicker {
  const picker = createJevPicker(client, fit === undefined ? {} : { fit });
  return {
    name: client.model === "jev-1.13.0" ? "jev13" : "jev",
    async pick(context, signal) {
      const result = await picker.pickWithScores(context, signal);
      return { ...result, requests: 1 };
    },
  };
}

export function pickContext(item: PickCase): PickContext {
  return {
    interest: item.interest,
    anchor: item.anchor,
    ...(item.wet ? { wet: true } : {}),
    found: item.found.map((candidate, index) => ({
      id: `c${index + 1}`,
      name: candidate.name,
      meters: candidate.meters,
      ...(candidate.keytag ? { keytag: candidate.keytag } : {}),
      ...(candidate.rating ? { rating: candidate.rating } : {}),
      ...(candidate.costYuan ? { costYuan: candidate.costYuan } : {}),
    })),
  };
}

export interface PickRow {
  readonly suite: "picks";
  readonly caseId: string;
  readonly picker: string;
  readonly heldOut: boolean;
  /** 挑出的候选名（按给出的顺序）；退回时是距离兜底的结果。 */
  readonly picked: readonly string[];
  readonly reasons: readonly string[];
  readonly fallback: boolean;
  readonly failure: string | null;
  readonly model: string | null;
  readonly checks: {
    /** 该说“没有”时说“没有”，有合适的时没有说“没有”。 */
    readonly noneRight: boolean;
    /** 合适的排在不合适的前面。 */
    readonly fitsFirst: boolean;
    /** 合适的都挑出来了（合适的超过上限时只要求挑满）。 */
    readonly allFits: boolean;
    readonly firstFits: boolean;
    /** 合适里的第一个是最近的合适候选。 */
    readonly nearestFirst: boolean;
    readonly stayOk: boolean;
  };
  readonly precision: number | null;
  readonly passed: boolean;
  readonly latencyMs: number;
  readonly requests: number;
  readonly inputTokens: number;
  readonly scores: Readonly<Record<string, number>> | null;
}

export async function runPickCase(item: PickCase, picker: EvalPicker): Promise<PickRow> {
  const context = pickContext(item);
  const started = performance.now();
  type Result = Awaited<ReturnType<EvalPicker["pick"]>>;
  const result: Result = await picker.pick(context, AbortSignal.timeout(30_000)).catch((): Result => ({ answer: null, requests: 0, failure: "error" }));
  const latencyMs = Math.round(performance.now() - started);
  const least = Math.min(SHORT_LIMITS.offerMin, item.found.length);
  const byId = (id: string) => item.found[Number(id.slice(1)) - 1];
  // 产品的兜底：挑不出来时取最近的几个，理由写“离你最近”。
  const picks = result.answer
    ? result.answer.picks.map((pick) => ({ candidate: byId(pick.id), reason: pick.reason, stayMinutes: pick.stayMinutes }))
    : item.found.slice(0, least).map((candidate) => ({ candidate, reason: "离你最近", stayMinutes: 60 }));
  const fits = item.found.filter((candidate) => candidate.fits);
  const flags = picks.map((pick) => pick.candidate.fits);
  const wanted = Math.min(fits.length, SHORT_LIMITS.offerMax);
  const noneExpected = fits.length === 0;
  const saidNone = !!result.answer && result.answer.picks.length === 0;
  const fitsFirst = flags.every((fit, index) => !fit || flags.slice(0, index).every(Boolean));
  const checks = {
    noneRight: noneExpected ? saidNone : !saidNone,
    fitsFirst,
    allFits: flags.filter(Boolean).length >= wanted,
    firstFits: noneExpected ? saidNone : flags[0] === true,
    nearestFirst: noneExpected ? saidNone : picks[0]?.candidate === fits[0],
    stayOk: picks.every((pick) => pick.stayMinutes >= item.stay[0] && pick.stayMinutes <= item.stay[1]),
  };
  return {
    suite: "picks",
    caseId: item.id,
    picker: picker.name,
    heldOut: !!item.heldOut,
    picked: picks.map((pick) => pick.candidate.name),
    reasons: picks.map((pick) => pick.reason),
    fallback: !result.answer,
    failure: result.failure ?? null,
    model: result.model ?? null,
    checks,
    precision: picks.length ? Math.round((flags.filter(Boolean).length / picks.length) * 100) / 100 : null,
    passed: checks.noneRight && checks.fitsFirst && checks.allFits && checks.firstFits,
    latencyMs,
    requests: result.requests,
    inputTokens: result.inputTokens ?? 0,
    scores: result.scores ?? null,
  };
}

const percentile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

/** 报告段落：按实现、非留出 / 留出分开。 */
export function renderPicks(rows: readonly PickRow[], repeat: number): string[] {
  const lines: string[] = [];
  for (const picker of [...new Set(rows.map((row) => row.picker))]) {
    for (const part of [{ label: "非留出", list: rows.filter((row) => row.picker === picker && !row.heldOut) }, { label: "留出", list: rows.filter((row) => row.picker === picker && row.heldOut) }]) {
      if (!part.list.length) continue;
      const list = part.list;
      const count = (name: keyof PickRow["checks"]) => `${list.filter((row) => row.checks[name]).length}/${list.length}`;
      const precisions = list.flatMap((row) => (row.precision === null ? [] : [row.precision]));
      const failures = [...new Set(list.flatMap((row) => (row.failure ? [row.failure] : [])))]
        .map((code) => `${code} ${list.filter((row) => row.failure === code).length}`).join("、") || "无";
      const models = [...new Set(list.flatMap((row) => (row.model ? [row.model] : [])))].join("、");
      lines.push(
        `## 短途挑地点（V2.9.2；${picker}${models ? `，${models}` : ""}；${part.label}；每题 ${repeat} 次）`,
        "",
        `整题通过 ${list.filter((row) => row.passed).length}/${list.length}；挑出的平均精确率 ${precisions.length ? Math.round((precisions.reduce((a, b) => a + b, 0) / precisions.length) * 100) : "—"}%；延迟中位 ${percentile(list.map((row) => row.latencyMs), 0.5)} ms，90 分位 ${percentile(list.map((row) => row.latencyMs), 0.9)} ms；请求 ${list.reduce((a, row) => a + row.requests, 0)} 次，输入 ${list.reduce((a, row) => a + row.inputTokens, 0)} tokens；退回 ${list.filter((row) => row.fallback).length} 次（${failures}）。`,
        "",
        "| 该说没有 | 合适的在前 | 合适的都挑出 | 第一个合适 | 第一个是最近的合适 | 停留时间合理 |",
        "| --- | --- | --- | --- | --- | --- |",
        `| ${count("noneRight")} | ${count("fitsFirst")} | ${count("allFits")} | ${count("firstFits")} | ${count("nearestFirst")} | ${count("stayOk")} |`,
        "",
        "| 用例 | 通过次数 | 未通过的检查 | 最后一次挑出 |",
        "| --- | --- | --- | --- |",
        ...[...new Set(list.map((row) => row.caseId))].map((id) => {
          const runs = list.filter((row) => row.caseId === id);
          const failed = [...new Set(runs.flatMap((row) => Object.entries(row.checks).filter(([, ok]) => !ok).map(([name]) => name)))];
          const last = runs.at(-1)!;
          return `| ${id} | ${runs.filter((row) => row.passed).length}/${runs.length} | ${failed.join("、") || "—"} | ${last.picked.map((name, index) => `${name}（${last.reasons[index]}）`).join("；").replace(/\|/g, "／").slice(0, 160)} |`;
        }),
        "",
      );
    }
  }
  return lines;
}
