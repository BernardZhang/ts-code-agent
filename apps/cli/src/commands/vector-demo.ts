import { indexDocument, ModelError, ModelErrorCode } from '@ts-code-agent/core';
import { ingestWorkspaceDocument } from '../bootstrap.js';
import {
  OllamaEmbeddingProvider,
  PostgresVectorStore,
} from '@ts-code-agent/adapters';
import { type IngestDocumentOptions } from '@ts-code-agent/code-agent';
import { z } from 'zod';
import type { EmbeddingConfig } from '../embedding-config.js';

const connectionSchema = z.url().pipe(
  z.string().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  }),
);

export function createVectorStore(
  config: EmbeddingConfig,
): PostgresVectorStore {
  const connection = connectionSchema.safeParse(process.env.AGENT_DATABASE_URL);
  if (!connection.success) {
    // 不输出连接串，避免将其中的数据库密码写入终端日志。
    throw new ModelError(
      ModelErrorCode.VALIDATION,
      '请设置 AGENT_DATABASE_URL 为有效的 PostgreSQL 连接串，例如 postgresql://用户:密码@127.0.0.1:15432/agent_rag。',
    );
  }
  return new PostgresVectorStore({
    connectionString: connection.data,
    dimensions: config.dimensions,
  });
}

export async function indexDemo(
  options: IngestDocumentOptions,
  config: EmbeddingConfig,
): Promise<void> {
  const store = createVectorStore(config);
  const parsed = await ingestWorkspaceDocument(options);
  const record = await indexDocument(
    {
      ...parsed,
      ...(options.signal ? { signal: options.signal } : {}),
      model: config.model,
      dimensions: config.dimensions,
    },
    new OllamaEmbeddingProvider(config),
    store,
  );
  process.stdout.write(
    JSON.stringify({
      sourcePath: record.sourcePath,
      indexed: record.chunks.length,
      model: record.model,
      dimensions: record.dimensions,
    }) + '\n',
  );
}

export async function vectorSearchDemo(
  query: string,
  corpusId: string,
  config: EmbeddingConfig,
  signal: AbortSignal,
): Promise<void> {
  const store = createVectorStore(config);
  const result = await new OllamaEmbeddingProvider(config).embed({
    model: config.model,
    texts: [query],
    signal,
  });
  const embedding = result.embeddings[0];
  if (!embedding) {
    throw new Error('查询向量缺失。');
  }
  const hits = await store.search({
    corpusId,
    model: result.model,
    embedding,
    limit: 5,
    signal,
  });
  // 摘要保持单行转义，默认只展示来源信息。
  process.stdout.write(
    JSON.stringify(
      hits.map(({ documentId, sourcePath, chunk, distance }) => ({
        documentId,
        sourcePath,
        chunkId: chunk.chunkId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        headingPath: chunk.headingPath,
        distance,
      })),
    ) + '\n',
  );
}
