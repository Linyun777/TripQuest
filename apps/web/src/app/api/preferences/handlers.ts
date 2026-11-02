import "server-only";
import { z } from "zod";
import { createPreferencesService } from "../../plan/preferences-service";
import { readBody, sameOrigin } from "../planning/request-body";
import { withUser, type WithUser } from "../../auth/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const editSchema = z.strictObject({ text: z.string().max(200), category: z.string().max(20) });

type Service = ReturnType<typeof createPreferencesService>;
type Context = { params: Promise<{ preferenceId: string }> };
/** V2.12：按当前用户建服务（测试注入）。 */
type Options = WithUser<{ service?: (userId: string) => Service }>;
const serviceFor = (options: Options, userId: string) => options.service?.(userId) ?? createPreferencesService({ userId });

/** PATCH /api/preferences/[id]：改正文或类别（同样的规则：不能含住处、号码）。 */
export function createPreferenceEditHandler(options: Options = {}) {
  return withUser<Context>(options, async (request, user, context): Promise<Response> => {
    const service = serviceFor(options, user.id);
    const { preferenceId } = await context.params;
    if (!UUID.test(preferenceId)) return json({ status: "not_found" }, 404);
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
      const outcome = await service.update(preferenceId, parsed);
      return json(outcome, outcome.status === "updated" ? 200 : outcome.status === "not_found" ? 404 : 422);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** DELETE /api/preferences/[id]：删除一条（物理删除，不可恢复）。 */
export function createPreferenceDeleteHandler(options: Options = {}) {
  return withUser<Context>(options, async (request, user, context): Promise<Response> => {
    const service = serviceFor(options, user.id);
    const { preferenceId } = await context.params;
    if (!UUID.test(preferenceId)) return json({ status: "not_found" }, 404);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    try {
      const outcome = await service.remove(preferenceId);
      return json(outcome, outcome.status === "removed" ? 200 : 404);
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}

/** DELETE /api/preferences：全部删除（页面先确认一次）。 */
export function createPreferencesClearHandler(options: Options = {}) {
  return withUser(options, async (request, user): Promise<Response> => {
    const service = serviceFor(options, user.id);
    if (!sameOrigin(request)) return json({ status: "forbidden" }, 403);
    try {
      return json({ status: "removed", count: await service.removeAll() });
    } catch {
      return json({ status: "unavailable" }, 503);
    }
  });
}
