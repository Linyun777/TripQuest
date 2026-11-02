import { isJourneyId } from "@tripquest/application";
import { withUser } from "../../../../auth/session";
import { sameOrigin } from "../../../planning/request-body";
import { createTaskService, taskJson } from "../../task-service";

export const runtime = "nodejs";
export const POST = withUser<{ params: Promise<{ taskId: string }> }>({}, async (request, user, context) => {
  const { taskId } = await context.params;
  if (!sameOrigin(request)) return taskJson({ status: "invalid_request" }, 403);
  if (!isJourneyId(taskId)) return taskJson({ status: "invalid_request" }, 400);
  try {
    const view = await createTaskService({ userId: user.id }).cancel(taskId);
    if (!view) return taskJson({ status: "not_found" }, 404);
    return taskJson(view, view.status === "cancelled" || !view.cancelRequested ? 200 : 202);
  } catch {
    return taskJson({ status: "temporarily_unavailable" }, 503);
  }
});
