import { createChoicesHandler } from "../../plan-handlers";

export const runtime = "nodejs";
// A step searches, asks the model and checks routes: well under a minute.
export const maxDuration = 120;
export const POST = createChoicesHandler();
