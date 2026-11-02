import "server-only";
import { traced } from "../../runs/runs";
import { withUser, type WithUser } from "../../auth/session";
import { z } from "zod";
import { logFailure } from "../planning/failure-code";
import { readBody, sameOrigin } from "../planning/request-body";
import { adjustRequestSchema } from "@tripquest/application/real-adjust";
import { randomUUID } from "node:crypto";
import { DrizzleConversationRepository, DrizzleJobRepository, DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { attachJob, startJob, stopJob, type JobOptions, type JobRepository } from "../../plan/jobs";
import { createPlanService, type PlanEvent, type PlanServiceOptions } from "../../plan/plan-service";
import { outingChangeRequestSchema } from "@tripquest/agent/chat";
import { createOutingSave, type OutingChangeEvent, type OutingEvent, type OutingSaveReply } from "../../plan/outing-service";
import { DRAFT_RECEIPT_BYTES, readDraftSaveConfig, verifyDraftReceipt } from "../../planning/new/draft-receipt";
import { readRealPlaceMode } from "../../real-places/real-mode";
import { createUserUsage, meteredAmap } from "../../usage/usage";
import { createTripNotesService, type TripNotesOptions, type TripNotesReply } from "../../plan/trip-notes-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** V3.5：页面每次点开始生成一个请求键（UUID）；同一个键重试是同一次（stages/V3.5.md §3.2）。 */
const requestKey = z.uuid().optional();
const startSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestKey });

/** V3.5：长任务经 jobs.ts 登记、一次只跑一个；测试可以注入任务仓库。 */
type JobHandlerOptions = WithUser<PlanServiceOptions & { jobs?: (userId: string) => JobRepository }>;
function jobOptions(options: JobHandlerOptions, userId: string): JobOptions {
  return {
    jobs: () => options.jobs?.(userId) ?? new DrizzleJobRepository(getSharedJourneyDatabase().database, userId),
    userId,
    ...(options.now ? { now: options.now } : {}),
  };
}
const savedSchema = z.strictObject({ runId: z.uuid(), journeyId: z.uuid() });
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function readJson<T>(request: Request, schema: z.ZodType<T>, limit?: number): Promise<T | Response> {
  if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
  const body = await readBody(request, limit);
  if (body === "too_large") return json({ status: "too_large" }, 413);
  try {
    const parsed = schema.safeParse(body === "invalid" ? null : JSON.parse(body));
    return parsed.success ? parsed.data : json({ status: "invalid_request" }, 400);
  } catch {
    return json({ status: "invalid_request" }, 400);
  }
}

/** One JSON line per event; the run finishes and stores its result even if the page goes away. */
function streamEvents<E extends PlanEvent | OutingEvent | OutingChangeEvent>(run: (emit: (event: E) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: E) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The page went away; the run still finishes and its result is stored.
        }
      };
      try {
        await run(emit);
      } catch (error) {
        logFailure("plan-stream", error);
        emit({ type: "refused", status: "unavailable", message: "规划服务暂时出错，请稍后再试。" } as E);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a disconnected client.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * POST /api/conversations/[id]/plan: "开始规划" on the latest card. Streams one JSON line per
 * agent step, then a final "done" line with the stored messages and an in-memory save receipt.
 * Real data runs in this request only and never becomes a durable task (D-045/D-046).
 */
export function createPlanHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, startSchema);
    if (input instanceof Response) return input;
    return startJob(
      jobOptions(options, user.id),
      { conversationId, kind: "plan", requestKey: input.requestKey ?? randomUUID(), signal: AbortSignal.timeout(150_000) },
      (emit, signal) => service.plan(conversationId, input.fingerprint, emit as (event: PlanEvent) => void, signal),
    );
  });
}

const outingSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** “继续规划剩下的天”“重排这一天”；不写是整趟。 */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  requestKey,
});

/**
 * POST /api/conversations/[id]/outing: V2.11 generates an outing day by day. Streams progress lines
 * ("第 2 天：…"), one "day" line per finished day (stored as a message, with that day's in-memory save
 * receipts), then "outing_done". A dropped connection loses at most the day being planned.
 */
export function createOutingHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, outingSchema);
    if (input instanceof Response) return input;
    const { requestKey: key, ...outing } = input;
    return startJob(
      jobOptions(options, user.id),
      { conversationId, kind: "outing", requestKey: key ?? randomUUID(), ...(outing.days ? { planned: outing.days } : {}), signal: AbortSignal.timeout(540_000) },
      (emit, signal) => service.outing(conversationId, outing, emit as (event: OutingEvent) => void, signal),
    );
  });
}

// V3.2：保存之后采纳审查建议也走改动流程（request 写成 adopt：哪条消息的第几条建议）。
const adoptSchema = z.strictObject({ adopt: z.strictObject({ messageId: z.uuid(), index: z.number().int().min(0).max(11) }) });
const outingChangeSchema = z.strictObject({ expectedCount: z.number().int().nonnegative(), request: z.union([outingChangeRequestSchema, adoptSchema]), requestKey });

