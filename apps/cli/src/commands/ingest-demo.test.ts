import { afterEach, expect, it, vi } from 'vitest';
import { ingestDemo } from './ingest-demo.js';

const { ingestDocument } = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
}));
vi.mock('../bootstrap.js', () => ({
  ingestWorkspaceDocument: ingestDocument,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const options = {
  rootPath: '/workspace',
  sourcePath: './guide.md',
  corpusId: 'manual',
  signal: new AbortController().signal,
};

it('传递导入参数并输出来源摘要，省略正文', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  ingestDocument.mockResolvedValue({
    document: { sourcePath: 'guide.md', text: '完整正文' },
    chunks: [
      {
        ordinal: 0,
        chunkId: 'abc',
        startLine: 2,
        endLine: 4,
        headingPath: ['指南'],
        text: '片段正文',
      },
    ],
  });

  await ingestDemo(options);

  expect(ingestDocument).toHaveBeenCalledExactlyOnceWith(options);
  expect(write).toHaveBeenCalledWith(
    '"guide.md"：1 个片段\n1. "abc" L2-L4 ["指南"]\n',
  );
});

it('空文档显示零片段', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  ingestDocument.mockResolvedValue({
    document: { sourcePath: 'guide.md' },
    chunks: [],
  });

  await ingestDemo(options);

  expect(write).toHaveBeenCalledWith('"guide.md"：0 个片段\n');
});

it('导入失败时保留原始错误且不输出成功摘要', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const error = new Error('导入失败');
  ingestDocument.mockRejectedValue(error);

  await expect(ingestDemo(options)).rejects.toBe(error);
  expect(write).not.toHaveBeenCalled();
});
