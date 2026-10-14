export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
