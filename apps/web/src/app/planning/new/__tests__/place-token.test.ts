import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { searchPlanningFixture } from "../planning-fixture";
import {
  issuePlaceToken,
  verifyPlaceToken,
  PLACE_TOKEN_TTL,
} from "../place-token";

const now = Date.parse("2026-10-08T00:00:00Z");
const secret = "synthetic-test-secret-independent-32-bytes";
const found = await searchPlanningFixture("演示起点", now);
if (found.status !== "ok") throw new Error("fixture unavailable");
const selection = { place: found.data.items[0], evidence: found.evidence };
const token = issuePlaceToken(selection, secret, "fixture", now);

function altered(values: Record<string, unknown>) {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString(),
  );
  const data = Buffer.from(JSON.stringify({ ...payload, ...values })).toString(
    "base64url",
  );
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
describe("short lived server-issued planning place selection", () => {
  it("roundtrips complete normalized evidence and permits rechecking before expiry", () => {
    expect(
      verifyPlaceToken(token, secret, "fixture", now + PLACE_TOKEN_TTL - 1),
    ).toEqual(selection);
    expect(verifyPlaceToken(token, secret, "fixture", now)).toEqual(selection);
    expect(() =>
      verifyPlaceToken(token, secret, "fixture", now + PLACE_TOKEN_TTL),
    ).toThrow("过期");
  });
  it("rejects forged contents, a different key, source and oversized inputs safely", () => {
    const [body, mac] = token.split(".");
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    data.selection.place.name = "forged";
    const forged = `${Buffer.from(JSON.stringify(data)).toString("base64url")}.${mac}`;
    for (const input of [
      forged,
      "x".repeat(8193),
      `${token}.extra`,
      `${body}.a`,
    ]) {
      expect(() => verifyPlaceToken(input, secret, "fixture", now)).toThrow(
        "地点选择无效",
      );
    }
    expect(() =>
      verifyPlaceToken(token, `${secret}different`, "fixture", now),
    ).toThrow();
    expect(() => verifyPlaceToken(token, secret, "amap", now)).toThrow();
  });
  it.each([
    { purpose: "login" },
    { version: "planning-place.v2" },
    { issuedAt: now + 1 },
    { expiresAt: now + PLACE_TOKEN_TTL + 1 },
    { extra: true },
    { expiresAt: now },
  ])("rejects invalid signed payload semantics %j", (change) => {
    expect(() =>
      verifyPlaceToken(altered(change), secret, "fixture", now),
    ).toThrow();
  });
});
