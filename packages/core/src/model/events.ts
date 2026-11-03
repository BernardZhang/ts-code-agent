import type { ModelResult } from './provider.js';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export enum EModelEventType {
  TEXT_DELTA = 'text.delta',
  DONE = 'done',
}

export type ModelEvent =
  | { type: EModelEventType.TEXT_DELTA; text: string }
  | { type: EModelEventType.DONE; result: ModelResult };
