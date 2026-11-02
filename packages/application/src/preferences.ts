import { z } from "zod";

/**
 * V2.9 长期偏好（stages/V2.9.md §3.4）。只在用户点“记住”后保存；最多 30 条；只有用户能修改和
 * 删除，删除即物理删除。正文是用户原话的简短改写，不含位置、住处、坐标、证件或电话号码。
 */
export const PREFERENCE_CATEGORIES = ["food", "pace", "travel", "interest", "other"] as const;
export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number];
export const MAX_PREFERENCES = 30;
export const PREFERENCE_TEXT_LIMIT = 40;

export const preferenceCategorySchema = z.enum(PREFERENCE_CATEGORIES);
export const preferenceTextSchema = z.string().trim().min(1).max(PREFERENCE_TEXT_LIMIT);

/** 不能成为偏好的内容：住处与楼栋、坐标、手机号、身份证号、邮箱。 */
const PRIVATE = [
  /小区|公寓|宿舍|我家|家附近|住在|住处|酒店房间|\d+\s*(幢|栋|号楼|单元|室)/,
  /\d{2,3}\.\d{3,}/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
];

/**
 * V2.10：号码类隐私（坐标、手机号、身份证号、邮箱）。卡片备注也不能有：P04 里模型把手机号写进备注，
 * 再回复“记下了”。住处类说法不算在内，“从酒店出发”这类备注规划时有用。
 */
export function hasPrivateNumber(text: string): boolean {
  return PRIVATE.slice(1).some((pattern) => pattern.test(text));
}

/** 偏好正文不合规的原因；null 表示可以提议或保存。 */
export function preferenceProblem(text: string): "empty" | "too_long" | "private" | null {
  const value = text.trim();
  if (!value) return "empty";
  if ([...value].length > PREFERENCE_TEXT_LIMIT) return "too_long";
  return PRIVATE.some((pattern) => pattern.test(value)) ? "private" : null;
}

export interface StoredPreference {
  readonly id: string;
  readonly text: string;
  readonly category: PreferenceCategory;
  /** 从哪个对话的哪条消息来（对话删除后为空；偏好本身保留）。 */
  readonly sourceConversationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SaveProposalOutcome =
  | { readonly status: "saved"; readonly preference: StoredPreference }
  | { readonly status: "not_found" | "already_decided" | "limit" | "invalid" };

export interface PreferenceRepository {
  list(): Promise<StoredPreference[]>;
  /** 用户在提议卡片上点“记住”：写入偏好并把卡片标为已保存（同一事务）。 */
  saveProposal(input: { conversationId: string; messageId: string; newId: string; now: Date }): Promise<SaveProposalOutcome>;
  /** 点“不用”：卡片标为已忽略，不写入。 */
  dismissProposal(input: { conversationId: string; messageId: string; now: Date }): Promise<{ status: "dismissed" | "not_found" | "already_decided" }>;
  update(input: { id: string; text: string; category: PreferenceCategory; now: Date }): Promise<{ status: "updated" | "not_found" | "invalid" }>;
  remove(id: string): Promise<{ status: "removed" | "not_found" }>;
  removeAll(): Promise<number>;
}
