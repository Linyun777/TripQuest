# @tripquest/worker

同仓库 Node Worker，执行 `planning_tasks` 中的虚构草稿与重排任务。使用官方 PostgreSQL Checkpointer 保存 LangGraph 检查点，不需要额外队列服务。

- `src/worker.ts`：进程入口；`src/loop.ts`：领取、清扫与清理；`src/execute.ts`：执行、心跳、取消与终态写入。
- `src/checkpointer.ts`：PostgreSQL 检查点；任务契约在 `packages/application/src/planning-task.ts`。
- `FOR UPDATE SKIP LOCKED` 领取，租约与 `lease_token` 阻止旧 Worker 在接管后写回；图按步持久化，中断时可能重做当前一步。
- Web 里的真实对话长任务由 `apps/web/src/app/plan/jobs.ts` 管理，与此任务队列分开。

根目录运行 `pnpm worker`，读取根 `.env` 的 `DATABASE_URL`；先完成数据库迁移。`pnpm dev` 在 `PLANNING_TASKS_ENABLED=true` 时自动启动本 Worker。

```bash
pnpm --filter @tripquest/worker build
pnpm test:worker
```

测试必须使用 `TEST_DATABASE_URL`（数据库名以 `_test` 结尾），包含真实 PostgreSQL 的任务恢复用例。
