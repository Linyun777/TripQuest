import { afterOutingTurn } from "@tripquest/agent/outing-after-turn";
import type { AfterTurn } from "../v29/conversation-run";

/**
 * V4.4：评测里每轮对话之后由代码补卡片，和对话服务的做法一样（出游走 V4.3 的补卡片；日常卡片不动）。
 */
export const datesAfterTurn: AfterTurn = async ({ draft, userTexts, changed, previous }, world) =>
  afterOutingTurn(draft, userTexts, world, AbortSignal.timeout(10_000), { changed, ...(previous ? { previous } : {}) });
