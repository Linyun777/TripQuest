import type { Pool } from "pg";

/** V2.12：测试里的用户。拥有者由迁移 0014 创建；其他用户按用户名建一次、之后复用。 */
export async function ownerId(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'");
  if (!rows[0]) throw new Error("owner missing: run the migrations first");
  return rows[0].id;
}

export async function testUserId(pool: Pool, username: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, username, display_username, role)
     VALUES ($1, gen_random_uuid()::text || '@users.invalid', $1, $1, 'user')
     ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
    [username],
  );
  return rows[0]!.id;
}
