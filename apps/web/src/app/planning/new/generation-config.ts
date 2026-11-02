import "server-only";
import type { GenerationAvailability } from "./contracts";
import { readPlanningConfig, type PlanningConfig } from "./planning-config";
import { readRealPlaceMode } from "../../real-places/real-mode";

export type LiveRound = "developer" | "independent-test";
export type { GenerationAvailability };
export type GenerationConfig =
  | { enabled: false; availability: GenerationAvailability }
  | {
      enabled: true;
      planning: Extract<PlanningConfig, { enabled: true }>;
      modelMode: "scripted" | "live";
      round: LiveRound | "disabled";
      /** S5.5/V2.1: local personal real mode, metered per day instead of one-off rounds. */
      personal: boolean;
      profileId: string;
      availability: GenerationAvailability;
    };

export function readGenerationConfig(environment: NodeJS.ProcessEnv = process.env): GenerationConfig {
  const unavailable = (message: string): GenerationConfig => ({ enabled: false, availability: { enabled: false, message } });
  if (environment.PLANNING_GENERATION_ENABLED !== "true") {
    return unavailable("草稿生成尚未启用；可以继续填写、选点并核对需求。");
  }
  const planning = readPlanningConfig(environment);
  if (!planning.enabled) return unavailable("请先启用可用的地点选择服务。");
  const modelMode = environment.PLANNING_MODEL_MODE ?? "scripted";
  const round = environment.PLANNING_LIVE_ROUND ?? "disabled";
  if (!["scripted", "live"].includes(modelMode) || !["disabled", "developer", "independent-test"].includes(round)) {
    return unavailable("草稿生成配置无效，请检查本地设置。");
  }
  const live = modelMode === "live";
  const amap = planning.source === "amap";
  if ((amap || live) && environment.NODE_ENV !== "development") {
    return unavailable("当前环境不允许真实地点或模型生成。");
  }
  if (amap && environment.PLANNING_AMAP_GENERATION_ENABLED !== "true") {
    return unavailable("真实地点生成尚未启用，周边搜索与本地规划使用条件仍需核实。");
  }
  // Personal real mode (S5.5, D-051): Amap with rules or a live model, metered by the daily
  // local ledger instead of a one-off round; the user accepted the local-use risk (D-046).
  const personal = amap && readRealPlaceMode(environment).enabled;
  if (amap && live && !personal && environment.PLANNING_AMAP_MODEL_ENABLED !== "true") {
    return unavailable("真实地点用于模型规划的处理条件尚未确认。");
  }
  if ((amap || live) && round === "disabled" && !personal) return unavailable("本次真实验证轮次尚未启用。");
  if (live && (environment.AGENT_LIVE_ENABLED !== "true" || !environment.AGENT_MODEL_PROFILE)) {
    return unavailable("真实模型尚未配置，请检查本地模型开关与 profile。");
  }
  return {
    enabled: true, planning, modelMode: modelMode as "scripted" | "live", round: round as LiveRound | "disabled",
    personal,
    profileId: environment.AGENT_MODEL_PROFILE ?? "",
    availability: {
      enabled: true,
      message: planning.source === "fixture"
        ? live ? "演示地点与路线 + 真实模型：全部地点为虚构样例，本轮受调用预算限制。"
          : "演示生成：地点、路线与决策均为本地虚构/规则演示，不调用外部服务。"
        : "按高德地点与步行路线排出一天的安排；营业与票务请自行确认。",
    },
  };
}
