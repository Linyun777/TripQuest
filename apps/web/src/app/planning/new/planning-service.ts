import "server-only";
import {
  PLANNING_INTERESTS,
  planningTimeSchema,
  validatePlanningRequirements,
  type PlanningFieldErrors,
  type PlanningPlace,
} from "@tripquest/application";
import type { MobilityProvider } from "@tripquest/providers";
import { AmapMobilityProvider } from "@tripquest/providers/server";
import { z } from "zod";
import type { ReviewReply, SearchReply } from "./contracts";
import { readPlanningConfig, type PlanningConfig } from "./planning-config";
import { searchPlanningFixture } from "./planning-fixture";
import {
  issuePlaceToken,
  PlaceTokenError,
  verifyPlaceToken,
} from "./place-token";

const token = z.string().min(1, "请搜索并明确选择地点").max(8192);
const visitSchema = z.discriminatedUnion("role", [
  z.strictObject({
    token,
    role: z.enum(["optional", "required"]),
    stayMinutes: z.number().int().min(15).max(240),
  }),
  z.strictObject({
    token,
    role: z.literal("fixed"),
    startsAt: planningTimeSchema,
    endsAt: planningTimeSchema,
  }),
]);
export const planningSubmissionSchema = z.strictObject({
  schemaVersion: z.literal("planning-requirements.v1"),
  cityAdcode: z.literal("330100"),
  timeZone: z.literal("Asia/Shanghai"),
  travelMode: z.literal("walking"),
  date: z.string().max(10),
  window: z.strictObject({
    startsAt: planningTimeSchema,
    endsAt: planningTimeSchema,
  }),
  startPlace: token,
  endPlace: token,
  interests: z.array(z.enum(PLANNING_INTERESTS)).max(4),
  pace: z.enum(["relaxed", "standard"]),
  visits: z.array(visitSchema).max(8),
});

/** Per-action instance; no retained selections, responses or cross-request cache. */
export function createPlanningService(
  options: {
    config?: PlanningConfig;
    now?: () => number;
    provider?: Pick<MobilityProvider, "searchPlaces">;
    /** S5.2 amap generation only: reserve the round's search budget before a real request. */
    beforeLiveSearch?: () => Promise<void>;
  } = {},
) {
  const config = options.config ?? readPlanningConfig();
  const now = options.now ?? Date.now;
  return {
    async search(query: unknown): Promise<SearchReply> {
      if (!config.enabled)
        return { status: "error", message: config.availability.message };
      if (
        typeof query !== "string" ||
        !query.trim() ||
        query.trim().length > 80
      ) {
        return { status: "error", message: "请输入 1–80 字符的杭州地点关键词" };
      }
      if (config.source === "amap" && options.beforeLiveSearch) {
        try {
          await options.beforeLiveSearch();
        } catch {
          return {
            status: "error",
            message: "本轮真实搜索额度不可用；已用、失败和取消的记录不会重置。",
          };
        }
      }
      try {
        const provider =
          options.provider ??
          new AmapMobilityProvider({
            key: config.key,
            fetch: globalThis.fetch,
            now: () => new Date(now()).toISOString(),
          });
        const result =
          config.source === "fixture"
            ? await searchPlanningFixture(query.trim(), now())
            : await provider.searchPlaces({
                query: query.trim(),
                scope: { kind: "city", cityAdcode: "330100" },
                limit: 5,
              });
        if (result.status === "failure") {
          return { status: "error", message: result.failure.safeMessage };
        }
        // Validate and sign the whole result set; never partly hide malformed data.
        const items = result.data.items.map((place) => {
          const selection = { place, evidence: result.evidence };
          return {
            selection,
            token: issuePlaceToken(
              selection,
              config.secret,
              config.source,
              now(),
            ),
          };
        });
        return {
          status: "ok",
          items,
          evidence: result.evidence,
          truncated: result.data.truncated,
        };
      } catch {
        return {
          status: "error",
          message: "暂时无法取得可用地点，请稍后手动重新搜索",
        };
      }
    },
    review(input: unknown): ReviewReply {
      if (!config.enabled)
        return { status: "unavailable", message: config.availability.message };
      try {
        const encoded = JSON.stringify(input);
        if (
          encoded === undefined ||
          Buffer.byteLength(encoded, "utf8") > 64 * 1024
        ) {
          return {
            status: "invalid",
            fieldErrors: { form: ["提交内容过大或格式不正确"] },
          };
        }
      } catch {
        return { status: "invalid", fieldErrors: { form: ["提交格式不正确"] } };
      }
      const parsed = planningSubmissionSchema.safeParse(input);
      if (!parsed.success) {
        const fieldErrors: PlanningFieldErrors = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.map(String).join(".") || "form";
          (fieldErrors[path] ??= []).push(
            issue.code === "unrecognized_keys"
              ? "输入包含不支持的字段"
              : "请检查该字段的格式或范围",
          );
        }
        return { status: "invalid", fieldErrors };
      }
      const errors: PlanningFieldErrors = {};
      const instant = now();
      const resolve = (value: string, path: string): PlanningPlace | null => {
        try {
          return verifyPlaceToken(value, config.secret, config.source, instant);
        } catch (error) {
          errors[path] = [
            error instanceof PlaceTokenError ? error.message : "请重新选择地点",
          ];
          return null;
        }
      };
      const value = parsed.data;
      const startPlace = resolve(value.startPlace, "startPlace");
      const endPlace = resolve(value.endPlace, "endPlace");
      const visits = value.visits.map(
        ({ token: selectionToken, ...intent }, index) => ({
          ...intent,
          place: resolve(selectionToken, `visits.${index}.place`),
        }),
      );
      if (Object.keys(errors).length > 0)
        return { status: "invalid", fieldErrors: errors };
      const checked = validatePlanningRequirements({
        ...value,
        startPlace,
        endPlace,
        visits,
      });
      return checked.success
        ? { status: "ready", requirements: checked.requirements }
        : { status: "invalid", fieldErrors: checked.fieldErrors };
    },
  };
}
