import { OllamaProvider, readTextFile } from '@ts-code-agent/adapters';
import type { ModelRequest } from '@ts-code-agent/core';
import {
  ingestWorkspaceDocument as ingestFromWorkspace,
  type IngestDocumentOptions,
} from '@ts-code-agent/code-agent';
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

/** 文件系统读取由 CLI 注入，Code Agent 只依赖 Core 契约。 */
export function ingestWorkspaceDocument(options: IngestDocumentOptions) {
  return ingestFromWorkspace(options, readTextFile);
}
