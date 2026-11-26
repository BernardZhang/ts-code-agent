import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk-document.js';
import { parseDocument } from './parse-document.js';
import { EDocumentFormat, type Document } from './types.js';

function createDocument(text: string): Document {
  return {
    corpusId: 'manual',
    sourcePath: 'guide.txt',
    documentId: 'document',
    contentHash: 'version',
    format: EDocumentFormat.TEXT,
    text,
  };
}

describe('chunkDocument', () => {
  it('跳过围栏内的纯空白片段，保留原文坐标并连续编号', () => {
    const text = '```\n' + '\n'.repeat(2000) + '尾部😀\n```';
    const chunks = chunkDocument(
      createDocument(text),
      parseDocument(text, EDocumentFormat.MARKDOWN),
      800,
    );

    expect(chunks).toHaveLength(2);
    expect(chunks.map(({ ordinal }) => ordinal)).toEqual([0, 1]);
    expect(chunks.every(({ text }) => text.trim().length > 0)).toBe(true);
    expect(chunks[1]).toMatchObject({
      startOffset: 1600,
      endOffset: text.length,
      startLine: 1598,
      endLine: 2003,
    });
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.startOffset, chunk.endOffset));
    }
    expect(chunks[1]?.text).toContain('尾部😀\n```');
  });

  it('纯空白区段全部跳过，包括空格、tab 和 Unicode 空白', () => {
    const text = ' \t\n\u3000\u00a0';
    expect(
      chunkDocument(
        createDocument(text),
        [{ startOffset: 0, endOffset: text.length, headingPath: [] }],
        1,
      ),
    ).toEqual([]);
  });

  it('硬切超长单行时保持 emoji 完整，并保留可复原的 UTF-16 坐标', () => {
    const text = '甲😀乙😀丙';
    const chunks = chunkDocument(
      createDocument(text),
      [{ startOffset: 0, endOffset: text.length, headingPath: [] }],
      2,
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['甲😀', '乙😀', '丙']);
    expect(
      chunks.map(({ startOffset, endOffset }) => [startOffset, endOffset]),
    ).toEqual([
      [0, 3],
      [3, 6],
      [6, 7],
    ]);
    expect(
      chunks.map(({ startLine, endLine }) => [startLine, endLine]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    expect(chunks.map(({ ordinal }) => ordinal)).toEqual([0, 1, 2]);
    expect(new Set(chunks.map(({ chunkId }) => chunkId)).size).toBe(3);
  });

  it('区段刚好达到上限时保留一块，并返回跨行位置和标题', () => {
    const text = '序言\n甲\n乙';
    const chunks = chunkDocument(
      createDocument(text),
      [{ startOffset: 3, endOffset: text.length, headingPath: ['一级'] }],
      3,
    );

    expect(chunks).toMatchObject([
      {
        text: '甲\n乙',
        startLine: 2,
        endLine: 3,
        headingPath: ['一级'],
      },
    ]);
  });

  it('优先换行再空白切分，保留全部区段文本并生成可重复的 ID', () => {
    const text = 'ab cd\nef gh ij';
    const document = createDocument(text);
    const sections = [
      { startOffset: 0, endOffset: text.length, headingPath: [] },
    ];
    const chunks = chunkDocument(document, sections, 8);
    expect(chunks.map(({ text }) => text)).toEqual(['ab cd\n', 'ef gh ij']);
    expect(
      chunks.map(({ startLine, endLine }) => [startLine, endLine]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(chunkDocument(document, sections, 8)).toEqual(chunks);
    expect(
      chunkDocument(document, sections, 5)
        .map(({ text }) => text)
        .join(''),
    ).toBe(text);
  });

  it('拒绝非法上限，并支持提前取消', () => {
    const document = createDocument('正文');
    expect(() => chunkDocument(document, [], 0)).toThrow(RangeError);
    expect(() => chunkDocument(document, [], 2, AbortSignal.abort())).toThrow();
  });
});
