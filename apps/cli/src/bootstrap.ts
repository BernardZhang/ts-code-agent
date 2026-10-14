import { OllamaProvider } from '@ts-code-agent/adapters';
import type { ModelRequest } from '@ts-code-agent/core';
import type { Config } from './config.js';

export function bootstrap(config: Config, signal: AbortSignal) {
  return {
    provider: new OllamaProvider({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    }),
    request: {
      model: config.model,
      contextLength: config.contextLength,
      think: config.think,
      signal,
      messages: [],
    } satisfies ModelRequest,
  };
}
