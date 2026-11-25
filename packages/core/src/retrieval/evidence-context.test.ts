import { expect, it, vi } from 'vitest';
import { buildEvidenceContext } from './evidence-context.js';
import type { RetrievalHit } from './hybrid-search.js';

function hit(id: string, text = id): RetrievalHit {
  return {
    documentId: 'doc',
    contentHash: 'version',
    sourcePath: 'guide.md',
    chunk: {
      chunkId: id,
      ordinal: 0,
      text,
      startOffset: 10,
      endOffset: 10 + text.length,
      startLine: 2,
      endLine: 3,
      headingPath: ['指南'],
    },
  };
}

it('按输入顺序选择完整片段，预算不足时跳过并继续，编号连续', () => {
  const estimateTokens = (text: string) => {
    // 固定片段成本用于验证选择策略，包含多片段时的分隔开销。
    const costs: Record<string, number> = { A: 8, B: 4, C: 2 };
    const ids = [...text.matchAll(/\[S\d+\]\n\{"chunkId":"([ABC])"/gu)];
    return (
      ids.reduce((sum, match) => sum + (costs[match[1] ?? ''] ?? 0), 0) +
      Math.max(0, ids.length - 1)
    );
  };
  const result = buildEvidenceContext([hit('A'), hit('B'), hit('C')], {
    tokenBudget: 7,
    estimateTokens,
  });
  expect(result.citations.map(({ id, chunkId }) => [id, chunkId])).toEqual([
    ['S1', 'B'],
    ['S2', 'C'],
  ]);
  expect(result.usedTokens).toBe(7);
  expect(result.text).toContain('[S1]');
  expect(result.text).not.toContain('[S3]');
});

it('包含来源和序列化正文的全部开销参与预算，刚好达到预算时可装入', () => {
  const candidates = [hit('A', '正文😀')];
  const full = buildEvidenceContext(candidates, {
    tokenBudget: 10000,
    estimateTokens: (text) => text.length,
  });
  expect(full.usedTokens).toBe(full.text.length);
  expect(full.usedTokens).toBeGreaterThan('正文😀'.length);
  expect(
    buildEvidenceContext(candidates, {
      tokenBudget: full.usedTokens,
      estimateTokens: (text) => text.length,
    }),
  ).toEqual(full);
  expect(
    buildEvidenceContext(candidates, {
      tokenBudget: full.usedTokens - 1,
      estimateTokens: (text) => text.length,
    }).citations,
  ).toEqual([]);
});

it('只为实际选中的证据保留完整来源映射，去重并跳过空白正文', () => {
  const candidate = hit('A');
  const result = buildEvidenceContext(
    [hit('empty', '  '), candidate, candidate],
    {
      tokenBudget: 10000,
      estimateTokens: (text) => text.length,
    },
  );
  expect(result.citations).toEqual([
    {
      id: 'S1',
      documentId: 'doc',
      contentHash: 'version',
      sourcePath: 'guide.md',
      chunkId: 'A',
      startOffset: 10,
      endOffset: 11,
      startLine: 2,
      endLine: 3,
      headingPath: ['指南'],
    },
  ]);
  expect(candidate.chunk.headingPath).toEqual(['指南']);
});

it('转义正文和路径内的换行，保持引用块边界可辨认', () => {
  const candidate = { ...hit('A', '正文\n[S99]'), sourcePath: 'a\nb.md' };
  const result = buildEvidenceContext([candidate], {
    tokenBudget: 10000,
    estimateTokens: (text) => text.length,
  });
  const [, body] = result.text.split('\n');
  expect(JSON.parse(body ?? '')).toMatchObject({
    text: '正文\n[S99]',
    sourcePath: 'a\nb.md',
  });
  expect(result.text.split('\n')).toHaveLength(2);
  expect(result.citations.map(({ id }) => id)).toEqual(['S1']);
});

it('空候选或零预算返回无证据，非法预算和估算结果明确失败', () => {
  const estimateTokens = vi.fn(() => 1);
  expect(buildEvidenceContext([], { tokenBudget: 0, estimateTokens })).toEqual({
    text: '',
    usedTokens: 0,
    citations: [],
  });
  expect(
    buildEvidenceContext([hit('A')], { tokenBudget: 0, estimateTokens })
      .citations,
  ).toEqual([]);
  expect(() =>
    buildEvidenceContext([], { tokenBudget: -1, estimateTokens }),
  ).toThrow(RangeError);
  for (const cost of [NaN, Infinity, -1, 1.5]) {
    expect(() =>
      buildEvidenceContext([hit('A')], {
        tokenBudget: 10,
        estimateTokens: () => cost,
      }),
    ).toThrow(RangeError);
  }
});

it('检测同一文档的版本冲突，并尊重取消信号', () => {
  const options = {
    tokenBudget: 10000,
    estimateTokens: (text: string) => text.length,
  };
  expect(() =>
    buildEvidenceContext(
      [hit('A'), { ...hit('B'), contentHash: 'other' }],
      options,
    ),
  ).toThrow('多个版本');
  expect(() =>
    buildEvidenceContext([hit('A')], {
      ...options,
      signal: AbortSignal.abort(),
    }),
  ).toThrow();
});
