import {
  ModelError,
  ModelErrorCode,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
} from '@ts-code-agent/core';
import { z } from 'zod';
import type { OllamaOptions } from './provider.js';

export interface OllamaEmbeddingOptions extends OllamaOptions {
  /** 索引约定的向量维度；校验模型实际输出，避免混入不同向量空间。 */
  dimensions: number;
}

const responseSchema = z.object({
  model: z.string().trim().min(1),
  embeddings: z.array(z.array(z.number().finite())),
});

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly dimensions: number;

  constructor(options: OllamaEmbeddingOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('Ollama 地址必须使用 HTTP 或 HTTPS。');
    }
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1) {
      throw new RangeError('向量维度必须为正整数。');
    }
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647
    ) {
      throw new RangeError('超时必须为合法的正整数毫秒数。');
    }
    this.endpoint = options.baseUrl.replace(/\/$/u, '') + '/api/embed';
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.dimensions = options.dimensions;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timedOut = false;
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) {
      cancel();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      controller.signal.throwIfAborted();
      if (
        !request.model.trim() ||
        !request.texts.length ||
        request.texts.some((text) => !text.trim())
      ) {
        throw new ModelError(
          ModelErrorCode.VALIDATION,
          '模型和输入文本不能为空。',
        );
      }
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        // 超出模型上下文时明确失败，确保向量对应完整片段。
        body: JSON.stringify({
          model: request.model,
          input: request.texts,
          truncate: false,
        }),
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelError(
          ModelErrorCode.HTTP,
          `Ollama HTTP ${response.status}。`,
        );
      }

      // 先完成读取，再解析 JSON，区分读取中断与 JSON 语法错误。
      const text = await response.text();
      controller.signal.throwIfAborted();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (cause) {
        throw new ModelError(
          ModelErrorCode.JSON,
          'Embedding 响应不是合法 JSON。',
          { cause },
        );
      }
      const parsed = responseSchema.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.embeddings.length !== request.texts.length ||
        parsed.data.embeddings.some(
          (vector) => vector.length !== this.dimensions,
        )
      ) {
        throw new ModelError(
          ModelErrorCode.PROTOCOL,
          'Embedding 响应的模型、数量、维度或数值不合法。',
        );
      }
      return parsed.data;
    } catch (cause) {
      if (request.signal?.aborted) {
        throw new ModelError(
          ModelErrorCode.CANCELLED,
          'Embedding 请求已取消。',
          { cause },
        );
      }
      if (timedOut) {
        throw new ModelError(ModelErrorCode.TIMEOUT, 'Embedding 请求超时。', {
          cause,
        });
      }
      if (cause instanceof ModelError) {
        throw cause;
      }
      throw new ModelError(
        ModelErrorCode.NETWORK,
        '无法连接或读取 Ollama 服务。',
        { cause },
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
}
