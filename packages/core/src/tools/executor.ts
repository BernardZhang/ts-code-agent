import type { ToolExecutionContext } from './definition.js';
import type { ToolRegistry } from './registry.js';
import { ToolErrorCode, type ToolResult } from './result.js';

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly timeoutMs: number = 10_000, // 默认超时时间为 10 秒
  ) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    ) {
      throw new Error('timeoutMs 必须是一个介于 1 和 2,147,483,647 之间的整数');
    }
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        success: false,
        error: {
          code: ToolErrorCode.UNKNOWN_TOOL,
          message: `工具 "${name}" 未注册`,
        },
      };
    }

    if (context.signal.aborted) {
      return {
        success: false,
        error: {
          code: ToolErrorCode.CANCELLED,
          message: '工具调用已取消',
        },
      };
    }

    const controller = new AbortController();

    let resolveStopRequest: (result: ToolResult) => void;
    // 超时、取消信号时都需要取消工具调用
    const stopRequest = (
      code: ToolErrorCode.TIMEOUT | ToolErrorCode.CANCELLED,
    ) => {
      resolveStopRequest({
        success: false,
        error: {
          code,
          message:
            code === ToolErrorCode.TIMEOUT
              ? `工具调用超时，超过 ${this.timeoutMs} 毫秒`
              : '工具调用已取消',
        },
      });
      controller.abort();
    };
    const onAbort = () => {
      stopRequest(ToolErrorCode.CANCELLED);
    };
    context.signal.addEventListener('abort', onAbort);

    const timmer = setTimeout(
      () => stopRequest(ToolErrorCode.TIMEOUT),
      this.timeoutMs,
    );
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      resolveStopRequest = resolve;
    });

    return Promise.race([
      timeoutPromise,
      tool.invoke(rawArguments, { signal: controller.signal }),
    ]).finally(() => {
      clearTimeout(timmer);
      context.signal.removeEventListener('abort', onAbort);
    });
  }
}
