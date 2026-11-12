import "server-only";
import { requireOwner } from "../../auth/owner";
import type { z } from "zod";
import { isJourneyId } from "@tripquest/application";
import {
  dayProgressCommandSchema,
  reportDayProgress,
  type DayProgressRepository,
} from "@tripquest/application/day-progress";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { readBody, sameOrigin } from "../planning/request-body";
import { readDayEditConfig } from "../../journeys/edit-receipt";

/**
 * 演示行程的进度报告（S5.3.3）：只保存用户报告的事实（完成、跳过、时间、位置），不改计划。
 * V3.6：途中重排（replan Agent）已删除，这里只剩报告；已保存的重排版本照常能看。
 */
const HTTP: Record<string, number> = {
  saved: 201,
  already_saved: 200,
  no_change: 200,
  invalid_request: 400,
  not_found: 404,
  source_not_allowed: 403,
  invalid_report: 422,
  stale: 409,
  intent_conflict: 409,
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

export function createProgressHandlers(options: {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  repository?: () => DayProgressRepository;
  /** V2.12：当前用户（路由从会话取得）。 */
  userId?: string;
} = {}) {
  const environment = () => options.environment ?? process.env;
  const now = () => (options.now ?? Date.now)();
  const repository = () =>
    options.repository?.() ?? new DrizzleJourneyRepository(getSharedJourneyDatabase().database, requireOwner(options.userId));

  return {
    async progress(request: Request, journeyId: string): Promise<Response> {
      const command = await readCommand(request, dayProgressCommandSchema);
      if (command instanceof Response) return command;
      if (!isJourneyId(journeyId)) return reply({ status: "invalid_request" });
      try {
        return reply(await reportDayProgress({
          journeyId,
          command,
          // 保存报告和确认改动共用 PLANNING_SAVE_ENABLED 与它的凭据密钥。
          enabled: readDayEditConfig(environment()).enabled,
          now: now(),
          repository: repository(),
        }));
      } catch {
        return reply({ status: "temporarily_unavailable" });
      }
    },
  };
}
