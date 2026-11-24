import { expect, it, vi, afterEach } from 'vitest';
import { PostgresVectorStore } from './vector-store.js';

const { query, connect, end } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));
vi.mock('pg', () => ({
  Client: class {
    query = query;
    connect = connect;
    end = end;
  },
}));
afterEach(() => vi.resetAllMocks());

const store = () =>
  new PostgresVectorStore({
    connectionString: 'postgresql://localhost/test',
    dimensions: 2,
  });
const record = {
  corpusId: 'manual',
  documentId: 'doc',
  contentHash: 'v1',
  sourcePath: 'guide.md',
  model: 'test:v1',
  dimensions: 2,
  chunks: [
    {
      chunkId: 'chunk',
      ordinal: 0,
      text: '正文',
      startOffset: 0,
      endOffset: 2,
      startLine: 1,
      endLine: 1,
      headingPath: [],
      embedding: [1, 0],
    },
  ],
};

it('向量维度错误或零向量在连接前拒绝', async () => {
  for (const embedding of [[1], [0, 0], [NaN, 1], [Infinity, 1]]) {
    await expect(
      store().replaceDocument({
        ...record,
        chunks: [{ ...record.chunks[0]!, embedding }],
      }),
    ).rejects.toThrow();
  }
  expect(connect).not.toHaveBeenCalled();
});

it('事务内依次锁定、替换并提交，所有值参数化', async () => {
  await store().replaceDocument(record);
  const sql = query.mock.calls.map(([sql]) => String(sql));
  expect(sql[0]).toBe('BEGIN');
  expect(sql[1]).toContain('pg_advisory_xact_lock');
  expect(sql.at(-1)).toBe('COMMIT');
  expect(sql.find((text) => text.includes('DELETE FROM'))).toBeDefined();
  expect(
    query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_rag_chunks'),
    )?.[1],
  ).toContain('[1,0]');
  expect(end).toHaveBeenCalledOnce();
});

it('写入失败关闭专用连接且不提交', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO agent_rag_chunks')) {
      throw new Error('disk full');
    }
    return { rows: [] };
  });
  await expect(store().replaceDocument(record)).rejects.toThrow(
    '向量数据库操作失败',
  );
  expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  expect(end).toHaveBeenCalledOnce();
});

it('连接失败保持安全错误消息并关闭连接', async () => {
  connect.mockRejectedValue(new Error('connection string with secret'));
  await expect(store().replaceDocument(record)).rejects.toThrow(
    '向量数据库操作失败',
  );
  expect(end).toHaveBeenCalledOnce();
});

it('查询按资料集、模型和维度隔离，并解析外部响应', async () => {
  const { embedding: _embedding, ...metadata } = record.chunks[0]!;
  void _embedding;
  query.mockResolvedValue({
    rows: [
      {
        document_id: 'doc',
        source_path: 'guide.md',
        content_hash: 'v1',
        metadata,
        distance: 0.2,
      },
    ],
  });
  const result = await store().search({
    corpusId: 'manual',
    model: 'test:v1',
    embedding: [1, 0],
    limit: 5,
  });
  expect(result[0]).toMatchObject({ sourcePath: 'guide.md', distance: 0.2 });
  expect(query.mock.calls[0]?.[1]).toEqual([
    '[1,0]',
    'manual',
    'test:v1',
    2,
    5,
  ]);
});

it('提前取消时不建立连接', async () => {
  await expect(
    store().replaceDocument(record, AbortSignal.abort()),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
