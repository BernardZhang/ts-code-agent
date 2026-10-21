import { Buffer } from 'node:buffer';
import type {
  MessageTokenEstimator,
  ToolDescription,
} from '@ts-code-agent/core';

const MESSAGE_ENVELOPE_OVERHEAD = 16;
const TOOL_DEFINITION_ENVELOPE_OVERHEAD = 16;

// UTF-8 序列化字节数加固定开销：仅为启发式估算，非 tokenizer，
// 不保证与实际 token 数一致，也不是模型输入成本的严格上界。
export const estimateMessageTokens: MessageTokenEstimator = (message) =>
  Buffer.byteLength(JSON.stringify(message), 'utf8') +
  MESSAGE_ENVELOPE_OVERHEAD;

export function estimateToolDefinitionTokens(
  tools: readonly ToolDescription[],
): number {
  if (tools.length === 0) return 0;
  // 仅序列化公开描述，避免执行函数或调用方额外字段混入估算。
  const descriptions = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return (
    Buffer.byteLength(JSON.stringify(descriptions), 'utf8') +
    TOOL_DEFINITION_ENVELOPE_OVERHEAD
  );
}
