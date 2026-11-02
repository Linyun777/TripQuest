import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  DAY_CONFIRMATION_PROTOCOL,
  assertDaySnapshotIntegrity,
  dayDraftConfirmationSnapshotSchema,
  daySnapshotSource,
  dayDraftSemanticFingerprint,
  refreshDayFixtureRoutes,
  type DayDraftConfirmationSnapshot,
} from "@tripquest/application/day-confirmation";
import type { DayPlanningResult, DaySaveOffer } from "@tripquest/application/day-planning";
import { readRealPlaceMode } from "../../real-places/real-mode";

export const DRAFT_RECEIPT_TTL = 15 * 60 * 1000;
export const DRAFT_RECEIPT_PAYLOAD_BYTES = 32 * 1024;
export const DRAFT_RECEIPT_BYTES = 48 * 1024;
export const draftReceiptPayloadSchema = z.strictObject({
  purpose: z.literal(DAY_CONFIRMATION_PROTOCOL),
  runId: z.uuid(),
  requirementsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  draftFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: dayDraftConfirmationSnapshotSchema,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export class DraftReceiptError extends Error {
  constructor(readonly code: "invalid_receipt" | "source_not_allowed") {
    super("Draft receipt is unavailable");
  }
}

export function readDraftSaveConfig(environment: NodeJS.ProcessEnv = process.env) {
  const secret = environment.PLANNING_DRAFT_RECEIPT_SECRET ?? "";
  const validSecret =
    secret.trim().length > 0 &&
    Buffer.byteLength(secret, "utf8") >= 32 &&
    ![
      environment.PLANNING_PLACE_TOKEN_SECRET,
      environment.DEEPSEEK_API_KEY,
      environment.AMAP_WEB_SERVICE_KEY,
    ].some((other) => other && secret === other);
  return {
    secret: validSecret ? secret : "",
    enabled:
      environment.PLANNING_SAVE_ENABLED === "true" &&
      validSecret &&
      (environment.PLANNING_PLACE_SOURCE === "fixture" || readRealPlaceMode(environment).enabled) &&
      modelAllowed(environment),
  };
}

/** 实时模型草案只在本机个人真实模式下允许保存；每份草案都由确定性服务端独立复核，模型模式不改变写入保护。 */
function modelAllowed(environment: NodeJS.ProcessEnv): boolean {
  return (environment.PLANNING_MODEL_MODE ?? "scripted") === "scripted" || readRealPlaceMode(environment).enabled;
}
// HMAC 证明候选由本服务签发且未被篡改，不是加密；payload 仍可解码，真实地点凭据不做持久缓存。
// 签名也不证明候选此刻仍可行，确认用例仍要复查过期、版本、路线和硬约束。
const mac = (encoded: string, secret: string) =>
  createHmac("sha256", secret).update(encoded).digest();

function validatePayload(value: unknown, now: number) {
  const parsed = draftReceiptPayloadSchema.safeParse(value);
  if (!parsed.success) throw new DraftReceiptError("invalid_receipt");
  const payload = parsed.data;
  if (
    !Number.isSafeInteger(now) ||
    payload.issuedAt > now ||
    payload.expiresAt - payload.issuedAt !== DRAFT_RECEIPT_TTL ||
    Date.parse(payload.snapshot.draft.createdAt) > payload.issuedAt ||
    payload.snapshot.problem.input.nowMs > Date.parse(payload.snapshot.draft.createdAt) ||
    payload.runId !== payload.snapshot.problem.runId ||
    payload.requirementsFingerprint !== payload.snapshot.problem.requirementsFingerprint ||
    payload.draftFingerprint !== dayDraftSemanticFingerprint(payload.snapshot)
  ) {
    throw new DraftReceiptError("invalid_receipt");
  }
  try {
    const source = daySnapshotSource(payload.snapshot);
    if (!source) throw new Error("mixed source");
    assertDaySnapshotIntegrity(payload.snapshot, false, source);
  } catch {
    throw new DraftReceiptError("source_not_allowed");
  }
  return payload;
}

/** 过期判断留到首次写入用例查完成功回执之后，保证已保存请求过期重试仍可回放。 */
export function verifyDraftReceipt(receipt: string, secret: string, now: number) {
  if (Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(receipt) > DRAFT_RECEIPT_BYTES) {
    throw new DraftReceiptError("invalid_receipt");
  }
  try {
    const parts = receipt.split(".");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new DraftReceiptError("invalid_receipt");
    }
    const [encoded, signature] = parts;
    const expected = mac(encoded, secret);
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== signature ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new DraftReceiptError("invalid_receipt");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (
      decoded.byteLength > DRAFT_RECEIPT_PAYLOAD_BYTES ||
      decoded.toString("base64url") !== encoded
    ) {
      throw new DraftReceiptError("invalid_receipt");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    return validatePayload(JSON.parse(text), now);
  } catch (error) {
    if (error instanceof DraftReceiptError) throw error;
    throw new DraftReceiptError("invalid_receipt");
  }
}

export async function createDraftSaveOffer(
  snapshot: DayDraftConfirmationSnapshot | null,
  result: DayPlanningResult,
  options: { environment?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<DaySaveOffer> {
  const environment = options.environment ?? process.env;
  const config = readDraftSaveConfig(environment);
  const real = environment.PLANNING_PLACE_SOURCE === "amap";
  if ((real && !readRealPlaceMode(environment).enabled) || !modelAllowed(environment)) {
    return { status: "unavailable", reason: "source_not_allowed" };
  }
  if (!config.enabled) return { status: "unavailable", reason: "disabled" };
  if (
    !snapshot ||
    result.status !== "completed" ||
    result.outcome !== "draft" ||
    result.runId !== snapshot.problem.runId ||
    JSON.stringify(result.draft) !== JSON.stringify(snapshot.draft)
  ) {
    return { status: "unavailable", reason: "snapshot_invalid" };
  }
  const now = options.now ?? Date.now();
  let payload;
  try {
    if (daySnapshotSource(snapshot) !== (real ? "amap" : "fixture")) throw new Error("source");
    assertDaySnapshotIntegrity(snapshot, !real, real ? "amap" : "fixture");
    const draftFingerprint = dayDraftSemanticFingerprint(snapshot);
    // 真实路线刚在本轮查询，确认时还会再查；签发凭据阶段不额外重复请求。
    if (!real) {
      const refreshed = await refreshDayFixtureRoutes(snapshot, now);
      if (dayDraftSemanticFingerprint(snapshot, refreshed) !== draftFingerprint) {
        return { status: "unavailable", reason: "snapshot_invalid" };
      }
    }
    payload = validatePayload({
      purpose: DAY_CONFIRMATION_PROTOCOL,
      runId: result.runId,
      requirementsFingerprint: snapshot.problem.requirementsFingerprint,
      draftFingerprint,
      snapshot,
      issuedAt: now,
      expiresAt: now + DRAFT_RECEIPT_TTL,
    }, now);
  } catch {
    return { status: "unavailable", reason: "source_not_allowed" };
  }
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.byteLength > DRAFT_RECEIPT_PAYLOAD_BYTES) {
    return { status: "unavailable", reason: "receipt_too_large" };
  }
  const encoded = bytes.toString("base64url");
  const receipt = `${encoded}.${mac(encoded, config.secret).toString("base64url")}`;
  if (Buffer.byteLength(receipt) > DRAFT_RECEIPT_BYTES) {
    return { status: "unavailable", reason: "receipt_too_large" };
  }
  return {
    status: "available",
    runId: result.runId,
    requirementsFingerprint: payload.requirementsFingerprint,
    draftFingerprint: payload.draftFingerprint,
    receipt,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    acknowledgeUnknownsRequired: snapshot.draft.verification === "pending",
  };
}
