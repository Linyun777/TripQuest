import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBaselineCandidate } from "@tripquest/domain";
import { createLiveModel, resolveProfile } from "../live";
import { DecisionModelError } from "../contracts";
import type { DecisionContext, ModelReply } from "../contracts";
import { diagnosticInput } from "./independent-fixtures";

/**
 * Independent configuration/transport tests. They focus on the isolation
 * promises in design §7 (profile switching without touching the graph, zero
 * network on configuration failure, no credential or response leakage) rather
 * than repeating the developer's parameter snapshot test.
 */

afterEach(() => vi.unstubAllEnvs());

interface Received {
  readonly url: string;
  readonly auth?: string;
  readonly body: Record<string, unknown>;
}

async function loopback(responder: (req: IncomingMessage, res: ServerResponse, hit: number) => void) {
  const received: Received[] = [];
  const instance = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({
      url: req.url ?? "",
      auth: req.headers.authorization,
      body: text ? JSON.parse(text) as Record<string, unknown> : {},
    });
    responder(req, res, received.length);
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  return {
    received,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    },
  };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "independent-response",
    object: "chat.completion",
    created: 1,
    model: "returned-model",
    system_fingerprint: "synthetic-fingerprint",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: '{"action":"finish","reasonCode":"cannot_resolve"}' },
    }],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 12,
      total_tokens: 54,
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 32,
    },
    ...overrides,
  };
}

const send = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const profile = (url: string, extra: Record<string, unknown> = {}) => ({
  providerId: "deepseek",
  adapter: "chat_completions",
  baseURL: url,
  model: "deepseek-flash",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  jsonMode: "json_object",
  thinkingMode: "disabled",
  temperature: 0,
  outputTokenLimit: 512,
  ...extra,
});

const config = (entry: Record<string, unknown>, id = "test") => ({
  version: 1,
  profiles: { [id]: entry },
});

const context: DecisionContext = {
  initial: diagnosticInput("15:30"),
  travelLegs: [],
  currentResult: generateBaselineCandidate(diagnosticInput("15:30")),
  observations: [],
  allowedEdges: [["P-B", "P-C"], ["P-B", "P-D"], ["P-C", "P-D"]],
  remaining: { routes: 3, models: 4 },
};

const signal = () => new AbortController().signal;

describe("profile resolution is the only gate before the network", () => {
  it("reads credentials from the injected environment, never from process.env", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-from-process-env");
    expect(() => resolveProfile(config(profile("https://api.deepseek.com")), "test", {})).toThrow(
      "Missing model credential",
    );
    expect(resolveProfile(config(profile("https://api.deepseek.com")), "test", {
      DEEPSEEK_API_KEY: "synthetic-injected",
    }).apiKey).toBe("synthetic-injected");
  });

  it("rejects a blank credential as firmly as a missing one", () => {
    for (const value of ["", "   ", "\t"]) {
      expect(() => resolveProfile(
        config(profile("https://api.deepseek.com")),
        "test",
        { DEEPSEEK_API_KEY: value },
      ), JSON.stringify(value)).toThrow("Missing model credential");
    }
  });

  it("refuses to start when an external tracing callback is enabled", () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    expect(() => createLiveModel({
      config: config(profile("https://api.deepseek.com")),
      profileId: "test",
      environment: { DEEPSEEK_API_KEY: "synthetic" },
    })).toThrow("tracing");
  });

  it.each([
    ["unknown profile", { version: 1, profiles: { other: profile("https://api.deepseek.com") } }, "test"],
    ["unsupported version", { version: 2, profiles: { test: profile("https://api.deepseek.com") } }, "test"],
    ["credential in the URL", config(profile("https://user:secret@api.deepseek.com")), "test"],
    ["query string in the URL", config(profile("https://api.deepseek.com?key=x")), "test"],
    ["fragment in the URL", config(profile("https://api.deepseek.com#x")), "test"],
    ["plain http endpoint", config(profile("http://example.invalid")), "test"],
    ["unknown adapter", config(profile("https://api.deepseek.com", { adapter: "responses" })), "test"],
    ["unsupported json mode", config(profile("https://api.deepseek.com", { jsonMode: "json_schema" })), "test"],
    ["thinking disabled off DeepSeek", config(profile("https://api.deepseek.com", { providerId: "compatible" })), "test"],
    ["non-zero temperature", config(profile("https://api.deepseek.com", { temperature: 0.7 })), "test"],
    ["unsupported token limit", config(profile("https://api.deepseek.com", { outputTokenLimit: 1024 })), "test"],
    ["invalid credential variable name", config(profile("https://api.deepseek.com", { apiKeyEnv: "lower_case" })), "test"],
    ["extra profile field", config(profile("https://api.deepseek.com", { retries: 3 })), "test"],
    ["upper-case profile id", { version: 1, profiles: { Test: profile("https://api.deepseek.com") } }, "Test"],
  ])("rejects %s before any request", (_label, raw, id) => {
    expect(() => resolveProfile(raw, id as string, { DEEPSEEK_API_KEY: "synthetic" })).toThrow();
  });

  it("keeps loopback http available for transport tests only", () => {
    expect(() => resolveProfile(config(profile("http://127.0.0.1:1")), "test", {
      DEEPSEEK_API_KEY: "synthetic",
    })).toThrow("Unsupported model endpoint");
    expect(resolveProfile(config(profile("http://127.0.0.1:1")), "test", {
      DEEPSEEK_API_KEY: "synthetic",
    }, true).profile.baseURL).toBe("http://127.0.0.1:1");
  });

  it("sends nothing at all when the configuration is invalid", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion()));
    try {
      for (const entry of [
        profile(endpoint.url, { adapter: "unsupported" }),
        profile(`${endpoint.url}/v1`, { temperature: 1 }),
      ]) {
        expect(() => createLiveModel({
          config: config(entry),
          profileId: "test",
          environment: { DEEPSEEK_API_KEY: "synthetic" },
          allowLoopback: true,
        })).toThrow();
      }
      expect(() => createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "missing",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      })).toThrow();
      expect(endpoint.received).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });
});

