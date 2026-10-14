# Day 1 初始化验证

验证日期：2026-10-14。工程改动尚未提交或推送。

## 环境

- Node.js：24.21.0（项目本地工具）
- pnpm：10.34.7
- Ollama：0.40.3
- 模型：`qwen3:8b`，Q4_K_M
- 模型 digest：`500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`
- 请求参数：`num_ctx=8192`、`think=false`、超时 120000ms

## 已执行检查

- `pnpm typecheck`：通过。
- `pnpm test`：4 个测试文件、16 项测试通过。
- `pnpm lint`：通过。
- `pnpm format:check`：通过。
- `pnpm build`：通过。
- `pnpm test:ollama`：通过；普通响应、流式响应与结构化 Schema 校验均成功。

测试使用模拟数据验证分片、错误、超时、取消和退出码。CLI 的 Ctrl+C 行为以模拟服务及 SIGINT 集成测试验证；未单独对真实模型执行人工 Ctrl+C 操作。

真实模型普通和流式提示均为“仅回复：你好”，实际文本为“你好”。结构化示例返回 `task` 和三个非空 `steps`，通过 JSON 解析及 Zod 校验。

普通请求记录输入 20 tokens、输出 2 tokens，调用耗时约 74ms；该请求在其他验证之后执行，属于模型已加载的小请求，不代表首次加载延迟或一般生成速度。尚未完成内存压力、长上下文或多轮效果评测。

## 学习阅读顺序

1. `packages/core/src/model/provider.ts`：理解输入、输出与模型接口。
2. `packages/adapters/src/ollama/stream-parser.ts`：理解网络分片与 JSON 行的区别。
3. `packages/adapters/src/ollama/provider.ts`：理解传输、取消、超时与响应映射。
4. `apps/cli/src/commands/structured-demo.ts`：理解生成约束与运行时校验。
5. `tests/integration/cli.test.ts`：理解流式输出和退出码如何验收。

工具调用和 Agent Loop 留到 Day 2–3，当前目录中没有这两项实现。
