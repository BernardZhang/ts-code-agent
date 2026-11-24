import { ingestWorkspaceDocument } from '../bootstrap.js';
import { OllamaEmbeddingProvider } from '@ts-code-agent/adapters';
import { type IngestDocumentOptions } from '@ts-code-agent/code-agent';
import type { EmbeddingConfig } from '../embedding-config.js';

const EMBEDDING_BATCH_SIZE = 16;

/** 分批向量化，成功处理全部片段后才输出摘要。 */
export async function embedDemo(
  options: IngestDocumentOptions,
  config: EmbeddingConfig,
): Promise<void> {
  const { document, chunks } = await ingestWorkspaceDocument(options);
  const provider = new OllamaEmbeddingProvider(config);
  const models = new Set<string>();
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const result = await provider.embed({
      model: config.model,
      texts: chunks
        .slice(offset, offset + EMBEDDING_BATCH_SIZE)
        .map(({ text }) => text),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    models.add(result.model);
    if (models.size > 1) {
      throw new Error('同一文档的批次返回不同模型标识，请重新导入。');
    }
  }
  options.signal?.throwIfAborted();
  process.stdout.write(
    `${JSON.stringify({
      sourcePath: document.sourcePath,
      chunks: chunks.length,
      embedded: chunks.length,
      model: models.values().next().value ?? config.model,
      dimensions: config.dimensions,
    })}\n`,
  );
}
