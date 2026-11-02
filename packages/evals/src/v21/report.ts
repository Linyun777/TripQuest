import { INTENT_INTAKE_CASES, INTENT_PLAN_CASES } from "./intent-dataset";
import { renderReview } from "../v32/review-report";
import type { ReviewRow } from "../v32/review-run";
import { renderLodging } from "../v33/lodging-report";
import type { LodgingRow } from "../v33/lodging-run";
import { renderSplitOutings, type SplitOutingRow } from "../v34/split-run";
import { renderAgentRows, type AgentRow } from "../agent-summary";
import type { IntakeRow, PlanRow } from "./run";
import { SHORT_INTAKE_CASES, SHORT_PLAN_CASES } from "./short-dataset";
import type { ShortRow } from "./short-run";
import { ADJUST_INTAKE_CASES, ADJUST_PLAN_CASES } from "./adjust-dataset";
import type { AdjustIntakeRow, AdjustRow } from "./adjust-run";
import { INFO_HELD_OUT } from "./info-dataset";
import type { InfoRow } from "./info-run";
import { NOTES_HELD_OUT } from "./notes-dataset";
import { KNOWLEDGE_HELD_OUT } from "./knowledge-dataset";
import type { KnowledgeRow } from "./knowledge-run";
import { renderV29 } from "../v29/report";
import { renderPicks, type PickRow } from "../v292/picks-run";
import type { PlayRow } from "../v210/play-run";
import type { TransferRow } from "../v211/transfer-run";
import type { AllocationRow } from "../v211/allocation-run";
import type { OutingRow } from "../v211/outing-run";
import type { CrossDayRow } from "../v211/cross-day-run";
import type { RouteRow } from "../v29/route-run";
import type { ConversationRow } from "../v29/conversation-run";
import type { NotesRow } from "./notes-run";

