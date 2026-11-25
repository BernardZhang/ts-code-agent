import { OllamaEmbeddingProvider } from '@ts-code-agent/adapters';
import { hybridSearch } from '@ts-code-agent/core';
import type { EmbeddingConfig } from '../embedding-config.js';
import { createVectorStore } from './vector-demo.js';

export interface HybridSearchDemoOptions {
  readonly corpusId: string;
  readonly sourcePath?: string;
  readonly documentId?: string;
  readonly keywords?: readonly string[];
}

export async function hybridSearchDemo(
  query: string,
  options: HybridSearchDemoOptions,
  config: EmbeddingConfig,
  signal: AbortSignal,
): Promise<void> {
  const hits = await hybridSearch(
    {
      query,
      corpusId: options.corpusId,
      model: config.model,
      signal,
      ...(options.keywords ? { terms: options.keywords } : {}),
      filter: {
        ...(options.sourcePath !== undefined
          ? { sourcePath: options.sourcePath }
          : {}),
        ...(options.documentId !== undefined
          ? { documentId: options.documentId }
          : {}),
      },
    },
    new OllamaEmbeddingProvider(config),
    createVectorStore(config),
  );
  process.stdout.write(
    JSON.stringify(
      hits.map((hit) => ({
        documentId: hit.documentId,
        sourcePath: hit.sourcePath,
        chunkId: hit.chunk.chunkId,
        startLine: hit.chunk.startLine,
        endLine: hit.chunk.endLine,
        headingPath: hit.chunk.headingPath,
        score: hit.score,
        vectorRank: hit.vectorRank,
        keywordRank: hit.keywordRank,
      })),
    ) + '\n',
  );
}
