import { describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './provider.js';
import { EMessageRole, type ModelRequest } from '@ts-code-agent/core';

const request: ModelRequest = {
  model: 'test',
  messages: [{ role: EMessageRole.USER, content: 'hello' }],
};
const item = (content: string, done: boolean) => ({
  message: { role: EMessageRole.ASSISTANT, content },
  done,
});
const provider = (fetcher: typeof fetch, timeoutMs = 1000) =>
  new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    timeoutMs,
    fetch: fetcher,
  });

describe('Ollama provider', () => {
  it('maps non-streaming text and optional usage and sends the schema', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...item('hello', true), eval_count: 5 })),
      );
    const result = await provider(fetcher).generate({
      ...request,
      jsonSchema: { type: 'object' },
    });
    expect(result).toEqual({ text: 'hello', usage: { outputTokens: 5 } });
    const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      stream: false,
      format: { type: 'object' },
      options: { num_ctx: 8192 },
      think: false,
    });
  });

  it('streams deltas and exactly one completion event', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          [item('你', false), item('好', false), item('', true)]
            .map((value) => JSON.stringify(value))
            .join('\n'),
        ),
      );
    const events = [];
    for await (const event of provider(fetcher).stream(request))
      events.push(event);
    expect(events).toEqual([
      { type: 'text.delta', text: '你' },
      { type: 'text.delta', text: '好' },
      { type: 'done', usage: {} },
    ]);
  });

  it('rejects HTTP errors, service errors and incomplete streams', async () => {
    const cases = [
      new Response('', { status: 404 }),
      new Response('{"error":"missing model"}'),
      new Response(JSON.stringify(item('partial', false))),
    ];
    for (const [index, response] of cases.entries()) {
      const consume = async () => {
        for await (const event of provider(
          vi.fn<typeof fetch>().mockResolvedValue(response),
        ).stream(request))
          void event;
      };
      await expect(consume()).rejects.toMatchObject({
        code: index === 0 ? 'http' : 'protocol',
      });
    }
  });

  it('distinguishes bad response JSON from a transport failure', async () => {
    await expect(
      provider(
        vi.fn<typeof fetch>().mockResolvedValue(new Response('bad')),
      ).generate(request),
    ).rejects.toMatchObject({ code: 'protocol' });
    await expect(
      provider(
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection')),
      ).generate(request),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('honors pre-cancellation without sending a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      provider(fetcher).generate({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('distinguishes timeout from user cancellation', async () => {
    const hanging: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    await expect(provider(hanging, 10).generate(request)).rejects.toMatchObject(
      { code: 'timeout' },
    );
    const controller = new AbortController();
    const pending = provider(hanging).generate({
      ...request,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('将工具描述传递给模型请求', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...item('hello', true), eval_count: 5 })),
      );
    const echoTool = {
      name: 'echo',
      description: 'Echoes the input',
      parameters: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string' } },
      },
    };

    const result = await provider(fetcher).generate({
      ...request,
      tools: [echoTool],
    });

    expect(result).toEqual({ text: 'hello', usage: { outputTokens: 5 } });

    // 模拟 fetch 第一次调用时，第二个参数里的 body
    const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));

    expect(body).toMatchObject({
      tools: [
        {
          type: 'function',
          function: echoTool,
        },
      ],
    });
  });

  it('工具调用返回能够正常解析', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          done: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'add',
                  arguments: { a: 12, b: 30 },
                },
              },
            ],
          },
        }),
      ),
    );

    const response = await provider(fetcher).generate(request);

    expect(response).toMatchObject({
      toolCalls: [
        {
          name: 'add',
          arguments: { a: 12, b: 30 },
        },
      ],
    });
  });

  it('验证工具结果回传的请求格式', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(item('结果是 42', true))));

    await provider(fetcher).generate({
      ...request,
      messages: [
        {
          role: EMessageRole.ASSISTANT,
          content: '',
          toolCalls: [
            {
              name: 'add',
              arguments: {
                a: 10,
                b: 32,
              },
            },
          ],
        },
        {
          role: EMessageRole.TOOL,
          name: 'add',
          content: '42',
        },
      ],
    });

    const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));

    expect(body).toMatchObject({
      messages: [
        {
          role: EMessageRole.ASSISTANT,
          content: '',
          tool_calls: [
            {
              function: {
                name: 'add',
                arguments: {
                  a: 10,
                  b: 32,
                },
              },
            },
          ],
        },
        {
          role: EMessageRole.TOOL,
          tool_name: 'add',
          content: '42',
        },
      ],
    });

    // 没有多余的toolCalls 数据
    expect(body).not.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          toolCalls: expect.anything(),
        }),
      ]),
    });
  });
});
