import { withUser } from "../../../../../auth/session";
import { createReplanHandlers } from "../../../replan-handlers";

export const runtime = "nodejs";
export const POST = withUser<{ params: Promise<{ journeyId: string }> }>({}, async (request, user, context) => {
  const { journeyId } = await context.params;
  return createReplanHandlers({ userId: user.id }).confirm(request, journeyId);
});
