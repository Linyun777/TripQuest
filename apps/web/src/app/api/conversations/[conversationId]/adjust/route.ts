import { createAdjustHandler } from "../../plan-handlers";

export const runtime = "nodejs";
// Planning the rest of the day streams for up to a couple of minutes.
export const maxDuration = 180;
export const POST = createAdjustHandler();
