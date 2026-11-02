import { createDraftHandler } from "./draft-handler";

export const runtime = "nodejs";

// POST only: Next answers other methods with 405 and adds no CORS headers.
export const POST = createDraftHandler();
