# Issue #16 RAG 问答验收

## 执行链路

问题经过混合检索，RRF 取前 20 个候选。可解释重排按正文词项覆盖率、
标题匹配数及原排名取前 5 个。Core 构建预算内完整证据并分配 S1/S2，
再调用回答模型，解析结构化结果并校验引用编号。

无预算内证据时不调用回答模型，返回 insufficient_evidence。
模型判断证据不足时也返回该状态。未知或缺失引用返回 invalid_citations，
CLI 以非零退出码结束，原始生成正文不作为有效回答输出。

## 2026-11-24 真实模型验收

- Ollama 0.40.16，回答模型 qwen3:8b，think=false。
- Embedding 使用 embeddinggemma，768 维。
- 模型上下文配置为 40960，输出预留 1024；输入使用既有启发式估算。
- 查询资料集 project-docs，来源过滤 docs/spec.md。
- 既有本地 PostgreSQL/pgvector 用于只读查询，本轮未重建用户数据库。

### 有证据的问题

问题为“取消后，后续模型请求会停止吗？已经执行的工具副作用能保证撤销吗？”
关键词为“取消、副作用”。

第一轮模型漏写引用，程序报告 missing_citation，状态 invalid_citations，
退出码为 1。该失败保留在本地验收记录中。

随后提示词补充了具体的 [S1] 格式示例，并明确有证据回答必须引用本轮编号。
未增加自动重试，也未降低校验条件。补充后独立运行两次，均返回 answered，
退出码为 0，引用两条证据。两次回答均为：

> 取消会停止后续模型请求。[S2] 已经执行的工具副作用不能保证撤销。[S1]

S2 对应 docs/spec.md 第 113 行，说明取消停止后续模型请求，
不保证撤销或强停副作用。S1 对应第 94–100 行，说明超时取消不回滚副作用。
两条来源的内容哈希均与本地规范化原文一致，UTF-16 区间可复原对应正文。

两次进程总耗时为 15.306s 和 4.185s，是本机单次测量，包含启动、检索和生成。

### 资料不足的问题

问题为“取消工具后，被修改的文件会在多少秒内自动恢复？请给出具体秒数。”
关键词为“取消、副作用”。

结果为 insufficient_evidence，回答“当前资料不足以回答这个问题。”，
没有引用，退出码为 0，进程总耗时约 13.935s。
相同问题将路径过滤改为 missing.md 后，同样返回资料不足。

## 复跑命令

在 .env 已配置模型和数据库且资料已入库的情况下执行：

```bash
pnpm dev rag-query "取消后，后续模型请求会停止吗？已经执行的工具副作用能保证撤销吗？" \
  --corpus-id project-docs \
  --keywords 取消 副作用 \
  --source-path docs/spec.md \
  --timeout-ms 120000

pnpm dev rag-query "取消工具后，被修改的文件会在多少秒内自动恢复？请给出具体秒数。" \
  --corpus-id project-docs \
  --keywords 取消 副作用 \
  --source-path docs/spec.md \
  --timeout-ms 120000
```

本轮 JSON 记录位于被忽略的 .agent/rag-acceptance/2026-11-24-\_nhrnece/，
包含首轮失败、重复有证据回答、资料不足和空来源场景。

## 验收边界

引用编号校验能发现来源不在本轮证据中的情况，不能单独证明正文忠实于证据。
本轮人工逐项对照了两个事实结论，尚未进行 #18 的固定样本质量评测。
词项覆盖基线不具备语义重排模型的理解能力。模型仍可能再次漏引，
此时现有校验继续拦截，不保证每次请求都成功生成有效回答。

## 本轮工程回归

类型检查、构建和 lint 通过。默认并行全仓测试中，一条已有的会话 CLI
启动等待出现超时，未修改其断言。改用单 worker、关闭文件并行后，
52 个测试文件通过，461 条测试通过，4 条数据库集成测试因未指定独立连接而跳过。
单 worker 命令为 pnpm exec vitest run --maxWorkers=1 --no-file-parallelism。
真实模型请求未显式设置 temperature 或 seed，重复结果不构成稳定性保证。

## PR 交付前最终回归（2026-11-25）

使用专属 PostgreSQL/pgvector 临时测试库运行
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism，
53 个测试文件、465 条测试全部通过，包含 4 条真实数据库集成测试。
pnpm typecheck、pnpm build、pnpm lint 与 git diff --check 通过。
pnpm format:check 仅报告既有 .vscode/settings.json 格式问题。
模型行为证据沿用上方 2026-11-24 的真实问答验收，未把数据库测试视为模型质量评测。
本轮代码审查未发现需要修复的具体缺陷，任务进入 PR 审阅。

交付提交为 862604b，已推送并创建
[PR #53](https://github.com/BernardZhang/ts-code-agent/pull/53)。
该 PR 同时包含 414ac47 的 #13/#14 基础能力。#13–#16 的任务验收勾选及
路线总表 #47 已同步，当前处于 PR 审阅状态。
