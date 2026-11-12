import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDayPlanningProblem,
  dayPlanningResultSchema,
  type DayPlanningProblem,
  type DayPlanningResult,
  type DayPlanningRunner,
} from "@tripquest/application/day-planning";
import { createDayPlanningRunner, createDayScriptedModel, DayRunError, type DayPlanningDecisionModel } from "@tripquest/agent/day-planning";
import { createDayLiveModel } from "@tripquest/agent/day-live";
import { AmapMobilityProvider } from "@tripquest/providers/server";
import { PlanningFixtureProvider, PLANNING_FIXTURE_VERSION } from "@tripquest/providers/planning-fixture";
import type { MobilityProvider } from "@tripquest/providers";
import { createPlanningService } from "./planning-service";
import { readGenerationConfig } from "./generation-config";
import { createS52LiveBudget, s52LedgerPath } from "./live-budget";
import { UsageUnavailableError } from "@tripquest/db";
import { createUserUsage, meteredAmap } from "../../usage/usage";
import { requireOwner } from "../../auth/owner";
import type { ReviewReply } from "./contracts";

export type PreparedGeneration =
  | Exclude<ReviewReply, { status: "ready" }>
  | {
      status: "ready";
      problem: DayPlanningProblem;
      runner: DayPlanningRunner;
      /** Fixture data with the scripted policy: eligible for a durable task (S6.1). */
      durable: boolean;
    };

export function createGenerationService(options: {
  environment?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  now?: () => number;
  provider?: MobilityProvider;
  model?: DayPlanningDecisionModel;
  /** V2.12：当前用户（个人模式下用量记在他名下）。 */
  userId?: string;
} = {}) {
  const owner = () => requireOwner(options.userId);
  const environment = options.environment ?? process.env;
  const root = options.workspaceRoot ?? resolve(process.cwd(), "../..");
  const now = options.now ?? Date.now;
  return {
    async prepare(submission: unknown): Promise<PreparedGeneration> {
      const config = readGenerationConfig(environment);
      if (!config.enabled) return { status: "unavailable", message: config.availability.message };
      const reviewed = createPlanningService({ config: config.planning, now }).review(submission);
      if (reviewed.status !== "ready") return reviewed;
      const requirements = reviewed.requirements;
      const selections = [requirements.startPlace, requirements.endPlace, ...requirements.visits.map((v) => v.place)];
      if (config.planning.source === "fixture" && selections.some((s) => s.evidence.datasetVersion !== PLANNING_FIXTURE_VERSION)) {
        return { status: "invalid", fieldErrors: { form: ["演示目录已更新，请重新搜索并选择起终点及活动地点。"] } };
      }
      let problem: DayPlanningProblem;
      try {
        problem = createDayPlanningProblem({
          requirements, runId: randomUUID(),
          requirementsFingerprint: createHash("sha256").update(JSON.stringify(requirements)).digest("hex"), nowMs: now(),
        });
      } catch {
        return { status: "invalid", fieldErrors: { form: ["地点快照不一致，请重新选择相关地点。"] } };
      }
      try {
        const real = !config.personal && (config.modelMode === "live" || config.planning.source === "amap");
        const budget = real && config.round !== "disabled"
          ? createS52LiveBudget(s52LedgerPath(root), config.round, now) : null;
        let model: DayPlanningDecisionModel;
        if (config.modelMode === "live") {
          if (options.model) model = options.model;
          else {
            const profilePath = resolve(root, "agent-models.local.json");
            if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
            const profileConfig: unknown = JSON.parse(await readFile(profilePath, "utf8"));
            const usage = config.personal ? createUserUsage(owner(), now) : null;
            model = createDayLiveModel({
              config: profileConfig, profileId: config.profileId, environment,
              beforeRequest: async () => {
                try {
                  if (usage) await usage.reserve("model", "model", "generation");
                  else await budget!.reserveRequest(problem.runId, "model");
                } catch (error) {
                  // 账本暂时记不了不是次数用完（同对话规划）。
                  throw new DayRunError(error instanceof UsageUnavailableError ? "internal_error" : "live_budget");
                }
              },
            });
          }
        } else model = options.model ?? createDayScriptedModel();
        const provider = options.provider ?? (config.planning.source === "fixture"
          ? new PlanningFixtureProvider(now)
          : config.personal
            ? meteredAmap({
                key: config.planning.key,
                usage: createUserUsage(owner(), now),
                purpose: "generation",
                now,
              })
            : new AmapMobilityProvider({ key: config.planning.key, fetch: globalThis.fetch, now: () => new Date(now()).toISOString() }));
        if (real) await budget!.reserveRun(problem.runId, config.planning.source, config.modelMode);
        const runner = createDayPlanningRunner({
          provider, model, now,
          beforeProvider: async (kind) => {
            if (config.planning.source !== "amap" || config.personal) return;
            try { await budget!.reserveRequest(problem.runId, kind); }
            catch { throw new DayRunError("live_budget"); }
          },
        });
        return {
          status: "ready", problem,
          // Task rows store the whole problem, so only fixture data may become durable (D-046).
          durable: !real && config.planning.source === "fixture" && !options.model && !options.provider,
          runner: {
            async run(frozen, runOptions): Promise<DayPlanningResult> {
              const result = dayPlanningResultSchema.parse(await runner.run(frozen, runOptions));
              if (budget) {
                try { await budget.recordResult(problem.runId, result, model.model); }
                catch {
                  return { runId: problem.runId, counts: result.counts, elapsedMs: result.elapsedMs, usage: result.usage, status: "failed", code: "live_budget" };
                }
              }
              return result;
            },
          },
        };
      } catch {
        return { status: "unavailable", message: "生成配置或本轮真实预算不可用，请检查本地 profile、凭据与调用记录。" };
      }
    },
  };
}
