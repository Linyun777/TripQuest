# @tripquest/agent

LangGraph.js 编排与 LangChain.js 模型适配。模型选择工具和提出结构化候选；工具调用、预算、硬约束和正式写入由代码控制。

## 源码入口

- `src/chat-agents.ts`、`chat-agent-prompts.ts`、`chat-graph.ts`：需求理解、改行程、资料查询、建议、陪聊与偏好；按分流选择，一轮有调用上限。
- `src/intent.ts`：默认规则与模型级联分流；规则拿不准时调用 DeepSeek，失败退回规则。模型、向量与 Jev 实现分别隔离。
- `src/day-graph.ts`、`day-tools.ts`：搜索、路线调查、一日试排与完成；`short-candidates.ts`：短途候选。
- `src/outing-graph.ts`：出游分配、逐天生成和跨天改动；`outing-lodging.ts`：住处；`outing-after-turn.ts`、`outing-rides.ts`：按用户原话补全每晚城市和暂定交通。
- `src/outing-review.ts`：默认单步审查；`outing-repair.ts`：带工具循环、调用一日规划器试排的审查-修复 Agent；`outing-judge.ts`：对照需求清单判断整体结果。
- `src/notes-graph.ts`、`chat-summary.ts`：出发须知和滚动摘要。
- `src/agents/registry.ts`、`run-agent.ts`、`runs.ts`：Agent 与单步模型调用分类、契约、交接、运行树及共用预算。
- `src/profile.ts`、`live.ts`、各 `*-live.ts`：模型配置与适配；`graph.ts`：虚构行程的有界路线调查。

出游审查默认 `OUTING_REVIEW=single`。`agent` 启用审查-修复、整体判断和长期偏好实验，`off` 关闭审查。试排仍须通过确定性校验，正式行程仍由用户确认后保存。

模型 profile 使用根 `agent-models.local.json`（由示例复制）；密钥只引用环境变量名。真实服务需显式开启，默认脚本模式不调用网络。外部网页与检索内容按不可信数据处理，不授予写入权限。

```bash
pnpm test:agent
pnpm eval:agent -- --mode scripted
```

在仓库根运行。脚本评测使用虚构世界，仅验证编排和校验，不代表真实模型质量。
