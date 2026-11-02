# @tripquest/providers

外部数据适配层，将地点、路线、天气、搜索、嵌入与重排转为统一契约。真实适配在服务端，浏览器与测试可使用纯类型和虚构实现。

- `src/contracts.ts`、`index.ts`：提供方契约与纯入口。
- `src/fixture-provider.ts`、`planning-fixture.ts`：可注入时钟和故障的合成地点/路线。
- `src/server/amap.ts`：高德地点、路线与天气；`server/deepseek-search.ts`：联网查询。
- `src/server/dashscope.ts`：嵌入与重排；`src/domain-mapper.ts`：转换为领域交通输入。

每次结果携带来源、fixture/live 标记和获取时间。查询成功但无结果、无可用路线与接口失败分开；未知时长不会转成零。服务端密钥、原始响应与精确位置不进入普通日志或客户端代码。

根目录运行 `pnpm test:providers`；测试注入假请求，不需要真实服务密钥。
