import { expect, it, vi } from 'vitest';
import { ModelErrorCode } from '@ts-code-agent/core';
import { OllamaEmbeddingProvider } from './embedding-provider.js';

const request = { model: 'embedding-test', texts: ['安装', '测试'] };

it('批量提交文本并关闭自动截断，保留模型标识和向量顺序', async () => {
  const result = {
    model: 'embedding-test:v1',
    embeddings: [
      [1, 0],
      [0, 1],
    ],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(result));
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://localhost:11434/',
    timeoutMs: 1000,
    dimensions: 2,
    fetch: fetcher,
  });
  await expect(provider.embed(request)).resolves.toEqual(result);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('http://localhost:11434/api/embed');
  expect(JSON.parse(String(init?.body))).toEqual({
    model: request.model,
    input: request.texts,
    truncate: false,
  });
});

it.each([
  { model: 'test', embeddings: [[1, 0]] },
  { model: 'test', embeddings: [[1], [0, 1]] },
  { model: 'test', embeddings: [[], []] },
  {
    model: '',
    embeddings: [
      [1, 0],
      [0, 1],
    ],
  },
  {
    model: 'test',
    embeddings: [
      [null, 0],
      [0, 1],
    ],
  },
])('拒绝不完整或非法向量响应 %j', async (body) => {
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://localhost:11434',
    timeoutMs: 1000,
    dimensions: 2,
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
  });
  await expect(provider.embed(request)).rejects.toMatchObject({
    code: ModelErrorCode.PROTOCOL,
  });
});

it('区分 HTTP、网络和 JSON 错误', async () => {
  for (const [fetcher, code] of [
    [
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { status: 503 })),
      ModelErrorCode.HTTP,
    ],
    [
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')),
      ModelErrorCode.NETWORK,
    ],
    [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
      ModelErrorCode.JSON,
    ],
  ] as const) {
    await expect(
      new OllamaEmbeddingProvider({
        baseUrl: 'http://localhost:11434',
        timeoutMs: 1000,
        dimensions: 2,
        fetch: fetcher,
      }).embed(request),
    ).rejects.toMatchObject({ code });
  }
});

it('提前取消时不发起 HTTP 请求', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://localhost:11434',
    timeoutMs: 1000,
    dimensions: 2,
    fetch: fetcher,
  });
  await expect(
    provider.embed({ ...request, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: ModelErrorCode.CANCELLED });
  expect(fetcher).not.toHaveBeenCalled();
});

it('区分请求期间的取消和超时', async () => {
  const fetcher: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://localhost:11434',
    timeoutMs: 10,
    dimensions: 2,
    fetch: fetcher,
  });
  await expect(provider.embed(request)).rejects.toMatchObject({
    code: ModelErrorCode.TIMEOUT,
  });
  const controller = new AbortController();
  const pending = provider.embed({ ...request, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    code: ModelErrorCode.CANCELLED,
  });
});
