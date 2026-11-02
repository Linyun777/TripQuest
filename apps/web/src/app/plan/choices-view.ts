import type { RequirementsDraft, StoredMessage } from "@tripquest/application/conversation";
import type { ChoicesView } from "./view-models";

/** V2.4: three rounds per step, the first offer and two "换一批". */
export const ROUNDS = 3;

/** A step as stored: names and reasons only; `meters` may be added from a live lookup. */
export function storedChoicesView(message: Extract<StoredMessage, { kind: "choices" }>, draft: RequirementsDraft, open: boolean, meters?: ReadonlyMap<string, number>): ChoicesView {
  return {
    id: message.id,
    role: "assistant",
    kind: "choices",
    tripId: message.body.tripId,
    step: message.body.step,
    total: draft.interests.length,
    interest: draft.interests.find((item) => item.id === message.body.interestId)?.text ?? "下一站",
    anchorName: message.body.anchor?.name ?? "你的位置",
    round: message.body.round,
    options: message.body.options.map((option) => ({
      externalId: option.externalId,
      name: option.name,
      reason: option.reason,
      ...(meters?.has(option.externalId) ? { meters: meters.get(option.externalId)! } : {}),
    })),
    chosen: message.body.chosen,
    open: open && !message.body.chosen,
    canRefresh: open && !message.body.chosen && message.body.round < ROUNDS,
  };
}
