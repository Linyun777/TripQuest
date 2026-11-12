import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDS, AGENTS, TRIGGER_BUDGETS } from "../agents/registry";
import { inAgent } from "../agents/run-agent";
import { SUMMARY_PROMPT_VERSION } from "../chat-summary";
import { createJsonDecisionTransport } from "../live";
import { ALLOCATE_PROMPT_VERSION } from "../outing-allocate";
import { REPAIR_PROMPT_VERSION } from "../outing-repair";
import { AgentRun, MemoryRunSink, runIn, withRun } from "../runs";

/** V3.0 运行记录（stages/V3.0.md §5）：父子与根、共用预算、交接校验、记录失败不影响请求、步骤不带正文。 */

afterEach(() => vi.restoreAllMocks());

async function model(content: string) {
  let hits = 0;
  const server = createServer(async (req, res: ServerResponse) => {
    for await (const chunk of req) void chunk;
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "r1",
      model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 10 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const transport = createJsonDecisionTransport({
    config: {
      version: 1,
      profiles: {
        test: {
          providerId: "deepseek", adapter: "chat_completions", baseURL: `http://127.0.0.1:${address.port}`, model: "deepseek-flash",
          apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: "json_object", thinkingMode: "disabled", temperature: 0, outputTokenLimit: 512,
        },
      },
    },
    profileId: "test",
    environment: { DEEPSEEK_API_KEY: "synthetic" },
    allowLoopback: true,
  });
  return {
    transport,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

describe("runs", () => {
  it("child runs hang under one root and their counts add up to the root", async () => {
    const sink = new MemoryRunSink();
    const root = AgentRun.root({ trigger: "outing_generate", userId: "u1", sink });
    await runIn(root, async () => {
      await inAgent("day-planner", {}, async (run) => run?.spend("amap"), () => ({ status: "ok" }));
      await inAgent("day-planner", {}, async (run) => {
        run?.spend("amap");
        run?.spend("amap");
      }, () => ({ status: "none", outcome: "constraints_not_met" }));
    }, () => ({ status: "ok" }));

    expect(sink.runs).toHaveLength(3);
    const [top, first, second] = sink.runs;
    expect(top).toMatchObject({ parentId: null, rootId: top!.id, trigger: "outing_generate", status: "ok" });
    expect(first).toMatchObject({ parentId: top!.id, rootId: top!.id, agent: "day-planner", version: "day-planning.v1", status: "ok" });
    expect(second).toMatchObject({ parentId: top!.id, status: "none", outcome: "constraints_not_met" });
    expect(top!.counts.amap).toBe(3);
    expect(second!.counts.amap).toBe(2);
  });

  it("the shared budget stops further model requests and marks the root budget_exhausted", async () => {
    const live = await model('{"action":"search_places","query":"西湖边的咖啡馆"}');
    try {
      const sink = new MemoryRunSink();
      const root = AgentRun.root({ trigger: "plan", userId: "u1", budget: { model: 1 }, sink });
      const signal = new AbortController().signal;
      await runIn(root, async () => {
        await live.transport.request("system", "{}", signal);
        await expect(live.transport.request("system", "{}", signal)).rejects.toMatchObject({ code: "quota" });
      }, () => ({ status: "ok" }));

      expect(live.hits()).toBe(1);
      expect(sink.runs[0]).toMatchObject({ status: "budget_exhausted", counts: { model: 1, inputTokens: 40, cacheHitTokens: 30 } });
      expect(sink.steps.map((step) => [step.kind, step.name, step.summary.code])).toEqual([
        ["model_call", "search_places", "ok"],
        ["model_call", "error", "quota"],
      ]);
      // 步骤只有动作名、结果码和 tokens：搜索词这类决定的内容不进摘要。
      expect(JSON.stringify(sink.steps)).not.toContain("咖啡");
    } finally {
      await live.close();
    }
  });

  it("an invalid handoff is not passed on: the agent returns its own failure instead", async () => {
    const sink = new MemoryRunSink();
    const operation = vi.fn(async () => "planned");
    const result = await runIn(AgentRun.root({ trigger: "plan", userId: "u1", sink }), () => inAgent(
      "day-planner",
      { input: { date: "2026-11-01", startPlace: { name: "家", address: "某路 1 号" } }, rejected: () => "rejected" },
      operation,
      () => ({ status: "ok" }),
    ), () => ({ status: "ok" }));

    expect(result).toBe("rejected");
    expect(operation).not.toHaveBeenCalled();
    expect(sink.runs[1]).toMatchObject({ agent: "day-planner", status: "failed", outcome: "invalid_handoff" });
    const handoff = sink.steps.find((step) => step.kind === "handoff")!;
    expect(handoff).toMatchObject({ name: "plan→day-planner", summary: { checked: true, valid: false } });
    // 只记出错字段的路径，不记交过来的值。
    expect(JSON.stringify(handoff.summary)).not.toContain("某路");
  });

  it("a recorder that fails does not fail the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = AgentRun.root({
      trigger: "chat_turn",
      userId: "u1",
      sink: { write: () => Promise.reject(new Error("db down: postgres://secret")) },
    });
    await expect(runIn(root, async () => "reply", () => ({ status: "ok" }))).resolves.toBe("reply");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret");
  });

  it("without a current run agents run exactly as before and record nothing", async () => {
    const live = await model('{"action":"finish"}');
    try {
      await expect(live.transport.request("system", "{}", new AbortController().signal)).resolves.toMatchObject({ decision: { action: "finish" } });
      await expect(inAgent("outing-allocator", { input: {} }, async (run) => run, () => ({ status: "ok" }))).resolves.toBeNull();
    } finally {
      await live.close();
    }
  });

  it("V4.3: every registered model use says whether it is a tool-loop agent or a single model step", () => {
    const byKind = (kind: "agent" | "step") => Object.values(AGENTS).filter((contract) => contract.kind === kind).map((contract) => contract.id).sort();
    expect(byKind("agent")).toEqual(["chat-advice", "chat-companion", "chat-info", "chat-intake", "chat-trip", "day-planner", "outing-repair", "short-picker"]);
    expect(byKind("step")).toEqual(["chat-summary", "outing-allocator", "outing-judge", "outing-reviewer", "trip-notes"]);
    expect(byKind("agent").length + byKind("step").length).toBe(AGENT_IDS.length);
  });

  it("the registry matches the agents' own versions and every caller is a known entry or agent", async () => {
    expect(AGENTS["chat-summary"].version).toBe(SUMMARY_PROMPT_VERSION);
    expect(AGENTS["outing-allocator"].version).toBe(ALLOCATE_PROMPT_VERSION);
    expect(AGENTS["outing-repair"].version).toBe(REPAIR_PROMPT_VERSION);
    const known = new Set([...Object.keys(AGENTS), ...Object.keys(TRIGGER_BUDGETS), "outing_generate", "outing_change", "short_step"]);
    for (const contract of Object.values(AGENTS)) {
      for (const caller of contract.callers) expect(known, `${contract.id} ← ${caller}`).toContain(caller);
    }
    // 根运行的预算由子运行共用：子运行再扣也算在同一份里。
    const root = AgentRun.root({ trigger: "allocate", userId: "u1", budget: { model: 1 } });
    await withRun(root, async () => {
      root.child("outing-allocator").spend("model");
      expect(() => root.child("outing-allocator").spend("model")).toThrow(/budget/);
    });
  });
});
