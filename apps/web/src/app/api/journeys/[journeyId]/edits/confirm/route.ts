import { withUser } from "../../../../../auth/session";
import { createDayEditHandlers } from "../../../edit-handlers";

export const runtime = "nodejs";
export const POST = withUser<{ params: Promise<{ journeyId: string }> }>({}, async (request, user, context) => {
  const { journeyId } = await context.params;
  return createDayEditHandlers({ userId: user.id }).confirm(request, journeyId);
});
