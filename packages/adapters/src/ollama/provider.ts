import {
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelEvent,
  type ModelResult,
  EMessageRole,
} from '@ts-code-agent/core';
import { mapResponse } from './mapper.js';
import { parseNdjson } from './stream-parser.js';

export interface OllamaOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class OllamaProvider implements ModelProvider {
  readonly capabilities = { structuredOutput: true };
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OllamaOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private scope(request: ModelRequest) {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);

    return {
      signal: controller.signal,
      error: (cause: unknown): Error => {
        if (request.signal?.aborted)
          return new ModelError('cancelled', '请求已取消。', { cause });
        if (timedOut)
          return new ModelError('timeout', '模型请求超时。', { cause });
        if (cause instanceof ModelError) return cause;
        return new ModelError('network', '无法连接或读取 Ollama 服务。', {
          cause,
        });
      },
      close: () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', cancel);
        controller.abort();
      },
    };
  }

  private async send(
    request: ModelRequest,
    stream: boolean,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const response = await this.fetcher(
      `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((message) => {
            if (message.role === EMessageRole.TOOL) {
              return {
                role: message.role,
                tool_name: message.name,
                content: message.content,
              };
            }

            if (message.role === EMessageRole.ASSISTANT) {
              return {
                role: message.role,
                content: message.content,
                ...(message.toolCalls
                  ? {
                      tool_calls: message.toolCalls.map((toolCall) => ({
                        function: {
                          name: toolCall.name,
                          arguments: toolCall.arguments,
                        },
                      })),
                    }
                  : {}),
              };
            }

            return {
              role: message.role,
              content: message.content,
            };
          }),
          stream,
          think: request.think ?? false,
          ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
          options: { num_ctx: request.contextLength ?? 8192 },
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelError(
        'http',
        `Ollama HTTP ${response.status}；请检查服务及模型。`,
      );
    }
    return response;
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const scope = this.scope(request);
    try {
      const response = await this.send(request, false, scope.signal);
      // Read separately so transport failures remain distinguishable from bad JSON.
      const text = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (cause) {
        throw new ModelError('protocol', 'Ollama 响应不是合法 JSON。', {
          cause,
        });
      }
      const result = mapResponse(raw);

      if (!result.done)
        throw new ModelError('protocol', '非流式响应没有结束标记。');
      return {
        text: result.text,
        usage: result.usage,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
      };
    } catch (cause) {
      throw scope.error(cause);
    } finally {
      scope.close();
    }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    if (request.tools?.length) {
      throw new ModelError(
        'unsupported',
        '当前不支持流式工具调用，请使用 generate。',
      );
    }
    const scope = this.scope(request);
    try {
      const response = await this.send(request, true, scope.signal);
      if (!response.body)
        throw new ModelError('protocol', 'Ollama 返回空响应流。');
      for await (const raw of parseNdjson(response.body)) {
        scope.signal.throwIfAborted();
        const item = mapResponse(raw);

        if (item.toolCalls?.length) {
          throw new ModelError(
            'unsupported',
            '流式响应包含工具调用，当前无法处理。',
          );
        }

        if (item.text) yield { type: 'text.delta', text: item.text };
        if (item.done) {
          yield {
            type: 'done',
            usage: item.usage,
            ...(item.finishReason ? { finishReason: item.finishReason } : {}),
          };
          return;
        }
      }
      throw new ModelError('protocol', '响应流提前结束，缺少结束标记。');
    } catch (cause) {
      throw scope.error(cause);
    } finally {
      scope.close();
    }
  }
}
