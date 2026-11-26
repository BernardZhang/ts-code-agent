import type {
  IndexedDocument,
  VectorChunk,
  VectorStore,
} from './vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { ParsedDocument } from './types.js';

const BATCH_SIZE = 16;

export interface IndexDocumentOptions extends ParsedDocument {
  readonly model: string;
  readonly dimensions: number;
  readonly signal?: AbortSignal;
}

/** 网络向量化全部完成后再替换数据库，模型失败时旧文档保持可查询。 */
export async function indexDocument(
  options: IndexDocumentOptions,
  provider: EmbeddingProvider,
  store: VectorStore,
): Promise<IndexedDocument> {
  options.signal?.throwIfAborted();
  // 公共用例也校验配置，保证空文档走相同的入口约束。
  if (!options.model.trim()) {
    throw new TypeError('Embedding 模型不能为空。');
  }
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1) {
    throw new RangeError('向量维度必须为正整数。');
  }
  const { document, chunks } = options;
  const indexed: VectorChunk[] = [];
  let actualModel: string | undefined;
  for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
    options.signal?.throwIfAborted();
    const batch = chunks.slice(offset, offset + BATCH_SIZE);
    const result = await provider.embed({
      model: options.model,
      texts: batch.map(({ text }) => text),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    if (
      !result.model.trim() ||
      (actualModel !== undefined && actualModel !== result.model) ||
      result.embeddings.length !== batch.length
    ) {
      throw new TypeError('Embedding 模型标识或向量数量不一致。');
    }
    actualModel = result.model;
    batch.forEach((chunk, index) => {
      const embedding = result.embeddings[index];
      if (
        !embedding ||
        embedding.length !== options.dimensions ||
        embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new TypeError('Embedding 维度或数值不合法。');
      }
      indexed.push({ ...chunk, embedding });
    });
  }

  const record: IndexedDocument = {
    corpusId: document.corpusId,
    documentId: document.documentId,
    contentHash: document.contentHash,
    sourcePath: document.sourcePath,
    model: actualModel ?? options.model,
    dimensions: options.dimensions,
    chunks: indexed,
  };
  options.signal?.throwIfAborted();
  await store.replaceDocument(record, options.signal);
  return record;
}
