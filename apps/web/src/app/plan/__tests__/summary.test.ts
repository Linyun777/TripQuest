import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createChatRunner, type ChatDecisionModel, type ChatTurnInput } from "@tripquest/agent/chat";
import type { SummaryInput } from "@tripquest/agent/chat-summary";
import type { ProviderEvidence, WeatherProvider } from "@tripquest/providers";
import { createConversationService } from "../conversation-service";
import { MemoryConversations } from "./memory-conversations";

// Synthetic conversation; no provider data.
const NOW = Date.parse("2026-10-22T04:00:00Z");
const evidence: ProviderEvidence = { provider: "amap", sourceKind: "live", attribution: "高德地图", retrievedAt: "2026-10-22T04:00:00Z" };
const weather: WeatherProvider = { async getWeatherForecast() { return { status: "ok", data: { cityAdcode: "330100", reportedAt: "2026-10-22T12:00:00+08:00", days: [] }, evidence }; } };
const places = { async searchPlaces() { return { status: "ok" as const, data: { items: [], truncated: false }, evidence }; } };
const model: ChatDecisionModel = { mode: "scripted", provider: "test", model: "scripted", async decide() { return { decision: { action: "reply", text: "好的" }, usage: null }; } };

describe("V2.9 rolling summary of long conversations", () => {
  it("summarizes what leaves the window, passes it on, and keeps the old one when summarizing fails", async () => {
    const repository = new MemoryConversations();
    const inputs: ChatTurnInput[] = [];
    const asked: SummaryInput[] = [];
    let failing = false;
    const service = createConversationService({
      now: () => NOW,
      repository: () => repository,
      weather: () => weather,
      runner: async () => {
        const runner = createChatRunner({ model, places, weather });
        return { run: (input: ChatTurnInput, run: { signal: AbortSignal }) => { inputs.push(input); return runner.run(input, run); } };
      },
      summarizer: async () => ({
        async summarize(input: SummaryInput) {
          asked.push(input);
          return failing ? null : `摘要到：${input.messages.at(-1)!.text}`;
        },
      }),
    });
    const started = await service.start("朋友推荐过老街茶馆，先记着");
    if (started.status !== "ok") throw new Error("start");
    // Each turn adds the user's message and a reply; the window holds the last 11.
    for (let turn = 1; turn <= 6; turn += 1) {
      const sent = await service.send(started.conversationId, `第${turn}句`, turn * 2);
      if (sent.status !== "ok") throw new Error("send");
    }
    expect(asked[0].messages[0].text).toBe("朋友推荐过老街茶馆，先记着");
    // V3.0：每轮的决策记录改记在运行记录里（agent_runs），不再写 chat_traces。
    expect(await repository.listTraces(started.conversationId)).toEqual([]);
    expect(inputs.at(-1)!.summary).toMatch(/^摘要到：/);
    const stored = repository.conversations.get(started.conversationId)!.summary!;
    failing = true;
    await service.send(started.conversationId, "第7句", 14);
    expect(repository.conversations.get(started.conversationId)!.summary).toEqual(stored);
    expect(inputs.at(-1)!.summary).toBe(stored.text);
  });
});
