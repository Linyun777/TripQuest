import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createLiveModel, resolveProfile } from "../live";
import { input } from "./fixtures";
import { generateBaselineCandidate } from "@tripquest/domain";
import type { DecisionContext } from "../contracts";

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No local server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    },
  };
}
const context: DecisionContext = {
  initial: input(), travelLegs: [], currentResult: generateBaselineCandidate(input()),
  observations: [], allowedEdges: [["P-B", "P-C"], ["P-B", "P-D"], ["P-C", "P-D"]],
  remaining: { routes: 3, models: 4 },
};
const profile = (url: string, deepseek = true) => ({
  providerId: deepseek ? "deepseek" : "compatible-test",
  adapter: "chat_completions",
  baseURL: url,
  model: deepseek ? "deepseek-flash" : "other-model",
  apiKeyEnv: deepseek ? "KEY_A" : "KEY_B",
  jsonMode: "json_object",
  thinkingMode: deepseek ? "disabled" : "omit",
  temperature: 0,
  outputTokenLimit: 512,
});
const completion = () => ({
  id: "test-response", object: "chat.completion", created: 1, model: "returned-model",
  system_fingerprint: "synthetic-fingerprint",
  choices: [{ index: 0, finish_reason: "stop", message: {
    role: "assistant", content: '{"action":"finish","reasonCode":"cannot_resolve"}',
  } }],
  usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54,
    prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 32 },
});

