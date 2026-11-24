import { afterEach, expect, it, vi } from 'vitest';
import { embedDemo } from './embed-demo.js';

const { ingestDocument, embed } = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  embed: vi.fn(),
}));
vi.mock('../bootstrap.js', () => ({
  ingestWorkspaceDocument: ingestDocument,
}));
vi.mock('@ts-code-agent/adapters', () => ({
  OllamaEmbeddingProvider: class {
    embed = embed;
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const options = {
  rootPath: '.',
  sourcePath: 'guide.md',
  corpusId: 'manual',
  signal: new AbortController().signal,
};
const config = {
  baseUrl: 'http://localhost:11434',
  model: 'test',
  dimensions: 2,
  timeoutMs: 1000,
};

it('按顺序分批向量化，携带取消信号，全部成功后输出摘要', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  ingestDocument.mockResolvedValue({
    document: { sourcePath: 'guide.md' },
    chunks: Array.from({ length: 17 }, (_, i) => ({ text: String(i) })),
  });
  embed.mockResolvedValue({ model: 'test:v1', embeddings: [] });
  await embedDemo(options, config);
  expect(ingestDocument).toHaveBeenCalledExactlyOnceWith(options);
  expect(embed).toHaveBeenCalledTimes(2);
  expect(embed.mock.calls[0]?.[0]).toMatchObject({
    model: 'test',
    signal: options.signal,
  });
  expect(embed.mock.calls[0]?.[0].texts).toHaveLength(16);
  expect(embed.mock.calls[1]?.[0].texts).toEqual(['16']);
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
    chunks: 17,
    embedded: 17,
    dimensions: 2,
    model: 'test:v1',
  });
});

it('空文档不请求模型', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  ingestDocument.mockResolvedValue({
    document: { sourcePath: 'guide.md' },
    chunks: [],
  });
  await embedDemo(options, config);
  expect(embed).not.toHaveBeenCalled();
});

it('批次失败时传播错误且不输出成功摘要', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  ingestDocument.mockResolvedValue({
    document: { sourcePath: 'guide.md' },
    chunks: [{ text: '正文' }],
  });
  const error = new Error('offline');
  embed.mockRejectedValue(error);
  await expect(embedDemo(options, config)).rejects.toBe(error);
  expect(write).not.toHaveBeenCalled();
});
