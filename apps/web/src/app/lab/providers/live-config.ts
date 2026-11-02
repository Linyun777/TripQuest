import "server-only";
import type { LiveConfiguration } from "./live-types";
export function liveConfiguration(): LiveConfiguration {
  if (process.env.NODE_ENV !== "development") return "unavailable";
  if (process.env.AMAP_LIVE_ENABLED !== "true") return "disabled";
  if (!process.env.AMAP_WEB_SERVICE_KEY?.trim()) return "missing_key";
  return "ready";
}
