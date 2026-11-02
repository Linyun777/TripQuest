import "server-only";
import { requireOwner } from "../auth/owner";
import { preferenceCategorySchema, preferenceProblem, type PreferenceRepository } from "@tripquest/application/preferences";
import { DrizzlePreferenceRepository, getSharedJourneyDatabase } from "@tripquest/db";
import type { PreferenceView } from "./view-models";

/**
 * V2.9“我的偏好”：查看、修改、删除单条、全部删除。只有用户能改和删（模型只能提议新增）；
 * 删除即物理删除，不可恢复；对话里当初说过的原话不随之删除。
 */
export function createPreferencesService(options: { repository?: () => PreferenceRepository; now?: () => number; userId?: string } = {}) {
  const owner = () => requireOwner(options.userId);
  const repository = () => options.repository?.() ?? new DrizzlePreferenceRepository(getSharedJourneyDatabase().database, owner());
  const now = () => new Date((options.now ?? Date.now)());
  return {
    async list(): Promise<PreferenceView[]> {
      return (await repository().list()).map((item) => ({
        id: item.id,
        text: item.text,
        category: item.category,
        fromConversation: item.sourceConversationId !== null,
        createdAt: item.createdAt,
      }));
    },
    async update(id: string, input: { text: unknown; category: unknown }) {
      const category = preferenceCategorySchema.safeParse(input.category);
      if (typeof input.text !== "string" || !category.success || preferenceProblem(input.text)) return { status: "invalid" } as const;
      return repository().update({ id, text: input.text, category: category.data, now: now() });
    },
    remove: (id: string) => repository().remove(id),
    removeAll: () => repository().removeAll(),
  };
}
