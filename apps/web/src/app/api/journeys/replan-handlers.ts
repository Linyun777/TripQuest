import "server-only";
import { requireOwner } from "../../auth/owner";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";
import { isJourneyId } from "@tripquest/application";
import {
  dayProgressCommandSchema,
  reportDayProgress,
  type DayProgressRepository,
} from "@tripquest/application/day-progress";
import {
  REPLAN_STREAM_EVENT_BYTES,
  REPLAN_STREAM_TOTAL_BYTES,
  confirmReplanCommandSchema,
  prepareDayReplan,
  replanCommandSchema,
  replanStreamEventSchema,
  type DayReplanProblem,
  type ReplanResult,
  type ReplanStreamEvent,
} from "@tripquest/application/day-replan";
import {
  confirmDayReplan,
  loadReplanOriginal,
  type DayReplanRepository,
} from "@tripquest/application/day-replan-confirm";
import {
  createReplanRunner,
  createReplanScriptedModel,
  type ReplanDecisionModel,
} from "@tripquest/agent/replanning";
import { createReplanLiveModel } from "@tripquest/agent/replan-live";
import { DayRunError } from "@tripquest/agent/day-planning";
import type { MobilityProvider } from "@tripquest/providers";
import { PlanningFixtureProvider } from "@tripquest/providers/planning-fixture";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { readBody, sameOrigin } from "../planning/request-body";
import { readReplanConfig } from "../../journeys/replan-config";
import { verifyReplanReceipt } from "../../journeys/replan-receipt";
import { createS533LiveBudget, s533LedgerPath } from "../../journeys/replan-budget";
import { issueReplanOffer } from "../../journeys/replan-offer";
import { createTaskService, readRequestKey, tasksEnabled } from "../tasks/task-service";

