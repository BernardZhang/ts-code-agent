# ts-code-agent

TypeScript AI Agent + Code Agent：6 周 / 36 天学习与工程实践

当前实现 Day 1：本地 Ollama 文本生成、流式输出、取消及结构化输出。尚未实现工具调用或 Agent Loop。

本次检查结果与真实模型环境见 [Day 1 验证记录](docs/day1-verification.md)。

## 环境

- Node.js **24.21.0**（见 `.node-version`）
- pnpm **10.34.7**（见 `packageManager`）
- 本机 Ollama，默认模型 `qwen3:8b`

建议使用你已有的 Node 版本管理工具切换到项目版本。当前初始化过程中还准备了被 Git 忽略的 `.tools/` 本地工具；在这台机器可以在终端执行：

```bash
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
node --version
pnpm --version
```

`.tools/` 不随仓库分发。其他机器应安装上述 Node.js 与 pnpm 版本。

## 安装与运行

```bash
pnpm install --frozen-lockfile
pnpm dev chat "用一句话解释 Agent Loop"
pnpm dev chat "解释 AbortSignal" --no-stream
pnpm dev structured-demo
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
- `packages/core`：统一消息、Provider 接口、事件与错误类型。
- `packages/adapters`：Ollama HTTP 接入、响应映射及 NDJSON 解析。
- `tests/integration`：使用模拟 Ollama 验证 CLI。
- `docs/spec.md`、`docs/architecture.md`：需求、验收与架构图。

建议阅读顺序：`provider.ts` 接口 → `stream-parser.ts` → Ollama Provider → CLI 命令 → 对应测试。JSON Schema 约束模型生成，Zod 校验模型实际输出；两者承担不同职责。
