# 文档切片、向量化与入库验收

## 调用链

`main.ts / index-demo` 装配 CLI 配置，通过 bootstrap 调用 Code Agent 的
`ingestWorkspaceDocument` 校验工作区路径。CLI 注入 Adapters 的
`readTextFile` 完成有界读取与 UTF-8 解码，随后调用 Core 的 ingestDocument
完成文本规范化、文档身份与内容哈希生成、解析和分片。
结果作为 ParsedDocument 交给 Core 的 `indexDocument`，再按每批 16 个片段
调用 Core 的 `EmbeddingProvider`。
Adapters 的 `OllamaEmbeddingProvider` 处理实际模型请求并校验响应，
全部批次成功后，`PostgresVectorStore.replaceDocument` 事务替换文档。

正文、片段 ID、来源行号与偏移、标题层级和向量一同保存。查询通过
同一模型生成问题向量，在指定资料集内按余弦距离返回来源摘要。

## 关键取舍

- 读取上限默认 1 MiB，分块上限默认 800 个 Unicode 码点，零重叠。
- 切片采用 UTF-16 半开区间定位，切分时保持代理对完整。
- 模型请求设置 truncate=false，超长片段明确失败。
- 文档 ID 由资料集和规范化路径决定，内容哈希区分版本。
- 向量化位于数据库事务外，任一批失败或取消时不替换旧文档。
- 数据库对同一文档加事务锁，整批替换，重复导入不增加重复行。
- 空文档跳过模型请求并提交空片段集，从而清除旧片段。
- 当前每次重新计算向量，暂未使用缓存；近邻查询使用精确扫描。

## 2026-11-23 真实环境验证

运行环境为 Node.js v26.12.1、Ollama 0.40.16，
模型为 embeddinggemma:latest，768 维，BF16，
模型摘要为
`85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`。
本地 Docker 临时数据库使用 PostgreSQL 17 与 pgvector。
临时数据库在验证后移除，持久开发数据库按 README 启动。

在已配置 AGENT_DATABASE_URL、AGENT_EMBEDDING_MODEL、
AGENT_EMBEDDING_DIMENSIONS 的终端执行以下命令：

```bash
pnpm build
node apps/cli/dist/main.js vector-init
node apps/cli/dist/main.js index-demo docs/spec.md --corpus-id real-acceptance
node apps/cli/dist/main.js index-demo docs/spec.md --corpus-id real-acceptance
node apps/cli/dist/main.js vector-search '项目如何处理取消请求？' --corpus-id real-acceptance
```

两次导入均输出 indexed=65、dimensions=768，数据库直接检查得到
65 行片段，最小和最大向量维度均为 768。实际模型响应标识为
embeddinggemma。真实查询返回 5 个带路径、行号、标题和距离的结果，
来源均为 docs/spec.md。这一运行验证了模型、CLI 和数据库连通，
检索质量仍由 #18 固定样本评测。

## 自动化边界验证

Core 的 index-document.test.ts 使用纯内存文档，覆盖成功入库、空文档清除、首批和后续批次失败、
向量数量和维度异常、非法数值、跨批次模型变化、取消与非法配置。
真实数据库集成测试覆盖重复导入、模型和资料集隔离、
中途写入失败回滚、并发导入和空文档清除。

默认测试通过 Fake Provider 和模拟 HTTP 保持离线。数据库集成测试通过
AGENT_TEST_DATABASE_URL 单独启用。提交交接时取消或断线可能发生在
服务器提交之后，重复导入可以收敛状态。

## Core 通用能力重构

解析、分片、Document/Chunk 类型和索引编排位于 packages/core/src/retrieval。
Core 的索引函数接收已经解析的文档与片段，可由不同文档来源复用。
本地读取位于 packages/adapters/src/documents，工作区导入仍位于 Code Agent；通用文档创建与导入已迁入 Core。
CLI 命令参数、文档/片段 ID 算法及数据库表结构沿用原实现。
跨包文件导入测试位于 tests/rag-ingestion.test.ts，Core 索引测试无需文件系统。

## Core 导入重构后的回归验收

Core 的 ingestDocument 接收文本、格式、资料集和来源标识，负责规范化、
文档 ID 与内容哈希、解析和分片。Code Agent 的 ingestWorkspaceDocument
负责工作区路径与格式选择，调用注入的读取函数。旧的 Code Agent
ingestDocument 导出作为兼容别名保留。

启用真实数据库后，全仓 46 个测试文件、428 条测试全部通过。
真实 embeddinggemma 的 CLI 回归对 docs/spec.md 连续导入两次，
均得到 65 个 768 维片段；数据库行数与维度查询结果为 65、768、768。
两次导入总耗时约 2.880s、1.083s，查询总耗时约 0.148s。
这些数值为本机单次验收测量，包含 CLI 启动、模型请求和数据库操作。

查询返回五个来源结果，文档 ID 和历史片段 ID 核对通过。
本轮使用的数据库为专属临时容器，验收后清理。
