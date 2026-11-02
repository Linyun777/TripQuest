import { parseStoredMessage } from "@tripquest/application/conversation";
import {
  MAX_PREFERENCES,
  preferenceCategorySchema,
  preferenceProblem,
  type PreferenceCategory,
  type PreferenceRepository,
  type SaveProposalOutcome,
  type StoredPreference,
} from "@tripquest/application/preferences";
import { and, asc, count, eq } from "drizzle-orm";
import type { JourneyDatabase } from "./connection";
import { conversationMessages, conversations, preferences } from "./schema";

const toStored = (row: typeof preferences.$inferSelect): StoredPreference => ({
  id: row.id,
  text: row.text,
  category: preferenceCategorySchema.parse(row.category),
  sourceConversationId: row.sourceConversationId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * V2.9：长期偏好。写入只来自用户点“记住”；修改和删除只来自“我的偏好”页。
 * V2.12：仓库绑定一个用户，只读写这个用户的偏好，提议卡片只认这个用户自己的对话；上限按每人 30 条。
 */
export class DrizzlePreferenceRepository implements PreferenceRepository {
  constructor(
    private readonly database: JourneyDatabase,
    private readonly userId: string,
  ) {}

  private mine(id: string) {
    return and(eq(preferences.id, id), eq(preferences.userId, this.userId));
  }

  /** 提议卡片：这个用户的对话里的这条消息（锁住消息，防止两个标签页同时决定）。 */
  private async proposal(transaction: Parameters<Parameters<JourneyDatabase["transaction"]>[0]>[0], conversationId: string, messageId: string) {
    const [row] = await transaction
      .select({ message: conversationMessages })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(
        eq(conversationMessages.id, messageId),
        eq(conversationMessages.conversationId, conversationId),
        eq(conversations.userId, this.userId),
      ))
      .for("update", { of: conversationMessages });
    return row?.message;
  }

  async list(): Promise<StoredPreference[]> {
    const rows = await this.database
      .select()
      .from(preferences)
      .where(eq(preferences.userId, this.userId))
      .orderBy(asc(preferences.createdAt), asc(preferences.id));
    return rows.map(toStored);
  }

  async saveProposal(input: { conversationId: string; messageId: string; newId: string; now: Date }): Promise<SaveProposalOutcome> {
    return this.database.transaction(async (transaction) => {
      const row = await this.proposal(transaction, input.conversationId, input.messageId);
      if (!row) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...row, createdAt: row.createdAt.toISOString() });
      if (message.kind !== "preference_proposal") return { status: "not_found" } as const;
      // 卡片只能决定一次；锁内检查防止两个标签页重复保存同一条。
      if (message.body.status !== "pending") return { status: "already_decided" } as const;
      if (preferenceProblem(message.body.text)) return { status: "invalid" } as const;
      // 上限按每人在同一事务里数。
      const [{ total }] = await transaction.select({ total: count() }).from(preferences).where(eq(preferences.userId, this.userId));
      if (total >= MAX_PREFERENCES) return { status: "limit" } as const;
      const [saved] = await transaction.insert(preferences).values({
        id: input.newId,
        userId: this.userId,
        text: message.body.text.trim(),
        category: message.body.category,
        sourceConversationId: input.conversationId,
        createdAt: input.now,
        updatedAt: input.now,
      }).returning();
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, status: "saved", preferenceId: input.newId } })
        .where(eq(conversationMessages.id, row.id));
      await transaction
        .update(conversations)
        .set({ updatedAt: input.now })
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, this.userId)));
      return { status: "saved", preference: toStored(saved) } as const;
    });
  }

  async dismissProposal(input: { conversationId: string; messageId: string; now: Date }) {
    return this.database.transaction(async (transaction) => {
      const row = await this.proposal(transaction, input.conversationId, input.messageId);
      if (!row) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...row, createdAt: row.createdAt.toISOString() });
      if (message.kind !== "preference_proposal") return { status: "not_found" } as const;
      if (message.body.status !== "pending") return { status: "already_decided" } as const;
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, status: "dismissed" } })
        .where(eq(conversationMessages.id, row.id));
      return { status: "dismissed" } as const;
    });
  }

  async update(input: { id: string; text: string; category: PreferenceCategory; now: Date }) {
    if (preferenceProblem(input.text)) return { status: "invalid" } as const;
    const rows = await this.database
      .update(preferences)
      .set({ text: input.text.trim(), category: input.category, updatedAt: input.now })
      .where(this.mine(input.id))
      .returning({ id: preferences.id });
    return { status: rows.length ? "updated" : "not_found" } as const;
  }

  async remove(id: string) {
    const rows = await this.database.delete(preferences).where(this.mine(id)).returning({ id: preferences.id });
    return { status: rows.length ? "removed" : "not_found" } as const;
  }

  async removeAll(): Promise<number> {
    const rows = await this.database.delete(preferences).where(eq(preferences.userId, this.userId)).returning({ id: preferences.id });
    return rows.length;
  }
}
