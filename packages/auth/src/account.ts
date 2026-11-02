import type { JourneyDatabaseClient } from "@tripquest/db";
import type { Auth } from "./auth";

type Pool = JourneyDatabaseClient["pool"];

/** 拥有者账号（迁移 0014 建的，持有原来的本机数据）：不能在页面上删除自己（stages/V2.12.md §3.6）。 */
export const OWNER_USERNAME = "owner";

/** 核对这个用户的密码（库自己的哈希，与登录相同）。没有密码（拥有者初始状态）就是不对。 */
export async function passwordMatches(auth: Auth, userId: string, password: string): Promise<boolean> {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const hash = accounts.find((account) => account.providerId === "credential")?.password;
  if (!hash) return false;
  return context.password.verify({ hash, password });
}

/**
 * V2.12 删除我的全部数据（§3.6）：核对密码后删掉账号；对话、行程、出游、偏好、决策记录、用量、会话都随外键
 * 级联删除。规划任务的 LangGraph 检查点按任务编号存、没有外键，先删掉。不可恢复。
 */
export async function deleteAccount(
  dependencies: { readonly auth: Auth; readonly pool: Pool },
  input: { readonly userId: string; readonly password: string },
): Promise<"deleted" | "wrong_password" | "owner_protected" | "not_found"> {
  const { rows } = await dependencies.pool.query<{ username: string | null }>("SELECT username FROM users WHERE id = $1", [input.userId]);
  if (!rows[0]) return "not_found";
  if (rows[0].username === OWNER_USERNAME) return "owner_protected";
  if (!(await passwordMatches(dependencies.auth, input.userId, input.password))) return "wrong_password";
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const ready = await client.query<{ ready: boolean }>("SELECT to_regclass('langgraph.checkpoints') IS NOT NULL AS ready");
    if (ready.rows[0]?.ready) {
      for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
        await client.query(
          `DELETE FROM langgraph.${table} WHERE thread_id IN (SELECT id::text FROM planning_tasks WHERE user_id = $1)`,
          [input.userId],
        );
      }
    }
    await client.query("DELETE FROM users WHERE id = $1", [input.userId]);
    await client.query("COMMIT");
    return "deleted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