describe("request shaping and separation", () => {
  it("honours a path-prefixed base URL for compatible services", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion()));
    try {
      const model = createLiveModel({
        config: config(profile(`${endpoint.url}/api/v1`, { providerId: "compatible", thinkingMode: "omit" })),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic-a" },
        allowLoopback: true,
      });
      expect(model.getRequestCount?.()).toBe(0);
      await model.decide(context, { signal: signal() });
      expect(endpoint.received.map((r) => r.url)).toEqual(["/api/v1/chat/completions"]);
      expect(endpoint.received[0].body).not.toHaveProperty("thinking");
      expect(model.getRequestCount?.()).toBe(1);
    } finally {
      await endpoint.close();
    }
  });

  it("keeps two profiles on one host fully separate and never retries a call", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion()));
    try {
      const raw = {
        version: 1,
        profiles: {
          first: profile(endpoint.url, { model: "deepseek-flash", apiKeyEnv: "KEY_A" }),
          second: profile(endpoint.url, {
            providerId: "compatible",
            thinkingMode: "omit",
            model: "compatible-model",
            apiKeyEnv: "KEY_B",
          }),
        },
      };
      const environment = { KEY_A: "synthetic-a", KEY_B: "synthetic-b" };
      const first = createLiveModel({ config: raw, profileId: "first", environment, allowLoopback: true });
      const second = createLiveModel({ config: raw, profileId: "second", environment, allowLoopback: true });
      await first.decide(context, { signal: signal() });
      await first.decide(context, { signal: signal() });
      await second.decide(context, { signal: signal() });
      expect(endpoint.received.map((r) => r.auth)).toEqual([
        "Bearer synthetic-a", "Bearer synthetic-a", "Bearer synthetic-b",
      ]);
      expect(endpoint.received.map((r) => r.body.model)).toEqual([
        "deepseek-flash", "deepseek-flash", "compatible-model",
      ]);
      expect(endpoint.received[0].body).toHaveProperty("thinking", { type: "disabled" });
      expect(endpoint.received[2].body).not.toHaveProperty("thinking");
      expect(first.getRequestCount?.()).toBe(2);
      expect(second.getRequestCount?.()).toBe(1);
      const bodies = JSON.stringify(endpoint.received.map((r) => r.body));
      expect(bodies).not.toContain("synthetic-a");
      expect(bodies).not.toContain("synthetic-b");
    } finally {
      await endpoint.close();
    }
  });

  it("does not touch the network when the caller has already aborted", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion()));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(model.decide(context, { signal: controller.signal })).rejects.toMatchObject({
        code: "timeout",
      });
      expect(endpoint.received).toHaveLength(0);
      expect(model.getRequestCount?.()).toBe(0);
    } finally {
      await endpoint.close();
    }
  });
});

