import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { siteDailyLimit } from "@tripquest/db";
import { permitsRealPlanning } from "../environment";
import { validateProductionConfig } from "../config";
import { createReadyHandler, databaseReady, healthResponse } from "../health";
import { readRealPlaceMode } from "../../real-places/real-mode";
import { readPlanningConfig } from "../../planning/new/planning-config";
import { readGenerationConfig } from "../../planning/new/generation-config";
import { readPlanningMapConfig } from "../../journeys/map-config";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://tripquest.example",
  BETTER_AUTH_SECRET: "auth-test-only-0123456789abcdef01234567",
  DATABASE_URL: "postgresql://test:test@localhost/deployment_test",
  MODEL_DAILY_LIMIT: "3",
};
const invited: NodeJS.ProcessEnv = {
  ...base,
  TRIPQUEST_DEPLOYMENT_MODE: "invited",
  PLANNING_PLACE_SOURCE: "amap",
  REAL_PLACE_SAVE_ENABLED: "true",
  PLANNING_PLACE_TOKEN_SECRET: "place-test-only-0123456789abcdef01234567",
  PLANNING_DRAFT_RECEIPT_SECRET: "receipt-test-only-0123456789abcdef01234567",
  PLANNING_GENERATION_ENABLED: "true",
  PLANNING_AMAP_GENERATION_ENABLED: "true",
  PLANNING_MODEL_MODE: "live",
  PLANNING_LIVE_ROUND: "disabled",
  AGENT_LIVE_ENABLED: "true",
  AGENT_MODEL_PROFILE: "test-model",
  PLANNING_SAVE_ENABLED: "true",
  AMAP_WEB_SERVICE_KEY: "synthetic-map-key",
  PLANNING_MAP_MODE: "amap",
  AMAP_JS_API_KEY: "synthetic-js-key",
  AMAP_JS_SECURITY_CODE: "synthetic-js-code",
  WEB_SEARCH_ENABLED: "false",
  KNOWLEDGE_ENABLED: "false",
  MODEL_TEST_KEY: "synthetic-model-key",
};
const profile = {
  version: 1,
  profiles: {
    "test-model": {
      providerId: "example",
      adapter: "chat_completions",
      baseURL: "https://model.example/v1",
      model: "test-model",
      apiKeyEnv: "MODEL_TEST_KEY",
      jsonMode: "json_object",
      thinkingMode: "omit",
      temperature: 0,
      outputTokenLimit: 512,
    },
  },
};
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("invited production deployment", () => {
  it("only permits local development or explicitly invited production", () => {
    for (const [node, mode, allowed] of [
      ["development", undefined, true], ["development", "invited", false],
      ["production", undefined, false], ["production", "local", false],
      ["production", "invited", true], ["production", "typo", false], ["test", "invited", false],
    ] as const) {
      expect(permitsRealPlanning({ NODE_ENV: node, TRIPQUEST_DEPLOYMENT_MODE: mode })).toBe(allowed);
    }
  });

  it("opens all four real configuration entrances only with the invited boundary", () => {
    for (const mode of [undefined, "local", "invited", "typo"]) {
      const env = { ...invited, TRIPQUEST_DEPLOYMENT_MODE: mode };
      expect(readRealPlaceMode(env).enabled).toBe(mode === "invited");
      expect(readPlanningConfig(env).enabled).toBe(mode === "invited");
      expect(readGenerationConfig(env).enabled).toBe(mode === "invited");
      expect(readPlanningMapConfig(env).mode).toBe(mode === "invited" ? "amap" : "schematic");
    }
  });

  it("does not enable an old live fixture/lab round in production", () => {
    expect(readGenerationConfig({ ...invited, PLANNING_PLACE_SOURCE: "fixture", PLANNING_LIVE_ROUND: "developer" }).enabled).toBe(false);
    expect(readGenerationConfig({ ...invited, REAL_PLACE_SAVE_ENABLED: "false", PLANNING_AMAP_MODEL_ENABLED: "true", PLANNING_LIVE_ROUND: "developer" }).enabled).toBe(false);
  });

  it("keeps missing real keys and save switches closed", () => {
    expect(readRealPlaceMode({ ...invited, AMAP_WEB_SERVICE_KEY: "" }).enabled).toBe(false);
    expect(readGenerationConfig({ ...invited, PLANNING_AMAP_GENERATION_ENABLED: "false" }).enabled).toBe(false);
    expect(readPlanningMapConfig({ ...invited, AMAP_JS_SECURITY_CODE: "" }).mode).toBe("schematic");
  });

  it("accepts a local production site without opening real services or reading a profile", async () => {
    await expect(validateProductionConfig(base, "/nonexistent")).resolves.toBeUndefined();
  });

  it("rejects invalid HTTPS origins, credentials and limits without echoing values", async () => {
    for (const override of [
      { BETTER_AUTH_URL: "http://must-not-appear.example/private" },
      { BETTER_AUTH_URL: "https://must-not-appear.example/private" },
      { BETTER_AUTH_SECRET: "must-not-appear" },
      { BETTER_AUTH_SECRET: "合成测试签名密钥长度不足" },
      { DATABASE_URL: "must-not-appear" },
      { MODEL_DAILY_LIMIT: undefined },
      { MODEL_DAILY_LIMIT: "-1" },
      { MODEL_DAILY_LIMIT: "Infinity" },
    ]) {
      const error = await validateProductionConfig({ ...base, ...override }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("must-not-appear");
    }
  });

  it("checks the chosen model profile and credential locally, with no API calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tripquest-profile-"));
    directories.push(directory);
    await writeFile(join(directory, "agent-models.local.json"), JSON.stringify(profile));
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external requests allowed"));
    try {
      await expect(validateProductionConfig(invited, directory)).resolves.toBeUndefined();
      await expect(validateProductionConfig({ ...invited, MODEL_TEST_KEY: "" }, directory)).rejects.toThrow("Invalid model profile");
      await expect(validateProductionConfig({ ...invited, AGENT_MODEL_PROFILE: "absent" }, directory)).rejects.toThrow("Invalid model profile");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });

  it("refuses missing profile files, incomplete invited configuration and reused signing secrets", async () => {
    await expect(validateProductionConfig(invited, "/nonexistent")).rejects.toThrow("Invalid model profile");
    await expect(validateProductionConfig({ ...invited, PLANNING_SAVE_ENABLED: "false" })).rejects.toThrow("PLANNING_SAVE_ENABLED");
    await expect(validateProductionConfig({ ...invited, PLANNING_DRAFT_RECEIPT_SECRET: invited.BETTER_AUTH_SECRET })).rejects.toThrow("distinct");
  });

  it("requires a finite model cap in production, preserves local default and permits zero", () => {
    expect(siteDailyLimit("model", {})).toBe(Infinity);
    expect(siteDailyLimit("model", { NODE_ENV: "production", MODEL_DAILY_LIMIT: "0" })).toBe(0);
    expect(() => siteDailyLimit("model", { NODE_ENV: "production" })).toThrow("MODEL_DAILY_LIMIT");
    expect(() => siteDailyLimit("model", { NODE_ENV: "production", MODEL_DAILY_LIMIT: "3.5" })).toThrow();
  });

  it("keeps liveness independent from configuration and returns no internal details", async () => {
    const response = healthResponse(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("readiness rejects unavailable or unmigrated databases with a generic 503", async () => {
    for (const check of [async () => false, async () => { throw new Error("secret connection URL"); }]) {
      const response = await createReadyHandler(check)();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("readiness has a deadline even when the database check stalls", async () => {
    vi.useFakeTimers();
    const pending = createReadyHandler(() => new Promise(() => {}))();
    await vi.advanceTimersByTimeAsync(4_001);
    expect((await pending).status).toBe(503);
  });

  it("readiness rejects a schema whose applied migration hashes differ from the shipped image", async () => {
    expect(await databaseReady({ query: async () => ({ rows: [{ hash: "wrong" }] }) }, resolve(process.cwd(), "../.."))).toBe(false);
  });
});
