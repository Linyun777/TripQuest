import "server-only";

/**
 * S5.5 (D-046): saving and reopening days with real Amap places is a local, personal,
 * opt-in development mode. All three switches and a key are required; otherwise real
 * days stay unreadable and no Amap request is sent.
 */
export function readRealPlaceMode(environment: NodeJS.ProcessEnv = process.env):
  | { enabled: true; key: string }
  | { enabled: false } {
  const key = environment.AMAP_WEB_SERVICE_KEY?.trim() ?? "";
  const enabled =
    environment.NODE_ENV === "development" &&
    environment.PLANNING_PLACE_SOURCE === "amap" &&
    environment.REAL_PLACE_SAVE_ENABLED === "true" &&
    key.length > 0;
  return enabled ? { enabled: true, key } : { enabled: false };
}
