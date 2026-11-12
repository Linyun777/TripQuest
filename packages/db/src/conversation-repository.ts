import { fingerprint } from "@tripquest/application/fingerprint";
import {
  conversationSummarySchema,
  emptyDraft,
  parseStoredMessage,
  requirementsDraftSchema,
  type AppendOutcome,
  type ConversationRepository,
  type DraftUpdateOutcome,
  type StoredConversation,
  type StoredMessage,
} from "@tripquest/application/conversation";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { JourneyDatabase } from "./connection";
type Transaction = Parameters<Parameters<JourneyDatabase["transaction"]>[0]>[0];
import { chatTraces, conversationMessages, conversations } from "./schema";

type ConversationRow = typeof conversations.$inferSelect;

function toConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status as StoredConversation["status"],
    journeyId: row.journeyId,
    draft: requirementsDraftSchema.parse(row.draft),
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.summary ? { summary: conversationSummarySchema.parse(row.summary) } : {}),
  };
}

/**
 * 对话正文进出数据库都按消息类型重新校验，避免历史 JSON 结构异常被直接交给页面或 Agent。
 * V2.12：仓库绑定一个用户（stages/V2.12.md §3.4），只读写这个用户的对话；别人的对话和不存在一样（not_found / null）。
 * 消息、决策记录没有自己的用户列，先确认它们所属的对话是这个用户的。
 */
export class DrizzleConversationRepository implements ConversationRepository {
  constructor(
    private readonly database: JourneyDatabase,
    private readonly userId: string,
  ) {}

  private mine(id: string) {
    return and(eq(conversations.id, id), eq(conversations.userId, this.userId));
  }

  /** 对话是不是这个用户的；写消息前锁住对话根（同 appendTurn 的锁序）。 */
  private async owns(transaction: Transaction, id: string): Promise<boolean> {
    const [row] = await transaction.select({ id: conversations.id }).from(conversations).where(this.mine(id)).for("update");
    return !!row;
  }

