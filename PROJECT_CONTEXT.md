# TripQuest 工程导读

## 业务链路

用户说出需求 → 分流与专门 Agent 整理需求卡 → 用户确认需求 → 搜索地点与路线 → 确定性排程和校验 → 候选方案 → 用户确认 → 事务写入新版本。

日常模式支持一日与逐站短途；出游模式支持 1–7 天、固定交通、住处、多城和跨天调整。出游总控用一张 LangGraph StateGraph 承接分配、生成和修改，复用一日规划能力。审查器先由代码发现问题，再由 Agent 提结构化改动；直接修复需通过代码复查，其余交给用户选择。

## 边界与取舍

- **模型产生候选，代码裁决约束。** Zod 检查结构；领域和应用层检查时间、交通、固定事项、已完成事实及修改范围。未知路线保持未知，无法排出是合法结果。
- **确认绑定基础状态。** 候选指纹、版本、权限和幂等性在服务端复核；过期候选不能覆盖较新的行程，Agent 无权直接写正式安排。
- **分开保存不同状态。** 业务计划、实际进度、对话、长任务、图检查点及运行记录各有职责，避免用聊天记录代替业务状态。
- **同仓库 Web 与 Worker。** PostgreSQL 同时承担业务存储、任务租约、LangGraph 检查点和 pgvector 检索，不额外引入消息队列或向量服务。
- **真实数据临时查询。** 高德个人模式只在本机开发启用；持久化保留地点标识、名称和自有内容，展示信息实时查。fixture 与 live 来源分开，测试使用合成数据。
- **认证复用成熟实现。** Better Auth 管理凭证与会话，应用补充邀请码、用量和按用户隔离的仓库。
- **长任务按执行方式恢复。** 演示任务由 Worker 与图检查点恢复；真实对话长任务在 Web 服务登记，刷新可重新接上，服务重启中断后由用户继续，不承诺外部请求恰好执行一次。

## 按链路阅读源码

| 关注点 | 入口 |
| --- | --- |
| 对话页面与状态同步 | `apps/web/src/app/plan/chat-workspace.tsx`、`chat-controller.tsx` |
| 整理需求与专门 Agent | `apps/web/src/app/plan/conversation-service.ts` → `packages/agent/src/chat-agents.ts`、`chat-agent-prompts.ts` |
| 一日规划 | `apps/web/src/app/plan/plan-service.ts` → `packages/agent/src/day-graph.ts` → `packages/application/src/day-planning.ts` |
| 出游编排与审查 | `packages/agent/src/outing-graph.ts`、`outing-allocate.ts`、`outing-review.ts` |
| 地点与路线 | `packages/providers/src/contracts.ts`、`server/amap.ts` |
| 途中调整与确认 | `apps/web/src/app/plan/adjust-service.ts` → `packages/application/src/real-adjust.ts`、`day-confirmation.ts` |
| 领域校验 | `packages/domain/src/candidate-validation.ts`、`day-validation.ts` |
| 用户隔离与写入 | `packages/db/src/schema.ts`、`repository.ts`、`conversation-repository.ts` |
| 长任务与运行记录 | `apps/web/src/app/plan/jobs.ts`、`packages/db/src/job-repository.ts`、`packages/agent/src/runs.ts` |
| Worker 与检查点 | `apps/worker/src/worker.ts`、`loop.ts`、`execute.ts`、`checkpointer.ts` |
| 检索与回答 | `packages/rag/src/ingest.ts`、`retrieve.ts`、`chat.ts` |

## 如何理解测试

`domain` 和 `application` 测试验证业务约束；`providers` 用注入的假请求检查外部接口边界；`agent` 检查结构化动作、预算和编排。`evals` 使用固定虚构世界，把人工预期和评分器分开；脚本策略结果只反映工程行为。真实服务质量需要使用自己的账号另行评估。

`db`、`auth`、部分 Web / Worker / RAG 测试使用真实 PostgreSQL，但只允许 `_test` 数据库。迁移源码、测试源码与虚构题集随仓库提供，运行报告与本地数据不入库。运行方式见根 README 和各包 README。
