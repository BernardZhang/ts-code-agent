# ts-code-agent

TypeScript AI Agent + Code Agent：6 周 / 36 天学习与工程实践

当前实现 Day 1–3：本地 Ollama 文本生成、流式文本、取消、结构化输出、非流式工具调用，以及带模型请求步数上限的 Agent Loop。

Day 1 环境与历史验证见 [Day 1 验证记录](docs/day1-verification.md)；Day 2 功能、学习与验证见 [Day 2 学习记录](docs/learning/day-02.md)。

Day 3 Agent Loop 的设计、实验及限制见 [Day 3 学习记录](docs/learning/day-03.md)。

## 环境

- 使用机器默认的 Node.js，当前验证版本为 **26.11.1**；不通过项目目录提供或切换 Node.js。
- pnpm **10.34.7**（见 `packageManager`），全局安装。
- 本机 Ollama，默认模型 `qwen3:8b`。

检查环境；如果没有 pnpm，执行全局安装：

```bash
node --version
npm install -g pnpm@10.34.7
pnpm --version
```

## 安装与运行

```bash
pnpm install --frozen-lockfile
pnpm dev chat "用一句话解释 Agent Loop"
pnpm dev chat "解释 AbortSignal" --no-stream
pnpm dev structured-demo
pnpm start tools-demo "请调用 add 工具计算 12 加 30。"
```

`pnpm dev` 会先构建 workspace 包，再通过 tsx 执行 CLI。运行编译后的 CLI：

```bash
pnpm build
pnpm start chat "你好"
```

配置优先级为命令参数 > 环境变量 > 默认值：

| 参数               | 环境变量               | 默认值                   |
| ------------------ | ---------------------- | ------------------------ |
| `--base-url`       | `AGENT_BASE_URL`       | `http://127.0.0.1:11434` |
| `--model`          | `AGENT_MODEL`          | `qwen3:8b`               |
| `--context-length` | `AGENT_CONTEXT_LENGTH` | `8192`                   |
| `--timeout-ms`     | `AGENT_TIMEOUT_MS`     | `120000`                 |
| `--think`          | `AGENT_THINK`          | `false`                  |

例如：

```bash
pnpm dev chat "你好" --model qwen3:8b --timeout-ms 60000 --think false
```

`.env.example` 是配置参考；程序不自动加载 `.env`。可以在终端导出变量，或构建后使用 Node 的原生加载方式：

```bash
node --env-file=.env apps/cli/dist/main.js chat "你好"
```

Ctrl+C 中断请求，退出码为 `130`；普通成功为 `0`；配置、服务、协议与输出校验失败为 `1`。错误写入 stderr；流式失败时 stdout 可能已经包含部分文本，应结合退出码判断结果。

## Day 2 工具调用

构建后运行：

```bash
pnpm build
pnpm start tools-demo "请调用 add 工具计算 12 加 30。"
```

示例注册 `add`，由同一份 Zod Schema 校验参数并生成 JSON Schema。第一次非流式请求取得工具调用，程序按顺序执行，再将模型调用与完整 ToolResult 回传，第二次请求生成最终回答。stdout 包含工具结果 JSON 和最终文本。

工具执行器默认超时 10 秒，支持单次调用选项 `timeoutMs` 覆盖；CLI 的 `--timeout-ms` 配置模型 HTTP 请求超时。参数非法等工具失败作为结果回传，演示正常处理失败时退出码仍可为 0。模型未调用工具或第二次再次请求工具时，示例失败退出。

当前只演示一轮工具执行，不自动循环。流式请求携带工具或流式响应出现工具调用时明确报告 `unsupported`。超时只保证结束异步等待；忽略 AbortSignal 的工具可能继续执行，已有副作用不会自动回滚，也不能抢占阻塞事件循环的同步代码。

## Day 3 Agent Loop

```bash
pnpm build
pnpm start agent-demo "计算 (12 + 30) + 8"
pnpm start agent-demo "计算 1 + 2 + 3 + 4 + 5 + c"
```

`agent-demo` 注册 add 工具，自动重复模型请求与顺序工具执行，直到模型返回无工具调用的响应，或达到上限。Core 支持 `toolExecution: EToolExecution.PARALLEL`，同轮独立工具并发执行，全部结果按原调用顺序回传；默认和当前 CLI 仍顺序执行，尚无并发数量上限。当前 CLI 固定最多 10 次模型请求；Core 的 `maxSteps` 接受正的安全整数。最后一次响应中的工具仍完整执行，随后返回 `max_steps`，CLI 以退出码 1 结束。若最后一次响应已无工具调用，则正常完成。

最终回答写入 stdout，模型请求次数和工具调用请求数写入 stderr；参数校验失败的工具调用也计入统计。普通工具失败作为完整 ToolResult 回传，用户取消停止运行，Provider 错误直接向上抛出，不自动重试。`complete` 只表示循环结束，不保证回答正确或完成用户目标。

系统提示要求使用工具及不猜测未知变量，但模型可能提前回答或不遵循提示。当前 CLI 是单次任务，不等待变量补充；再次启动不会保留历史。调用方可显式传入上次返回的 messages 继续对话，新一次 run 的 steps 从头计数。

## 检查

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

默认测试只使用模拟响应和本机模拟 HTTP 服务，无需下载或运行模型。测试涵盖跨 UTF-8 字符的流分片、尾行、异常响应、取消、超时、结构化校验，以及编译后 CLI 的输出和退出码。测试启动本机监听端口，在受限运行环境中可能需要许可。

独立真实模型检查：

```bash
pnpm test:ollama
```

此命令记录 Ollama 版本、已安装模型信息（含模型 digest）、模型名称、上下文参数、文本结果和耗时。它会发送一条固定提示，不能代替完整的模型任务效果评测。

## 目录与学习入口

- `apps/cli`：配置、装配、命令与取消交互。
- `packages/core`：统一消息、Provider 接口、事件、工具定义、注册表、执行器与 AgentRunner。
- `packages/adapters`：Ollama HTTP 接入、响应映射及 NDJSON 解析。
- `tests/integration`：使用模拟 Ollama 验证 CLI。
- `docs/spec.md`、`docs/architecture.md`：需求、验收与架构图。

建议阅读顺序：`provider.ts` 接口 → `stream-parser.ts` → Ollama Provider → CLI 命令 → 对应测试。JSON Schema 约束模型生成，Zod 校验模型实际输出；两者承担不同职责。