type Repository = DayProgressRepository & DayReplanRepository;
const HTTP: Record<string, number> = {
  saved: 201,
  already_saved: 200,
  no_change: 200,
  invalid_request: 400,
  invalid_receipt: 403,
  not_found: 404,
  source_not_allowed: 403,
  invalid_report: 422,
  invalid_scope: 422,
  needs_information: 422,
  constraints_conflict: 422,
  acknowledgment_required: 422,
  stale: 409,
  candidate_changed: 409,
  intent_conflict: 409,
  expired: 410,
  disabled: 503,
  temporarily_unavailable: 503,
};
function reply(body: { status: string; [key: string]: unknown }, httpStatus?: number): Response {
  return Response.json(body, {
    status: httpStatus ?? HTTP[body.status] ?? 500,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readCommand<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  if (!sameOrigin(request)) return reply({ status: "invalid_request" }, 403);
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return reply({ status: "invalid_request" }, 415);
  }
  const body = await readBody(request);
  if (body === "too_large") return reply({ status: "invalid_request" }, 413);
  try {
    if (body === "invalid") throw new Error("invalid_body");
    return schema.parse(JSON.parse(body));
  } catch {
    return reply({ status: "invalid_request" });
  }
}

function emptyFailure(runId: string): ReplanResult {
  return {
    runId,
    status: "failed",
    code: "internal_error",
    counts: { model: 0, searches: 0, baseline: 0, tries: 0, routes: 0, semanticRepairs: 0 },
    elapsedMs: 0,
    usage: null,
  };
}

export function createReplanHandlers(options: {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  repository?: () => Repository;
  model?: ReplanDecisionModel;
  provider?: MobilityProvider;
  workspaceRoot?: string;
  /** S6.1 durable tasks; defaults to the shared service when PLANNING_TASKS_ENABLED=true. */
  tasks?: () => Pick<ReturnType<typeof createTaskService>, "createReplan"> | null;
  /** V2.12：当前用户（路由从会话取得）。 */
  userId?: string;
} = {}) {
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const repository = () =>
    options.repository?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, requireOwner(options.userId));
  const root = options.workspaceRoot ?? resolve(process.cwd(), "../..");

  async function liveModel(problem: DayReplanProblem, profileId: string, round: "developer" | "independent-test") {
    const budget = createS533LiveBudget(s533LedgerPath(root), round, now);
    const profilePath = resolve(root, "agent-models.local.json");
    if ((await stat(profilePath)).size > 64 * 1024) throw new Error("profile_limit");
    const model = options.model ?? createReplanLiveModel({
      config: JSON.parse(await readFile(profilePath, "utf8")),
      profileId,
      environment: environment(),
      beforeRequest: async () => {
        try {
          await budget.reserveModel(problem.runId);
        } catch {
          throw new DayRunError("live_budget");
        }
      },
    });
    await budget.reserveRun(problem.runId, profileId);
    return { model, budget };
  }

  const offerFor = (
    result: ReplanResult,
    problem: DayReplanProblem,
    execution: { mode: "scripted" | "live"; provider: string; model: string },
  ) => issueReplanOffer({ result, problem, execution, environment: environment(), now: now(), repository: repository() });

  return {
    async progress(request: Request, journeyId: string): Promise<Response> {
      const command = await readCommand(request, dayProgressCommandSchema);
      if (command instanceof Response) return command;
      if (!isJourneyId(journeyId)) return reply({ status: "invalid_request" });
      try {
        return reply(await reportDayProgress({
          journeyId,
          command,
          enabled: readReplanConfig(environment()).save.enabled,
          now: now(),
          repository: repository(),
        }));
      } catch {
        return reply({ status: "temporarily_unavailable" });
      }
    },

    async replan(request: Request, journeyId: string): Promise<Response> {
      const command = await readCommand(request, replanCommandSchema);
      if (command instanceof Response) return command;
      if (!isJourneyId(journeyId)) return reply({ status: "invalid_request" });
      const config = readReplanConfig(environment());
      if (!config.generation) return reply({ status: "disabled", message: config.availability.message });
      let problem: DayReplanProblem;
      let model: ReplanDecisionModel;
      let budget: ReturnType<typeof createS533LiveBudget> | null = null;
      try {
        const port = repository();
        const stored = await port.findCurrentJourney(journeyId);
        if (!stored) return reply({ status: "not_found" });
        if (stored.creationKind !== "generated_day") return reply({ status: "source_not_allowed" });
        // Facts are reread now; the page's versions only decide whether they are still current.
        const prepared = prepareDayReplan(stored, {
          runId: randomUUID(),
          scope: command.scope,
          goal: command.goal,
          nowMs: now(),
          basePlanVersion: command.basePlanVersion,
          baseObservationVersion: command.baseObservationVersion,
          original: await loadReplanOriginal(stored, port),
        });
        if (prepared.status !== "ready") return reply(prepared);
        problem = prepared.problem;
        // S6.1: the scripted fixture policy runs as a durable task the page polls.
        const tasks = config.modelMode === "scripted" && !options.model && !options.provider
          ? (options.tasks ?? (() => (tasksEnabled(environment()) ? createTaskService({ environment: environment(), now, userId: options.userId }) : null)))()
          : null;
        if (tasks) {
          const requestKey = readRequestKey(request);
          if (!requestKey) return reply({ status: "invalid_request" });
          const created = await tasks.createReplan(problem, requestKey);
          if (created.status === "intent_conflict") return reply({ status: "intent_conflict" });
          return reply(
            { status: "queued", taskId: created.task.id },
            created.status === "created" ? 202 : 200,
          );
        }
        if (config.modelMode === "live") {
          if (config.round === "disabled") return reply({ status: "disabled" });
          ({ model, budget } = await liveModel(problem, config.profileId, config.round));
        } else {
          model = options.model ?? createReplanScriptedModel();
        }
      } catch {
        return reply({
          status: "temporarily_unavailable",
          message: "调整服务、模型配置或本轮真实额度暂不可用。",
        });
      }
      const runner = createReplanRunner({
        provider: options.provider ?? new PlanningFixtureProvider(now),
        model,
        now,
      });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const encoder = new TextEncoder();
      let sequence = 0;
      let sent = 0;
      let open = true;
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const write = (event: ReplanStreamEvent, terminal = false): boolean => {
            if (!open) return false;
            let bytes: Uint8Array;
            try {
              bytes = encoder.encode(`${JSON.stringify(replanStreamEventSchema.parse(event))}\n`);
            } catch {
              return false;
            }
            const limit = terminal
              ? REPLAN_STREAM_TOTAL_BYTES
              : REPLAN_STREAM_TOTAL_BYTES - REPLAN_STREAM_EVENT_BYTES;
            if (bytes.byteLength > REPLAN_STREAM_EVENT_BYTES || sent + bytes.byteLength > limit) return false;
            try {
              output.enqueue(bytes);
            } catch {
              open = false;
              controller.abort();
              return false;
            }
            sent += bytes.byteLength;
            return true;
          };
          write({ type: "started", runId: problem.runId, sequence: 0 });
          let result: ReplanResult;
          try {
            result = await runner.run(problem, {
              signal: controller.signal,
              onProgress(progress) {
                if (write({ type: "progress", runId: problem.runId, sequence: sequence + 1, progress })) {
                  sequence += 1;
                }
              },
            });
          } catch {
            result = emptyFailure(problem.runId);
          }
          if (budget) {
            try {
              await budget.recordResult(problem.runId, result, model.model);
            } catch {
              result = {
                runId: problem.runId,
                status: "failed",
                code: "live_budget",
                counts: result.counts,
                elapsedMs: result.elapsedMs,
                usage: result.usage,
              };
            }
          }
          // Cancelled or disconnected runs never receive a confirmation receipt.
          const offer = controller.signal.aborted ? undefined : await offerFor(result, problem, {
            mode: model.mode,
            provider: model.provider,
            model: model.model,
          });
          const terminal = {
            type: "result" as const,
            runId: problem.runId,
            sequence: sequence + 1,
            result,
            ...(offer ? { offer } : {}),
          };
          if (!write(terminal, true)) {
            write({ ...terminal, result: emptyFailure(problem.runId), offer: undefined }, true);
          }
          request.signal.removeEventListener("abort", cancel);
          if (open) {
            open = false;
            output.close();
          }
        },
        cancel() {
          open = false;
          controller.abort();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-transform",
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },

    async confirm(request: Request, journeyId: string): Promise<Response> {
      const command = await readCommand(request, confirmReplanCommandSchema);
      if (command instanceof Response) return command;
      const config = readReplanConfig(environment());
      const at = now();
      let receipt;
      try {
        receipt = verifyReplanReceipt(command.receipt, config.save.secret, at);
        if (receipt.journeyId !== journeyId) return reply({ status: "invalid_receipt" });
      } catch {
        return reply({ status: "invalid_receipt" });
      }
      try {
        return reply(await confirmDayReplan({
          receipt,
          acknowledgeUnknowns: command.acknowledgeUnknowns,
          enabled: config.save.enabled,
          now: at,
          repository: repository(),
          idGenerator: { next: () => randomUUID() },
        }));
      } catch {
        return reply({ status: "temporarily_unavailable" });
      }
    },
  };
}
