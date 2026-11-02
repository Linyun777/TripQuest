/**
 * V2.12：服务按当前用户构造仓库（stages/V2.12.md §3.4）。没有用户就不建仓库，不会退回“看全部”。
 * 用户由接口从会话取得（session.ts 的 withUser / pageUser），不从请求内容里读。
 */
export function requireOwner(userId: string | undefined): string {
  if (!userId) throw new Error("no signed-in user for this service");
  return userId;
}
