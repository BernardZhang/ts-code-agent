import type { ModelMessage, ModelToolCall } from './messages.js';
import type { ModelEvent, ModelUsage } from './events.js';
import type { ToolDescription } from '../tools/definition.js';

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  contextLength?: number;
  think?: boolean;
  jsonSchema?: Record<string, unknown>;
  tools?: ToolDescription[];
}

export interface ModelResult {
  text: string;
  usage: ModelUsage;
  finishReason?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelProvider {
  readonly capabilities: { structuredOutput: boolean };
  generate(request: ModelRequest): Promise<ModelResult>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
