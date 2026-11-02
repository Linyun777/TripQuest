import "server-only";
import { readDayEditConfig } from "./edit-receipt";

export type ReplanRound = "developer" | "independent-test";
export interface ReplanAvailability {
  readonly enabled: boolean;
  readonly message: string;
}
export type ReplanConfig = {
  /** Saving reports and confirming plans share PLANNING_SAVE_ENABLED and its receipt secret. */
  readonly save: { readonly enabled: boolean; readonly secret: string };
  readonly availability: ReplanAvailability;
} & (
  | { readonly generation: false }
  | {
      readonly generation: true;
      readonly modelMode: "scripted" | "live";
      readonly round: ReplanRound | "disabled";
      readonly profileId: string;
    }
);

/** Data is always the local fixture; the global place source never switches it to a real map. */
export function readReplanConfig(environment: NodeJS.ProcessEnv = process.env): ReplanConfig {
  const save = readDayEditConfig(environment);
  const off = (message: string): ReplanConfig => ({
    save,
    generation: false,
    availability: { enabled: false, message },
  });
  if (environment.PLANNING_GENERATION_ENABLED !== "true") {
    return off("途中调整尚未启用；可以继续保存进度报告。");
  }
  const modelMode = environment.PLANNING_MODEL_MODE ?? "scripted";
  const round = environment.REPLANNING_LIVE_ROUND ?? "disabled";
  if (!["scripted", "live"].includes(modelMode) || !["disabled", "developer", "independent-test"].includes(round)) {
    return off("途中调整配置无效，请检查本地设置。");
  }
  if (modelMode === "live") {
    if (environment.NODE_ENV !== "development") return off("当前环境不允许真实模型调整。");
    if (round === "disabled") return off("本阶段真实模型验证轮次尚未启用。");
    if (environment.AGENT_LIVE_ENABLED !== "true" || !environment.AGENT_MODEL_PROFILE) {
      return off("真实模型尚未配置，请检查本地模型开关与 profile。");
    }
  }
  return {
    save,
    generation: true,
    modelMode: modelMode as "scripted" | "live",
    round: round as ReplanRound | "disabled",
    profileId: environment.AGENT_MODEL_PROFILE ?? "",
    availability: {
      enabled: true,
      message: modelMode === "live"
        ? "演示地点与路线 + 真实模型决策；地点为虚构样例，本轮受调用预算限制。"
        : "演示调整：地点、路线与决策均为本地虚构/规则演示，不调用外部服务。",
    },
  };
}
