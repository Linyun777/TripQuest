# @tripquest/domain

纯 TypeScript 领域逻辑：数据契约、候选校验、基线策略和一日排程。无数据库、框架、环境变量或外部服务依赖。

- `src/model.ts`：计划、状态、预约、调整请求与候选；`src/index.ts`：公开入口。
- `src/candidate-validation.ts`：保护已完成事实、锁定活动与可修改范围，检查时间和有向交通衔接。
- `src/baseline-planning.ts`：保持、顺延、必要时省略普通活动的确定性候选策略。
- `src/day-planning.ts`、`day-validation.ts`、`day-adjustment.ts`：一日排程、校验与调整。
- `src/reference-cases.ts`：手写虚构数据与人工预期。

未知交通不会按 0 分钟处理；候选通过校验只说明在给定证据下可行，不代表已经保存或核实外部预约。

根目录运行 `pnpm test:domain`，无需数据库或密钥。
