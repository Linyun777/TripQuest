# @tripquest/rag

带段落引用的知识库：自写杭州文化、历史与景点背景语料，经切分、嵌入、混合召回和重排交给对话回答。营业、预约和演出等时效信息另走联网查询。

1. `corpus/*.md`：自写文章与事实来源链接，只有 `reviewed` 文章入库；这是产品语料，不是设计或过程文档。
2. `src/corpus.ts`、`chunk.ts`：读取 front matter，按小节切分，长段按句子重叠切分。
3. `src/ingest.ts`、`store.ts`：内容哈希去重，嵌入写入 pgvector，同时建立中文字符 bigram 关键词索引。
4. `src/retrieve.ts`、`fuse.ts`、`keywords.ts`：按城市过滤，向量与关键词召回经 RRF 融合，再重排并选择段落。
5. `src/chat.ts`：回答证据与段落引用；`src/cli.ts`：入库、检索与召回评测。

根 `.env` 配置 `DASHSCOPE_API_KEY` 和数据库连接，执行：

```bash
pnpm rag chunks
pnpm rag:ingest
pnpm rag search "苏堤是谁修的"
pnpm test:rag
```

入库与真实检索会调用嵌入/重排服务。`--test` 使用 `_test` 数据库；存储集成测试需要 `TEST_DATABASE_URL`，无连接时跳过该组。运行报告不提交。
