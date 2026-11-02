# @tripquest/db

PostgreSQL / pgvector 的 Drizzle schema、SQL 迁移和仓库实现。业务数据、对话、实际进度、候选确认、偏好、用量、任务与 Agent 运行记录分表管理。

- `src/schema.ts`、`drizzle/`：schema 和可重放迁移；`drizzle.config.ts`：从根 `.env` 读取迁移连接。
- `src/connection.ts`：连接生命周期；`src/repository.ts`：行程事务与版本保护。
- `src/conversation-repository.ts`、`preference-repository.ts`：按用户隔离的对话和偏好。
- `src/task-repository.ts`、`job-repository.ts`：Worker 任务租约和 Web 长任务登记。
- `src/agent-runs.ts`、`usage.ts`：运行树及每日额度。
- `src/test-database-safety.ts`：测试库保护；`docker/init-test-database.sql`：新容器初始化测试库。

在根目录运行 `pnpm db:up`、`pnpm db:migrate`。迁移使用 `DATABASE_URL`，不以 schema push 替代。改 schema 后用 `pnpm db:generate` 生成 SQL 并检查差异。

公开副本默认 Compose 项目名 `tripquest-public`，监听 `127.0.0.1:55433`；命名卷保存本机数据。`pnpm db:down` 保留卷，删除卷会删除数据库。

`pnpm test:db` 只接收数据库名以 `_test` 结尾的 `TEST_DATABASE_URL`。测试会清理表数据，不要指向开发库，也不要和占用同一测试库的应用进程同时运行。
