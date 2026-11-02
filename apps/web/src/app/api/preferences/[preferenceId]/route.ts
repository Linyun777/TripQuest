import { createPreferenceDeleteHandler, createPreferenceEditHandler } from "../handlers";

export const runtime = "nodejs";
export const PATCH = createPreferenceEditHandler();
export const DELETE = createPreferenceDeleteHandler();
