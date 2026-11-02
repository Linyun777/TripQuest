import { createOutingChangeHandler } from "../../../plan-handlers";

export const runtime = "nodejs";
// Re-planning a few days of an outing can take a couple of minutes.
export const maxDuration = 300;
export const POST = createOutingChangeHandler();
