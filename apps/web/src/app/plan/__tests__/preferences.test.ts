import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createChatRunner, type ChatDecisionModel, type ChatTurnInput } from "@tripquest/agent/chat";
import type { PreferenceRepository, StoredPreference } from "@tripquest/application/preferences";
import type { ProviderEvidence, WeatherProvider } from "@tripquest/providers";
import { createPreferenceDecisionHandler, createStartHandler } from "../../api/conversations/handlers";
import { createPreferenceEditHandler } from "../../api/preferences/handlers";
import { createPreferencesService } from "../preferences-service";
import { MemoryConversations } from "./memory-conversations";
import { asTestUser } from "../../../test-support/users";

// Synthetic conversation; no provider data.
const NOW = Date.parse("2026-10-21T04:00:00Z");
const evidence: ProviderEvidence = { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: "2026-10-21T04:00:00Z" };
const weather: WeatherProvider = { async getWeatherForecast() { return { status: "ok", data: { cityAdcode: "330100", reportedAt: "2026-10-21T12:00:00+08:00", days: [] }, evidence }; } };
const places = { async searchPlaces() { return { status: "ok" as const, data: { items: [], truncated: false }, evidence }; } };

/** Preferences in memory with the same save-on-click rule as the database repository. */
class MemoryPreferences implements PreferenceRepository {
  items: StoredPreference[] = [];
  constructor(private readonly conversations: MemoryConversations) {}
  async list() { return [...this.items]; }
  async saveProposal(input: { conversationId: string; messageId: string; newId: string; now: Date }) {
    const message = this.conversations.messages.get(input.conversationId)?.find((item) => item.id === input.messageId);
    if (!message || message.kind !== "preference_proposal") return { status: "not_found" as const };
    if (message.body.status !== "pending") return { status: "already_decided" as const };
    const preference: StoredPreference = {
      id: input.newId, text: message.body.text, category: message.body.category,
      sourceConversationId: input.conversationId, createdAt: input.now.toISOString(), updatedAt: input.now.toISOString(),
    };
    this.items.push(preference);
    Object.assign(message.body, { status: "saved", preferenceId: input.newId });
    return { status: "saved" as const, preference };
  }
  async dismissProposal() { return { status: "dismissed" as const }; }
  async update() { return { status: "updated" as const }; }
  async remove() { return { status: "removed" as const }; }
  async removeAll() { const count = this.items.length; this.items = []; return count; }
}

function scripted(decisions: unknown[]): ChatDecisionModel {
  return { mode: "scripted", provider: "test", model: "scripted", async decide() { return { decision: decisions.shift() ?? { action: "reply", text: "好的" }, usage: null }; } };
}
const post = (url: string, body: unknown, origin = "http://localhost:3401", method = "POST") => new Request(`http://localhost:3401${url}`, {
  method,
  headers: { origin, host: "localhost:3401", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("V2.9 preferences in the web app", () => {
  it("shows a pending proposal card, saves it only on the click, and passes saved ones to the next turn", async () => {
    const repository = new MemoryConversations();
    const preferences = new MemoryPreferences(repository);
    const inputs: ChatTurnInput[] = [];
    const decisions: unknown[] = [
      { action: "propose_preference", text: "不吃辣", category: "food" },
      { action: "reply", text: "要我记住“不吃辣”吗？点卡片上的“记住”就行。" },
    ];
    const options = {
      user: asTestUser,
      now: () => NOW,
      repository: () => repository,
      weather: () => weather,
      preferences: () => preferences,
      runner: async () => {
        const runner = createChatRunner({ model: scripted(decisions), places, weather });
        return { run: (input: ChatTurnInput, run: { signal: AbortSignal }) => { inputs.push(input); return runner.run(input, run); } };
      },
    };
    const started = await (await createStartHandler(options)(post("/api/conversations", { text: "我从来不吃辣" }))).json();
    const card = started.messages.find((message: { kind: string }) => message.kind === "preference_proposal");
    expect(card).toMatchObject({ text: "不吃辣", category: "food", status: "pending" });
    expect(preferences.items).toEqual([]);
    expect(inputs[0]).not.toHaveProperty("preferences");

    const decide = createPreferenceDecisionHandler(options);
    const params = { params: Promise.resolve({ conversationId: started.conversationId }) };
    expect(await (await decide(post(`/api/conversations/${started.conversationId}/preference`, { messageId: card.id, decision: "save" }), params)).json()).toEqual({ status: "saved" });
    expect((await decide(post(`/api/conversations/${started.conversationId}/preference`, { messageId: card.id, decision: "save" }), params)).status).toBe(409);
    expect(preferences.items.map((item) => item.text)).toEqual(["不吃辣"]);

    await createStartHandler(options)(post("/api/conversations", { text: "明天晚上想找个地方吃饭" }));
    expect(inputs[1].preferences).toEqual([{ text: "不吃辣", category: "food" }]);
  });

  it("edits refuse a phone number, a cross-site request and an unknown category", async () => {
    const service = createPreferencesService({ repository: () => new MemoryPreferences(new MemoryConversations()) });
    const edit = createPreferenceEditHandler({ service: () => service, user: asTestUser });
    const id = "72000000-0000-4000-8000-000000000001";
    const params = { params: Promise.resolve({ preferenceId: id }) };
    expect((await edit(post(`/api/preferences/${id}`, { text: "电话13800138000", category: "other" }, undefined, "PATCH"), params)).status).toBe(422);
    expect((await edit(post(`/api/preferences/${id}`, { text: "不吃辣", category: "drinks" }, undefined, "PATCH"), params)).status).toBe(422);
    expect((await edit(post(`/api/preferences/${id}`, { text: "不吃辣", category: "food" }, "https://evil.example", "PATCH"), params)).status).toBe(403);
    expect((await edit(post(`/api/preferences/${id}`, { text: "不吃辣", category: "food" }, undefined, "PATCH"), params)).status).toBe(200);
  });
});
