import { PgPlanningTaskRepository, type JourneyDatabaseClient } from "@tripquest/db";

type Pool = JourneyDatabaseClient["pool"];

const USER_METHODS = new Set(["createTask", "findTask", "requestCancel", "setOffer"]);

/**
 * V2.12：任务仓库分用户和 Worker 两种（packages/db 的 PgPlanningTaskRepository）。这些测试既以页面身份建任务、
 * 又以 Worker 身份领取，用拥有者（迁移 0014 建的）的用户方法加 Worker 方法。
 */
export async function ownerAndWorkerTasks(pool: Pool): Promise<PgPlanningTaskRepository> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'");
  const user = new PgPlanningTaskRepository(pool, { userId: rows[0]!.id });
  const worker = new PgPlanningTaskRepository(pool, "worker");
  return new Proxy(worker, {
    get(target, property) {
      const source = USER_METHODS.has(String(property)) ? user : target;
      const value: unknown = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}
