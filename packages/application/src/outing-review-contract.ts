import { z } from "zod";
import { INTEREST_SLOTS, type InterestSlot } from "./planning-requirements";

/**
 * V3.2 审查 Agent 的修改（stages/V3.2.md §3.3）：6 种动作，每条带一句中文理由。审查 Agent 输出它，代码检查后直接改或
 * 作为建议存进对话（`outing_review` 消息），用户采纳时再换成卡片补丁。只有编号、天数和兴趣原话，没有地点数据。
 */
const reason = z.string().trim().min(1).max(80);
const dayNumber = z.number().int().min(1).max(7);
export const reviewFixSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("move_visit"), visit: z.string().regex(/^v\d{1,2}$/), toDay: dayNumber, reason }),
  z.strictObject({ action: z.literal("move_interest"), interest: z.string().regex(/^i\d{1,2}$/), toDay: dayNumber, reason }),
  z.strictObject({ action: z.literal("swap_days_content"), days: z.tuple([dayNumber, dayNumber]), reason }),
  z.strictObject({
    action: z.literal("add_interest"),
    day: dayNumber,
    text: z.string().trim().min(2).max(20),
    when: z.enum(Object.keys(INTEREST_SLOTS) as [InterestSlot, ...InterestSlot[]]).optional(),
    reason,
  }),
  z.strictObject({
    action: z.literal("set_day_travel"),
    day: dayNumber,
    remove: z.array(z.enum(["driving", "taxi", "transit", "walking", "bicycling"])).min(1).max(3),
    reason,
  }),
  z.strictObject({ action: z.literal("drop_visit"), visit: z.string().regex(/^v\d{1,2}$/), reason }),
]);
export type ReviewFix = z.infer<typeof reviewFixSchema>;

/**
 * V3.3 换住处（stages/V3.3.md §3.5）：代码给的建议，不在审查 Agent 的输出里。把这一段连住的每一晚换成高德查到的
 * 一家住处，只存编号、名称和城市；理由写离这几天的站多远。
 */
export const chooseLodgingFixSchema = z.strictObject({
  action: z.literal("choose_lodging"),
  nights: z.array(dayNumber).min(1).max(6),
  place: z.strictObject({
    externalId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    name: z.string().trim().min(1).max(80),
    city: z.string().regex(/^\d{6}$/).optional(),
  }),
  reason: z.string().trim().min(1).max(120),
});
export type ChooseLodgingFix = z.infer<typeof chooseLodgingFixSchema>;

/** 存进建议消息的修改：审查 Agent 的 6 种，加代码给的换住处。 */
export const suggestionFixSchema = z.discriminatedUnion("action", [...reviewFixSchema.options, chooseLodgingFixSchema]);
export type SuggestionFix = z.infer<typeof suggestionFixSchema>;
