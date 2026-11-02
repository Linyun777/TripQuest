# @tripquest/evals

可重现的虚构世界、手写用例、独立评分器和评测命令。保留题集源码与评分逻辑，生成报告、真实调用账本和本地配置不入库。

## 命令

在仓库根运行，默认脚本/规则策略不需要真实模型或地图密钥：

```bash
pnpm eval:baseline
pnpm eval:agent -- --mode scripted
pnpm eval:feedback
pnpm eval:planning
pnpm eval:v21 -- --help
pnpm test:evals
```

- `src/cases/dataset.ts`、`src/runner.ts`、`src/scoring.ts`：基础候选校验与基线评测。
- `src/agent-cli.ts`、`feedback-cli.ts`：有界路线调查、反馈与澄清。
- `src/s54/`：一日规划与调整的故障注入、人工预期及独立复核。
- `src/v21-cli.ts` 与各版本目录：对话、交通、出游、知识库、分流和专门 Agent 题集。版本号是数据集标识。

用 `--help` 查看各命令的筛选参数。输出写入根 `eval-results/`，包含机器可读与 Markdown 报告。人工预期与运行结果分开，合成路线、地点、时钟和故障可固定。

真实评测需要自行配置 `.env` 和 `agent-models.local.json` 并显式选择 live 策略，受命令各自的预算限制，会产生外部费用。脚本策略分数只说明工程行为，不等同于真实模型能力。
