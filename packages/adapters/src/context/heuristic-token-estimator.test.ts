import { describe, expect, it } from 'vitest';
import {
  EMessageRole,
  type ModelMessage,
  type ToolDescription,
} from '@ts-code-agent/core';
import {
  estimateMessageTokens,
  estimateToolDefinitionTokens,
} from './heuristic-token-estimator.js';

describe('启发式 token 成本估算', () => {
  it('计算中文的 UTF-8 字节成本而非字符串长度', () => {
    const ascii: ModelMessage = { role: EMessageRole.USER, content: 'a' };
    const chinese: ModelMessage = { role: EMessageRole.USER, content: '中' };
    expect(estimateMessageTokens(chinese) - estimateMessageTokens(ascii)).toBe(
      2,
    );
  });

  it('空正文的工具调用仍计算工具名及完整参数，且不修改消息', () => {
    const message: ModelMessage = {
      role: EMessageRole.ASSISTANT,
      content: '',
      toolCalls: [{ name: 'add', arguments: { a: 1, b: 2 } }],
    };
    const before = structuredClone(message);
    expect(estimateMessageTokens(message)).toBeGreaterThan(
      estimateMessageTokens({ role: EMessageRole.ASSISTANT, content: '' }),
    );
    expect(message).toEqual(before);
  });

  it('空消息仍有封装成本，结果为正的安全整数', () => {
    const cost = estimateMessageTokens({
      role: EMessageRole.USER,
      content: '',
    });
    expect(cost).toBeGreaterThan(0);
    expect(Number.isSafeInteger(cost)).toBe(true);
  });

  it('没有工具时成本为 0，Schema 增长时工具成本增加', () => {
    const tool: ToolDescription = {
      name: 'add',
      description: '计算',
      parameters: {},
    };
    const before = structuredClone(tool);
    expect(estimateToolDefinitionTokens([])).toBe(0);
    const cost = estimateToolDefinitionTokens([tool]);
    expect(cost).toBeGreaterThan(0);
    expect(Number.isSafeInteger(cost)).toBe(true);
    expect(
      estimateToolDefinitionTokens([
        {
          ...tool,
          parameters: { type: 'object', properties: { a: { type: 'number' } } },
        },
      ]),
    ).toBeGreaterThan(cost);
    expect(tool).toEqual(before);
  });

  it('工具名与说明也计入成本', () => {
    const tool: ToolDescription = {
      name: 'a',
      description: '',
      parameters: {},
    };
    const base = estimateToolDefinitionTokens([tool]);
    expect(
      estimateToolDefinitionTokens([{ ...tool, name: 'longer_tool_name' }]),
    ).toBeGreaterThan(base);
    expect(
      estimateToolDefinitionTokens([
        { ...tool, description: '计算两个数字的和' },
      ]),
    ).toBeGreaterThan(base);
  });
});
