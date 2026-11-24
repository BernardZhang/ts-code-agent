import { beforeEach, expect, it, vi } from 'vitest';
import { indexDocument } from './index-document.js';
import type { VectorStore } from '@ts-code-agent/core';

import { chunkDocument } from './chunk-document.js';
import { parseDocument } from './parse-document.js';
import { EDocumentFormat, type Document } from './types.js';

let content: string;
beforeEach(() => {
  content = '安装';
});
const config = (maxCodePoints = 800) => {
  const document: Document = {
    corpusId: 'manual',
    sourcePath: 'guide.txt',
    documentId: 'doc',
    contentHash: 'version',
    format: EDocumentFormat.TEXT,
    text: content,
  };
  return {
    document,
    chunks: chunkDocument(
      document,
      parseDocument(content, document.format),
      maxCodePoints,
    ),
    model: 'test',
    dimensions: 2,
  };
};
const store = (): VectorStore => ({
  replaceDocument: vi.fn(),
  search: vi.fn(),
});

it('完成向量化后交付正文、向量与来源到存储', async () => {
  content = '安装';
  const storage = store();
  const result = await indexDocument(
    config(),
    {
      embed: vi
        .fn()
        .mockResolvedValue({ model: 'test:v1', embeddings: [[1, 0]] }),
    },
    storage,
  );
  expect(storage.replaceDocument).toHaveBeenCalledExactlyOnceWith(
    result,
    undefined,
  );
  expect(result).toMatchObject({
    model: 'test:v1',
    chunks: [
      {
        text: '安装',
        embedding: [1, 0],
        startLine: 1,
      },
    ],
  });
});

it('向量化失败时不触碰存储', async () => {
  content = '安装';
  const storage = store();
  await expect(
    indexDocument(
      config(),
      {
        embed: vi.fn().mockRejectedValue(new Error('offline')),
      },
      storage,
    ),
  ).rejects.toThrow('offline');
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});

it('空文档不请求模型，仍替换为空集合以删除旧片段', async () => {
  content = '';
  const storage = store();
  const embed = vi.fn();
  const result = await indexDocument(config(), { embed }, storage);
  expect(embed).not.toHaveBeenCalled();
  expect(result.chunks).toEqual([]);
  expect(storage.replaceDocument).toHaveBeenCalledOnce();
});

it('后续批次失败时不写入前面已完成的向量', async () => {
  content = '甲'.repeat(17);
  const storage = store();
  const embed = vi
    .fn()
    .mockResolvedValueOnce({
      model: 'test:v1',
      embeddings: Array.from({ length: 16 }, () => [1, 0]),
    })
    .mockRejectedValueOnce(new Error('第二批失败'));
  await expect(indexDocument(config(1), { embed }, storage)).rejects.toThrow(
    '第二批失败',
  );
  expect(embed).toHaveBeenCalledTimes(2);
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});

it.each([
  { model: 'test:v1', embeddings: [] },
  { model: 'test:v1', embeddings: [[1]] },
  { model: 'test:v1', embeddings: [[NaN, 1]] },
  { model: '', embeddings: [[1, 0]] },
])('拒绝异常 Embedding 结果，保留旧索引 %j', async (result) => {
  content = '正文';
  const storage = store();
  await expect(
    indexDocument(
      config(),
      {
        embed: vi.fn().mockResolvedValue(result),
      },
      storage,
    ),
  ).rejects.toThrow();
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});

it('不同批次的实际模型标识不一致时拒绝入库', async () => {
  content = '甲'.repeat(17);
  const storage = store();
  const embed = vi
    .fn()
    .mockResolvedValueOnce({
      model: 'test:v1',
      embeddings: Array.from({ length: 16 }, () => [1, 0]),
    })
    .mockResolvedValueOnce({ model: 'test:v2', embeddings: [[1, 0]] });
  await expect(indexDocument(config(1), { embed }, storage)).rejects.toThrow(
    'Embedding 模型标识或向量数量不一致',
  );
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});

it('模型返回时已取消，不写入数据库', async () => {
  content = '正文';
  const storage = store();
  const controller = new AbortController();
  const embed = vi.fn().mockImplementation(async () => {
    controller.abort();
    return { model: 'test:v1', embeddings: [[1, 0]] };
  });
  await expect(
    indexDocument(
      {
        ...config(),
        signal: controller.signal,
      },
      { embed },
      storage,
    ),
  ).rejects.toThrow();
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});

it('索引参数非法时在模型调用与入库前失败', async () => {
  content = '';
  const storage = store();
  const embed = vi.fn();
  await expect(
    indexDocument(
      {
        ...config(),
        dimensions: 0,
      },
      { embed },
      storage,
    ),
  ).rejects.toThrow(RangeError);
  expect(embed).not.toHaveBeenCalled();
  expect(storage.replaceDocument).not.toHaveBeenCalled();
});
