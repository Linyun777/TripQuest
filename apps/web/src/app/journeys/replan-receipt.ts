import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  replanReceiptPayloadSchema,
  type ReplanReceiptPayload,
} from "@tripquest/application/day-replan";

export const REPLAN_RECEIPT_TTL = 15 * 60 * 1000;
export const REPLAN_RECEIPT_BYTES = 8 * 1024;

/** Same secret as other saves, but a distinct purpose: an edit receipt can never confirm a replan. */
export function signReplanReceipt(payload: ReplanReceiptPayload, secret: string): string {
  const parsed = replanReceiptPayloadSchema.parse(payload);
  if (parsed.expiresAt - parsed.issuedAt !== REPLAN_RECEIPT_TTL) {
    throw new Error("Replan receipt unavailable");
  }
  const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const receipt = `${encoded}.${signature}`;
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(receipt) > REPLAN_RECEIPT_BYTES) {
    throw new Error("Replan receipt unavailable");
  }
  return receipt;
}

export function verifyReplanReceipt(receipt: string, secret: string, now: number): ReplanReceiptPayload {
  if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(receipt) > REPLAN_RECEIPT_BYTES) {
    throw new Error("Invalid replan receipt");
  }
  const parts = receipt.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Invalid replan receipt");
  }
  const [encoded, signature] = parts;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid replan receipt");
  }
  const payload = replanReceiptPayloadSchema.parse(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")),
  ));
  if (payload.issuedAt > now || payload.expiresAt - payload.issuedAt !== REPLAN_RECEIPT_TTL) {
    throw new Error("Invalid replan receipt");
  }
  return payload;
}
