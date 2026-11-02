# @tripquest/application

框架无关的业务用例、输入契约和仓库端口，连接领域校验、Agent 候选与正式保存。依赖领域模型、Zod 和提供方的纯类型，不依赖 Next.js、Drizzle 或实时服务实现。

- `src/conversation.ts`、`planning-requirements.ts`：对话需求卡、结构化变更与一日需求。
- `src/day-planning.ts`、`leg-choice.ts`、`transfer-day.ts`：一日规划、分段交通与固定交通。
- `src/outing-allocation.ts`、`outing-trip.ts`、`outing-review-contract.ts`：多日分配、出游与审查契约。
- `src/day-confirmation.ts`、`day-replan-confirm.ts`、`real-adjust.ts`：候选确认、途中调整与版本保护。
- `src/contracts.ts`、`planning-task.ts`、`preferences.ts`：仓库端口、后台任务与偏好。

生成需求或候选不创建正式行程。确认时重新核对业务版本、事实、指纹和幂等性；指纹用于检测变化，权限由服务端和仓库另外保证。浏览器需要的契约使用包的专用子路径入口，避免将 Node 模块带进客户端。

根目录运行 `pnpm test:application`，无需数据库或密钥。
