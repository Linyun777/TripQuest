import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JourneyDatabaseClient } from "@tripquest/db";

/**
 * V2.12 邀请码（stages/V2.12.md §3.2）：只存哈希，只用一次，缺省 7 天过期。注册时先原子占用（claimed_at），
 * 建用户成功再写上使用者；建失败就释放。并发注册同一个码只有一个能占到。占用后进程中断留下的半截占用，
 * 10 分钟后视为没占用（不会永远卡死一个码）。
 */
export const INVITE_DAYS = 7;
const STALE_CLAIM_MINUTES = 10;
/** 去掉容易看错的 0/O、1/I/L。 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type Pool = JourneyDatabaseClient["pool"];

/** 用户输入的码规整后再哈希：忽略大小写、空格和连字符。 */
export function inviteHash(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/[\s-]/g, "")).digest("hex");
}

/** 12 个字符（约 59 位随机），显示成 XXXX-XXXX-XXXX。 */
function newCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((group) => group.join("")).join("-");
}

/** 生成一个邀请码，明文只返回这一次（不存、不记日志）。 */
export async function createInvite(pool: Pool, input: { createdBy: string | null; days?: number; now: Date }): Promise<{ code: string; expiresAt: Date }> {
  const days = input.days ?? INVITE_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("invite days must be 1–90");
  const code = newCode();
  const expiresAt = new Date(input.now.getTime() + days * 86_400_000);
  await pool.query(
    "INSERT INTO invites (id, code_hash, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [randomUUID(), inviteHash(code), input.createdBy, input.now, expiresAt],
  );
  return { code, expiresAt };
}

/** 占用一个可用的码；无效、过期、已用或正被别人占用都返回 null（对外统一说“邀请码不可用”）。 */
export async function claimInvite(pool: Pool, code: string, now: Date): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE invites SET claimed_at = $2
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
        AND (claimed_at IS NULL OR claimed_at < $2 - make_interval(mins => $3))
      RETURNING id`,
    [inviteHash(code), now, STALE_CLAIM_MINUTES],
  );
  return rows[0]?.id ?? null;
}

export async function releaseInvite(pool: Pool, id: string): Promise<void> {
  await pool.query("UPDATE invites SET claimed_at = NULL WHERE id = $1 AND used_at IS NULL", [id]);
}

export async function completeInvite(pool: Pool, id: string, userId: string, now: Date): Promise<void> {
  await pool.query("UPDATE invites SET used_by = $2, used_at = $3 WHERE id = $1", [id, userId, now]);
}
