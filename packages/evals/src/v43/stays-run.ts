import { afterOutingTurn } from "@tripquest/agent/outing-after-turn";
import type { AfterTurn } from "../v29/conversation-run";

/**
 * V4.3：评测里每轮对话之后由代码补卡片，和对话服务的做法一样（stages/V4.3.md §3.2–3.4）：认“住在哪”、挪车的日子、
 * 补车站和往返。城市和车站在评测世界里查。
 */
export const staysAfterTurn: AfterTurn = async ({ draft, userTexts, changed, previous }, world) =>
  afterOutingTurn(draft, userTexts, world, AbortSignal.timeout(10_000), { changed, ...(previous ? { previous } : {}) });
