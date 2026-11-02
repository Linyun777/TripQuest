import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { adjustOfferSchema, type AdjustOffer } from "@tripquest/application/real-adjust";

/** 调整凭据复用草案的签名机制，但用途单独隔离，不能混用两类确认入口。 */
export const ADJUST_RECEIPT_TTL = 15 * 60 * 1000;
const PURPOSE = "real-day-adjust.v1";
const MAX_BYTES = 48 * 1024;
const payloadSchema = z.strictObject({
  purpose: z.literal(PURPOSE),
  conversationId: z.uuid(),
  offer: adjustOfferSchema,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export type AdjustReceiptPayload = z.infer<typeof payloadSchema>;

// 用不同用途派生签名密钥，使草案凭据无法冒充调整凭据。
const mac = (encoded: string, secret: string) => createHmac("sha256", secret).update(`${PURPOSE}.${encoded}`).digest();

export function signAdjustReceipt(input: { conversationId: string; offer: AdjustOffer; now: number; secret: string }) {
  const payload = payloadSchema.parse({
    purpose: PURPOSE,
    conversationId: input.conversationId,
    offer: input.offer,
    issuedAt: input.now,
    expiresAt: input.now + ADJUST_RECEIPT_TTL,
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const receipt = `${encoded}.${mac(encoded, input.secret).toString("base64url")}`;
  if (Buffer.byteLength(receipt) > MAX_BYTES) return null;
  return { receipt, expiresAt: new Date(payload.expiresAt).toISOString() };
}

/** 只接受签名有效、结构合法且签发时间不在未来的载荷，其余统一返回 null。 */
export function verifyAdjustReceipt(receipt: string, secret: string, now: number): AdjustReceiptPayload | null {
  if (Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(receipt) > MAX_BYTES) return null;
  const parts = receipt.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [encoded, signature] = parts;
  const expected = mac(encoded, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.issuedAt > now || parsed.data.expiresAt - parsed.data.issuedAt !== ADJUST_RECEIPT_TTL) return null;
    // 此处只校验来源、结构与签发时刻；过期留给用例在幂等查询之后判断，
    // 这样已保存但响应丢失的同一意图，即使重试时凭据过期，也能返回原成功结果。
    return parsed.data;
  } catch {
    return null;
  }
}
