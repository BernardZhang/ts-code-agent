import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolExecutor } from './executor.js';
import type { ToolDefinition } from './definition.js';
import { ToolRegistry } from './registry.js';
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

describe('ToolExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('执行未知工具返回未知工具类型错误', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const context = { signal: new AbortController().signal };
    const result = await executor.execute('echo', 'test', context);
    expect(result.success).toBe(false);
    expect(result).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.UNKNOWN_TOOL,
        message: '工具 "echo" 未注册',
      },
    });
  });

  it('已取消的请求不会执行工具', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (input: string) => input);

    registry.register({
      ...echoTool,
      execute,
    });

    const executor = new ToolExecutor(registry);
    const controller = new AbortController();
    controller.abort(); // 取消请求
    const context = { signal: controller.signal };
    const result = await executor.execute('echo', 'test', context);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.CANCELLED,
        message: '工具调用已取消',
      },
    });
  });

  it('拒绝非法超时时间', () => {
    const registry = new ToolRegistry();

    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      expect(() => new ToolExecutor(registry, timeoutMs)).toThrow();
    }
  });

  it('执行期间取消，即使工具忽略信号也能返回', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (input: string) => {
      // 忽略取消信号，模拟长时间执行
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return input;
    });

    registry.register({
      ...echoTool,
      execute,
    });

    const executor = new ToolExecutor(registry, 500); // 设置超时时间为 500ms
    const controller = new AbortController();
    const context = { signal: controller.signal };

    const pending = executor.execute(echoTool.name, 'test', context);

    expect(execute).toHaveBeenCalled();
    controller.abort(); // 立即取消请求

    expect(await pending).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.CANCELLED,
        message: '工具调用已取消',
      },
    });
  });

  it('超时后返回 timeout，并通知工具取消', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let toolSignal;
    const execute = vi.fn(async (input: string, context) => {
      toolSignal = context.signal;
      // 忽略取消信号，模拟长时间执行
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return input;
    });

    registry.register({
      ...echoTool,
      execute,
    });

    const executor = new ToolExecutor(registry, 100);
    const controller = new AbortController();
    const context = { signal: controller.signal };

    const result = executor.execute(echoTool.name, 'test', context);

    await vi.advanceTimersByTime(100); // 快进时间到超时

    expect(await result).toEqual({
      success: false,
      error: {
        code: ToolErrorCode.TIMEOUT,
        message: '工具调用超时，超过 100 毫秒',
      },
    });
    expect(toolSignal!.aborted).toBe(true); // 工具收到取消信号
  });
});
