import {
  OllamaEmbeddingProvider,
  OllamaProvider,
  estimateMessageTokens,
} from '@ts-code-agent/adapters';
import {
  generateGroundedAnswer,
  hybridSearch,
  rerankCandidates,
  ERagAnswerStatus,
} from '@ts-code-agent/core';
import type { Config } from '../config.js';
import type { EmbeddingConfig } from '../embedding-config.js';
import type { HybridSearchDemoOptions } from './hybrid-search.js';
import { createVectorStore } from './vector-demo.js';

const RESERVED_OUTPUT_TOKENS = 1024;
const RERANK_CANDIDATE_LIMIT = 20;

export async function ragQuery(
  question: string,
  options: HybridSearchDemoOptions,
  config: Config,
  embeddingConfig: EmbeddingConfig,
  signal: AbortSignal,
): Promise<void> {
  const candidates = await hybridSearch(
    {
      query: question,
      limit: RERANK_CANDIDATE_LIMIT,
      corpusId: options.corpusId,
      model: embeddingConfig.model,
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
    new OllamaEmbeddingProvider(embeddingConfig),
    createVectorStore(embeddingConfig),
  );
  const reranked = rerankCandidates(question, candidates, {
    ...(options.keywords ? { terms: options.keywords } : {}),
    signal,
  });
  const result = await generateGroundedAnswer(
    question,
    reranked,
    {
      model: config.model,
      contextLength: config.contextLength,
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
      think: config.think,
      estimateMessageTokens,
      signal,
    },
    new OllamaProvider(config),
  );
  process.stdout.write(
    JSON.stringify({
      ...result,
      reranking: reranked.map(
        ({
          sourcePath,
          chunk,
          originalRank,
          rank,
          coverage,
          matchedTerms,
          headingMatches,
        }) => ({
          sourcePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          headingPath: chunk.headingPath,
          originalRank,
          rank,
          coverage,
          matchedTerms,
          headingMatches,
        }),
      ),
    }) + '\n',
  );
  if (result.status === ERagAnswerStatus.INVALID_CITATIONS) {
    process.exitCode = 1;
  }
}
