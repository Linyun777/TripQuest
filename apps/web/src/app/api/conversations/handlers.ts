import "server-only";
import { withUser, type WithUser } from "../../auth/session";
import { z } from "zod";
import { draftPatchSchema } from "@tripquest/application/conversation";
import { readBody, sameOrigin } from "../planning/request-body";
import {
  createConversationService,
  type ConversationServiceOptions,
  type EditReply,
  type TurnReply,
} from "../../plan/conversation-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const citySchema = z.strictObject({ adcode: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(40) });
const messageSchema = z.strictObject({
  text: z.string().trim().min(1).max(1000),
  expectedCount: z.number().int().min(0).max(100_000).optional(),
  /** V2.10：只在第一条消息上：打开页面时定位得到的城市。 */
  city: citySchema.optional(),
  /** V2.11：只在第一条消息上：用户在页面上选了出游。 */
  mode: z.literal("outing").optional(),
  /** V3.5：页面给每条消息的编号；网络断了重发同一条，回已经存的那一轮（stages/V3.5.md §3.2）。 */
  clientId: z.uuid().optional(),
});

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const editSchema = z.strictObject({
  patch: draftPatchSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

function reply(result: TurnReply | EditReply): Response {
  switch (result.status) {
    case "ok":
      return json(result, 200);
    case "conflict":
      return json({ status: "conflict" }, 409);
    case "not_found":
      return json({ status: "not_found" }, 404);
    case "unavailable":
      return json({ status: "unavailable" }, 503);
    case "invalid":
      return json(result, 422);
  }
}

type ReadMessage =
  | { ok: true; message: z.infer<typeof messageSchema> }
  | { ok: false; response: Response };

async function readMessage(request: Request): Promise<ReadMessage> {
  if (!sameOrigin(request)) return { ok: false, response: json({ status: "forbidden" }, 403) };
  const body = await readBody(request);
  if (body === "too_large") return { ok: false, response: json({ status: "too_large" }, 413) };
  let parsed: z.infer<typeof messageSchema> | null = null;
  try {
    const result = messageSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
    parsed = result.success ? result.data : null;
  } catch {
    parsed = null;
  }
  return parsed ? { ok: true, message: parsed } : { ok: false, response: json({ status: "invalid_request" }, 400) };
}

/**
 * 客户端声明 Accept: application/x-ndjson 时，查询进度逐行返回，最后 done 携带整轮结果。
 * 启动前拒绝仍返回普通 JSON；页面断开只停止输出，本轮仍继续完成并保存。
 */
function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/x-ndjson");
}

// 这是工具进度流，最终回复仍整段返回；流断开不会撤销已发出的模型调用或数据库写入。
// 浏览器应重新读取对话确认结果，不能依据断连断言本轮没有完成。
function streamTurn(run: (progress: (text: string) => void) => Promise<TurnReply>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // 页面断开不撤销已开始的对话轮次，服务端继续完成并保存。
        }
      };
      let result: TurnReply;
      try {
        result = await run((text) => emit({ type: "progress", text }));
      } catch {
        result = { status: "unavailable" };
      }
      emit({ type: "done", reply: result });
      try {
        controller.close();
      } catch {
        // 客户端断开后流可能已关闭，忽略重复关闭。
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

/** 首条消息先创建对话，再按新对话状态执行第一轮。 */
export function createStartHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser(options, async (request: Request, user): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const read = await readMessage(request);
    if (!read.ok) return read.response;
    const { city, mode, clientId } = read.message;
    if (wantsStream(request)) return streamTurn((progress) => service.start(read.message.text, progress, city, mode, clientId));
    try {
      return reply(await service.start(read.message.text, undefined, city, mode, clientId));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** 后续消息带页面已见计数，防止根据过期上下文追加一轮。 */
export function createMessageHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    const read = await readMessage(request);
    if (!read.ok) return read.response;
    if (read.message.expectedCount === undefined) return json({ status: "invalid_request" }, 400);
    const { text, expectedCount, clientId } = read.message;
    if (wantsStream(request)) return streamTurn((progress) => service.send(conversationId, text, expectedCount, progress, clientId));
    try {
      return reply(await service.send(conversationId, text, expectedCount, undefined, clientId));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** 卡片编辑入口复用对话草案的补丁协议（D-051）。 */
export function createDraftHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let parsed: z.infer<typeof editSchema> | null = null;
    try {
      const result = editSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return json({ status: "invalid_request" }, 400);
    try {
      return reply(await service.editDraft(conversationId, parsed.patch, parsed.fingerprint));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

const allocateSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** 把一项（地点 v1 或兴趣 i1）移到第几天。 */
  move: z.strictObject({ target: z.string().regex(/^[vi]\d{1,2}$/), day: z.number().int().min(1).max(7) }).optional(),
});

/** V2.11：出游分到各天，或把一项移到别的天。 */
export function createAllocateHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let parsed: z.infer<typeof allocateSchema> | null = null;
    try {
      const result = allocateSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return json({ status: "invalid_request" }, 400);
    try {
      return reply(await service.allocate(conversationId, parsed.fingerprint, parsed.move));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

const modeSchema = z.strictObject({ mode: z.enum(["daily", "outing"]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });

/** POST /api/conversations/[id]/mode: V2.11 switches 日常 / 出游 with a new card that carries what was said. */
export function createModeHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let parsed: z.infer<typeof modeSchema> | null = null;
    try {
      const result = modeSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return json({ status: "invalid_request" }, 400);
    try {
      return reply(await service.switchMode(conversationId, parsed.mode, parsed.fingerprint));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

const locationSchema = z.strictObject({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

/** 用户点击后单次提交设备点，服务端解析为最近地点后丢弃精确坐标，不记录日志或持久存储。 */
export function createLocationHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let parsed: z.infer<typeof locationSchema> | null = null;
    try {
      const result = locationSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return json({ status: "invalid_request" }, 400);
    try {
      return reply(await service.useLocation(conversationId, { longitude: parsed.longitude, latitude: parsed.latitude }, parsed.fingerprint));
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}


const decisionSchema = z.strictObject({ messageId: z.uuid(), decision: z.enum(["save", "dismiss"]) });

/** V2.9 POST /api/conversations/[id]/preference：在“要记住吗？”卡片上点“记住”或“不用”。 */
export function createPreferenceDecisionHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser<{ params: Promise<{ conversationId: string }> }>(options, async (request: Request, user, context: { params: Promise<{ conversationId: string }> }): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    const { conversationId } = await context.params;
    if (!UUID.test(conversationId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let parsed: z.infer<typeof decisionSchema> | null = null;
    try {
      const result = decisionSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return json({ status: "invalid_request" }, 400);
    try {
      const status = await service.decidePreference(conversationId, parsed.messageId, parsed.decision);
      const code = status === "saved" || status === "dismissed" ? 200 : status === "not_found" ? 404 : status === "invalid" ? 422 : 409;
      return json({ status }, code);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

const pointSchema = z.strictObject({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90) });

/**
 * V2.10 POST /api/city：打开页面时的定位只换成所在城市（编码和名称），用来显示和写进卡片；
 * 精确点只用于这一次查询，不保存、不记日志。查不到时页面显示缺省的杭州。
 */
export function createCityHandler(options: WithUser<ConversationServiceOptions> = {}) {
  return withUser(options, async (request: Request, user): Promise<Response> => {
    const service = createConversationService({ ...options, userId: user.id });
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    const body = await readBody(request);
    if (body === "too_large") return json({ status: "too_large" }, 413);
    let point: z.infer<typeof pointSchema> | null = null;
    try {
      const parsed = pointSchema.safeParse(body === "invalid" ? null : JSON.parse(body));
      point = parsed.success ? parsed.data : null;
    } catch {
      point = null;
    }
    if (!point) return json({ status: "invalid_request" }, 400);
    try {
      const city = await service.locateCity(point);
      return city ? json({ status: "ok", city }) : json({ status: "unavailable" }, 503);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}
