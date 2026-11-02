import {
  emptyDraft,
  parseStoredMessage,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage,
} from "@tripquest/application/conversation";
import { fingerprint } from "@tripquest/application/fingerprint";

/** Conversations in memory for web tests: the same contract as the PostgreSQL repository. */
export class MemoryConversations implements ConversationRepository {
  conversations = new Map<string, StoredConversation>();
  messages = new Map<string, StoredMessage[]>();
  async createConversation(input: { id: string; title: string; now: Date }) {
    const conversation: StoredConversation = {
      id: input.id, title: input.title, status: "active", journeyId: null, draft: emptyDraft(),
      messageCount: 0, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
    };
    this.conversations.set(input.id, conversation);
    this.messages.set(input.id, []);
    return conversation;
  }
  traces = new Map<string, { seq: number; record: unknown; createdAt: string }[]>();
  async recordTrace(input: { conversationId: string; seq: number; record: unknown; now: Date }) {
    const list = this.traces.get(input.conversationId) ?? [];
    if (!list.some((item) => item.seq === input.seq)) list.push({ seq: input.seq, record: input.record, createdAt: input.now.toISOString() });
    this.traces.set(input.conversationId, list);
  }
  async listTraces(conversationId: string) {
    return [...(this.traces.get(conversationId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
  async updateSummary(input: { conversationId: string; summary: { text: string; throughSeq: number } }) {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) return { status: "not_found" as const };
    if (conversation.summary && conversation.summary.throughSeq > input.summary.throughSeq) return { status: "stale" as const };
    this.conversations.set(input.conversationId, { ...conversation, summary: input.summary });
    return { status: "updated" as const };
  }
  async findConversation(id: string) {
    const conversation = this.conversations.get(id);
    return conversation ? { conversation, messages: [...this.messages.get(id)!] } : null;
  }
  async appendTurn(input: Parameters<ConversationRepository["appendTurn"]>[0]) {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) return { status: "not_found" as const };
    if (conversation.messageCount !== input.expectedCount) return { status: "conflict" as const };
    const list = this.messages.get(input.conversationId)!;
    for (const message of input.messages) {
      // Same validation as the database repository: provider details are refused.
      list.push(parseStoredMessage({ ...message, id: input.newId(), seq: list.length + 1, createdAt: input.now.toISOString() }));
    }
    this.conversations.set(input.conversationId, {
      ...conversation,
      messageCount: list.length,
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
    return { status: "appended" as const, messageCount: list.length };
  }
  async markPlanSaved(input: Parameters<ConversationRepository["markPlanSaved"]>[0]) {
    const list = this.messages.get(input.conversationId) ?? [];
    const index = list.findIndex((message) => message.kind === "plan_card" && message.body.runId === input.runId);
    if (index < 0) return { status: "not_found" as const };
    const message = list[index];
    if (message.kind === "plan_card") list[index] = { ...message, body: { ...message.body, journeyId: input.journeyId } };
    return { status: "updated" as const };
  }
  async markOutingSaved(input: Parameters<ConversationRepository["markOutingSaved"]>[0]) {
    const list = this.messages.get(input.conversationId) ?? [];
    let found = false;
    list.forEach((message, index) => {
      if (message.kind !== "outing_day" || message.body.generationId !== input.generationId) return;
      found = true;
      list[index] = { ...message, body: { ...message.body, tripId: input.tripId } };
    });
    return { status: found ? "updated" as const : "not_found" as const };
  }
  async markAdjustSaved(input: Parameters<ConversationRepository["markAdjustSaved"]>[0]) {
    const list = this.messages.get(input.conversationId) ?? [];
    const index = list.findIndex((message) => message.kind === "adjust_card" && message.body.runId === input.runId);
    if (index < 0) return { status: "not_found" as const };
    const message = list[index];
    if (message.kind === "adjust_card") list[index] = { ...message, body: { ...message.body, savedVersion: input.planVersion } };
    return { status: "updated" as const };
  }
  async chooseOption(input: Parameters<ConversationRepository["chooseOption"]>[0]) {
    const list = this.messages.get(input.conversationId) ?? [];
    const index = list.findIndex((message) => message.id === input.messageId);
    const message = list[index];
    if (!message || message.kind !== "choices" || !message.body.options.some((option) => option.externalId === input.externalId)) {
      return { status: "not_found" as const };
    }
    if (message.body.chosen) return { status: "conflict" as const };
    list[index] = { ...message, body: { ...message.body, chosen: input.externalId } };
    return { status: "updated" as const };
  }
  async decideSuggestion(input: Parameters<ConversationRepository["decideSuggestion"]>[0]) {
    const list = this.messages.get(input.conversationId) ?? [];
    const index = list.findIndex((message) => message.id === input.messageId);
    const message = list[index];
    const suggestion = message?.kind === "outing_review" ? message.body.suggestions[input.index] : undefined;
    if (!message || message.kind !== "outing_review" || !suggestion) return { status: "not_found" as const };
    if (suggestion.status !== "pending") return { status: "conflict" as const };
    const suggestions = message.body.suggestions.map((item, at) => (at === input.index ? { ...item, status: input.status } : item));
    list[index] = { ...message, body: { ...message.body, suggestions } };
    return { status: "updated" as const };
  }
  async updateDraft(input: Parameters<ConversationRepository["updateDraft"]>[0]) {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) return { status: "not_found" as const };
    if (fingerprint(conversation.draft) !== input.expectedFingerprint) return { status: "conflict" as const };
    this.conversations.set(input.conversationId, { ...conversation, draft: input.draft });
    return { status: "updated" as const };
  }
}
