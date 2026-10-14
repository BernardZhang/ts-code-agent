import type { ModelMessage } from './messages.js';
import type { ModelEvent, ModelUsage } from './events.js';

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  contextLength?: number;
  think?: boolean;
  jsonSchema?: Record<string, unknown>;
}

export interface ModelResult {
  text: string;
  usage: ModelUsage;
  finishReason?: string;
}

export interface ModelProvider {
  readonly capabilities: { structuredOutput: boolean };
  generate(request: ModelRequest): Promise<ModelResult>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
