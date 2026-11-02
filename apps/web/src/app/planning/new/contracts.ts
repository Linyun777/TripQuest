import type {
  PlanningFieldErrors,
  PlanningPlace,
  PlanningRequirements,
} from "@tripquest/application";
import type { ProviderEvidence } from "@tripquest/providers";

export type PlaceSource = "fixture" | "amap";
export type PlacePurpose = "start" | "end" | "optional" | "required" | "fixed";
export interface SelectedPlace {
  selection: PlanningPlace;
  token: string;
}
export interface PlanningAvailability {
  enabled: boolean;
  source: PlaceSource | "disabled";
  message: string;
}
/** Safe for the browser: no mode secrets, profile names or ledger paths. */
export interface GenerationAvailability {
  enabled: boolean;
  message: string;
}
export type SearchReply =
  | {
      status: "ok";
      items: SelectedPlace[];
      evidence: ProviderEvidence;
      truncated: boolean;
    }
  | { status: "error"; message: string };
export type ReviewReply =
  | { status: "ready"; requirements: PlanningRequirements }
  | { status: "invalid"; fieldErrors: PlanningFieldErrors }
  | { status: "unavailable"; message: string };

export const INTEREST_LABELS = {
  culture: "展馆 / 文化",
  nature: "自然",
  city_walk: "城市散步",
  food: "餐饮",
} as const;
export const INTEREST_QUERIES = {
  culture: "博物馆",
  nature: "公园",
  city_walk: "步行街",
  food: "餐饮",
} as const;
