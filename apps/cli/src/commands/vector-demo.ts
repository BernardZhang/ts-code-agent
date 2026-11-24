import { indexDocument } from '@ts-code-agent/core';
import { ingestWorkspaceDocument } from '../bootstrap.js';
import {
  OllamaEmbeddingProvider,
  PostgresVectorStore,
} from '@ts-code-agent/adapters';
import { type IngestDocumentOptions } from '@ts-code-agent/code-agent';
import { z } from 'zod';
import type { EmbeddingConfig } from '../embedding-config.js';

const connectionSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'postgres:' || protocol === 'postgresql:';
});

export function createVectorStore(
  config: EmbeddingConfig,
): PostgresVectorStore {
  return new PostgresVectorStore({
    connectionString: connectionSchema.parse(process.env.AGENT_DATABASE_URL),
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
