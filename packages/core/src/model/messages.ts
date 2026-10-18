export enum EMessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

export type ModelMessage =
  | {
      role: EMessageRole.SYSTEM | EMessageRole.USER;
      content: string;
    }
  | {
      role: EMessageRole.ASSISTANT;
      content: string;
      toolCalls?: ModelToolCall[];
    }
  | {
      role: EMessageRole.TOOL;
      name: string;
      content: string;
    };

export interface ModelToolCall {
  name: string;
  arguments: unknown;
}
