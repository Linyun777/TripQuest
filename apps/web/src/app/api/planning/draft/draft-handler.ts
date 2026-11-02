import "server-only";
import { traced } from "../../../runs/runs";
import { withUser, type UserResolver } from "../../../auth/session";
import {
  DAY_STREAM_EVENT_BYTES,
  DAY_STREAM_TOTAL_BYTES,
  dayStreamEventSchema,
  type DayPlanningResult,
  type DayStreamEvent,
  type DaySaveOffer,
} from "@tripquest/application/day-planning";
import type { DayDraftConfirmationSnapshot } from "@tripquest/application/day-confirmation";
import { createDraftSaveOffer } from "../../../planning/new/draft-receipt";
import { createGenerationService } from "../../../planning/new/generation-service";
import { createTaskService, readRequestKey, taskJson, tasksEnabled } from "../../tasks/task-service";

import { PLANNING_BODY_LIMIT, readBody, sameOrigin } from "../request-body";

export const DRAFT_BODY_LIMIT = PLANNING_BODY_LIMIT;

type Service = Pick<ReturnType<typeof createGenerationService>, "prepare">;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function refusal(status: number, message: string): Response {
  return json(status, { status: "unavailable", message });
}

function internalFailure(runId: string): DayPlanningResult {
  return {
    runId,
    status: "failed",
    code: "internal_error",
    counts: { model: 0, searches: 0, tries: 0, routes: 0, semanticRepairs: 0 },
    elapsedMs: 0,
    usage: null,
  };
}

type Tasks = Pick<ReturnType<typeof createTaskService>, "createDraft">;

export function createDraftHandler(
  createService: (userId: string) => Service = (userId) => createGenerationService({ userId }),
  createOffer: typeof createDraftSaveOffer = createDraftSaveOffer,
  createTasks: (userId: string) => Tasks | null = (userId) => (tasksEnabled() ? createTaskService({ userId }) : null),
  /** V2.12：测试注入当前用户。 */
  user?: UserResolver,
) {
  return withUser({ ...(user ? { user } : {}) }, async (request, sessionUser): Promise<Response> => {
    if (!sameOrigin(request)) return refusal(403, "只接受本页面发起的生成请求。");
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json\s*(?:;|$)/i.test(type)) {
      return refusal(415, "生成请求必须是 JSON。");
    }
    const text = await readBody(request);
    if (text === "too_large") return refusal(413, "提交内容过大。");
    let submission: unknown;
    try {
      if (text === "invalid") throw new Error("invalid_body");
      submission = JSON.parse(text);
    } catch {
      return refusal(400, "提交格式不正确。");
    }

    // Tokens, configuration and requirements are rechecked before any stream or external call.
    const prepared = await createService(sessionUser.id).prepare(submission);
    if (prepared.status === "unavailable") return json(503, prepared);
    if (prepared.status === "invalid") return json(422, prepared);

    // S6.1: fixture + scripted runs become a durable task the page polls; real modes stream.
    const tasks = prepared.durable ? createTasks(sessionUser.id) : null;
    if (tasks) {
      const requestKey = readRequestKey(request);
      if (!requestKey) return refusal(400, "缺少本次生成的请求编号，请刷新页面后重试。");
      try {
        const created = await tasks.createDraft(prepared.problem, requestKey);
        if (created.status === "intent_conflict") {
          return refusal(409, "这个请求编号已用于不同的需求，请刷新页面后重新生成。");
        }
        return taskJson(
          { taskId: created.task.id, status: created.task.status },
          created.status === "created" ? 202 : 200,
        );
      } catch {
        return refusal(503, "暂时无法创建生成任务，请稍后重试。");
      }
    }

    const { problem, runner } = prepared;
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
        // Progress may be dropped near the size limit; the single terminal event never is.
        const write = (event: DayStreamEvent, terminal = false): boolean => {
          if (!open) return false;
          let bytes: Uint8Array;
          try {
            bytes = encoder.encode(`${JSON.stringify(dayStreamEventSchema.parse(event))}\n`);
          } catch {
            return false;
          }
          const limit = terminal
            ? DAY_STREAM_TOTAL_BYTES
            : DAY_STREAM_TOTAL_BYTES - DAY_STREAM_EVENT_BYTES;
          if (bytes.byteLength > DAY_STREAM_EVENT_BYTES || sent + bytes.byteLength > limit) {
            return false;
          }
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
        let result: DayPlanningResult;
        let snapshot: DayDraftConfirmationSnapshot | null = null;
        let snapshots = 0;
        try {
          // V3.0：旧的一日规划页也是 plan 根运行。
          result = await traced({ trigger: "plan", userId: sessionUser.id }, () => runner.run(problem, {
            signal: controller.signal,
            onDraftReady(next) {
              snapshots += 1;
              snapshot = snapshots === 1 ? next : null;
            },
            onProgress(progress) {
              const event = {
                type: "progress" as const,
                runId: problem.runId,
                sequence: sequence + 1,
                progress,
              };
              if (write(event)) sequence += 1;
            },
          }));
        } catch {
          result = internalFailure(problem.runId);
        }
        let saveOffer: DaySaveOffer | undefined;
        if (!controller.signal.aborted && result.status === "completed" && result.outcome === "draft") {
          try {
            saveOffer = await createOffer(snapshot, result);
          } catch {
            saveOffer = { status: "unavailable", reason: "snapshot_invalid" };
          }
        }
        const terminal = {
          type: "result" as const,
          runId: problem.runId,
          sequence: sequence + 1,
          result,
          ...(saveOffer ? { saveOffer } : {}),
        };
        if (!write(terminal, true)) {
          const withoutOffer = {
            type: terminal.type, runId: terminal.runId,
            sequence: terminal.sequence, result: terminal.result,
            saveOffer: { status: "unavailable" as const, reason: "receipt_too_large" as const },
          };
          if (!write(withoutOffer, true)) {
            write({ ...withoutOffer, result: internalFailure(problem.runId) }, true);
          }
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
  });
}
