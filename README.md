# ts-code-agent

TypeScript AI Agent + Code Agent：六阶段渐进学习与工程实践

当前实现 Day 1–4（Day 4 验收边界见学习记录），并已接入 Day 5 四个只读仓库工具。Day 5 CLI 已完成模拟模型集成及真实模型四工具基础验证；回答完整性和剩余验收见 [Day 5 学习记录](docs/learning/day-05.md)。

Day 1 环境与历史验证见 [Day 1 验证记录](docs/day1-verification.md)；Day 2 功能、学习与验证见 [Day 2 学习记录](docs/learning/day-02.md)。

Day 3 Agent Loop 的设计、实验及限制见 [Day 3 学习记录](docs/learning/day-03.md)。

最新顺序、工时、缓冲与日期见 [学习路线](docs/learning-roadmap.md)。原 36 个学习日保留为历史任务单元，新增会话 CLI 与流式 Agent 专项；不再把一个 Issue 等同一个日历学习日。当前目标为2026-12-15前完成全部内容学习（12-14验收），每周6天、每天≤10h；逐日预算和实测校准规则见路线文档。

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

聊天、会话及回答模型配置由命令参数或环境提供，表中为 .env.example 示例值：

| 参数               | 环境变量               | 配置示例                 |
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

`pnpm dev`、`pnpm start` 和构建后的 CLI 会自动加载当前工作目录中的 `.env`。
先将 `.env.example` 复制为 `.env`，再填写本地实际配置。
配置优先级为命令参数 > 已有环境变量 > `.env`。聊天模型配置项均需提供；
Embedding 配置另有 embeddinggemma:latest、768 维等回退值。
缺少 `.env` 时继续运行，读取失败时明确报错。`.env` 已被 Git 忽略。

```bash
cp .env.example .env
pnpm dev chat "你好"
```

数据库连接请在 `.env` 中填写 `AGENT_DATABASE_URL`，
并与 PostgreSQL 初始化时的账号、密码、端口和数据库名保持一致。
Docker Compose 启动时通过 `--env-file .env` 显式读取仓库根目录配置。

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

系统提示要求使用工具及不猜测未知变量，但模型可能提前回答或不遵循提示。`agent-demo` 是单次任务，不等待变量补充；再次启动不会保留历史。调用方可显式传入上次返回的 messages 继续对话，新一次 run 的 steps 从头计数。

## 交互式多轮与流式会话（Issue #45 / #46）

```bash
pnpm dev session
# 或先 pnpm build，再运行编译产物
pnpm start session --workspace . --model qwen3:8b --context-length 16384 --think false
# 非流式对照：等待完整回答后一次性显示
pnpm start session --workspace . --no-stream
```

每条提交启动一个 Agent 任务，默认流式显示文字，`--no-stream` 等完整响应后显示，可连续探索目录、读取文件、搜索代码和查询 Git 状态。`--workspace` 默认当前目录，启动时解析真实路径并验证目录；四个只读工具共用该边界。每轮最多10次模型请求，工具描述计入现有 ContextManager 的启发式预算。回答写入 stdout，错误与限制提示写入 stderr。

目录最多10层、50条；读取默认64 KiB；搜索采用工具默认扫描预算。Git 状态暂时要求工作区为 Git 仓库根目录。`agent-demo` 继续保留 add 计算示例。

- `/reset`：空闲时清空对话历史，保留系统规则。
- `/multiline`：空闲时进入多行输入，保留空行与缩进；单独一行 `/send` 提交整段，`/cancel` 或 Ctrl+C 放弃草稿。多行模式中 `/reset`、`/exit` 等按正文处理；EOF 放弃草稿并退出。控制命令行不带缩进或额外空格，空白草稿不能提交。
- `/exit` 或 EOF（空行时 Ctrl+D）：取消当前任务并等待收尾，然后退出。
- Ctrl+C：运行时取消当前任务，收尾后可继续；空闲时退出。
- 按回车提交时若任务仍在运行，普通输入与 `/reset` 会被丢弃并提示，不排队执行。

