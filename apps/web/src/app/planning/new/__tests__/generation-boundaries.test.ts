import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DayPlanningResult } from "@tripquest/application/day-planning";
import { readGenerationConfig } from "../generation-config";
import { createS52LiveBudget, LiveBudgetError } from "../live-budget";
import { readPlanningConfig } from "../planning-config";
import { createPlanningService } from "../planning-service";

const secret = "generation-test-secret-0123456789abcdef";
const key = "synthetic-amap-key-for-generation-tests";
const t0 = Date.parse("2026-10-08T03:00:00Z");
const base: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PLANNING_PLACE_SOURCE: "fixture",
  PLANNING_PLACE_TOKEN_SECRET: secret,
  PLANNING_GENERATION_ENABLED: "true",
};
const live = {
  PLANNING_MODEL_MODE: "live",
  PLANNING_LIVE_ROUND: "developer",
  AGENT_LIVE_ENABLED: "true",
  AGENT_MODEL_PROFILE: "deepseek-flash",
};
const amap = {
  PLANNING_PLACE_SOURCE: "amap",
  AMAP_WEB_SERVICE_KEY: key,
  PLANNING_AMAP_GENERATION_ENABLED: "true",
  PLANNING_LIVE_ROUND: "developer",
};

describe("S5.2 generation configuration and live budget", () => {
  it("enables only explicit, environment-appropriate source and model combinations", () => {
    const cases: [string, NodeJS.ProcessEnv, boolean][] = [
      ["not enabled", { ...base, PLANNING_GENERATION_ENABLED: undefined }, false],
      ["place source disabled", { ...base, PLANNING_PLACE_SOURCE: "disabled" }, false],
      ["fixture + scripted", base, true],
      ["fixture + scripted in production", { ...base, NODE_ENV: "production" }, true],
      ["unknown model mode", { ...base, PLANNING_MODEL_MODE: "agent" }, false],
      ["unknown live round", { ...base, PLANNING_LIVE_ROUND: "rerun" }, false],
      ["fixture + live", { ...base, ...live }, true],
      ["fixture + live in production", { ...base, ...live, NODE_ENV: "production" }, false],
      ["live without a round", { ...base, ...live, PLANNING_LIVE_ROUND: "disabled" }, false],
      ["live without the agent switch", { ...base, ...live, AGENT_LIVE_ENABLED: "false" }, false],
      ["amap without its generation switch", { ...base, ...amap, PLANNING_AMAP_GENERATION_ENABLED: undefined }, false],
      ["amap + scripted", { ...base, ...amap }, true],
      ["amap + live without model processing switch", { ...base, ...amap, ...live }, false],
      ["amap + live", { ...base, ...amap, ...live, PLANNING_AMAP_MODEL_ENABLED: "true" }, true],
      ["amap in production", { ...base, ...amap, NODE_ENV: "production" }, false],
    ];
    for (const [label, environment, enabled] of cases) {
      const config = readGenerationConfig(environment);
      expect(config.enabled, label).toBe(enabled);
      const shown = JSON.stringify(config.availability);
      expect(shown, label).not.toContain(secret);
      expect(shown, label).not.toContain(key);
    }
  });

  it("reserves runs and requests atomically per round, including failures, and never after a result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s52-budget-"));
    const path = join(directory, "ledger.jsonl");
    try {
      const developer = createS52LiveBudget(path, "developer", () => t0);
      await developer.reserveRun("run-1", "fixture", "live");
      await expect(developer.reserveRun("run-2", "fixture", "live")).rejects.toThrow(LiveBudgetError);
      await developer.reserveRun("run-3", "amap", "live");

      for (let i = 0; i < 10; i += 1) await developer.reserveRequest("run-1", "model");
      await expect(developer.reserveRequest("run-1", "model"), "10 per run").rejects.toThrow(LiveBudgetError);
      for (let i = 0; i < 10; i += 1) await developer.reserveRequest("run-3", "model");
      await developer.reserveRequest("manual-a", "search", true);
      await developer.reserveRequest("manual-b", "search", true);
      for (let i = 0; i < 4; i += 1) await developer.reserveRequest("run-3", "search");
      await expect(developer.reserveRequest("manual-c", "search", true), "6 searches per round").rejects.toThrow(LiveBudgetError);
      await expect(developer.reserveRequest("manual-d", "model", true), "manual is search only").rejects.toThrow(LiveBudgetError);
      await expect(developer.reserveRequest("run-unknown", "route"), "unreserved run").rejects.toThrow(LiveBudgetError);

      const result: DayPlanningResult = {
        runId: "run-3",
        status: "completed",
        outcome: "no_plan",
        reason: "constraints_not_met",
        issues: [],
        explanation: "本轮未找到满足要求的草稿。",
        counts: { model: 10, searches: 4, tries: 3, routes: 0, semanticRepairs: 0 },
        elapsedMs: 10,
        usage: null,
      };
      await developer.recordResult("run-3", result, "deepseek-flash");
      await expect(developer.reserveRequest("run-3", "route"), "after the result").rejects.toThrow(LiveBudgetError);

      const independent = createS52LiveBudget(path, "independent-test", () => t0);
      await independent.reserveRun("run-9", "fixture", "live");
      await independent.reserveRequest("run-9", "model");

      await mkdir(`${path}.lock`);
      await expect(independent.reserveRequest("run-9", "model"), "held lock fails closed").rejects.toThrow(LiveBudgetError);
      await rm(`${path}.lock`, { recursive: true });

      const ledger = await readFile(path, "utf8");
      const lines = ledger.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.kind === "request" && line.round === "developer")).toHaveLength(26);
      expect(ledger).not.toMatch(/token|location|longitude|address/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reserves a manual amap search before the provider and skips the reservation for fixture searches", async () => {
    const searchPlaces = vi.fn(async () => ({
      status: "ok" as const,
      data: { items: [], truncated: false },
      evidence: {
        provider: "amap",
        sourceKind: "live" as const,
        retrievedAt: new Date(t0).toISOString(),
        attribution: "高德地图",
      },
    }));
    const amapConfig = readPlanningConfig({ ...base, ...amap });
    const refused = createPlanningService({
      config: amapConfig,
      now: () => t0,
      provider: { searchPlaces },
      beforeLiveSearch: async () => {
        throw new LiveBudgetError();
      },
    });
    expect(await refused.search("博物馆")).toMatchObject({ status: "error" });
    expect(searchPlaces).not.toHaveBeenCalled();

    const reserve = vi.fn(async () => {});
    const allowed = createPlanningService({
      config: amapConfig,
      now: () => t0,
      provider: { searchPlaces },
      beforeLiveSearch: reserve,
    });
    expect(await allowed.search("博物馆")).toMatchObject({ status: "ok" });
    expect([reserve.mock.calls.length, searchPlaces.mock.calls.length]).toEqual([1, 1]);

    const fixture = createPlanningService({
      config: readPlanningConfig(base),
      now: () => t0,
      beforeLiveSearch: reserve,
    });
    expect(await fixture.search("演示起点")).toMatchObject({ status: "ok" });
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});
