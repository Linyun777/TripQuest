import { z } from "zod";

export const SCHEMA_VERSION = "route-decision-v1";
export const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("lookup_route"),
    fromPlaceId: z.string().min(1).max(128),
    toPlaceId: z.string().min(1).max(128),
    reasonCode: z.enum(["check_retention", "check_direct", "check_alternative"]).optional(),
  }).strict(),
  z.object({
    action: z.literal("finish"),
    reasonCode: z.enum(["sufficient_information", "cannot_resolve"]),
  }).strict(),
]);
export type Decision = z.infer<typeof decisionSchema>;