describe("Chat Completions transport (loopback only)", () => {
  it("switches profiles across two servers and freezes exact request parameters/Key separation", async () => {
    const received: { url: string; auth?: string; body: Record<string, unknown> }[][] = [[], []];
    const servers = await Promise.all(received.map(async (requests) => server(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      requests.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(text) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(completion()));
    })));
    try {
      const config = { version: 1, profiles: {
        first: profile(servers[0].url), second: profile(servers[1].url, false),
      } };
      for (const id of ["first", "second"]) {
        const model = createLiveModel({
          config, profileId: id, environment: { KEY_A: "synthetic-a", KEY_B: "synthetic-b" }, allowLoopback: true,
        });
        const reply = await model.decide(context, { signal: new AbortController().signal });
        expect(reply.decision).toEqual({ action: "finish", reasonCode: "cannot_resolve" });
        expect(reply.usage).toEqual({ inputTokens: 42, outputTokens: 12, totalTokens: 54, cacheHitTokens: 10, cacheMissTokens: 32 });
        expect(reply.returnedModel).toBe("returned-model");
        expect(model.getRequestCount?.()).toBe(1);
      }
      expect(received.map((r) => r.length)).toEqual([1, 1]);
      expect(received[0][0].auth).toBe("Bearer synthetic-a");
      expect(received[1][0].auth).toBe("Bearer synthetic-b");
      expect(received[0][0].body).toMatchObject({
        model: "deepseek-flash", temperature: 0, max_tokens: 512,
        stream: false, response_format: { type: "json_object" }, thinking: { type: "disabled" },
      });
      expect(received[1][0].body.model).toBe("other-model");
      expect(received[1][0].body).not.toHaveProperty("thinking");
      expect(received.map((r) => r[0].url)).toEqual(["/chat/completions", "/chat/completions"]);
      const messages = JSON.stringify(received[0][0].body.messages);
      expect(messages).not.toContain("synthetic-a");
      expect(messages).not.toMatch(/expected|caseId|dataset|score/);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
  });
  it.each([401, 402, 429, 500])("does not retry HTTP %s and emits safe errors", async (status) => {
    let calls = 0;
    const endpoint = await server((_req, res) => {
      calls += 1;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unsafe-body-secret", type: "test" } }));
    });
    try {
      const model = createLiveModel({
        config: { version: 1, profiles: { test: profile(endpoint.url) } },
        profileId: "test", environment: { KEY_A: "test-key" }, allowLoopback: true,
      });
      const expected = status === 401 ? "auth" : status === 402 ? "quota" : status === 429 ? "rate_limit" : "transport";
      await expect(model.decide(context, { signal: new AbortController().signal })).rejects.toMatchObject({ message: expected });
      expect(calls).toBe(1);
    } finally {
      await endpoint.close();
    }
  });
  it("keeps missing usage unknown and rejects truncation/extra tool calls without retry", async () => {
    let mode = "missing-usage";
    let calls = 0;
    const endpoint = await server((_req, res) => {
      calls += 1;
      const body = completion();
      if (mode === "missing-usage") Reflect.deleteProperty(body, "usage");
      if (mode === "length") body.choices[0].finish_reason = "length";
      if (mode === "tools") {
        Reflect.set(body.choices[0].message, "tool_calls", [{
          id: "x", type: "function", function: { name: "hack", arguments: "{}" },
        }]);
      }
      if (mode === "empty") body.choices[0].message.content = "";
      if (mode === "non-json") body.choices[0].message.content = "plain text";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
    try {
      const model = createLiveModel({
        config: { version: 1, profiles: { test: profile(endpoint.url) } },
        profileId: "test", environment: { KEY_A: "test-key" }, allowLoopback: true,
      });
      expect((await model.decide(context, { signal: new AbortController().signal })).usage).toBeNull();
      for (mode of ["length", "tools", "empty", "non-json"]) {
        await expect(model.decide(context, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_output" });
      }
      expect(calls).toBe(5);
    } finally {
      await endpoint.close();
    }
  });
  it("propagates AbortSignal to an in-flight HTTP request", async () => {
    let accepted!: () => void;
    const started = new Promise<void>((resolve) => { accepted = resolve; });
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const endpoint = await server((_req, res) => {
      res.on("close", closed);
      accepted();
    });
    try {
      const model = createLiveModel({
        config: { version: 1, profiles: { test: profile(endpoint.url) } },
        profileId: "test", environment: { KEY_A: "test-key" }, allowLoopback: true,
      });
      const controller = new AbortController();
      const pending = model.decide(context, { signal: controller.signal });
      const failure = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await started;
      controller.abort();
      await failure;
      await disconnected;
      expect(model.getRequestCount?.()).toBe(1);
    } finally {
      await endpoint.close();
    }
  });
  it("rejects unsupported profiles and credentials before requests", () => {
    const valid = profile("https://example.invalid");
    expect(() => resolveProfile({ version: 1, profiles: { one: valid } }, "missing", { KEY_A: "test" })).toThrow();
    expect(() => resolveProfile({ version: 1, profiles: { one: valid } }, "one", {})).toThrow();
    for (const changed of [
      { ...valid, baseURL: "https://name:password@example.invalid" },
      { ...valid, baseURL: "https://example.invalid?key=x" },
      { ...valid, baseURL: "https://example.invalid#fragment" },
      { ...valid, baseURL: "http://example.invalid" },
      { ...valid, adapter: "unsupported" },
      { ...valid, jsonMode: "json_schema" },
      { ...valid, providerId: "other", thinkingMode: "disabled" },
    ]) {
      expect(() => resolveProfile({ version: 1, profiles: { one: changed } }, "one", { KEY_A: "test" })).toThrow();
    }
  });
});


it("uses the new system prompt only for the program-selected feedback protocol", async () => {
  const messages: string[] = [];
  const service = await server(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    messages.push(body.messages[0].content);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(completion()));
  });
  try {
    const model = createLiveModel({
      config: { version: 1, profiles: { selected: profile(service.url) } },
      profileId: "selected", environment: { KEY_A: "synthetic-key" }, allowLoopback: true,
    });
    await model.decide(context, { signal: new AbortController().signal });
    await model.decide({
      ...context, protocolVersion: "route-investigation-feedback-v1",
    }, { signal: new AbortController().signal });
    expect(messages[0]).not.toContain("action-feedback-v1");
    expect(messages[1]).toContain("action-feedback-v1");
    expect(model.getRequestCount?.()).toBe(2);
  } finally {
    await service.close();
  }
});
