import { isJourneyId } from "@tripquest/application";
import { withUser } from "../../../auth/session";
import { createTaskService, taskJson } from "../task-service";

export const runtime = "nodejs";
export const GET = withUser<{ params: Promise<{ taskId: string }> }>({}, async (_request, user, context) => {
  const { taskId } = await context.params;
  if (!isJourneyId(taskId)) return taskJson({ status: "invalid_request" }, 400);
  try {
    const view = await createTaskService({ userId: user.id }).read(taskId);
    return view ? taskJson(view, 200) : taskJson({ status: "not_found" }, 404);
  } catch {
    return taskJson({ status: "temporarily_unavailable" }, 503);
  }
});