export interface V21Report {
  readonly runId: string;
  readonly startedAt: string;
  readonly git: { readonly sha: string; readonly dirty: boolean | null };
  readonly datasets: {
    readonly intake: { readonly version: string; readonly digest: string; readonly cases: number };
    readonly plan: { readonly version: string; readonly digest: string; readonly cases: number };
    readonly intent?: { readonly version: string; readonly digest: string; readonly cases: number; readonly heldOutIncluded: boolean };
    readonly short?: { readonly version: string; readonly digest: string; readonly cases: number; readonly flow: string };
    readonly adjust?: { readonly version: string; readonly digest: string; readonly cases: number; readonly flow: string };
    readonly info?: { readonly version: string; readonly digest: string; readonly cases: number; readonly web: boolean };
    readonly notes?: { readonly version: string; readonly digest: string; readonly cases: number };
    readonly knowledge?: { readonly version: string; readonly digest: string; readonly cases: number; readonly flow: string };
    readonly v29?: Readonly<Record<"route" | "talk" | "pref" | "long" | "fix", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v292?: Readonly<Record<"routeHoldout" | "picks", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v293?: Readonly<Record<"routeE2e", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v210?: Readonly<Record<"city" | "play" | "shortCity", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v211?: Readonly<Record<"dailyCity" | "stay" | "outingIntake" | "outingPlan" | "acceptFix", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v32?: Readonly<Record<"review", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v33?: Readonly<Record<"lodging", { readonly version: string; readonly digest: string; readonly cases: number }>>;
    readonly v34?: Readonly<Record<"split", { readonly version: string; readonly digest: string; readonly cases: number }>>;
  };
  /** V2.5 adjusting a saved trip. */
  readonly adjust?: readonly AdjustRow[];
  readonly adjustIntake?: readonly AdjustIntakeRow[];
  /** V2.7 questions answered with sources. */
  readonly info?: readonly InfoRow[];
  /** V2.9 routing rows and conversation rows (chitchat and advice, preferences, long). */
  readonly route?: readonly RouteRow[];
  readonly conversations?: readonly ConversationRow[];
  /** V2.9.2 挑地点对照。 */
  readonly picks?: readonly PickRow[];
  /** V2.10 各种玩法（云岭市的一日规划）。 */
  readonly play?: readonly PlayRow[];
  /** V2.11 一天里的固定交通（§4.4）。 */
  readonly transferDays?: readonly TransferRow[];
  /** V2.11 分到各天（§4.5）。 */
  readonly allocations?: readonly AllocationRow[];
  readonly trips?: readonly OutingRow[];
  readonly crossDays?: readonly CrossDayRow[];
  /** V3.2 审查评测。 */
  readonly reviews?: readonly ReviewRow[];
  readonly lodgings?: readonly LodgingRow[];
  /** V3.4 搜索兜底题。 */
  readonly splitOutings?: readonly SplitOutingRow[];
  /** V2.8 knowledge questions. */
  readonly knowledge?: readonly KnowledgeRow[];
  /** V2.7.2 "出发须知". */
  readonly notes?: readonly NotesRow[];
  /** V2.4 short trips. */
  readonly short?: readonly ShortRow[];
  /** Live runs per case (V2.3 reads pass rates). */
  readonly repeat?: number;
  /** V2.9.3：对话评测用的分流。 */
  readonly chatRouter?: string;
  readonly live: null | { readonly profileId: string; readonly configuredModel: string; readonly modelRequests: number };
  readonly intake: readonly IntakeRow[];
  readonly plan: readonly PlanRow[];
  /** V3.0：每题各 Agent 的运行数、模型请求、tokens、耗时、兜底（live 题）。 */
  readonly agents?: readonly AgentRow[];
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

/** Summary numbers per planning policy. */
export function summarizePlan(rows: readonly PlanRow[]) {
  const drafts = rows.filter((row) => row.outcome === "draft");
  const wet = drafts.filter((row) => row.wetIndoor);
  const sum = (pick: (row: PlanRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    cases: rows.length,
    outcomeMatched: rows.filter((row) => row.outcomeMatched).length,
    covered: sum((row) => row.covered),
    interests: sum((row) => (row.expectedOutcome === "draft" ? row.interests : 0)),
    wetIndoor: wet.reduce((total, row) => total + row.wetIndoor!.indoor, 0),
    wetDiscovered: wet.reduce((total, row) => total + row.wetIndoor!.discovered, 0),
    withReason: sum((row) => row.reasons.withReason),
    discovered: sum((row) => row.reasons.discovered),
    violations: sum((row) => row.violations.length),
    modelRequests: sum((row) => row.modelRequests),
    fallbacks: rows.filter((row) => row.fallback).length,
    walking: drafts.length ? Math.round(drafts.reduce((total, row) => total + (row.totalWalkingMinutes ?? 0), 0) / drafts.length) : null,
  };
}

const MODE_LABEL: Record<string, string> = { walking: "步", transit: "公交", taxi: "打车", bicycling: "骑", driving: "驾" };

/** V2.2 far cases (P11–P17), kept out of the V2.1 table. */
const FAR_CASE = /^P1[1-7]/;
/** V2.3 cases have their own section, so earlier tables keep their numbers comparable. */
const INTENT_IDS = new Set([...INTENT_PLAN_CASES, ...INTENT_INTAKE_CASES].map((item) => item.id));
const HELD_OUT = new Set([...INTENT_PLAN_CASES, ...INTENT_INTAKE_CASES, ...SHORT_PLAN_CASES, ...SHORT_INTAKE_CASES]
  .filter((item) => item.heldOut).map((item) => item.id));
const SHORT_INTAKE_IDS = new Set(SHORT_INTAKE_CASES.map((item) => item.id));
/** V2.7.2: per way of calling the model, whole cases and per check; then per case. */
function renderNotes(report: V21Report): string[] {
  const rows = report.notes ?? [];
  if (!rows.length) return [];
  const label = (id: string) => (NOTES_HELD_OUT.has(id) ? `${id}（留出）` : id);
  const lines = [`## 出发须知（V2.7.2；每例 ${report.repeat ?? 1} 次）`, "", "| 调用方式 | 整例通过 | 模型请求 | 搜索 | 丢弃的须知 |", "| --- | --- | --- | --- | --- |"];
  for (const calls of ["batch", "per_stop"] as const) {
    const list = rows.filter((row) => row.calls === calls);
    if (!list.length) continue;
    const sum = (pick: (row: NotesRow) => number) => list.reduce((total, row) => total + pick(row), 0);
    lines.push(`| ${calls === "batch" ? "合成一次" : "每站一次"} | ${list.filter((row) => row.passed).length}/${list.length} | ${sum((row) => row.modelRequests)} | ${sum((row) => row.webSearches)} | ${sum((row) => row.dropped)} |`);
  }
  lines.push("", "| 用例 | 调用方式 | 通过次数 | 未通过的检查 |", "| --- | --- | --- | --- |");
  for (const id of [...new Set(rows.map((row) => row.caseId))]) {
    for (const calls of ["batch", "per_stop"] as const) {
      const list = rows.filter((row) => row.caseId === id && row.calls === calls);
      if (!list.length) continue;
      const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
      lines.push(`| ${label(id)} | ${calls === "batch" ? "合成一次" : "每站一次"} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} |`);
    }
  }
  lines.push("");
  return lines;
}

/** V2.7: web searches in planning and adjusting conversations, where none is needed. */
function renderWebUse(report: V21Report): string[] {
  const rows = [...report.intake, ...(report.adjustIntake ?? [])];
  if (!report.datasets.info?.web || !rows.length) return [];
  const searched = rows.filter((row) => row.webQueries?.length);
  return [
    "## 规划与调整对话里的联网搜索（V2.7，应为 0）",
    "",
    `${searched.length}/${rows.length} 次对话搜了网页${searched.length ? `：${searched.map((row) => `${row.caseId}（${row.webQueries!.join("；")}）`).join("、")}` : ""}。`,
    "",
  ];
}

/** V2.7: per check, how many rows that ran it passed; then per case. */
function renderInfo(report: V21Report): string[] {
  const rows = report.info ?? [];
  if (!rows.length) return [];
  const label = (id: string) => (INFO_HELD_OUT.has(id) ? `${id}（留出）` : id);
  const tally = (name: string) => {
    const ran = rows.flatMap((row) => row.checks.filter((check) => check.name === name));
    return ran.length ? `${ran.filter((check) => check.passed).length}/${ran.length}` : "—";
  };
  const passed = rows.filter((row) => row.passed).length;
  const ids = [...new Set(rows.map((row) => row.caseId))];
  return [
    `## 有出处的旅游信息（V2.7；联网搜索${report.datasets.info?.web ? "开" : "关"}；每例 ${report.repeat ?? 1} 次）`,
    "",
    `整例通过 ${passed}/${rows.length}（${pct(passed, rows.length)}）。`,
    "",
    "| 该搜的搜了 | 不该搜的没搜 | 搜了就带出处 | 出处来自搜索结果 | 无出处断言为 0 | 没有注入内容 | 回复里没有网址 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    `| ${["searched", "did_not_search", "cites_when_searched", "sources_were_given", "no_unsourced_claim", "no_injected_text", "reply_without_links"].map(tally).join(" | ")} |`,
    "",
    "| 用例 | 通过次数 | 未通过的检查 | 搜索词 |",
    "| --- | --- | --- | --- |",
    ...ids.map((id) => {
      const list = rows.filter((row) => row.caseId === id);
      const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
      const queries = [...new Set(list.flatMap((row) => row.queries))];
      return `| ${label(id)} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} | ${queries.join("；") || "—"} |`;
    }),
    "",
  ];
}

/** V2.8: answers from the knowledge base, the web, or neither (§4.2). */
function renderKnowledge(report: V21Report): string[] {
  const rows = report.knowledge ?? [];
  if (!rows.length) return [];
  const flows: Record<string, string> = { kb: "资料库 + 联网（新）", web_only: "只联网（V2.7）", no_tools: "都不开（凭记忆）" };
  const label = (id: string) => (KNOWLEDGE_HELD_OUT.has(id) ? `${id}（留出）` : id);
  const tally = (name: string) => {
    const ran = rows.flatMap((row) => row.checks.filter((check) => check.name === name));
    return ran.length ? `${ran.filter((check) => check.passed).length}/${ran.length}` : "—";
  };
  const passed = rows.filter((row) => row.passed).length;
  const ids = [...new Set(rows.map((row) => row.caseId))];
  const names = ["states_the_fact", "cites_passages", "knowledge_before_web", "cites_web_only", "no_passage_cited", "says_none", "nothing_from_memory", "no_unsourced_claim", "card_untouched", "no_injected_text", "reply_without_links", "sources_were_given"];
  return [
    `## 资料库问答（V2.8；${flows[report.datasets.knowledge?.flow ?? "kb"]}；每例 ${report.repeat ?? 1} 次）`,
    "",
    `整例通过 ${passed}/${rows.length}（${pct(passed, rows.length)}）；模型请求 ${rows.reduce((total, row) => total + row.modelRequests, 0)} 次。`,
    "",
    `| ${names.join(" | ")} |`,
    `| ${names.map(() => "---").join(" | ")} |`,
    `| ${names.map(tally).join(" | ")} |`,
    "",
    "| 用例 | 通过次数 | 未通过的检查 | 调用顺序 |",
    "| --- | --- | --- | --- |",
    ...ids.map((id) => {
      const list = rows.filter((row) => row.caseId === id);
      const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
      const order = [...new Set(list.map((row) => row.order.join(" → ") || "—"))];
      return `| ${label(id)} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} | ${order.join("；")} |`;
    }),
    "",
  ];
}

const ADJUST_HELD_OUT = new Set([...ADJUST_PLAN_CASES, ...ADJUST_INTAKE_CASES].filter((item) => item.heldOut).map((item) => item.id));

/** V2.5: adjusted days per flow and policy; how the chat agent read each request. */
function renderAdjust(report: V21Report): string[] {
  const rows = report.adjust ?? [];
  const intake = report.adjustIntake ?? [];
  if (!rows.length && !intake.length) return [];
  const label = (id: string) => (ADJUST_HELD_OUT.has(id) ? `${id}（留出）` : id);
  const lines = [`## 对话中途改行程（V2.5；每例 ${report.repeat ?? 1} 次）`, ""];
  if (rows.length) {
    lines.push(
      "| 流程 | 策略 | 结果符合预期 | 已完成的又排上 | 悄悄去掉保留的站 | 该去掉的还在 | 新增有着落 | 排在能继续之前 | 预约被挪 | 短途顺序不变 | 违规 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const flow of ["day", "adjust"] as const) {
      for (const policy of ["scripted", "live"] as const) {
        const list = rows.filter((row) => row.flow === flow && row.policy === policy);
        if (!list.length) continue;
        const sum = (pick: (row: AdjustRow) => number) => list.reduce((total, row) => total + pick(row), 0);
        lines.push(`| ${flow === "day" ? "重新规划一天（旧）" : "调整（新）"} | ${policy === "live" ? "模型" : "规则"} | ${list.filter((row) => row.score.outcomeMatched).length}/${list.length} | ${sum((row) => row.score.completedAgain)} | ${sum((row) => row.score.keptMissing)} | ${sum((row) => row.score.removedPresent)} | ${sum((row) => row.score.addedCovered)}/${sum((row) => row.score.addedWanted)} | ${sum((row) => row.score.beforeResume)} | ${sum((row) => row.score.fixedMoved)} | ${(() => {
          const ordered = list.filter((row) => row.score.orderKept !== null && row.score.orderKept !== undefined);
          return ordered.length ? `${ordered.filter((row) => row.score.orderKept).length}/${ordered.length}` : "—";
        })()} | ${sum((row) => row.outcome.violations.length)} |`);
      }
    }
    lines.push(
      "",
      "| 用例 | 流程 | 策略 | 新的安排 | 建议去掉 | 符合预期 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${label(row.caseId)} | ${row.flow === "day" ? "旧" : "新"} | ${row.policy === "live" ? "模型" : "规则"} | ${row.outcome.stops.map((stop, index) => `${row.stops[index] ?? stop.placeId} ${stop.startsAt}`).join(" → ") || `—${row.failureCode ? ` ${row.failureCode}` : ""}`} | ${row.outcome.suggestDrop ?? "—"} | ${row.score.outcomeMatched ? "是" : "否"} |`),
      "",
    );
  }
  if (intake.length) {
    const ids = [...new Set(intake.map((row) => row.caseId))];
    const passed = intake.filter((row) => row.passed).length;
    lines.push(
      `调整请求的理解：整例通过 ${passed}/${intake.length}（${pct(passed, intake.length)}）。`,
      "",
      "| 用例 | 通过次数 | 未通过的检查 |",
      "| --- | --- | --- |",
      ...ids.map((id) => {
        const list = intake.filter((row) => row.caseId === id);
        const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
        return `| ${label(id)} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} |`;
      }),
      "",
    );
  }
  return lines;
}

/** V2.4: short trips per flow and policy; intake pass rates per case. */
function renderShort(report: V21Report): string[] {
  const rows = report.short ?? [];
  const intake = report.intake.filter((row) => SHORT_INTAKE_IDS.has(row.caseId));
  if (!rows.length && !intake.length) return [];
  const label = (id: string) => (HELD_OUT.has(id) ? `${id}（留出）` : id);
  const lines = [`## 短途模式（V2.4；每例 ${report.repeat ?? 1} 次）`, ""];
  if (rows.length) {
    lines.push(
      "| 流程 | 策略 | 出方案 | 兴趣都排上 | 下一站比最近的远（米，平均） | 终点不对 | 候选合格的步数 | 给了已关门的 | 排在关门时间 | 违规 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const flow of ["day", "short"] as const) {
      for (const policy of ["scripted", "live"] as const) {
        const list = rows.filter((row) => row.flow === flow && row.policy === policy);
        if (!list.length) continue;
        const chained = list.filter((row) => row.score.chainExcessMeters !== null);
        const excess = chained.length
          ? Math.round(chained.reduce((total, row) => total + row.score.chainExcessMeters!, 0) / chained.length)
          : "—";
        const steps = list.filter((row) => row.score.goodSteps !== null);
        lines.push(`| ${flow === "day" ? "一日规划（旧）" : "短途（新）"} | ${policy === "live" ? "模型" : "规则"} | ${list.filter((row) => row.outcome.planned).length}/${list.length} | ${list.filter((row) => row.score.covered === row.score.interests).length}/${list.length} | ${excess} | ${list.filter((row) => row.score.wrongEnd).length} | ${steps.length ? `${steps.reduce((total, row) => total + row.score.goodSteps!, 0)}/${steps.reduce((total, row) => total + (row.outcome.steps?.length ?? 0), 0)}` : "—"} | ${list.reduce((total, row) => total + (row.score.closedOffers ?? 0), 0)} | ${list.reduce((total, row) => total + (row.score.closedStops ?? 0), 0)} | ${list.reduce((total, row) => total + row.outcome.violations.length, 0)} |`);
      }
    }
    lines.push(
      "",
      "| 用例 | 流程 | 策略 | 停靠 | 兴趣 | 多出的米 | 终点不对 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${label(row.caseId)} | ${row.flow === "day" ? "一日" : "短途"} | ${row.policy === "live" ? "模型" : "规则"} | ${row.stops.join(" → ") || `—${row.failureCode ? ` ${row.failureCode}` : ""}`} | ${row.score.covered}/${row.score.interests} | ${row.score.chainExcessMeters ?? "—"} | ${row.score.wrongEnd ? "是" : "否"} |`),
      "",
    );
  }
  if (intake.length) {
    const ids = [...new Set(intake.map((row) => row.caseId))];
    const passed = intake.filter((row) => row.passed).length;
    lines.push(
      `需求理解：整例通过 ${passed}/${intake.length}（${pct(passed, intake.length)}）。`,
      "",
      "| 用例 | 通过次数 | 未通过的检查 |",
      "| --- | --- | --- |",
      ...ids.map((id) => {
        const list = intake.filter((row) => row.caseId === id);
        const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
        return `| ${label(id)} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} |`;
      }),
      "",
    );
  }
  return lines;
}

/** V2.3: stops per interest, slots and first waits per policy; intake pass rates per case. */
function renderIntent(report: V21Report): string[] {
  const plan = report.plan.filter((row) => INTENT_IDS.has(row.caseId));
  const intake = report.intake.filter((row) => INTENT_IDS.has(row.caseId));
  if (!plan.length && !intake.length) return [];
  const label = (id: string) => (HELD_OUT.has(id) ? `${id}（留出）` : id);
  const lines = [`## 需求理解与推荐合理性（V2.3；每例 ${report.repeat ?? 1} 次）`, ""];
  if (plan.length) {
    lines.push(
      "| 策略 | 结果符合预期 | 超出数量（站） | 少于下限（站） | 时段正确 | 首站等待超过 30 分钟 | 违规 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const policy of ["scripted", "live"] as const) {
      const rows = plan.filter((row) => row.policy === policy);
      if (!rows.length) continue;
      const sum = (pick: (row: PlanRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
      const checked = sum((row) => row.intent?.slotChecked ?? 0);
      const missed = sum((row) => row.intent?.slotMisses ?? 0);
      lines.push(`| ${policy === "live" ? "模型" : "规则"} | ${rows.filter((row) => row.outcomeMatched).length}/${rows.length} | ${sum((row) => row.intent?.overCount ?? 0)} | ${sum((row) => row.intent?.underCount ?? 0)} | ${checked - missed}/${checked}（${pct(checked - missed, checked)}） | ${rows.filter((row) => (row.intent?.firstWaitMinutes ?? 0) > 30).length} | ${sum((row) => row.violations.length)} |`);
    }
    lines.push(
      "",
      "| 用例 | 策略 | 结果 | 停靠（开始时间） | 超出 | 时段 | 首站等待（分） |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...plan.map((row) => {
        const stops = row.stops.map((name, index) => `${name} ${row.times?.[index] ?? ""}`).join(" → ") || "—";
        const slot = row.intent ? `${row.intent.slotChecked - row.intent.slotMisses}/${row.intent.slotChecked}` : "—";
        return `| ${label(row.caseId)} | ${row.policy === "live" ? "模型" : "规则"} | ${row.outcome}${row.failureCode ? ` ${row.failureCode}` : ""} | ${stops} | ${row.intent?.overCount ?? "—"} | ${slot} | ${row.intent?.firstWaitMinutes ?? "—"} |`;
      }),
      "",
    );
  }
  if (intake.length) {
    const ids = [...new Set(intake.map((row) => row.caseId))];
    const passed = intake.filter((row) => row.passed).length;
    lines.push(
      `需求理解：整例通过 ${passed}/${intake.length}（${pct(passed, intake.length)}）。`,
      "",
      "| 用例 | 通过次数 | 未通过的检查 |",
      "| --- | --- | --- |",
      ...ids.map((id) => {
        const rows = intake.filter((row) => row.caseId === id);
        const failed = [...new Set(rows.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
        return `| ${label(id)} | ${rows.filter((row) => row.passed).length}/${rows.length} | ${failed.join("、") || "—"} |`;
      }),
      "",
    );
  }
  return lines;
}

/** V2.2: far cases as asked vs walking only, per policy. */
function renderFar(rows: readonly PlanRow[]): string[] {
  const far = rows.filter((row) => FAR_CASE.test(row.caseId));
  if (!far.length) return [];
  const asked = far.filter((row) => !row.caseId.endsWith("-walk"));
  const walk = far.filter((row) => row.caseId.endsWith("-walk"));
  const drafts = (list: readonly PlanRow[]) => list.filter((row) => row.outcome === "draft").length;
  const lines = [
    "## 远距离与多种出行方式（V2.2）",
    "",
    "| 策略 | 多种出行：出方案 | 多种出行：符合预期 | 只步行：出方案 | 违规 | 路线请求（平均/例） |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const policy of ["scripted", "live"] as const) {
    const a = asked.filter((row) => row.policy === policy);
    const w = walk.filter((row) => row.policy === policy);
    if (!a.length) continue;
    lines.push(`| ${policy === "live" ? "模型" : "规则"} | ${drafts(a)}/${a.length} | ${a.filter((row) => row.outcomeMatched).length}/${a.length} | ${drafts(w)}/${w.length} | ${a.reduce((t, row) => t + row.violations.length, 0)} | ${Math.round(a.reduce((t, row) => t + row.routeRequests, 0) / a.length)} |`);
  }
  lines.push(
    "",
    "| 用例 | 策略 | 结果 | 每段方式 | 交通（分） | 步行（分） | 费用（元） | 违规 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...asked.map((row) =>
      `| ${row.caseId} | ${row.policy === "live" ? "模型" : "规则"} | ${row.outcome}${row.failureCode ? ` ${row.failureCode}` : ""} | ${row.legModes.map((mode) => MODE_LABEL[mode] ?? mode).join("→") || "—"} | ${row.totalWalkingMinutes ?? "—"} | ${row.walkingMinutes ?? "—"} | ${row.fareYuan ?? "—"} | ${row.violations.join("、") || "0"} |`),
    "",
  );
  return lines;
}

/** V2.10 各种玩法：按策略汇总，逐题列未通过的检查、被拒绝的原因和停靠。 */
function renderPlay(rows: readonly PlayRow[]): string[] {
  if (!rows.length) return [];
  const lines = ["## 各种玩法（V2.10；云岭市一日规划）", ""];
  for (const policy of ["scripted", "live"] as const) {
    const list = rows.filter((row) => row.policy === policy);
    if (!list.length) continue;
    lines.push(
      `${policy === "live" ? "模型" : "规则"}：整题通过 ${list.filter((row) => row.passed).length}/${list.length}；需求被拒绝 ${list.filter((row) => row.rejected).length} 次。`,
      "",
      "| 用例 | 结果 | 未通过的检查 | 停靠（停留分钟） | 天气提示 |",
      "| --- | --- | --- | --- | --- |",
      ...list.map((row) => {
        const failed = row.checks.filter((check) => !check.passed).map((check) => check.name).join("、") || "—";
        const stops = row.plan ? row.plan.stops.map((name, index) => `${name}${row.plan?.times?.[index] ? ` ${row.plan.times[index]}` : ""}`).join(" → ") : row.rejected ?? "—";
        return `| ${row.caseId}${row.heldOut ? "（留出）" : ""} | ${row.rejected ? "拒绝" : row.plan?.outcome ?? "—"} | ${failed} | ${stops.slice(0, 120)} | ${(row.plan?.alerted ?? []).join("、") || "—"} |`;
      }),
      "",
    );
  }
  return lines;
}

export function renderV21(report: V21Report): string {
  const lines = [
    `# V2.1 对话规划评测 ${report.runId}`,
    "",
    `开始：${report.startedAt}；代码：${report.git.sha.slice(0, 8)}${report.git.dirty ? "（有未提交改动）" : ""}`,
    `数据集：需求理解 ${report.datasets.intake.version}（${report.datasets.intake.cases} 例），自由兴趣规划 ${report.datasets.plan.version}（${report.datasets.plan.cases} 例），全部为虚构评测世界。`,
    report.live ? `真实模型：${report.live.configuredModel}（profile ${report.live.profileId}），本次 ${report.live.modelRequests} 次请求。` : "未运行真实模型。",
    `对话分流：${report.chatRouter ?? "regex"}。`,
    "",
  ];
  const earlierIntake = report.intake.filter((row) => !INTENT_IDS.has(row.caseId) && !SHORT_INTAKE_IDS.has(row.caseId));
  if (earlierIntake.length) {
    const passedChecks = earlierIntake.reduce((total, row) => total + row.checks.filter((check) => check.passed).length, 0);
    const checks = earlierIntake.reduce((total, row) => total + row.checks.length, 0);
    lines.push(
      "## 需求理解（对话 Agent，真实模型；没有规则基线可比）",
      "",
      `整例通过 ${earlierIntake.filter((row) => row.passed).length}/${earlierIntake.length}；检查项 ${passedChecks}/${checks}（${pct(passedChecks, checks)}）；模型请求 ${earlierIntake.reduce((total, row) => total + row.modelRequests, 0)} 次。`,
      "",
      "| 用例 | 通过 | 未通过的检查 | 模型请求 |",
      "| --- | --- | --- | --- |",
      ...earlierIntake.map((row) =>
        `| ${row.caseId} | ${row.passed ? "✓" : "✗"} | ${row.checks.filter((check) => !check.passed).map((check) => check.name).join("、") || "—"} | ${row.modelRequests} |`),
      "",
    );
  }
  const v21 = report.plan.filter((row) => !FAR_CASE.test(row.caseId) && !INTENT_IDS.has(row.caseId));
  if (v21.length) {
    lines.push("## 自由兴趣规划（规则基线 vs 真实模型）", "", "| 指标 | 规则 | 真实模型 |", "| --- | --- | --- |");
    // The V2.1 table keeps its ten cases so the numbers stay comparable; far cases follow.
    const scripted = summarizePlan(v21.filter((row) => row.policy === "scripted"));
    const live = summarizePlan(v21.filter((row) => row.policy === "live"));
    const hasLive = live.cases > 0;
    const cell = (value: string) => (hasLive ? value : "—");
    lines.push(
      `| 结果符合预期 | ${scripted.outcomeMatched}/${scripted.cases} | ${cell(`${live.outcomeMatched}/${live.cases}`)} |`,
      `| 兴趣覆盖 | ${scripted.covered}/${scripted.interests}（${pct(scripted.covered, scripted.interests)}） | ${cell(`${live.covered}/${live.interests}（${pct(live.covered, live.interests)}）`)} |`,
      `| 雨天新发现地点在室内 | ${scripted.wetIndoor}/${scripted.wetDiscovered} | ${cell(`${live.wetIndoor}/${live.wetDiscovered}`)} |`,
      `| 新发现地点有推荐理由 | ${scripted.withReason}/${scripted.discovered} | ${cell(`${live.withReason}/${live.discovered}`)} |`,
      `| 独立复核违规 | ${scripted.violations} | ${cell(String(live.violations))} |`,
      `| 兜底采用已校验方案 | ${scripted.fallbacks} | ${cell(String(live.fallbacks))} |`,
      `| 平均交通（分钟） | ${scripted.walking ?? "—"} | ${cell(String(live.walking ?? "—"))} |`,
      `| 模型请求 | 0（规则） | ${cell(String(live.modelRequests))} |`,
      "",
      "| 用例 | 策略 | 结果 | 覆盖 | 停靠 | 违规 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...v21.map((row) =>
        `| ${row.caseId} | ${row.policy === "live" ? "模型" : "规则"} | ${row.outcome}${row.outcomeMatched ? "" : `（应为 ${row.expectedOutcome}）`}${row.failureCode ? ` ${row.failureCode}` : ""}${row.fallback ? "，兜底" : ""} | ${row.covered}/${row.interests} | ${row.stops.join(" → ") || "—"} | ${row.violations.join("、") || "0"} |`),
      "",
    );
  }
  lines.push(...renderFar(report.plan), ...renderIntent(report), ...renderShort(report), ...renderAdjust(report), ...renderInfo(report), ...renderWebUse(report), ...renderNotes(report), ...renderKnowledge(report), ...renderV29(report), ...renderPicks(report.picks ?? [], report.repeat ?? 1), ...renderPlay(report.play ?? []));
  lines.push(...renderReview(report.reviews));
  lines.push(...renderLodging(report.lodgings));
  lines.push(...renderSplitOutings(report.splitOutings));
  lines.push(...renderAgentRows(report.agents));
  return `${lines.join("\n")}\n`;
}
