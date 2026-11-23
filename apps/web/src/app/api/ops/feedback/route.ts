import { opsFeedbackGetApi, opsFeedbackPatchApi } from "../../../ops/api";

export const runtime = "nodejs";
export const GET = opsFeedbackGetApi();
export const PATCH = opsFeedbackPatchApi();
