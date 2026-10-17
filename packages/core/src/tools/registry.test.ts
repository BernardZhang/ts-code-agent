import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './definition.js';
import { ToolErrorCode } from './result.js';

const echoTool: ToolDefinition<string, string> = {
  name: 'echo',
  description: '原样返回字符串',
  parameters: { type: 'string' },
  inputSchema: {
    safeParse: (value) => {
      if (typeof value === 'string') {
        return { success: true, data: value };
      }
      return { success: false, error: { message: 'Invalid input' } };
    },
  },
  execute: async (input) => input,
};

describe('ToolRegistry', () => {
  it('未注册的工具返回 undefined', () => {
    const registry = new ToolRegistry();

    expect(registry.get('multiply')).toBeUndefined();
  });

  it('注册后可以按名称查找工具', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const registeredTool = registry.get('echo');
    expect(registeredTool).toBeDefined();
    expect(registeredTool?.name).toBe('echo');
  });

  it('拒绝重复注册同名工具', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    expect(() => registry.register(echoTool)).toThrowError(
      'Tool with name "echo" is already registered.',
    );
  });

  it('参数非法时不执行工具', async () => {
    const execute = vi.fn(async (input: string) => input);
    const registry = new ToolRegistry();

    registry.register({
      ...echoTool,
      execute,
    });

    const tool = registry.get('echo');

    if (!tool) {
      throw new Error('测试工具未注册');
    }

    const result = await tool?.invoke(42, {
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.INVALID_ARGUMENTS,
        message: 'Invalid input',
      },
    });

    // 参数错误execute 不会被调用
    expect(execute).not.toHaveBeenCalled();
  });

  it('工具调用执行失败', async () => {
    const execute = vi.fn(async () => {
      throw new Error('echo工具执行失败');
    });
    const registry = new ToolRegistry();

    registry.register({
      ...echoTool,
      execute,
    });

    const tool = registry.get('echo');

    if (!tool) {
      throw new Error('测试工具未注册');
    }

    const context = {
      signal: new AbortController().signal,
    };

    const result = await tool.invoke('test', context);

    expect(result).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.EXECUTION_FAILED,
        message: 'echo工具执行失败',
      },
    });

    expect(execute).toHaveBeenCalledWith('test', context);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('列出工具描述，不包含执行函数', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    expect(registry.list()).toEqual([
      {
        name: echoTool.name,
        description: echoTool.description,
        parameters: echoTool.parameters,
      },
    ]);
  });
});
