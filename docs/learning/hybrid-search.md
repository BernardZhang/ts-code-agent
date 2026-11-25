# Issue #15 混合检索

## 当前实现

向量召回以问题的 Embedding 查询 pgvector，关键词召回以显式词项匹配正文。
两路查询使用相同的资料集、实际模型和维度，并支持精确 sourcePath/documentId 过滤。
候选窗口默认各 50 条，返回前 5 条。

关键词采用大小写敏感字面子串匹配，命中的不同词项数决定关键词排名。
同分按文档和片段 ID 排序。关键词默认按问题空白拆分，中文问题可显式提供词项。
本阶段没有加入分词依赖、BM25 或全文索引，适用于当前小型学习语料。

Core 的 fuseRankings 按片段身份去重，使用等权 RRF：
每一路贡献 1/(60+rank)，未命中贡献零。同一路重复项只计首次排名。
最终同分按 documentId、chunkId 的字典序排列，不优先某一路。
返回结果保留 vectorRank、keywordRank 和 score。

例如向量结果 A/B/C、关键词结果 C/D/A，最终顺序为 A/C/B/D。
A 与 C 同分，B 与 D 同分，稳定 ID 决定各组内顺序。

## 调用链

CLI hybrid-search 调用 Core hybridSearch，注入 OllamaEmbeddingProvider 与
PostgresVectorStore。生成问题向量后，两路并发查询，再交给 fuseRankings。
失败时取消共享信号，不返回单路降级结果；跨路出现同文档多版本时提示重试。

## 2026-11-24 验证

默认离线测试覆盖融合去重、同分、交换输入路次序、单路重复、空结果、
配置边界、文档版本冲突、共享过滤、实际模型标识和失败取消。
真实数据库测试覆盖中文、AbortSignal、字面 %\_、多词命中数，
以及两路路径/文档过滤和资料集、模型隔离。

全仓开启真实数据库后运行 47 个测试文件，436 条测试通过。

真实 CLI 使用 Ollama embeddinggemma、768 维向量和 PostgreSQL/pgvector，
导入 docs/spec.md 的 65 个片段，执行以下查询：

```bash
pnpm dev hybrid-search "如何取消模型请求" \
  --corpus-id hybrid-acceptance \
  --keywords AbortSignal 取消 \
  --source-path docs/spec.md
```

查询成功返回 5 个带两路排名的融合结果，单次进程总耗时约 0.160s。
首条结果向量排名 8、关键词排名 1，融合分数约 0.0310993。
改为不存在的来源路径后，两路均无结果，输出空数组。
测量用于验证执行链路，检索质量仍由 #18 固定样本评测。
