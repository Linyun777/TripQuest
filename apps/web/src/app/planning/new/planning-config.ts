import "server-only";
import type { PlanningAvailability, PlaceSource } from "./contracts";

export type PlanningConfig =
  | { enabled: false; availability: PlanningAvailability }
  | {
      enabled: true;
      source: PlaceSource;
      secret: string;
      key: string;
      availability: PlanningAvailability;
    };

export function readPlanningConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PlanningConfig {
  const source = environment.PLANNING_PLACE_SOURCE ?? "disabled";
  const secret = environment.PLANNING_PLACE_TOKEN_SECRET ?? "";
  const key = environment.AMAP_WEB_SERVICE_KEY?.trim() ?? "";
  const validSecret =
    secret.trim().length > 0 &&
    Buffer.byteLength(secret, "utf8") >= 32 &&
    secret !== key &&
    secret !== environment.DEEPSEEK_API_KEY;
  if (
    (source !== "fixture" && source !== "amap") ||
    !validSecret ||
    (source === "amap" && (environment.NODE_ENV !== "development" || !key))
  ) {
    return {
      enabled: false,
      availability: {
        enabled: false,
        source: "disabled",
        message:
          "地点服务尚未启用，或当前环境不允许查询。可以先填写需求，选点与核对暂不可用。",
      },
    };
  }
  return {
    enabled: true,
    source,
    secret,
    key,
    availability: {
      enabled: true,
      source,
      message:
        source === "fixture"
          ? "演示模式：全部地点为手写虚构样例，不代表真实杭州地点。"
          : "地点来自高德地图。营业时间、门票和预约请出发前自行确认。",
    },
  };
}
