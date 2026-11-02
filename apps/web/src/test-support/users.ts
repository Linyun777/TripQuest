import type { SessionUser, UserResolver } from "../app/auth/session";

/**
 * V2.12 测试里的当前用户：内存仓库的测试用固定用户；连测试库的用迁移 0014 建的拥有者（外键要求真实用户）。
 * 处理器通过选项里的 user 注入，不碰 Better Auth 的会话。
 */
export const TEST_USER: SessionUser = {
  id: "00000000-0000-4000-8000-00000000a11c",
  username: "tester",
  displayUsername: "tester",
  role: "user",
};
export const asTestUser: UserResolver = async () => TEST_USER;
/** 没登录。 */
export const signedOut: UserResolver = async () => null;

type Queryable = { query<Row extends object>(text: string, values?: unknown[]): Promise<{ rows: Row[] }> };

export async function ownerId(pool: Queryable): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner'");
  if (!rows[0]) throw new Error("owner missing: run the migrations first");
  return rows[0].id;
}

export function asOwner(pool: Queryable): UserResolver {
  return async () => ({ id: await ownerId(pool), username: "owner", displayUsername: "owner", role: "admin" });
}

const USER_TASK_METHODS = new Set(["createTask", "findTask", "requestCancel", "setOffer"]);

/** 任务测试既以页面身份建任务、又以 Worker 身份领取：拥有者的用户方法加 Worker 方法。 */
export async function ownerAndWorkerTasks<Repository extends object>(
  pool: Queryable,
  create: (scope: { userId: string } | "worker") => Repository,
): Promise<Repository> {
  const user = create({ userId: await ownerId(pool) });
  const worker = create("worker");
  return new Proxy(worker, {
    get(target, property) {
      const source = USER_TASK_METHODS.has(String(property)) ? user : target;
      const value: unknown = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}
