import { ROUTE_FLAGS } from "./route-dataset";
import { summarizeRoute, type RouteRow } from "./route-run";
import type { ConversationRow } from "./conversation-run";

/** 对话模型的提示缓存命中率（DeepSeek 返回的命中 / 命中 + 未命中输入 tokens）。 */
function cacheRate(rows: readonly ConversationRow[]): string {
  const hit = rows.reduce((sum, row) => sum + (row.cache?.hit ?? 0), 0);
  const miss = rows.reduce((sum, row) => sum + (row.cache?.miss ?? 0), 0);
  return hit + miss > 0 ? `提示缓存命中率 ${Math.round((hit / (hit + miss)) * 100)}%；` : "";
}

/** V2.9.2：Jev 的实际版本与费用（每百万输入 tokens 0.042 美元，输出免费）。 */
function jevCost(rows: readonly RouteRow[]): string {
  const models = [...new Set(rows.flatMap((row) => (row.model ? [row.model] : [])))];
  const tokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  if (!tokens) return "";
  const perThousand = (tokens / rows.length) * 1000;
  // Jev 按每百万输入 tokens 0.042 美元计（官方价格页）；DeepSeek 只报 tokens（含缓存命中的部分）。
  return models.length
    ? `版本 ${models.join("、")}；每千条输入约 ${Math.round(perThousand)} tokens（约 ${((perThousand / 1e6) * 0.042).toFixed(4)} 美元）；`
    : `每千条输入约 ${Math.round(perThousand)} tokens；`;
}

/** V2.9.3：每轮总耗时（含分流）的中位数和 90 分位，以及分流平均每轮多用的输入 tokens。 */
function turnTimes(rows: readonly ConversationRow[]): string {
  const times = rows.flatMap((row) => row.turnMs ?? []).sort((a, b) => a - b);
  if (!times.length) return "";
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  const tokens = rows.reduce((sum, row) => sum + (row.routeTokens ?? 0), 0);
  return `每轮耗时中位 ${at(0.5)} ms、90 分位 ${at(0.9)} ms；${tokens ? `分流每轮约 ${Math.round(tokens / times.length)} 输入 tokens；` : ""}`;
}

/** V2.9 的报告段落：分流按实现汇总；对话类按题汇总，每题跑多次时报通过次数。 */
export function renderV29(report: { readonly route?: readonly RouteRow[]; readonly conversations?: readonly ConversationRow[]; readonly repeat?: number }): string[] {
  const lines: string[] = [];
  const routes = report.route ?? [];
  for (const router of [...new Set(routes.map((row) => row.router))]) {
    for (const part of [{ label: "非留出", rows: routes.filter((row) => row.router === router && !row.heldOut) }, { label: "留出", rows: routes.filter((row) => row.router === router && row.heldOut) }]) {
      if (!part.rows.length) continue;
      const summary = summarizeRoute(part.rows);
      const harmful = Object.entries(summary.harmful).map(([kind, count]) => `${kind} ${count}`).join("、") || "0";
      lines.push(
        `## 意图分流（V2.9；${router}；${part.label} ${summary.rows} 条）`,
        "",
        `整条完全正确 ${summary.exact}/${summary.rows}；有害错误：${harmful}；延迟中位 ${summary.latency.p50} ms，90 分位 ${summary.latency.p90} ms；${part.rows.some((row) => row.router === "cascade") ? `改问 DeepSeek ${part.rows.filter((row) => row.escalated).length} 条；` : ""}${jevCost(part.rows)}部分判断用正则补 ${summary.fallback.partial} 条，整条退回正则 ${summary.fallback.whole} 条（${[...new Set(part.rows.flatMap((row) => (row.failure ? [row.failure] : [])))].map((code) => `${code} ${part.rows.filter((row) => row.failure === code).length}`).join("、") || "无"}）。`,
        "",
        `| 判断 | ${ROUTE_FLAGS.join(" | ")} |`,
        `| --- | ${ROUTE_FLAGS.map(() => "---").join(" | ")} |`,
        `| 精确率 | ${ROUTE_FLAGS.map((flag) => summary.perFlag[flag].precision ?? "—").join(" | ")} |`,
        `| 召回率 | ${ROUTE_FLAGS.map((flag) => summary.perFlag[flag].recall ?? "—").join(" | ")} |`,
        "",
        "| 用例 | 真值 | 判断 | 有害错误 | 正则补的 |",
        "| --- | --- | --- | --- | --- |",
        ...part.rows.filter((row) => !row.exact).map((row) => `| ${row.caseId} | ${row.truth.join("+")} | ${row.predicted.join("+") || "—"} | ${row.harmful.join("、") || "—"} | ${row.fallback.length === 7 ? "整条" : row.fallback.join("+") || "—"} |`),
        "",
      );
    }
  }
  const titles = { talk: "闲聊与建议", pref: "长期偏好", long: "长对话", fix: "提示词检查修正（V2.9.1）", e2e: "端到端分流（V2.9.3）", city: "城市理解（V2.10）", kbcity: "资料库按城市过滤（V2.10）", daily: "日常只做单城市（V2.11）", stay: "停留来源（V2.11）", outing: "出游需求理解（V2.11）", split: "对话拆分（V3.4）" } as const;
  for (const suite of ["talk", "pref", "long", "fix", "e2e", "city", "kbcity", "daily", "stay", "outing", "split"] as const) {
    const rows = (report.conversations ?? []).filter((row) => row.suite === suite);
    if (!rows.length) continue;
    const ids = [...new Set(rows.map((row) => row.caseId))];
    const names = [...new Set(rows.flatMap((row) => row.checks.map((check) => check.name)))];
    const tally = (name: string) => {
      const ran = rows.flatMap((row) => row.checks.filter((check) => check.name === name));
      return `${ran.filter((check) => check.passed).length}/${ran.length}`;
    };
    // 每题多次时报平均（整例通过的比例）和最低（通过次数最少的那一题）。
    const perCase = ids.map((id) => {
      const list = rows.filter((row) => row.caseId === id);
      return list.filter((row) => row.passed).length / list.length;
    });
    lines.push(
      `## ${titles[suite]}（V2.9；每例 ${report.repeat ?? 1} 次）`,
      "",
      `整例通过 ${rows.filter((row) => row.passed).length}/${rows.length}；${cacheRate(rows)}${turnTimes(rows)}各题通过率平均 ${Math.round((perCase.reduce((sum, value) => sum + value, 0) / perCase.length) * 100)}%，最低 ${Math.round(Math.min(...perCase) * 100)}%。`,
      "",
      `| ${names.join(" | ")} |`,
      `| ${names.map(() => "---").join(" | ")} |`,
      `| ${names.map(tally).join(" | ")} |`,
      "",
      "| 用例 | 通过次数 | 未通过的检查 | 最后一次回复 |",
      "| --- | --- | --- | --- |",
      ...ids.map((id) => {
        const list = rows.filter((row) => row.caseId === id);
        const failed = [...new Set(list.flatMap((row) => row.checks.filter((check) => !check.passed).map((check) => check.name)))];
        const reply = (list.at(-1)?.replies.at(-1) ?? "").replace(/\|/g, "／").replace(/\n/g, " ").slice(0, 80);
        return `| ${id}${list[0].heldOut ? "（留出）" : ""} | ${list.filter((row) => row.passed).length}/${list.length} | ${failed.join("、") || "—"} | ${reply} |`;
      }),
      "",
    );
  }
  return lines;
}