正常返回（包括步数耗尽）保存完整历史；步数耗尽仍提示任务未完成。失败、取消或预算超限不保存当前轮，之前成功历史保留；历史回滚不会撤销已经执行的工具操作。预算超限可用 `/reset` 开始新对话。历史只在当前进程内保存，退出后不恢复。流式与非流式共用完整历史提交策略。

在会话中输入 `/plan 分析这个 TypeScript 仓库的 CLI 入口`，先生成结构化计划，再执行当前轮次。可输入「继续」沿用当前计划，或再次使用 `/plan <目标>` 更换计划。`/reset` 清空历史和计划。计划生效期间，模型可以调用 `update_plan` 申请更新；仓库调查的完成状态需要引用成功的工具调用。纯计算可以提交结果摘要，终端将这类步骤标为模型报告，并显示已提交的进度及剩余步骤。

当前状态：核心机制学习与实现完成，验收收尾待补。2026-11-03已有273项离线测试通过；真实仓库三轮带工具记录/延迟测量和关键组合测试待补，生命周期事件由#26承接。#45/#46未关闭，提交/PR不代表整体验收完成，交付状态以对应Git记录为准。详情见[会话验收记录](docs/learning/session-cli.md)。

## 检查

ESLint 使用 JavaScript 与 TypeScript recommended 规则，并要求所有 `if/else`、`for`、`while` 等控制语句使用大括号（单行也不例外）、严格相等、禁止 `var`、优先 `const`、对象简写及禁止基本类型包装对象。缩进、引号、换行等格式由 Prettier 统一处理。

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

## Day 4 离线综合演示

```sh
pnpm dev context-demo
```

`context-demo` 不需要 Ollama：创建演示计划，更新定位和修复步骤的状态，将最新计划放入 system 消息，然后按预算裁剪旧轮次。输出包含计划、裁剪前后消息数、上下文及模拟成本。成本为 JSON 序列化字符数，不是真实模型 token 数；预算恰好容纳 system 和当前用户轮次。计划状态为演示预设，不代表实际执行或验证。完整历史保留在内存中，旧工具证据不会自动转入计划。

### Agent Demo 上下文预算

`agent-demo` 已接入 ContextManager：总容量取 `--context-length`，输出预留为 1024 tokens，工具描述单独估算。Adapters 中的估算器使用完整消息或公开工具描述的 UTF-8 JSON 字节数加固定开销；不是实际 tokenizer，也不保证是严格上界。估算说明输出到 stderr。

单个用户任务的工具交互属于同一轮次，当前不压缩这一轮次；必要消息放不下时在下一次模型请求前失败。CLI 使用 context_budget_exceeded 等错误码明确报告上下文预算、历史结构和估算错误，退出码为 1。输出预留目前用于本地预算计算，不代表 Provider 已设置输出 token 硬上限。

Day 4 实现、真实模型实验与验收限制见 [Day 4 学习记录](docs/learning/day-04.md)。真实模型曾在计算任务中提前结束；不能将退出码 0 或 complete 当作任务成功。

```sh
pnpm dev plan-demo "修复失败测试，先定位原因，再修复并验证"
```