/**
 * POST /api/conversations/[id]/outing/change: V2.11 re-plans the days a cross-day change touches (the chat
 * understood it), streaming like "开始规划"; the last line carries the change card and its in-memory receipts.
 */
export function createOutingChangeHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, outingChangeSchema);
    if (input instanceof Response) return input;
    const { requestKey: key, ...change } = input;
    return startJob(
      jobOptions(options, user.id),
      { conversationId, kind: "outing_change", requestKey: key ?? randomUUID(), signal: AbortSignal.timeout(300_000) },
      (emit, signal) => service.outingChange(conversationId, change, emit as (event: OutingChangeEvent) => void, signal),
    );
  });
}

const reviewDecisionSchema = z.strictObject({
  messageId: z.uuid(),
  index: z.number().int().min(0).max(11),
  decision: z.enum(["adopt", "dismiss"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const REVIEW_STATUS: Record<string, number> = { ok: 200, saved_trip: 200, not_found: 404, conflict: 409, invalid: 422 };

/**
 * POST /api/conversations/[id]/review: V3.2 adopts or dismisses one review suggestion. Before the outing is
 * saved, adopting changes the card and answers the days to re-plan; after saving it answers saved_trip and the
 * page goes through the outing change flow (confirm before saving).
 */
export function createReviewHandler(options: WithUser<PlanServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, reviewDecisionSchema);
    if (input instanceof Response) return input;
    const reply = await service.decideReview(conversationId, input);
    return json(reply, REVIEW_STATUS[reply.status] ?? 200);
  });
}

/** V2.11 出游保存带着每一段的保存凭据（最多 7 天 × 3 段）。 */
const OUTING_RECEIPTS = 21;
const OUTING_BODY_LIMIT = OUTING_RECEIPTS * DRAFT_RECEIPT_BYTES + 8 * 1024;
const outingChangeConfirmSchema = z.strictObject({
  messageId: z.uuid(),
  receipts: z.array(z.string().min(1).max(DRAFT_RECEIPT_BYTES)).max(OUTING_RECEIPTS),
});
const OUTING_CHANGE_STATUS: Record<string, number> = {
  saved: 201, already_saved: 200, not_found: 404, stale: 409, invalid_receipt: 403, expired: 410, disabled: 503,
  acknowledgment_required: 422, draft_changed: 409, temporarily_unavailable: 503,
};

/** POST /api/conversations/[id]/outing/change/confirm: V2.11 saves a cross-day change (real mode only, D-046). */
export function createOutingChangeConfirmHandler(options: WithUser<PlanServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, outingChangeConfirmSchema, OUTING_BODY_LIMIT);
    if (input instanceof Response) return input;
    if (!readRealPlaceMode(options.environment ?? process.env).enabled) return json({ status: "disabled" }, 403);
    try {
      const result = await service.confirmOutingChange(conversationId, input);
      return json(result, OUTING_CHANGE_STATUS[result.status] ?? 500);
    } catch (error) {
      logFailure("outing-change", error, options.environment);
      return json({ status: "temporarily_unavailable" }, 503);
    }
  });
}

const outingSaveSchema = z.strictObject({
  generationId: z.uuid(),
  receipts: z.array(z.string().min(1).max(DRAFT_RECEIPT_BYTES)).min(1).max(OUTING_RECEIPTS),
  acknowledgeUnknowns: z.boolean(),
});
const OUTING_SAVE_STATUS: Record<OutingSaveReply["status"], number> = {
  saved: 201, already_saved: 200, not_found: 404, incomplete: 409, invalid_receipt: 403, expired: 410, disabled: 503,
  acknowledgment_required: 422, draft_changed: 409, temporarily_unavailable: 503, intent_conflict: 409,
};

/** POST /api/conversations/[id]/outing/save: V2.11 saves the whole outing at once (real mode only, D-046). */
export function createOutingSaveHandler(options: WithUser<{ environment?: NodeJS.ProcessEnv; now?: () => number }> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request, user, context): Promise<Response> => {
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, outingSaveSchema, OUTING_BODY_LIMIT);
    if (input instanceof Response) return input;
    const environment = options.environment ?? process.env;
    const mode = readRealPlaceMode(environment);
    if (!mode.enabled) return json({ status: "disabled" }, 403);
    const config = readDraftSaveConfig(environment);
    const now = options.now ?? Date.now;
    const database = () => getSharedJourneyDatabase().database;
    const save = createOutingSave({
      now,
      repository: () => new DrizzleConversationRepository(database(), user.id),
      trips: () => new DrizzleJourneyRepository(database(), user.id),
      routes: () => meteredAmap({ key: mode.key, usage: createUserUsage(user.id), purpose: "save" }),
      verify: (receipt, at) => verifyDraftReceipt(receipt, config.secret, at),
      enabled: () => config.enabled,
      cities: () => meteredAmap({ key: mode.key, usage: createUserUsage(user.id), purpose: "save" }),
    });
    try {
      const result = await traced({ trigger: "save", userId: user.id }, () => save(conversationId, input));
      return json(result, OUTING_SAVE_STATUS[result.status]);
    } catch (error) {
      logFailure("outing-save", error, environment);
      return json({ status: "temporarily_unavailable" }, 503);
    }
  });
}

