import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgresVectorStore } from './vector-store.js';

const connectionString = process.env.AGENT_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('pgvector 真实数据库', () => {
  const corpusId = 'test-' + randomUUID();
  const store = new PostgresVectorStore({
    connectionString: connectionString ?? 'postgresql://localhost/unused',
    dimensions: 2,
  });
  const record = {
    corpusId,
    documentId: 'doc',
    contentHash: 'v1',
    sourcePath: 'guide.md',
    model: 'test:v1',
    dimensions: 2,
    chunks: [
      {
        chunkId: 'a',
        ordinal: 0,
        text: '安装',
        startOffset: 0,
        endOffset: 2,
        startLine: 1,
        endLine: 1,
        headingPath: [],
        embedding: [1, 0],
      },
      {
        chunkId: 'b',
        ordinal: 1,
        text: '测试',
        startOffset: 3,
        endOffset: 5,
        startLine: 2,
        endLine: 2,
        headingPath: [],
        embedding: [0, 1],
      },
    ],
  };
  const search = () =>
    store.search({
      corpusId,
      model: record.model,
      embedding: [1, 0],
      limit: 5,
    });
  beforeAll(async () => {
    await store.initialize();
    await store.initialize();
  });
  afterAll(async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query('DELETE FROM agent_rag_documents WHERE corpus_id=$1', [
        corpusId,
      ]);
    } finally {
      await client.end();
    }
  });

  it('重复导入无重复，余弦检索保留来源并按模型和资料集隔离', async () => {
    await store.replaceDocument(record);
    await store.replaceDocument(record);
    const hits = await search();
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      sourcePath: 'guide.md',
      distance: 0,
      chunk: { chunkId: 'a' },
    });
    await expect(
      store.search({
        corpusId: corpusId + '-other',
        model: record.model,
        embedding: [1, 0],
        limit: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.search({
        corpusId,
        model: 'other',
        embedding: [1, 0],
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it('数据库中途写入失败回滚，旧版本仍可查询', async () => {
    await store.replaceDocument(record);
    await expect(
      store.replaceDocument({
        ...record,
        contentHash: 'v2',
        chunks: [{ ...record.chunks[0]!, text: '\0' }],
      }),
    ).rejects.toThrow();
    expect((await search())[0]?.contentHash).toBe('v1');
  });

  it('并发导入保留单一完整版本，空文档清除旧片段', async () => {
    const next = {
      ...record,
      contentHash: 'v2',
      chunks: [{ ...record.chunks[0]!, text: '更新' }],
    };
    await Promise.all([
      store.replaceDocument(record),
      store.replaceDocument(next),
    ]);
    const hits = await search();
    const versions = new Set(hits.map((hit) => hit.contentHash));
    expect(versions.size).toBe(1);
    expect(hits).toHaveLength(versions.has('v1') ? 2 : 1);
    await store.replaceDocument({ ...record, chunks: [] });
    await expect(search()).resolves.toEqual([]);
  });
});
