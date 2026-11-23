import type { OpsReader } from "@tripquest/db";

export type Lists = Awaited<ReturnType<OpsReader["runs"]>>;
export type Detail = NonNullable<Awaited<ReturnType<OpsReader["detail"]>>>;
export type UsersSnapshot = Awaited<ReturnType<OpsReader["users"]>>;
export type UserOverview = UsersSnapshot["users"][number];
export type SiteQuota = UsersSnapshot["site"][number];
export type Cost = Detail["cost"];
export type BadgeTone = "neutral" | "lake" | "sun" | "rain" | "danger";

export const labels: Record<string, string> = {
  plan: "一日规划",
  outing: "多日规划",
  outing_generate: "生成出游",
  adjust: "调整行程",
  outing_change: "跨天改动",
  chat_turn: "对话",
  running: "运行中",
  interrupted: "已中断",
  done: "完成",
  ok: "完成",
  failed: "系统失败",
  none: "无可行计划",
  fallback: "已降级",
  cancelled: "已取消",
  budget_exhausted: "达到运行上限",
  model: "模型",
  amap: "地图",
  web: "联网",
  embed: "向量与重排",
  jev: "Jev",
  unsent: "未发送",
  reserved: "待核对",
  unknown: "待核对",
  legacy: "接入前",
  count_only: "仅计次",
  model_call: "模型调用",
  tool_call: "工具调用",
  repair: "修复",
  check: "校验",
  handoff: "子任务",
  decision: "模型决策",
  quota: "额度检查",
  user_limit: "触发个人日上限",
  site_limit: "触发全站日上限",
  live_budget: "调用额度已用完",
  quota_exceeded: "供应商或请求额度已用完",
  rate_limited: "触发限流",
  rate_limit: "触发限流",
  upstream_unavailable: "上游暂不可用",
  authorization_failed: "鉴权失败",
  auth: "鉴权失败",
  daily_limit: "达到每日限额",
  provider_error: "地图服务异常",
  model_error: "模型调用失败",
  internal_error: "内部错误",
  timeout: "请求超时",
  invalid_output: "返回格式异常",
  invalid_allocation: "分配方案无效",
  invalid_action: "动作无效",
  invalid_review: "审查输出无效",
  semantic_invalid: "方案校验未通过",
  day_unknown_activity: "未知活动编号",
  day_missing_required: "遗漏必去项",
  duplicate_order: "重复顺序",
  no_searches_left: "搜索次数已用完",
  named_untried: "点名地点未尝试",
  amap_search: "高德地点或城市查询",
  amap_detail: "高德地点详情",
  amap_route: "高德路线查询",
  amap_nearby: "高德附近地点",
  amap_weather: "高德天气",
  web_search: "联网搜索",
  ask_knowledge: "查询资料库",
  trial_plan: "多日修复试排",
  trial_change: "调整后复核",
  allocation: "分配各天行程",
  assessment: "评估行程",
  review: "审查方案",
  try_move: "尝试移动项目",
  try_moves: "尝试批量移动",
  try_swap: "尝试交换日期",
  try_add_interest: "尝试添加兴趣",
  try_travel: "尝试调整交通",
  try_drop: "尝试移除项目",
  "day-planner": "单日规划",
  "outing-allocator": "多日分配",
  "outing-reviewer": "出游审查",
  "outing-judge": "质量判断",
  "outing-repair": "出游修复",
  "short-picker": "短途挑点",
  "chat-intake": "需求收集",
  "chat-trip": "行程调整",
  "chat-info": "资料问答",
  "chat-advice": "出行建议",
  "chat-companion": "陪聊偏好",
  "chat-summary": "对话摘要",
  "trip-notes": "出发须知",
  search_place: "查询地点",
  search_places: "查询地点",
  search_nearby: "周边搜索",
  lookup_nearby: "查找附近",
  inspect_place: "查看地点详情",
  get_weather: "查天气",
  update_requirements: "更新需求卡",
  try_itinerary: "试排行程",
  try_order: "试排顺序",
  finish: "提交结果",
  keep: "保留修改",
  suggest: "生成建议",
  findings: "发现问题",
  rejected: "已打回",
  baseline: "规则兜底",
  root: "根运行",
  other: "其他",
  route: "查询路线",
  result: "检查结果",
};

export const name = (s: string) =>
  s
    .split("+")
    .map((part) => labels[part] ?? part)
    .join(" + ");

export function duration(ms: number | null) {
  if (ms === null) return "耗时未知";
  return ms < 1000 ? ms + " 毫秒" : (ms / 1000).toFixed(1) + " 秒";
}

export const beijingTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

export const beijingDate = (iso: string) =>
  new Date(iso).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });

export function trimAmount(amount: string) {
  return amount.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function money(c: Cost) {
  const known = Object.entries(c.amounts).map(([k, v]) => k + " " + v);
  if (c.pending) known.push((known.length ? "" : "费用待核对 · ") + c.pending + " 笔待核对");
  return known.join(" · ") || "暂无计价样本";
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "done":
    case "ok":
      return "lake";
    case "running":
      return "rain";
    case "failed":
    case "budget_exhausted":
      return "danger";
    case "fallback":
    case "interrupted":
      return "sun";
    default:
      return "neutral";
  }
}

export function stepTone(kind: string): BadgeTone {
  switch (kind) {
    case "model_call":
      return "lake";
    case "tool_call":
      return "rain";
    case "repair":
      return "sun";
    default:
      return "neutral";
  }
}

export function codeTone(code: string): BadgeTone {
  if (
    /error|failed|exceeded|limit|timeout|unavailable|auth|budget|missing|unknown|invalid|rejected/.test(
      code,
    )
  ) {
    return "danger";
  }
  return "sun";
}