const chooseSchema = z.strictObject({
  tripId: z.uuid(),
  messageId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** The picked place's Amap ID; absent = "换一批". */
  pick: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
});

/** POST /api/conversations/[id]/choices: V2.4 "就去这家" or "换一批" on a short trip's newest step. */
export function createChoicesHandler(options: WithUser<PlanServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, chooseSchema);
    if (input instanceof Response) return input;
    return streamEvents((emit) => service.choose(conversationId, input, emit, AbortSignal.timeout(120_000)));
  });
}

/** POST /api/conversations/[id]/saved: link a just-saved journey back to its plan card. */
export function createSavedHandler(options: WithUser<PlanServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, savedSchema);
    if (input instanceof Response) return input;
    try {
      const result = await service.markSaved(conversationId, input.runId, input.journeyId);
      return result === "ok" ? json({ status: "ok" }) : json({ status: "not_found" }, 404);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

const adjustSchema = z.strictObject({
  expectedCount: z.number().int().nonnegative(),
  request: adjustRequestSchema,
  // V2.6: the device's point for "从我这儿重新排", once; never stored or logged.
  here: z.strictObject({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90) }).optional(),
  requestKey,
});

/**
 * POST /api/conversations/[id]/adjust: V2.5 plans the change the chat just understood, streaming
 * like "开始规划"; the done line carries the adjustment card and its signed offer.
 */
export function createAdjustHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, adjustSchema);
    if (input instanceof Response) return input;
    const { requestKey: key, ...adjust } = input;
    return startJob(
      jobOptions(options, user.id),
      { conversationId, kind: "adjust", requestKey: key ?? randomUUID(), signal: AbortSignal.timeout(150_000) },
      (emit, signal) => service.adjust(conversationId, adjust, emit as (event: PlanEvent) => void, signal),
    );
  });
}

/**
 * GET /api/conversations/[id]/job：V3.5 这段对话最近的长任务。在跑就按行推送（先回放已发出的，再接着推）；
 * 不在跑回 JSON（none / done / failed / cancelled / interrupted）。打开页面、切回前台、网络恢复时页面来接。
 */
export function createJobHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (_request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    try {
      return await attachJob(jobOptions(options, user.id), conversationId);
    } catch (error) {
      logFailure("job-attach", error);
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** POST /api/conversations/[id]/job/stop {jobId}：V3.5 停止这段对话正在跑的长任务（只有主人能停）。 */
export function createJobStopHandler(options: JobHandlerOptions = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, z.strictObject({ jobId: z.uuid() }));
    if (input instanceof Response) return input;
    return stopJob(jobOptions(options, user.id), conversationId, input.jobId);
  });
}

const ADJUST_STATUS: Record<string, number> = {
  saved: 201, already_saved: 200, invalid_receipt: 403, expired: 410, stale: 409, draft_changed: 409,
  intent_conflict: 409, not_found: 404, temporarily_unavailable: 503,
};

/** POST /api/conversations/[id]/adjust/confirm: "确认调整" with the signed offer. */
export function createAdjustConfirmHandler(options: WithUser<PlanServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createPlanService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, z.strictObject({ receipt: z.string().min(1).max(48 * 1024) }));
    if (input instanceof Response) return input;
    try {
      const result = await service.confirmAdjust(conversationId, input.receipt);
      return json(result, ADJUST_STATUS[result.status] ?? 500);
    } catch (error) {
      logFailure("adjust-confirm", error);
      // A lost response or database fault does not establish that no write occurred.
      return json({ status: "temporarily_unavailable" }, 503);
    }
  });
}

const notesStatus = (reply: TripNotesReply) =>
  reply.status === "ok" ? 200 : reply.status === "not_found" ? 404 : reply.status === "unavailable" ? 503 : 502;

/** POST /api/conversations/[id]/trip-notes {runId}: V2.7.2 "出发须知" for that plan card. */
export function createPlanNotesHandler(options: WithUser<TripNotesOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createTripNotesService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, z.strictObject({ runId: z.uuid() }));
    if (input instanceof Response) return input;
    try {
      const reply = await service.forPlan(conversationId, input.runId);
      return json(reply, notesStatus(reply));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** POST /api/journeys/[id]/trip-notes: the same for a saved trip's stops still to do. */
export function createJourneyNotesHandler(options: WithUser<TripNotesOptions> = {}) {
  return withUser<{ params: Promise<{ journeyId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ journeyId: string }> }): Promise<Response> => {
    const service = createTripNotesService({ ...options, userId: user.id });
    const { journeyId } = await context.params;
    if (!UUID.test(journeyId)) return json({ status: "not_found" }, 404);
    const input = await readJson(request, z.strictObject({}));
    if (input instanceof Response) return input;
    try {
      const reply = await service.forJourney(journeyId);
      return json(reply, notesStatus(reply));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}
