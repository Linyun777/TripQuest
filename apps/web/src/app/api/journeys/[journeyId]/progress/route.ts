import { withUser } from "../../../../auth/session";
import { createProgressHandlers } from "../../progress-handlers";

export const runtime = "nodejs";
export const POST = withUser<{ params: Promise<{ journeyId: string }> }>({}, async (request, user, context) => {
  const { journeyId } = await context.params;
  return createProgressHandlers({ userId: user.id }).progress(request, journeyId);
});
