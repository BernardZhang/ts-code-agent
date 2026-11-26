import type { RetrievalHit } from './hybrid-search.js';

const QUESTION_WORDS = new Set([
  '如何',
  '怎么',
  '什么',
  '哪些',
  '是否',
  '请问',
]);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

export interface RerankOptions {
  readonly terms?: readonly string[];
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface RerankedHit extends RetrievalHit {
  readonly originalRank: number;
  readonly rank: number;
  readonly coverage: number;
  readonly matchedTerms: readonly string[];
  readonly headingMatches: number;
}

/**
 * 可解释的词项覆盖基线。优先正文覆盖率，再比较标题匹配数，
 * 同分沿用原排名；零匹配候选保留，避免抹掉同义表达的向量召回。
 */
export function rerankCandidates(
  question: string,
  candidates: readonly RetrievalHit[],
  options: RerankOptions = {},
): readonly RerankedHit[] {
  const { limit = DEFAULT_LIMIT, signal } = options;
  signal?.throwIfAborted();
  if (
    !question.trim() ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw new RangeError('问题不能为空，重排返回数必须为 1 到 100 的整数。');
  }
  const queryTerms = [...segmenter.segment(question)]
    .filter(({ isWordLike }) => isWordLike)
    .map(({ segment }) => segment.toLowerCase())
    .filter((term) => !QUESTION_WORDS.has(term));
  const explicitTerms = (options.terms ?? []).map((term) =>
    term.trim().toLowerCase(),
  );
  if (explicitTerms.some((term) => !term || term.includes('\0'))) {
    throw new TypeError('显式重排词项不能为空或包含 NUL。');
  }
  const terms = [...new Set([...queryTerms, ...explicitTerms])];
  const seen = new Set<string>();
  const versions = new Map<string, string>();
  const ranked: Omit<RerankedHit, 'rank'>[] = [];
  candidates.forEach((candidate, index) => {
    signal?.throwIfAborted();
    const previousVersion = versions.get(candidate.documentId);
    if (
      previousVersion !== undefined &&
      previousVersion !== candidate.contentHash
    ) {
      throw new Error('重排候选包含同一文档的多个版本。');
    }
    versions.set(candidate.documentId, candidate.contentHash);
    const key = JSON.stringify([candidate.documentId, candidate.chunk.chunkId]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const body = candidate.chunk.text.toLowerCase();
    const headings = candidate.chunk.headingPath.join('\n').toLowerCase();
    const matchedTerms = terms.filter((term) => body.includes(term));
    ranked.push({
      documentId: candidate.documentId,
      contentHash: candidate.contentHash,
      sourcePath: candidate.sourcePath,
      chunk: {
        ...candidate.chunk,
        headingPath: [...candidate.chunk.headingPath],
      },
      originalRank: index + 1,
      coverage: terms.length ? matchedTerms.length / terms.length : 0,
      matchedTerms,
      headingMatches: terms.filter((term) => headings.includes(term)).length,
    });
  });
  return ranked
    .sort(
      (left, right) =>
        right.coverage - left.coverage ||
        right.headingMatches - left.headingMatches ||
        left.originalRank - right.originalRank,
    )
    .slice(0, limit)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}