describe("response validation and metadata whitelisting", () => {
  it.each([
    ["a refusal", { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: null, refusal: "cannot comply",
    } }] }],
    ["a function call", { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: null, function_call: { name: "hack", arguments: "{}" },
    } }] }],
    ["two choices", { choices: [
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"action":"finish","reasonCode":"cannot_resolve"}' } },
      { index: 1, finish_reason: "stop", message: { role: "assistant", content: '{"action":"finish","reasonCode":"cannot_resolve"}' } },
    ] }],
    ["array content", { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: [{ type: "text", text: "{}" }],
    } }] }],
    ["whitespace-only content", { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: "   ",
    } }] }],
    ["a missing choices array", { choices: undefined }],
  ])("rejects %s as invalid output", async (_label, overrides) => {
    const endpoint = await loopback((_req, res) => send(res, completion(overrides)));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      await expect(model.decide(context, { signal: signal() })).rejects.toMatchObject({
        code: "invalid_output",
      });
      expect(endpoint.received).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  });

  it("accepts padded JSON content and reports usage plus whitelisted metadata", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion({
      choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant",
        content: '  \n{"action":"lookup_route","fromPlaceId":"P-B","toPlaceId":"P-C"}\n  ',
      } }],
    })));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      const reply = await model.decide(context, { signal: signal() });
      expect(reply.decision).toEqual({
        action: "lookup_route", fromPlaceId: "P-B", toPlaceId: "P-C",
      });
      expect(reply.usage).toEqual({
        inputTokens: 42, outputTokens: 12, totalTokens: 54, cacheHitTokens: 10, cacheMissTokens: 32,
      });
      expect(reply.returnedModel).toBe("returned-model");
      expect(reply.fingerprint).toBe("synthetic-fingerprint");
      expect(Object.keys(reply).sort()).toEqual([
        "decision", "fingerprint", "requestId", "returnedModel", "usage",
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it.each([
    ["no usage block", { usage: undefined }],
    ["a partial usage block", { usage: { prompt_tokens: 1, completion_tokens: 2 } }],
    ["a negative token count", { usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 3 } }],
  ])("keeps token counts unknown for %s", async (_label, overrides) => {
    const endpoint = await loopback((_req, res) => send(res, completion(overrides)));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      const reply = await model.decide(context, { signal: signal() });
      expect(reply.usage).toBeNull();
    } finally {
      await endpoint.close();
    }
  });

  it("drops metadata that is not a safe identifier", async () => {
    const endpoint = await loopback((_req, res) => send(res, completion({
      model: "returned model <script>",
      system_fingerprint: "fingerprint with spaces",
      id: "id\"with quote",
    })));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      const reply: ModelReply = await model.decide(context, { signal: signal() });
      expect(reply.returnedModel).toBeUndefined();
      expect(reply.fingerprint).toBeUndefined();
      expect(reply.requestId).toBeUndefined();
    } finally {
      await endpoint.close();
    }
  });

  it("surfaces only a safe error code and never the response body", async () => {
    const endpoint = await loopback((_req, res) =>
      send(res, { error: { message: "unsafe-body-secret", type: "synthetic" } }, 500));
    try {
      const model = createLiveModel({
        config: config(profile(endpoint.url)),
        profileId: "test",
        environment: { DEEPSEEK_API_KEY: "synthetic" },
        allowLoopback: true,
      });
      const failure = await model.decide(context, { signal: signal() }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DecisionModelError);
      const typed = failure as DecisionModelError;
      expect(typed.code).toBe("transport");
      expect(typed.message).toBe("transport");
      expect(JSON.stringify({ message: typed.message, metadata: typed.metadata }))
        .not.toContain("unsafe-body-secret");
      expect(endpoint.received).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  });
});
