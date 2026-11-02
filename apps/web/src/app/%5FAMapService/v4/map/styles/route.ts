import { createMapStyleHandler } from "../../../../journeys/map-config";

export const runtime = "nodejs";
export const GET = createMapStyleHandler();
export function HEAD() {
  return new Response(null, { status: 405 });
}
