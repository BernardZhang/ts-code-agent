import type { RetrievalHit } from './hybrid-search.js';

export interface EvidenceCitation {
  /** 模型正文使用 [S1]，此处保存不带括号的稳定映射键 S1。 */
  readonly id: string;
  readonly documentId: string;
  readonly contentHash: string;
  readonly sourcePath: string;
  readonly chunkId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly headingPath: readonly string[];
}

export interface EvidenceContext {
  readonly text: string;
  readonly usedTokens: number;
  readonly citations: readonly EvidenceCitation[];
}

export interface EvidenceContextOptions {
  /** 已扣除系统提示、问题、工具定义及输出预留后的证据预算。 */
  readonly tokenBudget: number;
  /** 估算序列化后的完整证据正文，返回非负安全整数。 */
  readonly estimateTokens: (text: string) => number;
  readonly signal?: AbortSignal;
}

/** 按现有排名装入完整片段；放不下就跳过，继续尝试后面的候选。 */
export function buildEvidenceContext(
  candidates: readonly RetrievalHit[],
  options: EvidenceContextOptions,
): EvidenceContext {
  const { tokenBudget, estimateTokens, signal } = options;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new RangeError('证据预算必须为非负安全整数。');
  }
  let text = '';
  let usedTokens = 0;
  const citations: EvidenceCitation[] = [];
  const seen = new Set<string>();
  const versions = new Map<string, string>();

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const { documentId, contentHash, sourcePath, chunk } = candidate;
    const version = versions.get(documentId);
    if (version !== undefined && version !== contentHash) {
      throw new Error('证据候选包含同一文档的多个版本。');
    }
    versions.set(documentId, contentHash);
    const key = JSON.stringify([documentId, chunk.chunkId]);
    if (seen.has(key) || !chunk.text.trim()) {
      continue;
    }
    seen.add(key);

    // 编号仅随成功装入的片段增长，跳过超长片段后不会出现编号空洞。
    const id = `S${citations.length + 1}`;
    const block = `[${id}]\n${JSON.stringify({
      chunkId: chunk.chunkId,
      sourcePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      headingPath: chunk.headingPath,
      text: chunk.text,
    })}`;
    const proposed = text ? `${text}\n\n${block}` : block;
    // 对拼装后的整体重新估算，纳入标签、来源和分隔符开销，
    // 同时避免假定 tokenizer 对独立片段的成本具有可加性。
    const cost = estimateTokens(proposed);
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(cost) || cost < 0) {
      throw new RangeError('token 估算结果必须为非负安全整数。');
    }
    if (cost > tokenBudget) {
      continue;
    }
    text = proposed;
    usedTokens = cost;
    citations.push({
      id,
      documentId,
      contentHash,
      sourcePath,
      chunkId: chunk.chunkId,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      headingPath: [...chunk.headingPath],
    });
  }
  return { text, usedTokens, citations };
}
