export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ModelEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'done'; usage: ModelUsage; finishReason?: string };