  async createConversation(input: { id: string; title: string; now: Date }): Promise<StoredConversation> {
    const [row] = await this.database
      .insert(conversations)
      .values({
        id: input.id,
        userId: this.userId,
        title: input.title,
        draft: emptyDraft(),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return toConversation(row);
  }

  async findConversation(id: string): Promise<{ conversation: StoredConversation; messages: StoredMessage[] } | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction.select().from(conversations).where(this.mine(id));
      if (!row) return null;
      const rows = await transaction
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .orderBy(asc(conversationMessages.seq));
      return {
        conversation: toConversation(row),
        messages: rows.map((message) => parseStoredMessage({ ...message, createdAt: message.createdAt.toISOString() })),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /**
   * 查找最初保存这份行程的对话，供行程页回到原规划上下文。日常的行程编号在方案卡片上；出游各天各段的在
   * outing_day 的 parts 里（跨天改动换过的天是新存的那条）。
   */
  async findConversationIdByJourney(journeyId: string): Promise<string | null> {
    const inOutingDay = JSON.stringify([{ plan: { journeyId } }]);
    const [row] = await this.database
      .select({ conversationId: conversationMessages.conversationId })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(
        eq(conversations.userId, this.userId),
        or(
          and(eq(conversationMessages.kind, "plan_card"), sql`${conversationMessages.body}->>'journeyId' = ${journeyId}`),
          and(eq(conversationMessages.kind, "outing_day"), sql`${conversationMessages.body}->'parts' @> ${inOutingDay}::jsonb`),
        ),
      ))
      .limit(1);
    return row?.conversationId ?? null;
  }

  async findConversationIdByClientId(clientId: string): Promise<string | null> {
    const [row] = await this.database
      .select({ conversationId: conversationMessages.conversationId })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(
        eq(conversations.userId, this.userId),
        eq(conversationMessages.role, "user"),
        eq(conversationMessages.kind, "text"),
        sql`${conversationMessages.body}->>'clientId' = ${clientId}`,
      ))
      .limit(1);
    return row?.conversationId ?? null;
  }

  // 锁住对话根后比较调用方读到的消息数，一次提交用户消息、助手回复、卡片与计数。
  // 模型调用期间不持锁；若另一个标签页先写入，这一轮返回 conflict，由页面刷新。
  async appendTurn(input: Parameters<ConversationRepository["appendTurn"]>[0]): Promise<AppendOutcome> {
    const messages = input.messages.map((message) => parseStoredMessage({
      id: input.newId(),
      seq: 1,
      role: message.role,
      kind: message.kind,
      body: message.body,
      createdAt: input.now.toISOString(),
    }));
    const draft = input.draft ? requirementsDraftSchema.parse(input.draft) : undefined;
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ messageCount: conversations.messageCount })
        .from(conversations)
        .where(this.mine(input.conversationId))
        .for("update");
      if (!row) return { status: "not_found" } as const;
      if (row.messageCount !== input.expectedCount) return { status: "conflict" } as const;
      // 消息序号从锁内的最新计数连续分配，整轮消息和草案一起提交，页面不会读到半轮对话。
      const messageCount = row.messageCount + messages.length;
      if (messages.length > 0) {
        await transaction.insert(conversationMessages).values(messages.map((message, index) => ({
          id: message.id,
          conversationId: input.conversationId,
          seq: row.messageCount + index + 1,
          role: message.role,
          kind: message.kind,
          body: message.body,
          createdAt: input.now,
        })));
      }
      await transaction
        .update(conversations)
        .set({
          messageCount,
          updatedAt: input.now,
          ...(draft ? { draft } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.journeyId ? { journeyId: input.journeyId, status: "planned" } : {}),
        })
        .where(this.mine(input.conversationId));
      return { status: "appended", messageCount } as const;
    });
  }

  async markPlanSaved(input: Parameters<ConversationRepository["markPlanSaved"]>[0]): Promise<{ status: "updated" | "not_found" }> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return { status: "not_found" } as const;
      const rows = await transaction
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, input.conversationId))
        .for("update");
      const plan = rows.find((row) => row.kind === "plan_card" && (row.body as { runId?: string }).runId === input.runId);
      if (!plan) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...plan, createdAt: plan.createdAt.toISOString() });
      if (message.kind !== "plan_card") return { status: "not_found" } as const;
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, journeyId: input.journeyId } })
        .where(eq(conversationMessages.id, plan.id));
      await transaction
        .update(conversations)
        .set({ journeyId: input.journeyId, status: "planned", updatedAt: input.now })
        .where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async markOutingSaved(input: Parameters<ConversationRepository["markOutingSaved"]>[0]): Promise<{ status: "updated" | "not_found" }> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return { status: "not_found" } as const;
      const rows = await transaction
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, input.conversationId))
        .for("update");
      const days = rows.filter((row) => row.kind === "outing_day" && (row.body as { generationId?: string }).generationId === input.generationId);
      if (!days.length) return { status: "not_found" } as const;
      for (const row of days) {
        const message = parseStoredMessage({ ...row, createdAt: row.createdAt.toISOString() });
        if (message.kind !== "outing_day") continue;
        const parts = message.body.parts.map((part) => {
          if (part.kind !== "plan") return part;
          const saved = input.journeys.find((item) => item.day === message.body.day && item.part === part.segment);
          return saved ? { ...part, plan: { ...part.plan, journeyId: saved.journeyId } } : part;
        });
        await transaction
          .update(conversationMessages)
          .set({ body: { ...message.body, parts, tripId: input.tripId } })
          .where(eq(conversationMessages.id, row.id));
      }
      // 对话关联第一天的第一段：进度面板从它找到这趟出游（journeys.trip_id）。
      const first = [...input.journeys].sort((a, b) => a.day - b.day || a.part - b.part)[0];
      await transaction
        .update(conversations)
        .set({ ...(first ? { journeyId: first.journeyId } : {}), status: "planned", updatedAt: input.now })
        .where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async markAdjustSaved(input: Parameters<ConversationRepository["markAdjustSaved"]>[0]): Promise<{ status: "updated" | "not_found" }> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return { status: "not_found" } as const;
      const rows = await transaction
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, input.conversationId))
        .for("update");
      const card = rows.find((row) => row.kind === "adjust_card" && (row.body as { runId?: string }).runId === input.runId);
      if (!card) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...card, createdAt: card.createdAt.toISOString() });
      if (message.kind !== "adjust_card") return { status: "not_found" } as const;
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, savedVersion: input.planVersion } })
        .where(eq(conversationMessages.id, card.id));
      await transaction.update(conversations).set({ updatedAt: input.now }).where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async chooseOption(input: Parameters<ConversationRepository["chooseOption"]>[0]): Promise<{ status: "updated" | "not_found" | "conflict" }> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return { status: "not_found" } as const;
      const [row] = await transaction
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, input.messageId), eq(conversationMessages.conversationId, input.conversationId)))
        .for("update");
      if (!row) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...row, createdAt: row.createdAt.toISOString() });
      if (message.kind !== "choices" || !message.body.options.some((option) => option.externalId === input.externalId)) {
        return { status: "not_found" } as const;
      }
      // 候选按钮只能选择一次；锁内检查能阻止两个标签页同时把同一组候选选成不同地点。
      if (message.body.chosen) return { status: "conflict" } as const;
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, chosen: input.externalId } })
        .where(eq(conversationMessages.id, row.id));
      await transaction.update(conversations).set({ updatedAt: input.now }).where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async decideSuggestion(input: Parameters<ConversationRepository["decideSuggestion"]>[0]): Promise<{ status: "updated" | "not_found" | "conflict" }> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return { status: "not_found" } as const;
      const [row] = await transaction
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.id, input.messageId), eq(conversationMessages.conversationId, input.conversationId)))
        .for("update");
      if (!row) return { status: "not_found" } as const;
      const message = parseStoredMessage({ ...row, createdAt: row.createdAt.toISOString() });
      const suggestion = message.kind === "outing_review" ? message.body.suggestions[input.index] : undefined;
      if (message.kind !== "outing_review" || !suggestion) return { status: "not_found" } as const;
      if (suggestion.status !== "pending") return { status: "conflict" } as const;
      const suggestions = message.body.suggestions.map((item, index) => (index === input.index ? { ...item, status: input.status } : item));
      await transaction
        .update(conversationMessages)
        .set({ body: { ...message.body, suggestions } })
        .where(eq(conversationMessages.id, row.id));
      await transaction.update(conversations).set({ updatedAt: input.now }).where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async recordTrace(input: { conversationId: string; seq: number; record: unknown; now: Date }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (!(await this.owns(transaction, input.conversationId))) return;
      await transaction
        .insert(chatTraces)
        .values({ conversationId: input.conversationId, seq: input.seq, record: input.record, createdAt: input.now })
        .onConflictDoNothing();
    });
  }

  async listTraces(conversationId: string) {
    const rows = await this.database
      .select({ seq: chatTraces.seq, record: chatTraces.record, createdAt: chatTraces.createdAt })
      .from(chatTraces)
      .innerJoin(conversations, eq(conversations.id, chatTraces.conversationId))
      .where(and(eq(chatTraces.conversationId, conversationId), eq(conversations.userId, this.userId)))
      .orderBy(asc(chatTraces.seq));
    return rows.map((row) => ({ seq: row.seq, record: row.record, createdAt: row.createdAt.toISOString() }));
  }

  async updateSummary(input: Parameters<ConversationRepository["updateSummary"]>[0]): Promise<{ status: "updated" | "stale" | "not_found" }> {
    const summary = conversationSummarySchema.parse(input.summary);
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction.select().from(conversations).where(this.mine(input.conversationId)).for("update");
      if (!row) return { status: "not_found" } as const;
      const current = row.summary ? conversationSummarySchema.parse(row.summary) : null;
      // 两个请求先后摘要时，旧的不能覆盖新的。
      if (current && current.throughSeq > summary.throughSeq) return { status: "stale" } as const;
      await transaction.update(conversations).set({ summary }).where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }

  async updateDraft(input: Parameters<ConversationRepository["updateDraft"]>[0]): Promise<DraftUpdateOutcome> {
    const draft = requirementsDraftSchema.parse(input.draft);
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ draft: conversations.draft })
        .from(conversations)
        .where(this.mine(input.conversationId))
        .for("update");
      if (!row) return { status: "not_found" } as const;
      // jsonb 会调整对象键顺序，使用规范化指纹比较草案，不能比较原始 JSON 文本。
      if (fingerprint(row.draft) !== input.expectedFingerprint) return { status: "conflict" } as const;
      await transaction
        .update(conversations)
        .set({ draft, updatedAt: input.now })
        .where(this.mine(input.conversationId));
      return { status: "updated" } as const;
    });
  }
}
