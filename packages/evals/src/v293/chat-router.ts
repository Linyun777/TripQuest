import type { IntentRouter } from "@tripquest/agent/intent";

/**
 * V2.9.3：整次评测用哪种分流（`--router regex|deepseek`）。所有走对话 Agent 的评测（需求理解、调整理解、
 * 信息问答、资料库、V2.9 对话题、端到端分流题）都从这里取，换分流时不用逐个改 runner 的参数。
 * 不设时用产品缺省（正则）。
 */
let current: IntentRouter | undefined;

export function setEvalChatRouter(router: IntentRouter | undefined): void {
  current = router;
}

export function evalChatRouter(): { readonly router?: IntentRouter } {
  return current ? { router: current } : {};
}
