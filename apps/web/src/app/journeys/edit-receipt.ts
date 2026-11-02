import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { dayEditChangeSchema } from "@tripquest/application/saved-day";
import { DAY_EDIT_PURPOSE } from "@tripquest/application/day-edit";
import { readDraftSaveConfig } from "../planning/new/draft-receipt";

export const EDIT_RECEIPT_TTL = 15 * 60 * 1000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const editReceiptSchema = z
  .strictObject({
    purpose: z.literal(DAY_EDIT_PURPOSE),
    editId: z.uuid(),
    journeyId: z.uuid(),
    basePlanVersion: z.number().int().positive(),
    baseObservationVersion: z.literal(0),
    baseFingerprint: hash,
    candidateFingerprint: hash,
    change: dayEditChangeSchema,
    datasetVersion: z.string().min(1).max(80),
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .refine(
    (receipt) => receipt.expiresAt - receipt.issuedAt === EDIT_RECEIPT_TTL,
  );

export function readDayEditConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { secret } = readDraftSaveConfig(environment);
  // Editing the stored fixture never switches to the current search/model mode.
  return {
    secret,
    enabled: environment.PLANNING_SAVE_ENABLED === "true" && secret.length > 0,
  };
}

export function signEditReceipt(
  payload: z.infer<typeof editReceiptSchema>,
  secret: string,
): string {
  const encoded = Buffer.from(
    JSON.stringify(editReceiptSchema.parse(payload)),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const receipt = `${encoded}.${signature}`;
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(receipt) > 8 * 1024)
    throw new Error("Edit receipt unavailable");
  return receipt;
}

export function verifyEditReceipt(
  receipt: string,
  secret: string,
  now: number,
) {
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(receipt) > 8 * 1024)
    throw new Error("Invalid edit receipt");
  const parts = receipt.split(".");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new Error("Invalid edit receipt");
  const [encoded, signature] = parts;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid edit receipt");
  const payload = editReceiptSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(encoded, "base64url"),
      ),
    ),
  );
  if (payload.issuedAt > now) throw new Error("Invalid edit receipt");
  return payload;
}
