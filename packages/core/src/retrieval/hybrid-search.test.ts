import { expect, it, vi } from 'vitest';
import {
  fuseRankings,
  hybridSearch,
  type RetrievalHit,
  type HybridSearchStore,
} from './hybrid-search.js';

function hit(id: string): RetrievalHit {
  return {
    documentId: 'doc',
    sourcePath: 'guide.md',
    contentHash: 'v1',
    chunk: {
      chunkId: id,
      ordinal: 0,
      text: id,
      startOffset: 0,
      endOffset: 1,
      startLine: 1,
      endLine: 1,
      headingPath: [],
    },
  };
}
it('等权融合去重，同分以稳定 ID 排列，不偏向某路', () => {
  const results = fuseRankings(
    ['A', 'B', 'C'].map(hit),
    ['C', 'D', 'A'].map(hit),
  );
  expect(results.map(({ chunk }) => chunk.chunkId)).toEqual([
    'A',
    'C',
    'B',
    'D',
  ]);
  expect(results[0]?.score).toBe(results[1]?.score);
  expect(results[2]?.score).toBe(results[3]?.score);
  expect(results[0]).toMatchObject({ vectorRank: 1, keywordRank: 3 });
  expect(
    fuseRankings(['C', 'D', 'A'].map(hit), ['A', 'B', 'C'].map(hit)).map(
      ({ chunk }) => chunk.chunkId,
    ),
  ).toEqual(['A', 'C', 'B', 'D']);
});
it('单路重复不累计分数，空路可融合，并按文档区分同名片段', () => {
  expect(fuseRankings([hit('A'), hit('A')], [])[0]?.score).toBe(1 / 61);
  expect(fuseRankings([], [])).toEqual([]);
  expect(
    fuseRankings([hit('A')], [{ ...hit('A'), documentId: 'other' }]),
  ).toHaveLength(2);
});
it('检测并发更新产生的文档版本冲突，拒绝混合旧新正文', () => {
  expect(() =>
    fuseRankings([hit('A')], [{ ...hit('B'), contentHash: 'v2' }]),
  ).toThrow('多个版本');
});
it('验证限制，保持极小差异的真实分数优先', () => {
  expect(() => fuseRankings([], [], 0)).toThrow();
  expect(() => fuseRankings([], [], 5, 0)).toThrow();
  expect(fuseRankings([hit('B'), hit('A')], [], 1)[0]?.chunk.chunkId).toBe('B');
});

it('两路使用实际模型标识、相同过滤及候选数', async () => {
  const search = vi.fn().mockResolvedValue([{ ...hit('A'), distance: 0.1 }]);
  const searchKeywords = vi
    .fn()
    .mockResolvedValue([{ ...hit('A'), matchedTerms: 1 }]);
  const provider = {
    embed: vi.fn().mockResolvedValue({ model: 'actual', embeddings: [[1, 0]] }),
  };
  const filter = { sourcePath: 'guide.md' };
  const results = await hybridSearch(
    {
      query: '如何取消',
      terms: ['AbortSignal'],
      corpusId: 'manual',
      model: 'test',
      filter,
    },
    provider,
    { search, searchKeywords },
  );
  expect(results).toHaveLength(1);
  for (const call of [
    search.mock.calls[0]?.[0],
    searchKeywords.mock.calls[0]?.[0],
  ]) {
    expect(call).toMatchObject({
      model: 'actual',
      corpusId: 'manual',
      filter,
      limit: 50,
    });
  }
  expect(searchKeywords.mock.calls[0]?.[0].terms).toEqual(['AbortSignal']);
});
it('任一路失败取消共享请求并向上传播错误', async () => {
  let sharedSignal: AbortSignal | undefined;
  const store: HybridSearchStore = {
    search: vi.fn(async (request) => {
      sharedSignal = request.signal;
      throw new Error('数据库失败');
    }),
    searchKeywords: vi.fn(async () => []),
  };
  await expect(
    hybridSearch(
      { query: 'test', corpusId: 'manual', model: 'test' },
      {
        embed: vi
          .fn()
          .mockResolvedValue({ model: 'test', embeddings: [[1, 0]] }),
      },
      store,
    ),
  ).rejects.toThrow('数据库失败');
  expect(sharedSignal?.aborted).toBe(true);
});
