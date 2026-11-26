import type { EmbeddingProvider } from '../embedding/provider.js';
import type {
  VectorSearchHit,
  VectorSearchRequest,
  VectorStore,
  RetrievalFilter,
} from './vector-store.js';

export type RetrievalHit = Omit<VectorSearchHit, 'distance'>;

export interface KeywordSearchRequest {
  readonly corpusId: string;
  readonly model: string;
  readonly terms: readonly string[];
  readonly limit: number;
  readonly filter?: RetrievalFilter;
  readonly signal?: AbortSignal;
}

export interface KeywordSearchHit extends RetrievalHit {
  /** 命中的不同词项数，越大越靠前。 */
  readonly matchedTerms: number;
}

export interface HybridSearchStore extends Pick<VectorStore, 'search'> {
  searchKeywords(
    request: KeywordSearchRequest,
  ): Promise<readonly KeywordSearchHit[]>;
}

export interface HybridSearchHit extends RetrievalHit {
  readonly score: number;
  readonly vectorRank?: number;
  readonly keywordRank?: number;
}

const DEFAULT_RANK_CONSTANT = 60;
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULTS = 100;

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 同一路重复结果仅计第一次排名；等分按文档和片段 ID 确定顺序。 */
export function fuseRankings(
  vectorHits: readonly RetrievalHit[],
  keywordHits: readonly RetrievalHit[],
  limit = DEFAULT_RESULT_LIMIT,
  rankConstant = DEFAULT_RANK_CONSTANT,
): readonly HybridSearchHit[] {
  validateLimit(limit);
  if (!Number.isSafeInteger(rankConstant) || rankConstant < 1) {
    throw new RangeError('RRF 平滑常数必须为正整数。');
  }
  const hits = new Map<string, HybridSearchHit>();
  const versions = new Map<string, string>();
  const add = (list: readonly RetrievalHit[], vector: boolean) => {
    list.forEach((hit, index) => {
      const version = versions.get(hit.documentId);
      if (version !== undefined && version !== hit.contentHash) {
        throw new Error('召回结果包含同一文档的多个版本，请重试查询。');
      }
      versions.set(hit.documentId, hit.contentHash);
      const key = JSON.stringify([hit.documentId, hit.chunk.chunkId]);
      const existing = hits.get(key);
      if (
        vector
          ? existing?.vectorRank !== undefined
          : existing?.keywordRank !== undefined
      ) {
        return;
      }
      const rank = index + 1;
      hits.set(key, {
        documentId: hit.documentId,
        sourcePath: hit.sourcePath,
        contentHash: hit.contentHash,
        chunk: hit.chunk,
        ...existing,
        score: (existing?.score ?? 0) + 1 / (rankConstant + rank),
        ...(vector ? { vectorRank: rank } : { keywordRank: rank }),
      });
    });
  };
  add(vectorHits, true);
  add(keywordHits, false);
  return [...hits.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareId(left.documentId, right.documentId) ||
        compareId(left.chunk.chunkId, right.chunk.chunkId),
    )
    .slice(0, limit);
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new RangeError('检索数量必须为 1 到 100 的整数。');
  }
}

export interface HybridSearchOptions {
  readonly query: string;
  readonly corpusId: string;
  readonly model: string;
  /** 未提供时按空白拆分查询，中文可由调用方显式提供词项。 */
  readonly terms?: readonly string[];
  readonly filter?: RetrievalFilter;
  readonly candidateLimit?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** 模型生成问题向量后，两路共享范围并发召回；任一路失败即取消整次查询。 */
export async function hybridSearch(
  options: HybridSearchOptions,
  provider: EmbeddingProvider,
  store: HybridSearchStore,
): Promise<readonly HybridSearchHit[]> {
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  validateLimit(limit);
  validateLimit(candidateLimit);
  if (
    candidateLimit < limit ||
    !options.query.trim() ||
    !options.corpusId.trim() ||
    !options.model.trim()
  ) {
    throw new TypeError('查询和标识不能为空，候选数须大于等于返回数。');
  }
  const terms = [
    ...new Set(
      (options.terms ?? options.query.trim().split(/\s+/u)).map((term) =>
        term.trim(),
      ),
    ),
  ];
  if (!terms.length || terms.some((term) => !term || term.includes('\0'))) {
    throw new TypeError('关键词不能为空或包含 NUL。');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const result = await provider.embed({
      model: options.model,
      texts: [options.query],
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    const embedding = result.embeddings[0];
    if (
      !result.model.trim() ||
      result.embeddings.length !== 1 ||
      !embedding?.length ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new TypeError('查询 Embedding 响应不合法。');
    }
    const shared = {
      corpusId: options.corpusId,
      model: result.model,
      limit: candidateLimit,
      ...(options.filter ? { filter: options.filter } : {}),
      signal: controller.signal,
    };
    const [vectorHits, keywordHits] = await Promise.all([
      store.search({ ...shared, embedding } satisfies VectorSearchRequest),
      store.searchKeywords({ ...shared, terms }),
    ]);
    controller.signal.throwIfAborted();
    return fuseRankings(vectorHits, keywordHits, limit);
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', cancel);
  }
}
