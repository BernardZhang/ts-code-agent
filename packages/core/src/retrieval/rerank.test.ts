import { expect, it } from 'vitest';
import { rerankCandidates } from './rerank.js';
import type { RetrievalHit } from './hybrid-search.js';

function hit(
  id: string,
  text: string,
  headingPath: readonly string[] = [],
): RetrievalHit {
  return {
    documentId: 'doc',
    contentHash: 'v1',
    sourcePath: 'guide.md',
    chunk: {
      chunkId: id,
      text,
      headingPath,
      ordinal: 0,
      startOffset: 0,
      endOffset: text.length,
      startLine: 1,
      endLine: 1,
    },
  };
}

it('正文覆盖更多问题词项的片段提升排名，保留可解释信息', () => {
  const candidates = [
    hit('A', 'AbortSignal 是可选参数'),
    hit('B', '取消请求时，通过 AbortSignal 传播信号，并清理工具资源'),
  ];
  const ranked = rerankCandidates('取消 请求 清理', candidates, {
    terms: ['AbortSignal'],
    limit: 5,
  });
  expect(ranked.map(({ chunk }) => chunk.chunkId)).toEqual(['B', 'A']);
  expect(ranked[0]).toMatchObject({ originalRank: 2, rank: 1 });
  expect(ranked[0]?.matchedTerms).toEqual(
    expect.arrayContaining(['取消', '请求', '清理', 'abortsignal']),
  );
  expect(ranked[0]?.coverage).toBeGreaterThan(ranked[1]?.coverage ?? 0);
  expect(candidates.map(({ chunk }) => chunk.chunkId)).toEqual(['A', 'B']);
});

it('中文问题可分词匹配，忽略常见问法词', () => {
  const ranked = rerankCandidates('如何取消请求？', [
    hit('A', '如何使用其他功能'),
    hit('B', '取消请求的流程'),
  ]);
  expect(ranked[0]?.chunk.chunkId).toBe('B');
  expect(ranked[0]?.matchedTerms).toEqual(
    expect.arrayContaining(['取消', '请求']),
  );
  expect(ranked[1]?.matchedTerms).not.toContain('如何');
});

it('覆盖率相同时标题匹配优先，再沿用 RRF 顺序', () => {
  const ranked = rerankCandidates('取消', [
    hit('A', '取消'),
    hit('B', '取消', ['取消机制']),
    hit('C', '取消', ['取消机制']),
  ]);
  expect(ranked.map(({ chunk }) => chunk.chunkId)).toEqual(['B', 'C', 'A']);
});

it('不删除零匹配候选，保留同义语义召回；空输入可运行', () => {
  expect(
    rerankCandidates('中止', [hit('A', '取消'), hit('B', '结束')]).map(
      ({ chunk }) => chunk.chunkId,
    ),
  ).toEqual(['A', 'B']);
  expect(rerankCandidates('问题', [])).toEqual([]);
});

it('词项去重且大小写不敏感，只匹配字面量', () => {
  const ranked = rerankCandidates(
    'AbortSignal',
    [hit('A', 'abortsignal 100%_')],
    {
      terms: ['AbortSignal', '%_'],
    },
  );
  expect(ranked[0]?.matchedTerms).toEqual(['abortsignal', '%_']);
});

it('校验参数并支持取消，重复片段仅保留首次排名', () => {
  const candidate = hit('A', '正文');
  expect(rerankCandidates('正文', [candidate, candidate])).toHaveLength(1);
  expect(() => rerankCandidates('', [candidate])).toThrow();
  expect(() => rerankCandidates('问题', [], { limit: 0 })).toThrow();
  expect(() =>
    rerankCandidates('问题', [], { signal: AbortSignal.abort() }),
  ).toThrow();
});
