# TripQuest

用对话规划行程，在旅途中继续调整。TripQuest 是一个面向国内自由行的 TypeScript 全栈项目：模型提出方案，代码检查时间、路线与约束，用户确认后才保存。

## 可以做什么

- **日常出行**：所在城市的一日规划；短途逐站挑选，每一步都有候选。
- **多日出游**：1–7 天、支持一天内跨城，整理固定交通和每晚住处，先分配到各天，再逐天规划。
- **途中调整**：记录已完成、跳过和延误；保留固定事项与未授权修改的部分，预览差异后确认。
- **有依据的回答**：查询旅游信息并附来源；自写知识库通过混合召回与重排提供段落引用。
- **可恢复的交互**：长任务登记、去重、刷新后重新接上、停止及中断后的继续；记录 Agent 调用链与共用预算。
- **账号隔离**：邀请码注册，用户名与密码登录，每位用户独立的对话、行程、偏好与每日额度。

技术栈：Next.js / React / Tailwind CSS、LangGraph.js / LangChain.js、Zod、PostgreSQL / pgvector / Drizzle、Better Auth、Vitest、pnpm。

## 本地启动

需要 Node.js 24（见 `.nvmrc`）、pnpm 12.3.4 和可运行 Docker Compose 的环境。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
cp agent-models.example.json agent-models.local.json
```

编辑 `.env`，为 `BETTER_AUTH_SECRET`、`PLANNING_PLACE_TOKEN_SECRET`、`PLANNING_DRAFT_RECEIPT_SECRET` 分别填写独立随机值（至少 32 字节）。每个值可以用下面的命令单独生成：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

启动数据库并执行迁移，然后为本地管理账号设置密码：

```bash
pnpm db:up
pnpm db:migrate
pnpm users set-password owner
pnpm dev
```

访问 [http://localhost:3000](http://localhost:3000)，以 `owner` 登录。`pnpm users invite` 创建一次性邀请码。`pnpm dev` 同时管理 Web 和演示任务 Worker；`pnpm db:down` 停止数据库并保留数据。

此副本的 Compose 项目名为 `tripquest-public`，数据库默认只监听 `127.0.0.1:55433`，使用独立命名数据卷。更改端口时同步修改 `.env` 中的两个数据库连接地址。示例密码仅用于本机开发。

### 无外部密钥的演示

默认关闭真实地图与模型调用。若要使用虚构地点生成演示草稿，在 `.env` 设置：

```dotenv
PLANNING_PLACE_SOURCE=fixture
PLANNING_GENERATION_ENABLED=true
PLANNING_MODEL_MODE=scripted
PLANNING_SAVE_ENABLED=true
```

重启 `pnpm dev`，登录后访问 `/planning/new`。演示地点、路线和决策均为虚构/规则数据；对话规划需要下一节的真实服务配置。

不启动 Web 或数据库也可以运行虚构世界中的基线和脚本策略评测：

```bash
pnpm eval:baseline
pnpm eval:agent -- --mode scripted
```

### 本机真实对话规划

真实地点与对话规划目前仅允许在 **development 的本机个人模式** 中启用。`pnpm build` 验证生产打包，生产运行不会开启这一模式。

在自己的 `.env` 中配置：

```dotenv
PLANNING_PLACE_SOURCE=amap
REAL_PLACE_SAVE_ENABLED=true
AMAP_WEB_SERVICE_KEY=<你的高德 Web 服务密钥>
AGENT_LIVE_ENABLED=true
AGENT_MODEL_PROFILE=deepseek-flash
DEEPSEEK_API_KEY=<你的模型服务密钥>
PLANNING_SAVE_ENABLED=true
```

`agent-models.local.json` 配置模型适配、服务地址、模型名称和输出上限；密钥只通过环境变量读取。修改这些值以匹配自己的服务账号。启动后在 `/plan/new` 使用对话规划。

可选能力：

| 能力 | 配置 |
| --- | --- |
| 高德底图 | `PLANNING_MAP_MODE=amap`，填写独立的 `AMAP_JS_API_KEY` 与 `AMAP_JS_SECURITY_CODE` |
| 联网问答 | `WEB_SEARCH_ENABLED=true` 与 `DEEPSEEK_API_KEY` |
| 知识库 | `DASHSCOPE_API_KEY`、`KNOWLEDGE_ENABLED=true`，执行 `pnpm rag:ingest` |
| 手机定位测试 | 同一 Wi-Fi 下运行 `pnpm dev:https`，使用终端提示的 HTTPS 地址 |

真实请求会消耗各服务额度。地图来源、路线耗时与停留估计会展示相应说明；预约、营业和票务仍需确认。高德实时数据按本机个人模式使用，只长期保存地点编号、名称和自有计划，坐标、地址、路线、营业及天气在展示时查询。`pnpm real-places:purge --yes` 可清理本地真实地点行程与相关对话。不要将服务数据、运行记录或用户位置加入仓库。

## 检查

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:domain
pnpm test:application
pnpm test:providers
pnpm test:agent
pnpm test:evals
```

数据库、认证、Web、Worker 与知识库存储的集成测试使用 `TEST_DATABASE_URL`，数据库名必须以 `_test` 结尾。测试只传测试连接，不加载带真实服务开关的整份 `.env`。Worker 测试前先执行 `pnpm --filter @tripquest/worker build`。各包 README 说明入口和检查命令。

## 源码结构

| 目录 | 职责 |
| --- | --- |
| [apps/web](apps/web/README.md) | 对话、需求卡、地图、时间线、账号页面与服务端接口 |
| [apps/worker](apps/worker/README.md) | 演示规划任务的后台执行与 PostgreSQL 检查点 |
| [packages/domain](packages/domain/README.md) | 纯领域模型、确定性排程与硬约束校验 |
| [packages/application](packages/application/README.md) | 需求、行程、版本、候选确认与仓库接口 |
| [packages/agent](packages/agent/README.md) | 专门 Agent、出游总控、预算与模型适配 |
| [packages/providers](packages/providers/README.md) | 地图、天气、搜索、嵌入及重排适配 |
| [packages/db](packages/db/README.md) | Drizzle schema、迁移、事务与用户隔离 |
| [packages/auth](packages/auth/README.md) | Better Auth、邀请码、账号与管理命令 |
| [packages/rag](packages/rag/README.md) | 自写语料、切分、混合召回、重排与引用 |
| [packages/evals](packages/evals/README.md) | 虚构世界、评测用例、评分与报告生成 |

架构、关键取舍与推荐阅读顺序见 [工程导读](PROJECT_CONTEXT.md)。
