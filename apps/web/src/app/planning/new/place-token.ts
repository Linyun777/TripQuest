import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  planningPlaceSchema,
  type PlanningPlace,
} from "@tripquest/application";
import { z } from "zod";
import type { PlaceSource } from "./contracts";

export const PLACE_TOKEN_TTL = 30 * 60 * 1000;
export const PLACE_TOKEN_MAX_BYTES = 8 * 1024;
const payloadSchema = z.strictObject({
  version: z.literal("planning-place.v1"),
  purpose: z.literal("planning_place_selection"),
  selection: planningPlaceSchema,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});

export class PlaceTokenError extends Error {
  constructor(readonly code: "invalid" | "expired") {
    super(
      code === "expired"
        ? "地点选择已过期，请重新搜索并明确选择"
        : "地点选择无效，请重新搜索并明确选择",
    );
  }
}

function matchesSource(selection: PlanningPlace, source: PlaceSource): boolean {
  const provider = source === "amap" ? "amap" : "tripquest-planning-fixture";
  return (
    selection.place.ref.provider === provider &&
    selection.evidence.provider === provider &&
    selection.evidence.sourceKind === (source === "amap" ? "live" : "fixture")
  );
}

function signature(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

function checkedPayload(value: unknown, source: PlaceSource, now: number) {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) throw new PlaceTokenError("invalid");
  const payload = parsed.data;
  if (
    !Number.isSafeInteger(now) ||
    !matchesSource(payload.selection, source) ||
    payload.issuedAt > now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > PLACE_TOKEN_TTL ||
    Date.parse(payload.selection.evidence.retrievedAt) > payload.issuedAt
  ) {
    throw new PlaceTokenError("invalid");
  }
  if (now >= payload.expiresAt) throw new PlaceTokenError("expired");
  return payload;
}

export function issuePlaceToken(
  selection: PlanningPlace,
  secret: string,
  source: PlaceSource,
  now: number,
): string {
  if (Buffer.byteLength(secret, "utf8") < 32)
    throw new PlaceTokenError("invalid");
  const payload = checkedPayload(
    {
      version: "planning-place.v1",
      purpose: "planning_place_selection",
      selection,
      issuedAt: now,
      expiresAt: now + PLACE_TOKEN_TTL,
    },
    source,
    now,
  );
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${encoded}.${signature(encoded, secret).toString("base64url")}`;
  if (Buffer.byteLength(token) > PLACE_TOKEN_MAX_BYTES)
    throw new PlaceTokenError("invalid");
  return token;
}

export function verifyPlaceToken(
  token: string,
  secret: string,
  source: PlaceSource,
  now: number,
): PlanningPlace {
  try {
    if (
      Buffer.byteLength(secret, "utf8") < 32 ||
      Buffer.byteLength(token, "utf8") > PLACE_TOKEN_MAX_BYTES
    ) {
      throw new PlaceTokenError("invalid");
    }
    const parts = token.split(".");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    ) {
      throw new PlaceTokenError("invalid");
    }
    const [encoded, mac] = parts;
    const actual = Buffer.from(mac, "base64url");
    const expected = signature(encoded, secret);
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== mac ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new PlaceTokenError("invalid");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded)
      throw new PlaceTokenError("invalid");
    return checkedPayload(JSON.parse(decoded.toString("utf8")), source, now)
      .selection;
  } catch (error) {
    if (error instanceof PlaceTokenError) throw error;
    throw new PlaceTokenError("invalid");
  }
}
