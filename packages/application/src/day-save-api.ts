import { z } from "zod";

export const confirmDayCommandSchema = z.strictObject({
  receipt: z.string().min(1).max(48 * 1024),
  title: z.string().trim().min(1).max(80),
  acknowledgeUnknowns: z.boolean(),
});
export const confirmDayReplySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["saved", "already_saved"]), journeyId: z.uuid(), planVersion: z.literal(1),
  }),
  z.strictObject({
    status: z.enum([
      "invalid_request", "invalid_receipt", "source_not_allowed", "expired", "disabled",
      "acknowledgment_required", "draft_changed", "intent_conflict", "temporarily_unavailable",
    ]),
  }),
]);
export type ConfirmDayReply = z.infer<typeof confirmDayReplySchema>;
