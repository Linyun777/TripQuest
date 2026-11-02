# @tripquest/web

Next.js App Router 应用，承接页面、会话、实时服务组合与确认接口。界面用 React、Tailwind CSS、Radix UI 和 Motion。

## 入口

- `src/app/page.tsx`：首页；`src/app/plan/new` 与 `src/app/plan/[conversationId]`：日常/出游对话。
- `src/app/plan/chat-workspace.tsx`、`chat-controller.tsx`：对话、需求卡、方案、地图和长任务状态。
- `src/app/plan/conversation-service.ts`、`plan-service.ts`：组装模型、地图、预算与仓库；`outing-service.ts`、`adjust-service.ts`：出游和途中调整。
- `src/app/plan/jobs.ts`、`src/app/api/conversations/[conversationId]/job`：长操作登记、重连、停止与继续。
- `src/app/api/conversations`：对话和规划接口；`src/app/auth` 与 `src/proxy.ts`：会话与登录入口。
- `/planning/new`、`/journeys/new`、`/journeys/[journeyId]`：虚构规划与手动行程功能；`/lab/*` 只在开发环境开放。

## 运行与检查

在仓库根按 README 配置 `.env`、迁移数据库并设置管理账号。`pnpm dev` 启动 Web 与演示任务 Worker，`pnpm dev:web` 只启动 Web，`pnpm dev:https` 用于同网络手机定位测试。

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:web
```

Web 测试中的集成用例需要 `TEST_DATABASE_URL`，只传 `_test` 连接，不带真实服务开关。部分测试会清空测试表，避免与使用同一测试库的其他进程并行运行。

地图/模型密钥只在服务端读取；浏览器定位用于页面展示。用户主动请求“从我这儿重新排”时才把该次位置发往服务端定位起点。真实地点模式只在本机 development 启用，具体开关见根 `.env.example`。
