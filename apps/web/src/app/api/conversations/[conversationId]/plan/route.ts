import { createPlanHandler } from "../../plan-handlers";

export const runtime = "nodejs";
// Planning streams for up to a couple of minutes.
export const maxDuration = 180;
export const POST = createPlanHandler();
