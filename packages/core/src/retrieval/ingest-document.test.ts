import { expect, it } from 'vitest';
import { ingestDocument } from './ingest-document.js';
import { EDocumentFormat } from './types.js';

const options = {
  corpusId: 'manual',
  sourcePath: 'https://example.test/guide',
  format: EDocumentFormat.MARKDOWN,
  text: '# 指南\n\n正文',
};

it('直接导入内存文本，生成文档与可定位片段', () => {
  const result = ingestDocument(options);
  expect(result.document.sourcePath).toBe(options.sourcePath);
  expect(result.chunks.find(({ text }) => text.includes('正文'))).toMatchObject(
    { headingPath: ['指南'], startLine: 3 },
  );
});

it('同一来源保留逻辑 ID，正文变化更新内容和片段 ID', () => {
  const first = ingestDocument(options);
  expect(ingestDocument(options)).toEqual(first);
  const updated = ingestDocument({ ...options, text: '# 指南\n\n新正文' });
  expect(updated.document.documentId).toBe(first.document.documentId);
  expect(updated.document.contentHash).not.toBe(first.document.contentHash);
  expect(updated.chunks[0]?.chunkId).not.toBe(first.chunks[0]?.chunkId);
  expect(
    ingestDocument({ ...options, corpusId: 'other' }).document.documentId,
  ).not.toBe(first.document.documentId);
});

it('统一文本换行及开头 BOM，空文本返回零片段', () => {
  expect(
    ingestDocument({ ...options, text: '\uFEFF# 指南\r\n\r\n正文' }),
  ).toEqual(ingestDocument(options));
  expect(ingestDocument({ ...options, text: ' \n' }).chunks).toEqual([]);
});

it('取消和非法参数在导入前失败', () => {
  expect(() =>
    ingestDocument({ ...options, signal: AbortSignal.abort() }),
  ).toThrow();
  expect(() => ingestDocument({ ...options, maxChunkCodePoints: 0 })).toThrow(
    RangeError,
  );
  expect(() => ingestDocument({ ...options, corpusId: '' })).toThrow(TypeError);
});