通用 TaskPlanner 接入 Agent 主流程已排入 [Day 6 任务范围](docs/day-06-plan.md)及 [Issue #6](https://github.com/BernardZhang/ts-code-agent/issues/6)；当前独立计划模块和示例尚未实现计划驱动执行。

## Day 5：只读仓库分析

```bash
pnpm dev repo-demo "先查看项目结构，读取 package.json，并搜索 AgentRunner，依据工具结果解释项目" --workspace .
# 编译后运行
pnpm build
pnpm start repo-demo "查询 Git 状态，说明哪些文件有变化" --workspace /path/to/repository
```

`--workspace` 默认为当前目录；启动前验证目录存在。命令注册 list_directory、read_file、search_code、git_status，由模型选择调用，默认顺序执行，最多请求模型 10 次。回答写入 stdout，运行提示及调用次数写入 stderr；步数耗尽退出 1，Ctrl+C 退出 130。模型不调用工具或提前停止仍可能产生回答，正常退出仅表示循环结束，不能据此认定分析正确或任务完成。

目录默认 BFS、最多 10 层和 50 条；文件读取默认最多 64 KiB；搜索支持普通文本和多行，默认最多 200 个文件、10000 个目录条目、16 MiB 扫描字节、100 个匹配。工具失败及不完整标记会回传模型；工具输出仍受上下文预算限制，单个长轮次超限会停止，不自动压缩。当前不支持编辑、任意命令或计划驱动执行；TaskPlanner 执行集成留在 Day 6。

Git 工具当前要求工作区为仓库根目录，非仓库及仓库子目录调用会返回工具失败；子目录支持的后续设计见 Issue #43。普通工具失败不会自动令整个 Agent 退出非零，应结合工具结果和最终回答判断。模拟模型验证不能证明真实模型会稳定选对工具、充分探索或遵守所有提示。

`repo-demo --trace-tools` 可选开启工具调用诊断，向 stderr 输出工具名、请求路径及 started/succeeded/failed 状态，失败时附工具错误码；路径与名称最多显示 200 个字符，使用 JSON 转义。诊断不输出搜索词、文件正文或完整工具结果，默认关闭。提示明确工作区根目录是 `.`，不是系统根目录 `/`；此提示不放宽路径边界。

若出现 `context_budget_exceeded`，说明当前用户轮次的工具结果放不进上下文；可以缩小探索任务，或显式传入 `--context-length 16384`（需模型与本机资源支持）。命令不会自动扩大上下文或静默裁剪当前轮次。

### 本地运行追踪

`pnpm dev session --trace --workspace .` 开启脱敏JSONL追踪，默认关闭；可加 `--no-stream` 比较非流式行为。每轮文件位于工作区 `.agent/traces`，工具状态和保存结果输出到stderr，模型正文仍输出到stdout。

使用 `pnpm dev trace-read .agent/traces/<文件名>.jsonl` 流式查看已校验元数据和完整性诊断。存在缺口、损坏或缺少终态/页脚时返回非零退出码；不输出模型或工具正文。

默认7天保留期、256 MiB目录配额、1 MiB普通队列预算，满队列拒绝并统计丢弃。追踪失败不终止Agent。关闭等待5秒后可以报告超时，但后台IO可能继续，进程退出可能延迟；无fsync断电持久性保证。目录锁只允许一个会话管理同一目录，未知或无法确认失效的锁不会自动删除。

模块调用图、故障语义、测试与真实模型验证见 [Trace学习与验收](docs/learning/trace-collector.md)。离线压测：`pnpm exec tsx scripts/trace-benchmark.ts`。

### 文档向量化演示

先安装具有 Embedding 能力的 Ollama 模型，并确认模型实际输出维度。
模型与维度可通过命令参数提供，也可配置
`AGENT_EMBEDDING_MODEL`、`AGENT_EMBEDDING_DIMENSIONS`。
命令参数优先于环境变量，地址与超时沿用
`AGENT_BASE_URL`、`AGENT_TIMEOUT_MS`。

```bash
pnpm dev embed-demo docs/spec.md --corpus-id project-docs --model embeddinggemma --dimensions 768
```

命令按每批最多 16 个片段调用 Ollama，校验每个返回向量的维度，
全部成功后输出路径、片段数、模型与维度的 JSON 摘要。
空文档跳过模型请求。Ctrl+C 取消当前请求，超长输入明确失败。
当前演示在内存中处理向量，数据库持久化与近邻检索继续由 #14 实现。

### pgvector 文档入库和检索

本地数据库使用 `infra/compose.yaml`，持久数据保存在 Docker 命名卷。
在同一个终端按顺序执行，示例密码仅用于本机学习环境：

```bash
export AGENT_POSTGRES_PASSWORD=rag-local-dev
export AGENT_DATABASE_URL=postgresql://postgres:rag-local-dev@127.0.0.1:15432/agent_rag
export AGENT_EMBEDDING_MODEL=embeddinggemma
export AGENT_EMBEDDING_DIMENSIONS=768

docker compose --env-file .env -f infra/compose.yaml up -d --wait
ollama pull embeddinggemma

pnpm dev vector-init
pnpm dev index-demo docs/spec.md --corpus-id project-docs
pnpm dev vector-search "项目如何处理取消请求？" --corpus-id project-docs
```

`vector-init` 显式初始化扩展和专用表，使用有建表和扩展权限的账号。
`index-demo` 在事务外生成全部向量，随后事务性替换同一资料集内的文档，
重复导入覆盖旧片段，空文档清除旧片段。并发导入同一文档时，以数据库取得
文档锁后的提交顺序为准。当前每次重算向量，未实现增量缓存。

`vector-search` 按实际返回的模型标识、维度、资料集隔离，返回余弦距离最小
的五个片段来源。使用精确扫描；未建近似向量索引。模型标签指向的权重被替换时，
应重建文档索引。请求取消会关闭操作专用数据库连接，尚未提交的事务由数据库回滚。
取消或断线若发生在提交交接时，结果可能已经提交，可重复导入收敛状态。
数据库连接和语句默认超时为 10 秒。

默认测试离线。连接独立测试数据库运行真实 pgvector 集成测试：

```bash
AGENT_TEST_DATABASE_URL="$AGENT_DATABASE_URL" pnpm exec vitest run packages/adapters/src/postgres/vector-store.integration.test.ts
```

集成测试自动创建专属资料集并清理其记录。本地数据库可用
`docker compose --env-file .env -f infra/compose.yaml stop` 停止，命名卷会保留。

### 混合检索

完成文档入库后，使用相同的数据库连接和 Embedding 配置运行：

```bash
pnpm dev hybrid-search "如何取消模型请求" \
  --corpus-id project-docs \
  --keywords AbortSignal 取消 \
  --source-path docs/spec.md
```

两路各取最多 50 个候选，以等权 RRF（平滑常数 60）融合，返回前 5 个。
同分按 documentId、chunkId 的字典序排列。输出包含各路排名和融合分数，
便于检查候选为什么排在前面。--source-path 和 --document-id 为精确匹配，
在两路召回取候选之前应用。

关键词使用大小写敏感的字面子串匹配，按命中的不同词项数降序排列，
同分按稳定 ID 排列。% 和 \_ 均按普通文字处理。
未提供 --keywords 时，按问题中的空白拆分词项；中文自然语言问题可显式提供关键词。
当前关键词查询扫描片段正文，未加入分词器、BM25 或全文索引。
任一路查询失败时整体失败，跨路检测到同一文档的多个内容版本时提示重试。

### 带引用的 RAG 问答

在已完成入库且 .env 配置模型和数据库连接的情况下运行：

```bash
pnpm dev rag-query "项目如何处理取消请求？" \
  --corpus-id project-docs \
  --keywords AbortSignal 取消 \
  --source-path docs/spec.md
```

回答模型使用 AGENT_MODEL 或 --model，Embedding 模型使用
AGENT_EMBEDDING_MODEL 或 --embedding-model；向量维度由
AGENT_EMBEDDING_DIMENSIONS 或 --embedding-dimensions 指定。

RAG 问答先对 RRF 前 20 个候选重排，选取前 5 个再构建证据。
重排按正文词项覆盖率、标题匹配数、原 RRF 排名依次排序；中文使用 Node 原生分词。
系统提示与问题先占用预算，另预留 1024 输出 token，
其余空间装入完整证据并分配 S1/S2。没有可用证据时跳过回答模型，
返回 insufficient_evidence。模型也可报告证据不足。
回答只有在引用编号校验通过时才作为 answered 返回，输出包含引用来源和估算输入量。
未知或缺失引用返回 invalid_citations，进程退出码为 1，原始生成正文不输出。
引用编号有效性与事实支持程度分别评估。输出的 reranking 列出路径、行号、标题、
重排前后名次、覆盖率和匹配词，可直接比较。此基线使用词项覆盖，未使用语义重排模型。
使用现有启发式 token 估算，输出预留参与预算计算，当前未作为模型生成硬上限。

### RAG 交付记录

本轮覆盖 #13 文档导入、#14 向量入库、#15 混合检索和 #16 带引用问答。
模块分层、验证证据和待评测项见
[文档与入库验收](docs/learning/rag-ingestion.md)、
[混合检索验收](docs/learning/hybrid-search.md)和
[问答验收](docs/learning/rag-answer.md)。
