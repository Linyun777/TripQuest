import { createOutingHandler } from "../../plan-handlers";

export const runtime = "nodejs";
// An outing plans day by day; seven days can take several minutes.
export const maxDuration = 600;
export const POST = createOutingHandler();
