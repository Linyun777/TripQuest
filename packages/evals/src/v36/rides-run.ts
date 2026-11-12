import { afterOutingTurn } from "@tripquest/agent/outing-after-turn";
import type { AfterTurn } from "../v29/conversation-run";

/**
 * V3.6：评测里每轮对话之后补交通，和对话服务的做法一样（stages/V3.6.md §3.4）：出游卡片、车站在评测世界里搜。
 * V4.3 起对话服务每轮之后走 afterOutingTurn（先认“住在哪”、挪车的日子，再补交通），这里跟着走。
 */
export const fillRidesAfterTurn: AfterTurn = async ({ draft, userTexts, changed, previous }, world) =>
  afterOutingTurn(draft, userTexts, world, AbortSignal.timeout(10_000), { changed, ...(previous ? { previous } : {}) });
