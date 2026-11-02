import { S54_CASES } from "./dataset";
import type { Policy, S54Row } from "./run";

export interface S54Report {
  readonly runId: string;
  readonly startedAt: string;
  readonly dataset: { readonly version: string; readonly digest: string; readonly cases: number };
  readonly git: { readonly sha: string; readonly dirty: boolean | null };
  readonly policies: readonly Policy[];
  readonly live: null | {
    readonly round: string;
    readonly profileId: string;
    readonly configuredModel: string;
    readonly returnedModels: readonly string[];
  };
  readonly rows: readonly S54Row[];
}

const PLANNED = new Set(["draft", "candidate", "unchanged"]);

export interface PolicySummary {
  readonly policy: Policy;
  readonly rows: number;
  readonly passed: number;
  readonly mustPlan: { readonly total: number; readonly planned: number };
  readonly mustRefuse: { readonly total: number; readonly correct: number };
  readonly violations: number;
  readonly failures: readonly string[];
  readonly modelRequests: number;
  readonly tokens: number | null;
  readonly elapsedMs: number;
  readonly goal: { readonly checked: number; readonly met: number; readonly improved: number };
}

export function summarize(rows: readonly S54Row[], policy: Policy): PolicySummary {
  const mine = rows.filter((row) => row.policy === policy);
  const mustPlan = mine.filter((row) => row.expect === "must_plan");
  const mustRefuse = mine.filter((row) => row.expect === "must_refuse");
  const tokens = mine.map((row) => row.usage.tokens).filter((value): value is number => value !== null);
  const goal = mine.filter((row) => row.goalMet !== undefined);
  return {
    policy,
    rows: mine.length,
    passed: mine.filter((row) => row.passed).length,
    mustPlan: { total: mustPlan.length, planned: mustPlan.filter((row) => PLANNED.has(row.outcome)).length },
    mustRefuse: { total: mustRefuse.length, correct: mustRefuse.filter((row) => row.passed).length },
    violations: mine.reduce((sum, row) => sum + row.violations.length, 0),
    failures: mine
      .filter((row) => row.outcome === "failed" || row.outcome === "exception")
      .map((row) => `${row.caseId}:${row.reasons[0] ?? row.exception ?? row.outcome}` +
        (row.repairCodes.length ? `（首次被拒：${row.repairCodes.join("、")}）` : "")),
    modelRequests: mine.reduce((sum, row) => sum + row.usage.modelRequests, 0),
    tokens: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null,
    elapsedMs: mine.reduce((sum, row) => sum + row.usage.elapsedMs, 0),
    goal: {
      checked: goal.length,
      met: goal.filter((row) => row.goalMet).length,
      // Descriptive only: strictly better than the unchanged order on the chosen goal.
      improved: goal.filter((row) => row.metrics && row.baseline && (
        row.metrics.walking < row.baseline.walking ||
        row.metrics.activities < row.baseline.activities ||
        row.metrics.waiting < row.baseline.waiting
      )).length,
    },
  };
}

const cell = (value: unknown) => String(value ?? "—").replaceAll("|", "\\|");
const table = (header: readonly string[], rows: readonly (readonly unknown[])[]) => [
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
].join("\n");

export function renderS54(report: S54Report): string {
  const summaries = report.policies.map((policy) => summarize(report.rows, policy));
  const lines = [
    `# S5.4 规划与调整 Agent 小型评估 · ${report.runId}`,
    "",
    `开始：${report.startedAt}。数据：${report.dataset.version}（${report.dataset.cases} 例，SHA-256 \`${report.dataset.digest}\`）。` +
      `Git：\`${report.git.sha}\`${report.git.dirty === null ? "（状态未知）" : report.git.dirty ? "（有未提交改动）" : "（干净）"}。`,
    report.live
      ? `真实模型：轮次 ${report.live.round}，profile \`${report.live.profileId}\`，配置模型 \`${report.live.configuredModel}\`，` +
        `实际返回 ${report.live.returnedModels.map((model) => `\`${model}\``).join("、") || "（无）"}。`
      : "本次只运行规则策略，无模型、网络或费用。",
    "",
    "> 口径：全部为自有虚构演示地点与确定性路线，每例每种策略只运行一次，未测方差；规则策略成功不代表模型能力，" +
      "模型结果也只代表本数据集的演示环境。违规由评估独立复核：自行重查路线、调用领域校验，并按案例原文核对必去、固定、冻结与已完成事实。" +
      "决策次数在规则策略下是本地决策步数，在真实模型下等于模型请求数；分钟数均为整数分钟。",
    "",
    "## 汇总",
    "",
    table(
      ["策略", "符合预期", "应出方案→出方案", "应拒绝→正确拒绝", "违规", "目标达成/优于基线", "决策次数", "tokens", "用时 ms", "失败"],
      summaries.map((s) => [
        s.policy,
        `${s.passed}/${s.rows}`,
        `${s.mustPlan.planned}/${s.mustPlan.total}`,
        `${s.mustRefuse.correct}/${s.mustRefuse.total}`,
        s.violations,
        s.goal.checked ? `${s.goal.met}/${s.goal.checked}，${s.goal.improved}` : "—",
        s.modelRequests,
        s.tokens ?? "—",
        s.elapsedMs,
        s.failures.join("、") || "无",
      ]),
    ),
    "",
    "## 逐例",
    "",
    table(
      ["案例", "策略", "预期", "结果", "判定", "违规", "活动/步行/等待/余量", "基线 活动/步行/等待", "决策/搜索/试算/路线/纠错"],
      report.rows.map((row) => [
        `${row.caseId} ${row.title}`,
        row.policy,
        row.expect,
        `${row.outcome}${row.reasons.length
          ? `：${row.reasons.map((reason) => reason.replace(/^preflight:/, "")).join("、")}`
          : ""}${row.chosen ? `（${row.chosen}）` : ""}`,
        row.passed ? "✓" : `✗ ${row.misses.join("、")}`,
        row.violations.join("、") || "0",
        row.metrics
          ? `${row.metrics.activities} / ${row.metrics.walking} / ${row.metrics.waiting} / ${row.metrics.slack}`
          : "—",
        row.baseline ? `${row.baseline.activities} / ${row.baseline.walking} / ${row.baseline.waiting}` : "—",
        `${row.usage.modelRequests} / ${row.usage.searches} / ${row.usage.tries} / ${row.usage.routes} / ${row.usage.semanticRepairs}`,
      ]),
    ),
    "",
    "## 案例与手算依据",
    "",
    ...S54_CASES
      .filter((item) => report.rows.some((row) => row.caseId === item.id))
      .map((item) => `- **${item.id} ${item.title}**（${item.expect}）：${item.note}`),
    "",
  ];
  return lines.join("\n");
}
