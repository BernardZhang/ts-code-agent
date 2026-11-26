import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ingestWorkspaceDocument,
  type IngestDocumentOptions,
} from '@ts-code-agent/code-agent';
import { readTextFile } from '@ts-code-agent/adapters';
import { EDocumentFormat } from '@ts-code-agent/core';
import { EIngestErrorCode } from '@ts-code-agent/code-agent';

const ingestDocument = (options: IngestDocumentOptions) =>
  ingestWorkspaceDocument(options, readTextFile);

describe('ingestDocument', () => {
  let temporaryPath: string;
  let rootPath: string;

  beforeEach(async () => {
    temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'rag-ingest-'));
    rootPath = path.join(temporaryPath, 'workspace');
    await mkdir(rootPath);
  });

  afterEach(async () => {
    await rm(temporaryPath, { recursive: true, force: true });
  });

  it('导入 Markdown 并为正文保留标题和来源行号', async () => {
    await writeFile(path.join(rootPath, 'guide.md'), '# 指南\n\n正文');
    const result = await ingestDocument({
      rootPath,
      sourcePath: 'guide.md',
      corpusId: 'manual',
    });

    expect(result.document).toMatchObject({
      sourcePath: 'guide.md',
      format: EDocumentFormat.MARKDOWN,
    });
    const chunk = result.chunks.find(({ text }) => text.includes('正文'));
    expect(chunk).toMatchObject({ headingPath: ['指南'], endLine: 3 });
  });

  it('导入 TXT 时移除 BOM、统一 CRLF，并保留有效 Unicode', async () => {
    await writeFile(path.join(rootPath, 'guide.txt'), '\uFEFF你好😀\r\n第二行');
    const result = await ingestDocument({
      rootPath,
      sourcePath: 'guide.txt',
      corpusId: 'manual',
    });

    expect(result.document).toMatchObject({
      format: EDocumentFormat.TEXT,
      text: '你好😀\n第二行',
    });
    expect(result.chunks.map(({ text }) => text)).toEqual(['你好😀\n第二行']);
  });

  it.each(['', ' \t\r\n'])('空白内容 %j 返回零片段', async (content) => {
    await writeFile(path.join(rootPath, 'empty.txt'), content);
    const result = await ingestDocument({
      rootPath,
      sourcePath: 'empty.txt',
      corpusId: 'manual',
    });

    expect(result.chunks).toEqual([]);
  });

  it('重复导入保留 ID，隔离同路径的不同资料集并区分内容版本', async () => {
    const sourcePath = 'guide.txt';
    const options = { rootPath, sourcePath, corpusId: 'manual' };
    await writeFile(path.join(rootPath, sourcePath), '第一版');
    const first = await ingestDocument(options);
    const repeated = await ingestDocument(options);
    const otherCorpus = await ingestDocument({ ...options, corpusId: 'notes' });

    expect(repeated).toEqual(first);
    expect(otherCorpus.document.documentId).not.toBe(first.document.documentId);
    expect(otherCorpus.chunks[0]?.chunkId).not.toBe(first.chunks[0]?.chunkId);

    await writeFile(path.join(rootPath, sourcePath), '第二版');
    const updated = await ingestDocument(options);

    expect(updated.document.documentId).toBe(first.document.documentId);
    expect(updated.document.contentHash).not.toBe(first.document.contentHash);
    expect(updated.chunks[0]?.chunkId).not.toBe(first.chunks[0]?.chunkId);
  });

  it.each([Buffer.from([0xc3, 0x28]), Buffer.from([0x61, 0x00])])(
    '拒绝非法 UTF-8 或含 NUL 的正文',
    async (bytes) => {
      await writeFile(path.join(rootPath, 'invalid.txt'), bytes);
      await expect(
        ingestDocument({
          rootPath,
          sourcePath: 'invalid.txt',
          corpusId: 'manual',
        }),
      ).rejects.toMatchObject({ code: EIngestErrorCode.INVALID_ENCODING });
    },
  );

  it('内容刚好等于字节预算时成功，超过时失败', async () => {
    await writeFile(path.join(rootPath, 'budget.txt'), '你好');
    const options = { rootPath, sourcePath: 'budget.txt', corpusId: 'manual' };

    await expect(
      ingestDocument({ ...options, maxBytes: 6 }),
    ).resolves.toMatchObject({
      document: { text: '你好' },
    });
    await expect(
      ingestDocument({ ...options, maxBytes: 5 }),
    ).rejects.toMatchObject({
      code: EIngestErrorCode.FILE_TOO_LARGE,
    });
  });

  it('拒绝经相对路径或符号链接访问工作区外的文件', async () => {
    const outsidePath = path.join(temporaryPath, 'outside.txt');
    await writeFile(outsidePath, '外部文件');
    await symlink(outsidePath, path.join(rootPath, 'linked.txt'));

    for (const sourcePath of ['../outside.txt', 'linked.txt']) {
      await expect(
        ingestDocument({ rootPath, sourcePath, corpusId: 'manual' }),
      ).rejects.toMatchObject({ code: EIngestErrorCode.INVALID_PATH });
    }
  });

  it('拒绝不支持的文件格式', async () => {
    await writeFile(path.join(rootPath, 'guide.json'), '{}');
    await expect(
      ingestDocument({
        rootPath,
        sourcePath: 'guide.json',
        corpusId: 'manual',
      }),
    ).rejects.toMatchObject({ code: EIngestErrorCode.UNSUPPORTED_FORMAT });
  });

  it('已取消时优先报告取消，即使路径不存在', async () => {
    await expect(
      ingestDocument({
        rootPath,
        sourcePath: 'missing.txt',
        corpusId: 'manual',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: EIngestErrorCode.CANCELLED });
  });
});
